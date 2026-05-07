/**
 * HTML → markdown converter for `baget_read_document` (and any future
 * channel-side read paths that need to surface a doc body in chat).
 *
 * Why this exists: Sam 2026-05-07 Telegram smoke after PR #64 — the
 * deck doc body had been regenerated as the new HTML deck format
 * (HTML/CSS for visual rendering on the dashboard). When the channel
 * agent called `baget_read_document` and dutifully quoted the
 * returned content inline, the founder saw 1000+ lines of raw
 * `<section>` / `<style>` / CSS tokens in the chat — equally
 * unreadable as the PDF render path that PR #64 just shut off.
 *
 * The right structural answer is server-side: apps/web's GET
 * /api/companies/:id/documents/:docId returning a `?format=text`
 * variant that hands back stripped-to-text content for chat
 * consumers. That's queued as a follow-up. This module is the
 * fork-side bridge that unblocks the founder right now using
 * `turndown` — already pre-installed in the agent-runner image
 * (Dockerfile line ~102 adds it for the markdown→PDF path) so we
 * don't pay an install cost.
 *
 * Detection is intentionally permissive — false positives (treating
 * already-markdown content as HTML and round-tripping it through
 * turndown) are a no-op for plain markdown bodies, while false
 * negatives (treating HTML as markdown and emitting raw tags) are
 * the bug we're closing. When in doubt, convert.
 */
import TurndownService from 'turndown';

/**
 * Heuristic: does this string look like the kind of HTML produced by
 * the deck composer or any future HTML-storage doc category?
 *
 * The composer signs its output with a `<!--baget-deck-html:{...}-->`
 * leading comment containing JSON config; that's the strongest
 * positive signal. As a fallback we look for an early opening tag of
 * one of the structural elements the composer always emits
 * (`<section>`, `<style>`, `<html>`, `<body>`). The check is anchored
 * to the first ~256 characters so a markdown doc that happens to
 * include an inline HTML snippet later doesn't get round-tripped.
 */
export function looksLikeHtml(content: string): boolean {
  if (typeof content !== 'string' || content.length === 0) return false;
  const head = content.slice(0, 256).trimStart();
  if (head.startsWith('<!--baget-deck-html')) return true;
  // Common HTML structural openers the deck composer / any future
  // HTML-doc generator might emit. Lower-case the slice for a case-
  // insensitive prefix check without a regex.
  const lowered = head.toLowerCase();
  if (
    lowered.startsWith('<!doctype html') ||
    lowered.startsWith('<html') ||
    lowered.startsWith('<body') ||
    lowered.startsWith('<section') ||
    lowered.startsWith('<style') ||
    lowered.startsWith('<head')
  ) {
    return true;
  }
  return false;
}

/**
 * Lazy-initialise the converter once per process — turndown's
 * constructor compiles its rule set, so we want to amortize that
 * cost across every read_document call. Module-level state is fine
 * here: the agent-runner is single-threaded and the converter is
 * stateless (each `.turndown()` call is independent).
 */
let cachedConverter: TurndownService | null = null;

function getConverter(): TurndownService {
  if (cachedConverter) return cachedConverter;
  const td = new TurndownService({
    headingStyle: 'atx',           // `# h1` not `===` — atx is denser for chat
    codeBlockStyle: 'fenced',      // ``` blocks survive Telegram better than indented
    bulletListMarker: '-',         // `-` matches the codebase's house style
    emDelimiter: '_',              // single underscore (Telegram italic-friendly)
  });
  // Strip <style>, <script>, and HTML comments entirely. Default
  // turndown keeps <style> contents (CSS) as raw text in the output —
  // exactly the founder-facing failure mode we're trying to close.
  td.remove(['style', 'script']);
  // Comments aren't covered by `remove()`; add an explicit rule.
  // Pattern matches `<!--…-->` non-greedy. Returning '' drops the node.
  td.addRule('strip-comments', {
    filter: (node) => node.nodeType === 8, // COMMENT_NODE
    replacement: () => '',
  });
  cachedConverter = td;
  return td;
}

/**
 * Convert HTML to markdown. Safe to call on already-markdown content
 * (returns it roughly unchanged — turndown is a no-op when there are
 * no HTML nodes to transform), but the `looksLikeHtml` gate above
 * keeps that path from running unnecessarily.
 *
 * Throwing turndown errors are bubbled up — the caller in
 * `baget_read_document` catches them and falls back to the original
 * raw content, so a converter regression degrades to today's
 * behavior rather than blocking the read.
 */
export function htmlToMarkdown(content: string): string {
  return getConverter().turndown(content);
}
