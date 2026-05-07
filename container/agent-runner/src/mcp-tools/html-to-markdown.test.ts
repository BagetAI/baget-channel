/**
 * Pin the HTML→markdown bridge that closes Sam's 2026-05-07 deck-as-
 * raw-HTML Telegram regression. The actual smoke is on real Telegram
 * (turndown's behavior on real composer output); these are the unit-
 * level guardrails that fail fast on a regression.
 */
import { describe, expect, it } from 'bun:test';

import { htmlToMarkdown, looksLikeHtml } from './html-to-markdown.js';

describe('looksLikeHtml', () => {
  it('detects the deck composer signature comment', () => {
    expect(looksLikeHtml('<!--baget-deck-html:{"accent":"#3c47ff"}-->\n<section>...</section>')).toBe(true);
  });

  it('detects a leading <section>, <style>, <html>, <head>, <body>, or doctype', () => {
    expect(looksLikeHtml('<section data-slide-type="cover">hi</section>')).toBe(true);
    expect(looksLikeHtml('<style>.x{color:red}</style>')).toBe(true);
    expect(looksLikeHtml('<html><body>hi</body></html>')).toBe(true);
    expect(looksLikeHtml('<head><title>hi</title></head>')).toBe(true);
    expect(looksLikeHtml('<body>hi</body>')).toBe(true);
    expect(looksLikeHtml('<!DOCTYPE html><html>hi</html>')).toBe(true);
  });

  it('is case-insensitive on the structural tag check', () => {
    expect(looksLikeHtml('<SECTION>hi</SECTION>')).toBe(true);
    expect(looksLikeHtml('<HTML><BODY>x</BODY></HTML>')).toBe(true);
  });

  it('tolerates leading whitespace before the structural tag', () => {
    expect(looksLikeHtml('   \n\n<section>hi</section>')).toBe(true);
    expect(looksLikeHtml('\t<!--baget-deck-html-->')).toBe(true);
  });

  it('returns false on plain markdown', () => {
    expect(looksLikeHtml('# Hello\n\nThis is markdown.')).toBe(false);
    expect(looksLikeHtml('**Bold** and *italic* text.')).toBe(false);
    expect(looksLikeHtml('- bullet 1\n- bullet 2')).toBe(false);
  });

  it('returns false on plain prose', () => {
    expect(looksLikeHtml('This is just text without any HTML.')).toBe(false);
  });

  it('returns false on markdown that mentions HTML in passing', () => {
    // The check is anchored to the FIRST 256 chars and to a structural
    // opener. A markdown doc that mentions HTML somewhere in the body
    // is markdown, not HTML.
    expect(
      looksLikeHtml(
        'Some markdown content explaining the layout with `<section>` tags inside code blocks. ' +
          'This should not be detected as HTML because the first non-whitespace character is "S".',
      ),
    ).toBe(false);
  });

  it('returns false on empty / non-string input', () => {
    expect(looksLikeHtml('')).toBe(false);
    expect(looksLikeHtml('   ')).toBe(false);
    // @ts-expect-error — defensive runtime check
    expect(looksLikeHtml(null)).toBe(false);
    // @ts-expect-error — defensive runtime check
    expect(looksLikeHtml(undefined)).toBe(false);
  });
});

describe('htmlToMarkdown', () => {
  it('strips <style> blocks entirely (the founder-facing failure mode)', () => {
    const html =
      '<section><style>.cover { display: flex; padding: 32px; }</style><h1>Vela</h1><p>Pitch.</p></section>';
    const md = htmlToMarkdown(html);
    expect(md).not.toContain('<style>');
    expect(md).not.toContain('display: flex');
    expect(md).not.toContain('padding');
    expect(md).toContain('Vela');
    expect(md).toContain('Pitch.');
  });

  it('strips HTML comments (composer signature, license headers, etc.)', () => {
    const html = '<!--baget-deck-html:{"accent":"#3c47ff"}--><section><h1>Vela</h1></section>';
    const md = htmlToMarkdown(html);
    expect(md).not.toContain('baget-deck-html');
    expect(md).not.toContain('#3c47ff');
    expect(md).toContain('Vela');
  });

  it('strips <script> blocks (defense-in-depth, even if the composer never emits them)', () => {
    const html = '<section><script>alert(1)</script><h1>Vela</h1></section>';
    const md = htmlToMarkdown(html);
    expect(md).not.toContain('<script>');
    expect(md).not.toContain('alert(1)');
    expect(md).toContain('Vela');
  });

  it('converts headings to ATX-style (# instead of underline)', () => {
    const md = htmlToMarkdown('<h1>Vela</h1><h2>Problem</h2>');
    expect(md).toContain('# Vela');
    expect(md).toContain('## Problem');
  });

  it('converts a real deck-shaped slide into chat-readable markdown', () => {
    const html = `<!--baget-deck-html:{"accent":"#3c47ff"}-->
<section class="baget-deck-slide" data-slide-type="cover">
  <style>.cover { padding: 80px; }</style>
  <h1>Vela</h1>
  <p>Connecting independent designers with local master makers.</p>
</section>
<section class="baget-deck-slide" data-slide-type="problem">
  <h2>Problem</h2>
  <ul>
    <li>Factories require 100+ unit minimums.</li>
    <li>Sourcing skilled artisans is opaque.</li>
  </ul>
</section>`;
    const md = htmlToMarkdown(html);
    // Chat-friendly: heading prose + bullets, no markup.
    expect(md).toContain('Vela');
    expect(md).toContain('Connecting independent designers');
    expect(md).toContain('Problem');
    expect(md).toContain('Factories require 100+ unit minimums');
    expect(md).toContain('Sourcing skilled artisans is opaque');
    // The CSS, the comment, and the section attributes all gone.
    expect(md).not.toContain('padding: 80px');
    expect(md).not.toContain('baget-deck-html');
    expect(md).not.toContain('data-slide-type');
    expect(md).not.toContain('<style>');
    // Final markdown shouldn't start or end with stray whitespace tag
    // residue (turndown sometimes leaves leading/trailing newlines from
    // stripped blocks; trim is fine for our purpose but the test pins
    // there's no orphan tag).
    expect(md).not.toMatch(/<\/?(section|style|script)/i);
  });
});
