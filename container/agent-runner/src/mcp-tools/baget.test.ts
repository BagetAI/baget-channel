/**
 * Tests for the baget MCP tools — focused on the document-handling
 * surface. The earlier hallucination of `baget_send_document_file`
 * (the model invented a tool that didn't exist) is now closed by
 * shipping a REAL `baget_send_document_file` tool plus the
 * `baget_read_document` tool that does inline quoting. The two-tool
 * split has to stay legible to the model — the description tests
 * below guard against silent regression of the discovery surface.
 *
 * Mocking strategy:
 *   - `globalThis.fetch` — intercepted in beforeEach and dispatched
 *     by URL substring so the multi-hop send_document_file flow
 *     (POST /render-pdf → GET blob) can return distinct payloads.
 *   - SQLite — `initTestSessionDb` spins an in-memory DB pair so
 *     `writeMessageOut` works without a real workspace mount.
 *   - Filesystem — `BAGET_WORKSPACE` points at a tmpdir so outbox
 *     writes land somewhere we can inspect and clean up.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { closeSessionDb, getInboundDb, getOutboundDb, initTestSessionDb } from '../db/connection.js';
import './baget.js'; // registers the tools as a side effect
import { getRegisteredToolByName, getRegisteredTools } from './server.js';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_TOKEN = process.env.BAGET_CHANNEL_TOKEN;
const ORIGINAL_COMPANY = process.env.BAGET_COMPANY_ID;
const ORIGINAL_BASE = process.env.BAGET_API_BASE_URL;
const ORIGINAL_WORKSPACE = process.env.BAGET_WORKSPACE;

interface FetchCall {
  url: string;
  method?: string;
  authHeader?: string | null;
}

/**
 * URL-keyed fetch dispatcher. Tests register response factories per URL
 * substring so the multi-hop send_document_file flow (one POST to
 * baget.ai's /render-pdf, one GET to a Vercel Blob URL) can return
 * distinct payloads without bespoke wiring per test.
 *
 * `defaultResponse` is what unrecognized URLs return — keep it a benign
 * 200 with an empty JSON body so a stray fetch doesn't cascade into a
 * confusing JSON-parse error and obscure the real assertion failure.
 */
let fetchCalls: FetchCall[] = [];
let routedResponses: Array<{ matches: (url: string) => boolean; respond: () => Response }> = [];
let defaultResponse: () => Response = () => new Response('{}', { status: 200 });

function setDefaultResponse(fn: () => Response): void {
  defaultResponse = fn;
}

function routeResponse(matches: (url: string) => boolean, respond: () => Response): void {
  routedResponses.push({ matches, respond });
}

function installFetchSpy(): void {
  fetchCalls = [];
  routedResponses = [];
  defaultResponse = () => new Response('{}', { status: 200 });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    fetchCalls.push({
      url,
      method: init?.method,
      authHeader: headers['Authorization'] ?? headers['authorization'] ?? null,
    });
    for (const route of routedResponses) {
      if (route.matches(url)) return route.respond();
    }
    return defaultResponse();
  }) as typeof fetch;
}

const tmpWorkspaces: string[] = [];

function setupWorkspace(): string {
  // The runner creates `<workspace>/outbox/<msgId>/` on demand via
  // recursive mkdir, so we only need a writable root here. Path layout
  // tracks `workspaceOutboxDir()` in workspace-paths.ts.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baget-mcp-test-'));
  tmpWorkspaces.push(dir);
  process.env.BAGET_WORKSPACE = dir;
  return dir;
}

beforeEach(() => {
  process.env.BAGET_CHANNEL_TOKEN = 'test-bearer-token';
  process.env.BAGET_COMPANY_ID = 'company-uuid-123';
  process.env.BAGET_API_BASE_URL = 'https://stg-app.baget.ai';
  installFetchSpy();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_TOKEN === undefined) delete process.env.BAGET_CHANNEL_TOKEN;
  else process.env.BAGET_CHANNEL_TOKEN = ORIGINAL_TOKEN;
  if (ORIGINAL_COMPANY === undefined) delete process.env.BAGET_COMPANY_ID;
  else process.env.BAGET_COMPANY_ID = ORIGINAL_COMPANY;
  if (ORIGINAL_BASE === undefined) delete process.env.BAGET_API_BASE_URL;
  else process.env.BAGET_API_BASE_URL = ORIGINAL_BASE;
  if (ORIGINAL_WORKSPACE === undefined) delete process.env.BAGET_WORKSPACE;
  else process.env.BAGET_WORKSPACE = ORIGINAL_WORKSPACE;

  // Cleanup any test DBs and tmpdirs.
  try {
    closeSessionDb();
  } catch {
    // Some tests don't open a DB — the close is a no-op.
  }
  for (const dir of tmpWorkspaces.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('baget_read_document tool registration', () => {
  it('is registered under the exact name the prompt references', () => {
    const tool = getRegisteredToolByName('baget_read_document');
    expect(tool).toBeDefined();
    expect(tool!.tool.name).toBe('baget_read_document');
  });

  it('description steers the model toward inline-quoting use cases and disambiguates from send_document_file', () => {
    // The two-tool split (read_document = inline quote, send_document_file
    // = real attachment) only works if the model can pick correctly from
    // the descriptions. read_document MUST highlight discuss/summarize/
    // quote semantics AND name send_document_file as the alternative —
    // otherwise the model will reach for read_document when the founder
    // wants the actual file (regression of the original hallucination).
    const tool = getRegisteredToolByName('baget_read_document');
    const description = tool!.tool.description ?? '';
    expect(description.toLowerCase()).toContain('quote');
    expect(description.toLowerCase()).toContain('summarize');
    expect(description.toLowerCase()).toContain('inline');
    expect(description).toContain('baget_send_document_file');
    expect(description).toContain('baget_list_documents');
  });

  // Sam 2026-05-07 Telegram regression (companion to the same assertion
  // in baget_list_documents above): read_document is the CHAT-NATIVE
  // DEFAULT for any bare "send me X" / "share X" / "give me X" request.
  // Before this fix the description only listed discuss/summarize
  // intents, so the LLM defaulted to send_document_file (PDF) for
  // delivery requests. Pin the new positive triggers.
  it('description claims the chat-native default for NON-DECK content + deck content-discussion', () => {
    // Sam 2026-05-07 Phase 2: read_document is NO LONGER the bare-
    // delivery default for DECKS — `baget_send_deck_visuals` ships
    // visual slide images for that intent. read_document is the
    // chat-native default for (a) bare delivery on non-deck docs
    // (BPs, brand guides, research) and (b) content-discussion on
    // ANY document including decks ("what's in the deck?", "summarize
    // the pitch"). Pin the new framing.
    const tool = getRegisteredToolByName('baget_read_document');
    const description = (tool!.tool.description ?? '').toLowerCase();
    expect(description).toContain('chat-native default');
    // Must steer DECK delivery requests to send_deck_visuals, not itself.
    expect(description).toContain('baget_send_deck_visuals');
    // Must keep content-discussion intents as positive triggers.
    expect(description).toMatch(/what'?s in|summarize|read me|positioning|content-discussion/i);
    // Must list at least one bare-delivery phrase for non-deck docs.
    expect(description).toMatch(/send me the bp|share the bp|give me the (bp|brand guide)/i);
  });

  it('declares documentId as a required uuid string', () => {
    const tool = getRegisteredToolByName('baget_read_document');
    const schema = tool!.tool.inputSchema as {
      properties: Record<string, { type: string; format?: string }>;
      required?: string[];
    };
    expect(schema.required).toEqual(['documentId']);
    expect(schema.properties.documentId?.type).toBe('string');
    expect(schema.properties.documentId?.format).toBe('uuid');
  });
});

describe('baget_list_documents description', () => {
  it('points the model at BOTH baget_read_document and baget_send_document_file as next steps', () => {
    // The list endpoint is the entry point — its description has to seed
    // the discovery surface for both follow-up tools, otherwise the model
    // either invents a tool name (the original hallucination) or gets
    // stuck on whichever tool happens to come first in the registered list.
    const tool = getRegisteredToolByName('baget_list_documents');
    const description = tool!.tool.description ?? '';
    expect(description).toContain('baget_read_document');
    expect(description).toContain('baget_send_document_file');
  });

  // Sam 2026-05-07 Telegram regression: bare "send me the pitch deck" was
  // returning a 9 KB PDF attachment because all three tool descriptions
  // (list / read / send) reinforced the same wrong default — file
  // attachment for any "send me X" intent. PDF on Telegram requires a
  // download, has no inline preview, and breaks the conversation flow.
  // The right chat-native default is `baget_read_document` (markdown
  // body inline). Pin the new routing in all three description tests so
  // a future prompt edit can't silently re-default to the file path.
  it('routes bare "send me X" intents to baget_read_document as the chat-native default', () => {
    const tool = getRegisteredToolByName('baget_list_documents');
    const description = (tool!.tool.description ?? '').toLowerCase();
    // The hint must spell out that bare delivery requests default to
    // read, not send-file. Use phrase fragments the LLM can pattern on.
    expect(description).toContain('chat-native default');
    expect(description).toContain('baget_read_document');
    expect(description).toContain('send me the deck');
    // The send_document_file tool MUST be gated on explicit format /
    // forward / save intent — the description should mention at least
    // one such trigger so the model learns the contrast.
    expect(description).toMatch(/as a pdf|the file|to forward|to save|attach the file/i);
  });
});

describe('baget_read_document handler', () => {
  it('GETs the per-document endpoint with bearer auth and returns the unwrapped document body', async () => {
    // Production response shape from baget.ai's GET /api/companies/:id/documents/:docId
    // is `{ document: { id, title, content, category, agentRole, agentName, cycle, createdAt } }`
    // — wrapped under `document`. The handler unwraps so the model gets just the
    // document object (Gemini medium on PR #12 — saves tokens in the agent's context).
    const docPayload = {
      document: {
        id: 'doc-uuid-456',
        title: 'Pitch Deck',
        category: 'pitch-deck',
        content: '# Vela\n\nFashion designer marketplace.\n\n## Problem\n\n…',
      },
    };
    setDefaultResponse(() => new Response(JSON.stringify(docPayload), { status: 200 }));

    const tool = getRegisteredToolByName('baget_read_document');
    const result = await tool!.handler({ documentId: 'doc-uuid-456' });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe('https://stg-app.baget.ai/api/companies/company-uuid-123/documents/doc-uuid-456');
    expect(fetchCalls[0].method).toBe('GET');
    expect(fetchCalls[0].authHeader).toBe('Bearer test-bearer-token');
    expect(result.isError).toBeUndefined();
    const text = (result.content[0] as { text: string }).text;
    // Body of the document is included...
    expect(text).toContain('Vela');
    expect(text).toContain('Fashion designer marketplace');
    expect(text).toContain('doc-uuid-456');
    // ...but the `document` envelope key is NOT — that's the unwrap working.
    const parsed = JSON.parse(text);
    expect(parsed).not.toHaveProperty('document');
    expect(parsed.id).toBe('doc-uuid-456');
    expect(parsed.title).toBe('Pitch Deck');
  });

  it('falls back to the raw payload when the upstream shape lacks a `document` key', async () => {
    // Defensive — if baget.ai ever changes the response shape we'd
    // rather surface the unfamiliar JSON than null it out.
    const flatPayload = { id: 'doc-uuid-789', title: 'Old Shape', content: 'Body.' };
    // Pre-existing typo fix (was `fetchResponse = …`, an undefined symbol
    // that crashed the test before it could assert). Use the helper the
    // rest of the file uses.
    setDefaultResponse(() => new Response(JSON.stringify(flatPayload), { status: 200 }));
    const tool = getRegisteredToolByName('baget_read_document');
    const result = await tool!.handler({ documentId: 'doc-uuid-789' });
    expect(result.isError).toBeUndefined();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('Old Shape');
    expect(text).toContain('doc-uuid-789');
  });

  it('URL-encodes the documentId so a hallucinated path traversal is neutralized', async () => {
    setDefaultResponse(() => new Response(JSON.stringify({ error: 'Not found' }), { status: 404 }));
    const tool = getRegisteredToolByName('baget_read_document');
    await tool!.handler({ documentId: '../other-tenant/secret' });
    expect(fetchCalls).toHaveLength(1);
    // `..` and `/` must be percent-encoded — never let them re-target the URL.
    expect(fetchCalls[0].url).not.toContain('/other-tenant/');
    expect(fetchCalls[0].url).toContain('%2F');
  });

  it('returns a structured error when documentId is missing', async () => {
    const tool = getRegisteredToolByName('baget_read_document');
    const result = await tool!.handler({});
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('documentId');
    expect(fetchCalls).toHaveLength(0);
  });

  it('returns a structured error when documentId is an empty string', async () => {
    const tool = getRegisteredToolByName('baget_read_document');
    const result = await tool!.handler({ documentId: '   ' });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('documentId');
    expect(fetchCalls).toHaveLength(0);
  });

  it('surfaces upstream errors instead of swallowing them', async () => {
    setDefaultResponse(() => new Response(JSON.stringify({ error: 'document not found' }), { status: 404 }));
    const tool = getRegisteredToolByName('baget_read_document');
    const result = await tool!.handler({ documentId: 'doc-uuid-missing' });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('read_document failed');
    expect(text).toContain('document not found');
  });

  // Sam 2026-05-07 Telegram smoke (PR #65): the deck doc body had been
  // regenerated as the new HTML deck format (HTML/CSS for visual
  // rendering on the dashboard). Without HTML→markdown conversion
  // here, the agent dutifully quoted the returned `content` inline
  // and the founder saw 1000+ lines of `<section>` / `<style>` / CSS
  // tokens in the chat. Pin the conversion at the handler level so
  // any future channel surface inherits clean markdown automatically.
  it('converts HTML-shaped content (deck composer output) to markdown before returning', async () => {
    const docPayload = {
      document: {
        id: 'doc-uuid-deck',
        title: 'Pitch Deck',
        category: 'deck',
        content: `<!--baget-deck-html:{"accent":"#3c47ff"}-->
<section class="baget-deck-slide" data-slide-type="cover">
  <style>.cover { padding: 80px; background: #f5f2ed; }</style>
  <h1>Vela</h1>
  <p>Connecting independent designers with local master makers.</p>
</section>
<section class="baget-deck-slide" data-slide-type="problem">
  <h2>Problem</h2>
  <ul>
    <li>Factories require 100+ unit minimums.</li>
    <li>Sourcing skilled artisans is opaque.</li>
  </ul>
</section>`,
      },
    };
    setDefaultResponse(() => new Response(JSON.stringify(docPayload), { status: 200 }));

    const tool = getRegisteredToolByName('baget_read_document');
    const result = await tool!.handler({ documentId: 'doc-uuid-deck' });

    expect(result.isError).toBeUndefined();
    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text) as { content: string };
    // Markdown content survives.
    expect(parsed.content).toContain('Vela');
    expect(parsed.content).toContain('Connecting independent designers');
    expect(parsed.content).toContain('Problem');
    expect(parsed.content).toContain('Factories require 100+ unit minimums');
    expect(parsed.content).toContain('Sourcing skilled artisans is opaque');
    // HTML/CSS noise stripped — the founder-facing failure mode.
    expect(parsed.content).not.toContain('<style>');
    expect(parsed.content).not.toContain('<section');
    expect(parsed.content).not.toContain('padding: 80px');
    expect(parsed.content).not.toContain('baget-deck-html');
    expect(parsed.content).not.toContain('data-slide-type');
  });

  it('passes plain-markdown content through unchanged (no double-conversion of BPs / brand guides)', async () => {
    // The looksLikeHtml gate must not fire on plain markdown — running
    // turndown on already-markdown content can subtly mangle escaping.
    // Pin the no-op behavior with a doc whose content is unmistakably
    // markdown.
    const md = '# Vela\n\nFashion designer marketplace.\n\n## Problem\n\n- Factories\n- Skilled artisans\n';
    const docPayload = {
      document: {
        id: 'doc-uuid-bp',
        title: 'Business Plan',
        category: 'business',
        content: md,
      },
    };
    setDefaultResponse(() => new Response(JSON.stringify(docPayload), { status: 200 }));

    const tool = getRegisteredToolByName('baget_read_document');
    const result = await tool!.handler({ documentId: 'doc-uuid-bp' });

    expect(result.isError).toBeUndefined();
    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text) as { content: string };
    expect(parsed.content).toBe(md);
  });

  it('errors clearly when the channel token is missing', async () => {
    delete process.env.BAGET_CHANNEL_TOKEN;
    const tool = getRegisteredToolByName('baget_read_document');
    const result = await tool!.handler({ documentId: 'doc-uuid-456' });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('BAGET_CHANNEL_TOKEN');
    expect(fetchCalls).toHaveLength(0);
  });

  it('errors clearly when the company id is missing', async () => {
    delete process.env.BAGET_COMPANY_ID;
    const tool = getRegisteredToolByName('baget_read_document');
    const result = await tool!.handler({ documentId: 'doc-uuid-456' });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('BAGET_COMPANY_ID');
    expect(fetchCalls).toHaveLength(0);
  });
});

// ── send_document_file ──────────────────────────────────────────────────────

const PDF_HEADER = Buffer.from('%PDF-1.4\n%test pdf bytes\n');
// Real Vercel Blob URLs look like
// `https://<store-id>.public.blob.vercel-storage.com/<path>` — the
// `.public.blob.vercel-storage.com` suffix is the SSRF allowlist anchor
// in baget.ts. Tests must use this exact suffix or the host check rejects.
const BLOB_URL =
  'https://test-store-abc.public.blob.vercel-storage.com/attachments/company-uuid-123/pitch-deck-1234567890.pdf';

/**
 * Wires up the test session DB (in-memory SQLite pair) and seeds a single
 * destination so `resolveRouting(undefined)` falls through to it. Returns
 * the destination tuple so tests can assert on it.
 *
 * The session_routing table isn't part of `initTestSessionDb`'s schema —
 * `getSessionRouting` swallows the missing-table error and returns nulls,
 * which triggers the destination-fallback branch in `resolveRouting`.
 * Seeding ONE destination is the smallest config that exercises the
 * production code path without ambiguity errors.
 */
function seedSingleDestination(): { channel_type: string; platform_id: string } {
  initTestSessionDb();
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('founder', 'Founder Telegram', 'channel', 'telegram', 'tg-chat-42', NULL)`,
    )
    .run();
  return { channel_type: 'telegram', platform_id: 'tg-chat-42' };
}

describe('baget_send_document_file tool registration', () => {
  it('is registered under the name the prompt now points at', () => {
    const tool = getRegisteredToolByName('baget_send_document_file');
    expect(tool).toBeDefined();
    expect(tool!.tool.name).toBe('baget_send_document_file');
  });

  it('description tells the model when to pick THIS over read_document — no regression of the original hallucination', () => {
    // The original bug was the model hallucinating this tool name when it
    // didn't exist. Now it exists; the failure mode shifts to the model
    // picking the WRONG document tool. The description has to lead with
    // the file-attachment intent so the founder's EXPLICIT-format request
    // ("send me the deck as a PDF") routes here.
    const tool = getRegisteredToolByName('baget_send_document_file');
    const description = tool!.tool.description ?? '';
    expect(description.toLowerCase()).toContain('file attachment');
    expect(description).toContain('baget_read_document');
    expect(description).toContain('baget_list_documents');
  });

  // Sam 2026-05-07 Telegram regression: bare "send me the pitch deck"
  // returned a 9 KB PDF. Root cause was three coordinated description
  // failures — list / read / send all listed bare delivery requests as
  // a send-file trigger. THIS tool's description must now narrow the
  // trigger to EXPLICIT format-or-forward intent, and must NOT reference
  // bare delivery phrases as triggers (per landmine #28: literal
  // negative examples reinforce the banned content; describe the shape,
  // not the phrase).
  it('triggers ONLY on explicit format / forward / save intent — no bare-delivery literal in the description', () => {
    const tool = getRegisteredToolByName('baget_send_document_file');
    const description = (tool!.tool.description ?? '').toLowerCase();
    // Must name the chat-native default by tool name + steer back to it
    // when the founder didn't specify a format.
    expect(description).toContain('chat-native default');
    expect(description).toContain('baget_read_document');
    // Must list at least one positive trigger from the explicit-format
    // family so the model learns the shape.
    expect(description).toMatch(/as a pdf|the file to forward|the pdf|attach the/i);
    // Must NOT contain the bare-delivery literal that previously misrouted
    // (landmine #28: "send me the deck" appearing anywhere in the
    // description — even in a NOT framing — increases its salience as a
    // trigger candidate). Read_document owns this phrase now.
    expect(description).not.toContain('send me the deck');
    expect(description).not.toContain('share the bp');
    expect(description).not.toContain('share the brand guide');
  });

  // Sam 2026-05-07 Phase 2: PR #64's "decks ALWAYS read_document" rule
  // is REVOKED — `baget_send_deck_visuals` now ships actual rendered
  // slide images for deck delivery. The send_document_file description
  // must redirect deck-delivery intent to send_deck_visuals (NOT
  // read_document like PR #64 did). Pin the new redirect.
  it('redirects deck-delivery intent to baget_send_deck_visuals (Phase 2 revokes PR #64 deck=read rule)', () => {
    const sendDescription = (getRegisteredToolByName('baget_send_document_file')!.tool.description ?? '').toLowerCase();
    expect(sendDescription).toContain('deck');
    // Steers DECK requests to send_deck_visuals, not read_document.
    expect(sendDescription).toContain('baget_send_deck_visuals');
    // Visual-rendering rationale (the why behind the redirect).
    expect(sendDescription).toMatch(/visual|slide image|slide images|rendered slide/i);
  });
});

// Sam 2026-05-07 Phase 2: the visual-deck-delivery rule MUST appear in
// all three coordinated descriptions (landmine #19 — layered prompts
// can't override a base; one-off rules get drowned out). Pin the rule's
// presence across the discovery surface.
describe('deck routing rule (Phase 2) is reinforced across all three document tools', () => {
  it.each([
    // Each tool must mention "deck" + steer deck-delivery to
    // send_deck_visuals. Note: send_deck_visuals doesn't need to point
    // at itself — that test covers list_documents + read_document +
    // send_document_file as the three OTHER tools that must route
    // decks correctly.
    ['baget_list_documents', /baget_send_deck_visuals/i],
    ['baget_read_document', /baget_send_deck_visuals/i],
    ['baget_send_document_file', /baget_send_deck_visuals/i],
  ])('%s description routes deck-delivery to baget_send_deck_visuals', (toolName, redirectMatcher) => {
    const description = (getRegisteredToolByName(toolName)!.tool.description ?? '').toLowerCase();
    expect(description).toContain('deck');
    expect(description).toMatch(redirectMatcher);
  });

  it('declares documentId as required uuid plus an optional caption text', () => {
    const tool = getRegisteredToolByName('baget_send_document_file');
    const schema = tool!.tool.inputSchema as {
      properties: Record<string, { type: string; format?: string; maxLength?: number }>;
      required?: string[];
    };
    expect(schema.required).toEqual(['documentId']);
    expect(schema.properties.documentId?.type).toBe('string');
    expect(schema.properties.documentId?.format).toBe('uuid');
    expect(schema.properties.text?.type).toBe('string');
    expect(typeof schema.properties.text?.maxLength).toBe('number');
  });
});

describe('baget_send_document_file handler — success path', () => {
  it('POSTs render-pdf, fetches the blob, writes the file to outbox, and enqueues a messages_out row', async () => {
    seedSingleDestination();
    const workspace = setupWorkspace();

    routeResponse(
      (url) => url.includes('/render-pdf'),
      () =>
        new Response(
          JSON.stringify({
            blobUrl: BLOB_URL,
            blobKey: 'attachments/company-uuid-123/pitch-deck-1234567890.pdf',
            filename: 'pitch-deck.pdf',
            mimeType: 'application/pdf',
          }),
          { status: 200 },
        ),
    );
    routeResponse(
      (url) => url === BLOB_URL,
      () => new Response(PDF_HEADER, { status: 200 }),
    );

    const tool = getRegisteredToolByName('baget_send_document_file');
    const result = await tool!.handler({ documentId: 'doc-uuid-456' });

    expect(result.isError).toBeUndefined();
    expect((result.content[0] as { text: string }).text).toContain('pitch-deck.pdf');

    // Two fetches: one POST to baget.ai with bearer, one GET to the blob (no auth needed).
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[0].url).toBe(
      'https://stg-app.baget.ai/api/companies/company-uuid-123/documents/doc-uuid-456/render-pdf',
    );
    expect(fetchCalls[0].method).toBe('POST');
    expect(fetchCalls[0].authHeader).toBe('Bearer test-bearer-token');
    expect(fetchCalls[1].url).toBe(BLOB_URL);

    // File staged on disk under the per-message outbox dir
    // (`<workspace>/outbox/<msgId>/<filename>` per workspace-paths.ts).
    const outboxRoot = path.join(workspace, 'outbox');
    const messageDirs = fs.readdirSync(outboxRoot);
    expect(messageDirs).toHaveLength(1);
    const stagedFile = path.join(outboxRoot, messageDirs[0], 'pitch-deck.pdf');
    expect(fs.existsSync(stagedFile)).toBe(true);
    expect(fs.readFileSync(stagedFile).equals(PDF_HEADER)).toBe(true);

    // messages_out row written with the destination routing + filename pointer.
    const rows = getOutboundDb().prepare('SELECT platform_id, channel_type, content FROM messages_out').all() as Array<{
      platform_id: string;
      channel_type: string;
      content: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].platform_id).toBe('tg-chat-42');
    expect(rows[0].channel_type).toBe('telegram');
    // Path-based attachments contract (PR #18 / OutboundAttachment) — the
    // ONLY contract the Telegram adapter's deliver() loop reads. Asserting
    // on this shape locks in the wire so a future regression to the
    // legacy `content.files` shape (which silently drops on Telegram)
    // surfaces here instead of in production.
    const content = JSON.parse(rows[0].content);
    expect(content.text).toBe('');
    expect(content.files).toBeUndefined();
    expect(content.attachments).toHaveLength(1);
    expect(content.attachments[0]).toMatchObject({
      kind: 'document',
      filename: 'pitch-deck.pdf',
    });
    // The path is absolute and points at the staged outbox file the
    // host process can read directly.
    expect(content.attachments[0].path).toBe(stagedFile);
  });

  it('rides the optional caption text WITH the attachment (not as a separate sendMessage)', async () => {
    // Telegram's sendDocument supports up to 1024 chars of caption that
    // renders as a single bubble with the file. Splitting into a
    // separate text bubble would make the founder see two messages
    // for one user-facing intent. Caption stays on the attachment;
    // outer `text` stays empty.
    seedSingleDestination();
    setupWorkspace();
    routeResponse(
      (url) => url.includes('/render-pdf'),
      () =>
        new Response(JSON.stringify({ blobUrl: BLOB_URL, filename: 'bp.pdf', mimeType: 'application/pdf' }), {
          status: 200,
        }),
    );
    routeResponse(
      (url) => url === BLOB_URL,
      () => new Response(PDF_HEADER, { status: 200 }),
    );

    const tool = getRegisteredToolByName('baget_send_document_file');
    await tool!.handler({
      documentId: 'doc-uuid-456',
      text: "Here's the BP — section 3 covers the moat.",
    });

    const rows = getOutboundDb().prepare('SELECT content FROM messages_out').all() as Array<{ content: string }>;
    const content = JSON.parse(rows[0].content);
    expect(content.text).toBe('');
    expect(content.attachments[0].caption).toBe("Here's the BP — section 3 covers the moat.");
  });

  it('omits caption when text arg is missing or whitespace-only', async () => {
    seedSingleDestination();
    setupWorkspace();
    routeResponse(
      (url) => url.includes('/render-pdf'),
      () =>
        new Response(JSON.stringify({ blobUrl: BLOB_URL, filename: 'bp.pdf', mimeType: 'application/pdf' }), {
          status: 200,
        }),
    );
    routeResponse(
      (url) => url === BLOB_URL,
      () => new Response(PDF_HEADER, { status: 200 }),
    );
    const tool = getRegisteredToolByName('baget_send_document_file');
    await tool!.handler({ documentId: 'doc-uuid-456', text: '   ' });
    const rows = getOutboundDb().prepare('SELECT content FROM messages_out').all() as Array<{ content: string }>;
    const content = JSON.parse(rows[0].content);
    expect(content.attachments[0].caption).toBeUndefined();
  });

  it('URL-encodes the documentId so a hallucinated path traversal is neutralized', async () => {
    seedSingleDestination();
    setupWorkspace();
    routeResponse(
      (url) => url.includes('/render-pdf'),
      () => new Response(JSON.stringify({ error: 'Not found' }), { status: 404 }),
    );
    const tool = getRegisteredToolByName('baget_send_document_file');
    await tool!.handler({ documentId: '../other-tenant/secret' });
    expect(fetchCalls[0].url).not.toContain('/other-tenant/');
    expect(fetchCalls[0].url).toContain('%2F');
  });
});

describe('baget_send_deck_visuals handler — success + failure mapping', () => {
  // The full chromium-render path can't be unit-tested (no binary in CI),
  // so these tests cover the route's RESPONSE-shape handling: 200 →
  // download + outbox emission, 413/422/404 → typed founder-readable
  // error, 500 → generic. Each of the typed errors maps to a different
  // founder-facing message string the agent surfaces verbatim.

  const SLIDE_BASE = 'https://test-store-abc.public.blob.vercel-storage.com/attachments/company-uuid-123/pitch-deck';
  const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

  it('downloads each slide PNG, stages them in one outbox dir, and emits ONE messages_out row with all attachments', async () => {
    seedSingleDestination();
    const workspace = setupWorkspace();

    routeResponse(
      (url) => url.includes('/render-slides'),
      () =>
        new Response(
          JSON.stringify({
            slides: [
              { index: 0, blobUrl: `${SLIDE_BASE}-1.png`, mimeType: 'image/png', width: 1920, height: 1080, slideType: 'cover' },
              { index: 1, blobUrl: `${SLIDE_BASE}-2.png`, mimeType: 'image/png', width: 1920, height: 1080, slideType: 'problem' },
              { index: 2, blobUrl: `${SLIDE_BASE}-3.png`, mimeType: 'image/png', width: 1920, height: 1080, slideType: null },
            ],
          }),
          { status: 200 },
        ),
    );
    // Each slide URL returns the PNG fixture.
    routeResponse(
      (url) => url.startsWith(SLIDE_BASE),
      () => new Response(PNG_BYTES, { status: 200 }),
    );

    const tool = getRegisteredToolByName('baget_send_deck_visuals');
    const result = await tool!.handler({ documentId: 'doc-uuid-deck', text: "Here's the deck — tap any slide." });
    expect(result.isError).toBeUndefined();
    expect((result.content[0] as { text: string }).text).toContain('3 slides');

    // 1 POST to render-slides + 3 GETs to the slide blobs = 4 fetches.
    expect(fetchCalls).toHaveLength(4);
    expect(fetchCalls[0].method).toBe('POST');
    expect(fetchCalls[0].url).toContain('/render-slides');
    expect(fetchCalls[0].authHeader).toBe('Bearer test-bearer-token');
    expect(fetchCalls[1].url).toBe(`${SLIDE_BASE}-1.png`);

    // All slides staged in ONE outbox dir.
    const outboxRoot = path.join(workspace, 'outbox');
    const messageDirs = fs.readdirSync(outboxRoot);
    expect(messageDirs).toHaveLength(1);
    const dirEntries = fs.readdirSync(path.join(outboxRoot, messageDirs[0]));
    expect(dirEntries.sort()).toEqual(['slide-1-cover.png', 'slide-2-problem.png', 'slide-3.png']);

    // ONE messages_out row with all 3 attachments — adapter loops and
    // ships each as a separate Telegram photo message.
    const rows = getOutboundDb().prepare('SELECT content FROM messages_out').all() as Array<{ content: string }>;
    expect(rows).toHaveLength(1);
    const content = JSON.parse(rows[0].content);
    expect(content.text).toBe('');
    expect(content.attachments).toHaveLength(3);
    expect(content.attachments.every((a: { kind: string }) => a.kind === 'photo')).toBe(true);
    // Caption rides ONLY on the first attachment (Telegram convention).
    expect(content.attachments[0].caption).toBe("Here's the deck — tap any slide.");
    expect(content.attachments[1].caption).toBeUndefined();
    expect(content.attachments[2].caption).toBeUndefined();
  });

  it('omits caption when text arg is empty / whitespace-only', async () => {
    seedSingleDestination();
    setupWorkspace();
    routeResponse(
      (url) => url.includes('/render-slides'),
      () =>
        new Response(
          JSON.stringify({
            slides: [
              { index: 0, blobUrl: `${SLIDE_BASE}-1.png`, mimeType: 'image/png', width: 1920, height: 1080, slideType: 'cover' },
            ],
          }),
          { status: 200 },
        ),
    );
    routeResponse(
      (url) => url.startsWith(SLIDE_BASE),
      () => new Response(PNG_BYTES, { status: 200 }),
    );
    const tool = getRegisteredToolByName('baget_send_deck_visuals');
    const result = await tool!.handler({ documentId: 'doc-uuid-deck', text: '   ' });
    expect(result.isError).toBeUndefined();
    const rows = getOutboundDb().prepare('SELECT content FROM messages_out').all() as Array<{ content: string }>;
    const content = JSON.parse(rows[0].content);
    expect(content.attachments[0].caption).toBeUndefined();
  });

  it('returns the friendly 413 message when the deck is too long', async () => {
    seedSingleDestination();
    setupWorkspace();
    routeResponse(
      (url) => url.includes('/render-slides'),
      () =>
        new Response(JSON.stringify({ error: 'deck-too-many-slides', count: 50, limit: 20 }), { status: 413 }),
    );
    const tool = getRegisteredToolByName('baget_send_deck_visuals');
    const result = await tool!.handler({ documentId: 'doc-uuid-toobig' });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/longer than I can ship/i);
    expect(text).toMatch(/dashboard/i);
  });

  it('returns the read_document fallback message when the doc is not a deck (422)', async () => {
    seedSingleDestination();
    setupWorkspace();
    routeResponse(
      (url) => url.includes('/render-slides'),
      () => new Response(JSON.stringify({ error: 'Document is not a deck' }), { status: 422 }),
    );
    const tool = getRegisteredToolByName('baget_send_deck_visuals');
    const result = await tool!.handler({ documentId: 'doc-uuid-bp' });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    // Must steer the agent at the right next-tool call so the founder
    // doesn't see a dead-end refusal.
    expect(text).toContain('baget_read_document');
  });

  it('returns the list_documents-refresh hint on 404', async () => {
    seedSingleDestination();
    setupWorkspace();
    routeResponse(
      (url) => url.includes('/render-slides'),
      () => new Response(JSON.stringify({ error: 'Document not found' }), { status: 404 }),
    );
    const tool = getRegisteredToolByName('baget_send_deck_visuals');
    const result = await tool!.handler({ documentId: 'doc-uuid-stale' });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('baget_list_documents');
  });

  it('refuses to fetch a slide URL outside the Vercel Blob domain (SSRF guard)', async () => {
    seedSingleDestination();
    setupWorkspace();
    routeResponse(
      (url) => url.includes('/render-slides'),
      () =>
        new Response(
          JSON.stringify({
            slides: [
              {
                index: 0,
                blobUrl: 'https://attacker.example.com/internal/aws-metadata',
                mimeType: 'image/png',
                width: 1920,
                height: 1080,
                slideType: null,
              },
            ],
          }),
          { status: 200 },
        ),
    );
    const tool = getRegisteredToolByName('baget_send_deck_visuals');
    const result = await tool!.handler({ documentId: 'doc-uuid-deck' });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/blob domain|attacker\.example\.com/i);
    // No slide fetch happened — the SSRF check fires BEFORE any blob GET.
    // Only the render-slides POST should be in fetchCalls.
    expect(fetchCalls.filter((c) => c.url.includes('attacker.example.com'))).toHaveLength(0);
  });
});

describe('baget_send_document_file handler — failure paths', () => {
  it('returns an error when documentId is missing', async () => {
    const tool = getRegisteredToolByName('baget_send_document_file');
    const result = await tool!.handler({});
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('documentId');
    expect(fetchCalls).toHaveLength(0);
  });

  it('surfaces upstream render-pdf errors instead of swallowing them', async () => {
    seedSingleDestination();
    setupWorkspace();
    routeResponse(
      (url) => url.includes('/render-pdf'),
      () => new Response(JSON.stringify({ error: 'Document has no content' }), { status: 422 }),
    );
    const tool = getRegisteredToolByName('baget_send_document_file');
    const result = await tool!.handler({ documentId: 'doc-uuid-empty' });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('send_document_file failed');
    expect(text).toContain('Document has no content');
    // Should NOT have attempted the blob fetch after render-pdf failed.
    expect(fetchCalls).toHaveLength(1);
  });

  it('errors when render-pdf returns a malformed response (no blobUrl)', async () => {
    seedSingleDestination();
    setupWorkspace();
    routeResponse(
      (url) => url.includes('/render-pdf'),
      () => new Response(JSON.stringify({ filename: 'pitch.pdf' }), { status: 200 }),
    );
    const tool = getRegisteredToolByName('baget_send_document_file');
    const result = await tool!.handler({ documentId: 'doc-uuid-456' });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('unexpected response');
    expect(fetchCalls).toHaveLength(1);
  });

  it('errors when the blob fetch fails (HTTP 500)', async () => {
    seedSingleDestination();
    setupWorkspace();
    routeResponse(
      (url) => url.includes('/render-pdf'),
      () => new Response(JSON.stringify({ blobUrl: BLOB_URL, filename: 'x.pdf' }), { status: 200 }),
    );
    routeResponse(
      (url) => url === BLOB_URL,
      () => new Response('upstream blob storage error', { status: 500 }),
    );
    const tool = getRegisteredToolByName('baget_send_document_file');
    const result = await tool!.handler({ documentId: 'doc-uuid-456' });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('500');
    // Render-pdf and blob fetch happened; nothing should be written to outbox/DB.
    expect(fetchCalls).toHaveLength(2);
  });

  it('errors when the bearer token is missing — no fetch attempted', async () => {
    delete process.env.BAGET_CHANNEL_TOKEN;
    const tool = getRegisteredToolByName('baget_send_document_file');
    const result = await tool!.handler({ documentId: 'doc-uuid-456' });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('BAGET_CHANNEL_TOKEN');
    expect(fetchCalls).toHaveLength(0);
  });

  it('errors when the company id is missing — no fetch attempted', async () => {
    delete process.env.BAGET_COMPANY_ID;
    const tool = getRegisteredToolByName('baget_send_document_file');
    const result = await tool!.handler({ documentId: 'doc-uuid-456' });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('BAGET_COMPANY_ID');
    expect(fetchCalls).toHaveLength(0);
  });
});

describe('baget_send_document_file handler — SSRF + filename hardening', () => {
  it('refuses to fetch a blobUrl outside the Vercel Blob domain (SSRF defense)', async () => {
    // If baget.ai were compromised, a malicious response could direct
    // the agent to fetch internal services (instance metadata, internal
    // RPC endpoints, etc.). Locking the destination host closes that
    // class entirely. The fetch must NEVER happen for a disallowed host.
    seedSingleDestination();
    setupWorkspace();
    routeResponse(
      (url) => url.includes('/render-pdf'),
      () =>
        new Response(
          JSON.stringify({
            blobUrl: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
            filename: 'pwned.pdf',
            mimeType: 'application/pdf',
          }),
          { status: 200 },
        ),
    );
    const tool = getRegisteredToolByName('baget_send_document_file');
    const result = await tool!.handler({ documentId: 'doc-uuid-456' });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('outside the allowed Vercel Blob domain');
    // Only the render-pdf POST should have fired; the agent must NOT
    // have attempted to reach the metadata IP.
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls.some((c) => c.url.includes('169.254.169.254'))).toBe(false);
  });

  it('refuses an http (non-https) blobUrl even on the allowed host', async () => {
    seedSingleDestination();
    setupWorkspace();
    routeResponse(
      (url) => url.includes('/render-pdf'),
      () =>
        new Response(
          JSON.stringify({
            blobUrl: 'http://test-store-abc.public.blob.vercel-storage.com/x.pdf',
            filename: 'x.pdf',
            mimeType: 'application/pdf',
          }),
          { status: 200 },
        ),
    );
    const tool = getRegisteredToolByName('baget_send_document_file');
    const result = await tool!.handler({ documentId: 'doc-uuid-456' });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('outside the allowed Vercel Blob domain');
    expect(fetchCalls).toHaveLength(1);
  });

  it('refuses a malformed blobUrl', async () => {
    seedSingleDestination();
    setupWorkspace();
    routeResponse(
      (url) => url.includes('/render-pdf'),
      () =>
        new Response(JSON.stringify({ blobUrl: 'not a url', filename: 'x.pdf', mimeType: 'application/pdf' }), {
          status: 200,
        }),
    );
    const tool = getRegisteredToolByName('baget_send_document_file');
    const result = await tool!.handler({ documentId: 'doc-uuid-456' });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('invalid blobUrl');
    expect(fetchCalls).toHaveLength(1);
  });

  it('strips path separators from the server-supplied filename (defense-in-depth)', async () => {
    // path.basename collapses `../../../etc/passwd` to `passwd`. Even if
    // the server's slugifier ever leaked separators, the file lands
    // inside the per-message outbox dir, not somewhere on the host fs.
    seedSingleDestination();
    const workspace = setupWorkspace();
    routeResponse(
      (url) => url.includes('/render-pdf'),
      () =>
        new Response(
          JSON.stringify({
            blobUrl: BLOB_URL,
            filename: '../../../etc/passwd',
            mimeType: 'application/pdf',
          }),
          { status: 200 },
        ),
    );
    routeResponse(
      (url) => url === BLOB_URL,
      () => new Response(PDF_HEADER, { status: 200 }),
    );
    const tool = getRegisteredToolByName('baget_send_document_file');
    const result = await tool!.handler({ documentId: 'doc-uuid-456' });
    expect(result.isError).toBeUndefined();
    // File must land under outbox/<msgId>/ — not at /etc/passwd.
    const outboxRoot = path.join(workspace, 'outbox');
    const messageDirs = fs.readdirSync(outboxRoot);
    expect(messageDirs).toHaveLength(1);
    expect(fs.existsSync(path.join(outboxRoot, messageDirs[0], 'passwd'))).toBe(true);
    // Sanity — nothing escaped the workspace.
    expect(fs.existsSync(path.join(workspace, '..', '..', '..', 'etc', 'passwd'))).toBe(false);
  });

  it('rejects a filename that path.basename collapses to empty / dot', async () => {
    // path.basename("/") === "" and path.basename("./") === "" — we
    // must reject before fs.writeFileSync attempts to write to the dir.
    for (const filename of ['/', './', '.', '..']) {
      seedSingleDestination();
      setupWorkspace();
      installFetchSpy(); // reset between iterations
      routeResponse(
        (url) => url.includes('/render-pdf'),
        () =>
          new Response(JSON.stringify({ blobUrl: BLOB_URL, filename, mimeType: 'application/pdf' }), { status: 200 }),
      );
      routeResponse(
        (url) => url === BLOB_URL,
        () => new Response(PDF_HEADER, { status: 200 }),
      );
      const tool = getRegisteredToolByName('baget_send_document_file');
      const result = await tool!.handler({ documentId: 'doc-uuid-456' });
      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toContain('unusable filename');
      closeSessionDb();
    }
  });

  it('rejects on Content-Length pre-check WITHOUT buffering (OOM defense)', async () => {
    // Codex P1 + Gemini security-medium on PR #13: arrayBuffer() would
    // allocate the entire body BEFORE our size check, so a malicious
    // multi-GB response could OOM the runner. The new code checks
    // Content-Length first and rejects immediately if oversized — no
    // bytes ever land in process memory.
    seedSingleDestination();
    setupWorkspace();
    routeResponse(
      (url) => url.includes('/render-pdf'),
      () =>
        new Response(JSON.stringify({ blobUrl: BLOB_URL, filename: 'huge.pdf', mimeType: 'application/pdf' }), {
          status: 200,
        }),
    );
    routeResponse(
      (url) => url === BLOB_URL,
      // Tiny body, but advertise a giant Content-Length — the
      // pre-check should reject without ever reading the body.
      () =>
        new Response('x', {
          status: 200,
          headers: { 'content-length': String(100 * 1024 * 1024) }, // 100 MB declared
        }),
    );
    const tool = getRegisteredToolByName('baget_send_document_file');
    const result = await tool!.handler({ documentId: 'doc-uuid-456' });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('100.0 MB');
    expect(text).toContain('chat-attachment limit');
    expect(fetchCalls).toHaveLength(2);
    const rows = getOutboundDb().prepare('SELECT id FROM messages_out').all();
    expect(rows).toHaveLength(0);
  });

  it('rejects mid-stream when Content-Length is missing and the body grows past the cap', async () => {
    // Defense for the case where the upstream omits Content-Length OR
    // lies (advertised < cap, actual >> cap). The streaming reader
    // accumulates bytes with a running total and aborts the moment
    // total > cap. Without this, an attacker could bypass the
    // Content-Length pre-check entirely.
    seedSingleDestination();
    setupWorkspace();
    routeResponse(
      (url) => url.includes('/render-pdf'),
      () =>
        new Response(JSON.stringify({ blobUrl: BLOB_URL, filename: 'huge.pdf', mimeType: 'application/pdf' }), {
          status: 200,
        }),
    );
    routeResponse(
      (url) => url === BLOB_URL,
      () => {
        // Build a streamed body with NO Content-Length header that
        // emits 5 chunks of 10 MB each = 50 MB > 45 MB cap.
        const chunkSize = 10 * 1024 * 1024;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            for (let i = 0; i < 5; i++) {
              controller.enqueue(new Uint8Array(chunkSize));
            }
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      },
    );
    const tool = getRegisteredToolByName('baget_send_document_file');
    const result = await tool!.handler({ documentId: 'doc-uuid-456' });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('over the');
    expect(text).toContain('chat-attachment limit');
    expect(fetchCalls).toHaveLength(2);
    const rows = getOutboundDb().prepare('SELECT id FROM messages_out').all();
    expect(rows).toHaveLength(0);
  });

  it('rejects a Buffer-shaped Response over the cap via Content-Length pre-check', async () => {
    // Sanity: a real response body (Buffer-backed) sets Content-Length
    // automatically, so the pre-check fires the same way as the
    // declared-but-lying case above. Belt-and-braces over the OOM
    // defense — and the most realistic shape of a too-large blob.
    seedSingleDestination();
    setupWorkspace();
    routeResponse(
      (url) => url.includes('/render-pdf'),
      () =>
        new Response(JSON.stringify({ blobUrl: BLOB_URL, filename: 'huge.pdf', mimeType: 'application/pdf' }), {
          status: 200,
        }),
    );
    routeResponse(
      (url) => url === BLOB_URL,
      () => new Response(Buffer.alloc(46 * 1024 * 1024), { status: 200 }),
    );
    const tool = getRegisteredToolByName('baget_send_document_file');
    const result = await tool!.handler({ documentId: 'doc-uuid-456' });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('chat-attachment limit');
    expect(fetchCalls).toHaveLength(2);
    const rows = getOutboundDb().prepare('SELECT id FROM messages_out').all();
    expect(rows).toHaveLength(0);
  });

  it('errors when /render-pdf returns an empty / non-JSON body (null-data guard)', async () => {
    // Gemini medium on PR #13: bagetFetch returns data: null on an
    // empty body or invalid JSON, even when ok: true. Without the
    // null check, the destructure throws an uncaught TypeError and
    // crashes the runner.
    seedSingleDestination();
    setupWorkspace();
    routeResponse(
      (url) => url.includes('/render-pdf'),
      // Empty body is valid HTTP but bagetFetch's JSON.parse fails →
      // result.data === null. This is the bug the test guards against.
      () => new Response('', { status: 200 }),
    );
    const tool = getRegisteredToolByName('baget_send_document_file');
    const result = await tool!.handler({ documentId: 'doc-uuid-456' });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('empty or non-JSON');
    expect(fetchCalls).toHaveLength(1);
  });
});

// ── baget_get_credits ────────────────────────────────────────────────────────

describe('baget_get_credits tool registration', () => {
  it('is registered under the exact name the prompt references', () => {
    // The chat agent's prompt instructs it to call this tool BEFORE
    // answering any credits question, so the name has to match exactly.
    // Drift here = silent regression to the hallucination behavior the
    // tool was added to fix ("you have unlimited credits, Samuel").
    const tool = getRegisteredToolByName('baget_get_credits');
    expect(tool).toBeDefined();
    expect(tool!.tool.name).toBe('baget_get_credits');
  });

  it("description steers the model to use it for any credit/balance question", () => {
    // The whole point of this tool is to short-circuit the model's
    // tendency to fabricate or deflect on credit questions. The
    // description has to make the use case unambiguous so the model
    // picks it over the (much-shorter, much-tempting) "I don't know"
    // fallback.
    //
    // We assert the SPECIFIC phrasings that route the model — not just
    // single keywords — because a copy edit that softens "NEVER
    // hallucinate" → "do not invent" or strips an example phrase
    // would silently regress the anti-hallucination intent. Per the
    // QA reviewer's "brittle prompt-string test" finding, anchoring
    // on example phrases is more meaningful than single words.
    const tool = getRegisteredToolByName('baget_get_credits');
    const description = tool!.tool.description ?? '';
    expect(description.toLowerCase()).toContain('credit');
    expect(description.toLowerCase()).toContain('balance');
    // Anti-hallucination imperative — keep this exact phrase strong.
    expect(description.toLowerCase()).toContain('never hallucinate');
    // High-signal example phrases the model uses to route here.
    expect(description.toLowerCase()).toContain('how much do i have');
  });

  it('takes no arguments (the company is implicit from BAGET_COMPANY_ID)', () => {
    const tool = getRegisteredToolByName('baget_get_credits');
    const schema = tool!.tool.inputSchema as {
      properties: Record<string, unknown>;
      required?: string[];
      additionalProperties?: boolean;
    };
    expect(schema.properties).toEqual({});
    expect(schema.required ?? []).toEqual([]);
    expect(schema.additionalProperties).toBe(false);
  });
});

describe('baget_get_credits handler', () => {
  it('GETs /credits with bearer auth and returns the JSON-stringified payload', async () => {
    const creditsPayload = {
      totalCredits: 6_740,
      breakdown: {
        dailyCredits: 40,
        treasuryCredits: 5_500,
        purchasedCredits: 1_200,
      },
      planTier: 'atelier',
    };
    setDefaultResponse(() => new Response(JSON.stringify(creditsPayload), { status: 200 }));

    const tool = getRegisteredToolByName('baget_get_credits');
    const result = await tool!.handler({});

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe('https://stg-app.baget.ai/api/companies/company-uuid-123/credits');
    expect(fetchCalls[0].method).toBe('GET');
    expect(fetchCalls[0].authHeader).toBe('Bearer test-bearer-token');
    expect(result.isError).toBeUndefined();
    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.totalCredits).toBe(6_740);
    expect(parsed.planTier).toBe('atelier');
    expect(parsed.breakdown.dailyCredits).toBe(40);
  });

  it('surfaces upstream HTTP errors with a tool-prefixed message', async () => {
    setDefaultResponse(
      () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
    );
    const tool = getRegisteredToolByName('baget_get_credits');
    const result = await tool!.handler({});
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('get_credits failed');
  });

  it('errors cleanly when BAGET_COMPANY_ID is missing (no fetch fired)', async () => {
    delete process.env.BAGET_COMPANY_ID;
    const tool = getRegisteredToolByName('baget_get_credits');
    const result = await tool!.handler({});
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('BAGET_COMPANY_ID');
    expect(fetchCalls).toHaveLength(0);
  });
});

// ── baget_list_recent_activity ───────────────────────────────────────────────

describe('baget_list_recent_activity tool registration', () => {
  it('is registered under the exact name the prompt references', () => {
    const tool = getRegisteredToolByName('baget_list_recent_activity');
    expect(tool).toBeDefined();
    expect(tool!.tool.name).toBe('baget_list_recent_activity');
  });

  it('description steers the model toward "what did the team do" questions', () => {
    // Same brittle-substring concern as baget_get_credits — anchor on
    // example phrases plus the imperative anti-hallucination phrasing
    // so a copy edit can't quietly weaken either signal.
    const tool = getRegisteredToolByName('baget_list_recent_activity');
    const description = tool!.tool.description ?? '';
    expect(description.toLowerCase()).toContain('activity');
    // Anti-hallucination imperative — keep the exact phrase that tells
    // the model not to invent activity when the feed is empty.
    expect(description.toLowerCase()).toContain('never make up');
    // High-signal example phrases used to route here.
    expect(description.toLowerCase()).toContain('what did the team ship');
  });

  it('takes no arguments', () => {
    const tool = getRegisteredToolByName('baget_list_recent_activity');
    const schema = tool!.tool.inputSchema as {
      properties: Record<string, unknown>;
      required?: string[];
      additionalProperties?: boolean;
    };
    expect(schema.properties).toEqual({});
    expect(schema.required ?? []).toEqual([]);
    expect(schema.additionalProperties).toBe(false);
  });
});

describe('baget_list_recent_activity handler', () => {
  it('GETs /recent-activity with bearer auth and returns the unwrapped activity array', async () => {
    // Production response shape from baget.ai's GET /api/companies/:id/recent-activity
    // is `{ activity: [...] }` — wrapped under `activity`. The handler unwraps so the
    // model gets just the array, mirroring `baget_read_document`'s `{ document }`
    // unwrap pattern. Saves tokens in the agent's context window.
    const activityPayload = {
      activity: [
        {
          id: 'act-1',
          type: 'task-completed',
          message: 'Drafted hero copy',
          agentRole: 'marketing',
          createdAt: '2026-05-04T12:00:00.000Z',
        },
        {
          id: 'act-2',
          type: 'milestone-hit',
          message: 'First 100 signups',
          agentRole: null,
          createdAt: '2026-05-04T08:00:00.000Z',
        },
      ],
    };
    setDefaultResponse(() => new Response(JSON.stringify(activityPayload), { status: 200 }));

    const tool = getRegisteredToolByName('baget_list_recent_activity');
    const result = await tool!.handler({});

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(
      'https://stg-app.baget.ai/api/companies/company-uuid-123/recent-activity',
    );
    expect(fetchCalls[0].method).toBe('GET');
    expect(fetchCalls[0].authHeader).toBe('Bearer test-bearer-token');
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    // Unwrapped: parsed should be the activity array directly, NOT { activity: [...] }
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].id).toBe('act-1');
    // Sanity: the `activity` envelope key is NOT in the response.
    expect(parsed).not.toHaveProperty('activity');
  });

  it('falls back to the raw payload when the upstream shape lacks an `activity` key', async () => {
    // Defensive parity with baget_read_document — if baget.ai ever
    // changes the response shape we'd rather surface unfamiliar JSON
    // than null it out.
    const flatPayload = [{ id: 'a-1', type: 'task-completed' }];
    setDefaultResponse(() => new Response(JSON.stringify(flatPayload), { status: 200 }));
    const tool = getRegisteredToolByName('baget_list_recent_activity');
    const result = await tool!.handler({});
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed).toEqual(flatPayload);
  });

  it('surfaces upstream HTTP errors with a tool-prefixed message', async () => {
    setDefaultResponse(
      () => new Response(JSON.stringify({ error: 'company-mismatch' }), { status: 403 }),
    );
    const tool = getRegisteredToolByName('baget_list_recent_activity');
    const result = await tool!.handler({});
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('list_recent_activity failed');
  });

  it('errors cleanly when BAGET_COMPANY_ID is missing (no fetch fired)', async () => {
    delete process.env.BAGET_COMPANY_ID;
    const tool = getRegisteredToolByName('baget_list_recent_activity');
    const result = await tool!.handler({});
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('BAGET_COMPANY_ID');
    expect(fetchCalls).toHaveLength(0);
  });
});

// ── baget_generate_image ────────────────────────────────────────────────────

interface ImageGenCall {
  model: string;
  prompt: string;
  aspectRatio?: string;
}

function mockImageClient(opts: { bytes?: Buffer; mimeType?: string; noImages?: boolean; throwError?: Error }): {
  client: ImageGenClient;
  calls: ImageGenCall[];
} {
  const calls: ImageGenCall[] = [];
  const client: ImageGenClient = {
    models: {
      async generateImages(args) {
        calls.push({ model: args.model, prompt: args.prompt, aspectRatio: args.config?.aspectRatio });
        if (opts.throwError) throw opts.throwError;
        if (opts.noImages) return { generatedImages: [] };
        return {
          generatedImages: [
            {
              image: {
                imageBytes: (opts.bytes ?? Buffer.from('fake-png')).toString('base64'),
                mimeType: opts.mimeType ?? 'image/png',
              },
            },
          ],
        };
      },
    },
  };
  return { client, calls };
}

describe('baget_generate_image registration + description', () => {
  it('is registered under the name the prompt now points at', () => {
    const tool = getRegisteredToolByName('baget_generate_image');
    expect(tool).toBeDefined();
    expect(tool!.tool.name).toBe('baget_generate_image');
  });

  it('description leads with the founder verbs (logo / mockup / illustration)', () => {
    // The model picks this tool by recognizing intent in the
    // founder's phrasing. The description has to lead with the
    // exact verbs / framings the founder will use, not with the
    // implementation detail (Imagen / Gemini).
    const tool = getRegisteredToolByName('baget_generate_image');
    const description = (tool!.tool.description ?? '').toLowerCase();
    expect(description).toContain('logo');
    expect(description).toContain('mockup');
    expect(description).toContain('illustration');
    expect(description).toContain('image');
  });

  it('declares prompt required, aspectRatio enum, optional caption', () => {
    const tool = getRegisteredToolByName('baget_generate_image');
    const schema = tool!.tool.inputSchema as {
      properties: Record<string, { type: string; enum?: string[]; maxLength?: number }>;
      required?: string[];
    };
    expect(schema.required).toEqual(['prompt']);
    expect(schema.properties.prompt?.type).toBe('string');
    expect(schema.properties.aspectRatio?.enum).toEqual(['1:1', '3:4', '4:3', '9:16', '16:9']);
    expect(schema.properties.text?.type).toBe('string');
  });
});

describe('baget_generate_image handler — success path', () => {
  beforeEach(() => {
    // Reset the module-level client between tests so a stub from
    // an earlier test doesn't leak.
    _setImageGenDeps({});
  });

  it('calls Gemini, stages the image, and writes a photo attachment row', async () => {
    seedSingleDestination();
    const workspace = setupWorkspace();
    const fakeBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]);
    const { client, calls } = mockImageClient({ bytes: fakeBytes });
    _setImageGenDeps({ client });

    const tool = getRegisteredToolByName('baget_generate_image');
    const result = await tool!.handler({
      prompt: 'minimalist Vela logo, monochrome, vector style',
      aspectRatio: '1:1',
    });

    expect(result.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toBe('minimalist Vela logo, monochrome, vector style');
    expect(calls[0].aspectRatio).toBe('1:1');
    expect(calls[0].model).toBe('imagen-3.0-generate-002');

    // File staged under outbox/<msgId>/<slug>.png with the actual bytes.
    const outboxRoot = path.join(workspace, 'outbox');
    const messageDirs = fs.readdirSync(outboxRoot);
    expect(messageDirs).toHaveLength(1);
    const stagedFiles = fs.readdirSync(path.join(outboxRoot, messageDirs[0]));
    expect(stagedFiles).toHaveLength(1);
    expect(stagedFiles[0]).toMatch(/^minimalist-vela-logo-monochrome-vector-style\.png$/);
    expect(fs.readFileSync(path.join(outboxRoot, messageDirs[0], stagedFiles[0])).equals(fakeBytes)).toBe(true);

    // messages_out row written with photo (NOT document) attachment.
    const rows = getOutboundDb().prepare('SELECT platform_id, channel_type, content FROM messages_out').all() as Array<{
      platform_id: string;
      channel_type: string;
      content: string;
    }>;
    expect(rows).toHaveLength(1);
    const content = JSON.parse(rows[0].content);
    expect(content.text).toBe('');
    expect(content.attachments).toHaveLength(1);
    expect(content.attachments[0].kind).toBe('photo');
    expect(content.attachments[0].path).toContain('outbox');
    expect(content.attachments[0].path.endsWith('.png')).toBe(true);
  });

  it('honors a non-default aspectRatio (e.g., 9:16 for story / portrait)', async () => {
    seedSingleDestination();
    setupWorkspace();
    const { client, calls } = mockImageClient({});
    _setImageGenDeps({ client });

    const tool = getRegisteredToolByName('baget_generate_image');
    await tool!.handler({ prompt: 'Vela hero portrait', aspectRatio: '9:16' });

    expect(calls[0].aspectRatio).toBe('9:16');
  });

  it('rides the optional caption WITH the photo (not as a separate sendMessage)', async () => {
    seedSingleDestination();
    setupWorkspace();
    const { client } = mockImageClient({});
    _setImageGenDeps({ client });

    const tool = getRegisteredToolByName('baget_generate_image');
    await tool!.handler({
      prompt: 'minimalist logo',
      text: 'Quick mockup — what do you think?',
    });

    const rows = getOutboundDb().prepare('SELECT content FROM messages_out').all() as Array<{ content: string }>;
    const content = JSON.parse(rows[0].content);
    expect(content.text).toBe('');
    expect(content.attachments[0].caption).toBe('Quick mockup — what do you think?');
  });

  it('omits caption when text arg is whitespace-only', async () => {
    seedSingleDestination();
    setupWorkspace();
    const { client } = mockImageClient({});
    _setImageGenDeps({ client });

    const tool = getRegisteredToolByName('baget_generate_image');
    await tool!.handler({ prompt: 'logo', text: '   ' });
    const rows = getOutboundDb().prepare('SELECT content FROM messages_out').all() as Array<{ content: string }>;
    const content = JSON.parse(rows[0].content);
    expect(content.attachments[0].caption).toBeUndefined();
  });

  it('uses .jpg extension when Gemini returns image/jpeg (mimeType-driven)', async () => {
    seedSingleDestination();
    const workspace = setupWorkspace();
    const { client } = mockImageClient({ mimeType: 'image/jpeg' });
    _setImageGenDeps({ client });

    const tool = getRegisteredToolByName('baget_generate_image');
    await tool!.handler({ prompt: 'mockup' });
    const messageDirs = fs.readdirSync(path.join(workspace, 'outbox'));
    const filename = fs.readdirSync(path.join(workspace, 'outbox', messageDirs[0]))[0];
    expect(filename.endsWith('.jpg')).toBe(true);
  });
});

describe('baget_generate_image handler — failure paths', () => {
  beforeEach(() => {
    _setImageGenDeps({});
  });

  it('errors when prompt is missing — no Gemini call', async () => {
    const { client, calls } = mockImageClient({});
    _setImageGenDeps({ client });

    const tool = getRegisteredToolByName('baget_generate_image');
    const result = await tool!.handler({});
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("surfaces Gemini's safety-refusal as a friendly 'try rewording' error", async () => {
    seedSingleDestination();
    setupWorkspace();
    const { client } = mockImageClient({ noImages: true });
    _setImageGenDeps({ client });

    const tool = getRegisteredToolByName('baget_generate_image');
    const result = await tool!.handler({ prompt: 'a real person' });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('reword');
    // No outbox file or DB row when generation refused.
    const rows = getOutboundDb().prepare('SELECT id FROM messages_out').all();
    expect(rows).toHaveLength(0);
  });

  it('surfaces upstream errors (e.g., quota / network) without crashing', async () => {
    seedSingleDestination();
    setupWorkspace();
    const { client } = mockImageClient({ throwError: new Error('429 quota exceeded') });
    _setImageGenDeps({ client });

    const tool = getRegisteredToolByName('baget_generate_image');
    const result = await tool!.handler({ prompt: 'logo' });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('429 quota exceeded');
    // Generation failed BEFORE any I/O — no outbox dir created.
    const rows = getOutboundDb().prepare('SELECT id FROM messages_out').all();
    expect(rows).toHaveLength(0);
  });
});

describe('baget_send_deck_visuals tool registration', () => {
  it('is registered under the name the prompts now point at', () => {
    const tool = getRegisteredToolByName('baget_send_deck_visuals');
    expect(tool).toBeDefined();
    expect(tool!.tool.name).toBe('baget_send_deck_visuals');
  });

  it('description claims chat-native default for deck delivery, with positive trigger phrases', () => {
    // Sam 2026-05-07 Phase 2: this tool is the new chat-native default
    // for any DECK-delivery request on Telegram. The description must
    // (a) name the chat-native default explicitly, (b) list bare-
    // delivery triggers as POSITIVE (per landmine #21 additive framing
    // + landmine #28 no negative literals), (c) carve out the content-
    // discussion path back to baget_read_document so the LLM picks the
    // right tool when the founder asks about CONTENTS not DELIVERY.
    const tool = getRegisteredToolByName('baget_send_deck_visuals');
    const description = (tool!.tool.description ?? '').toLowerCase();
    expect(description).toContain('chat-native default');
    expect(description).toContain('deck');
    // Bare-delivery family — triggers we WANT the model to pattern on.
    expect(description).toMatch(/send me the deck|share the pitch|give me the deck|show me the slides/i);
    // Carve-out: content-discussion still goes to read_document.
    expect(description).toContain('baget_read_document');
    expect(description).toMatch(/what'?s in|summarize|content[-\s]?discuss|read me/i);
    // Discoverability: the model must know to call list_documents
    // first to resolve a name to a documentId.
    expect(description).toContain('baget_list_documents');
  });

  it('declares documentId required uuid + optional caption text with sane cap', () => {
    const tool = getRegisteredToolByName('baget_send_deck_visuals');
    const schema = tool!.tool.inputSchema as {
      properties: Record<string, { type: string; format?: string; maxLength?: number }>;
      required?: string[];
    };
    expect(schema.required).toEqual(['documentId']);
    expect(schema.properties.documentId?.type).toBe('string');
    expect(schema.properties.documentId?.format).toBe('uuid');
    expect(schema.properties.text?.type).toBe('string');
    expect(typeof schema.properties.text?.maxLength).toBe('number');
    // Caption cap: ≤500 chars (Telegram caption limit is 1024 but we
    // leave headroom for emoji + persona prefix).
    expect(schema.properties.text!.maxLength!).toBeLessThanOrEqual(500);
  });
});

describe('tool description hygiene — no literal env-var or template-placeholder leakage', () => {
  // Sam 2026-05-07: `baget_send_document_file` description literally
  // contained the string `BAGET_API_BASE_URL/dashboard/<companyId>/
  // documents` as a "placeholder" the prompt author meant to be
  // substituted. Models are obedient; Pauline pasted the unresolved
  // placeholder verbatim into a Telegram reply ("the dashboard at
  // BAGET_API_BASE_URL/dashboard/3ed5553c-…/documents …"). The class
  // of bug: any tool description that quotes an env-var name or
  // angle-bracket template variable expects the LLM to do a
  // substitution it cannot do. Pin the class so the next prompt edit
  // doesn't reopen it.
  const FORBIDDEN_LITERALS = [
    // Common env-var names that have shown up unsubstituted before.
    'BAGET_API_BASE_URL',
    'BAGET_PUBLIC_APP_URL',
    'BAGET_CHANNEL_TOKEN',
    'BAGET_ADMIN_TOKEN',
    'BAGET_COMPANY_ID',
    'BAGET_USER_ID',
    'BAGET_AGENT_GROUP_ID',
    'BAGET_WORKSPACE',
    'process.env.',
    // Angle-bracket placeholders meant to be substituted at runtime.
    // (Tool input-schema descriptions legitimately use these for
    // documenting a parameter shape — but tool top-level descriptions
    // shouldn't, because the LLM has no context that they need
    // substitution before quoting back.)
    '<companyId>',
    '<company_id>',
    '<userId>',
    '<user_id>',
    '<agentGroupId>',
    '<agent_group_id>',
    '${',
  ];

  for (const literal of FORBIDDEN_LITERALS) {
    it(`no top-level tool description contains the forbidden literal "${literal}"`, () => {
      const offenders = getRegisteredTools()
        .filter((t) => (t.tool.description ?? '').includes(literal))
        .map((t) => t.tool.name);
      expect(offenders).toEqual([]);
    });
  }
});
