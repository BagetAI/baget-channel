/**
 * Unit tests for the image-gen helper. The module is pure — no fs, no
 * DB, no destination resolution — so all the I/O surface to mock is
 * the Gemini client. Tests inject a stub via `GenerateImageDeps.client`.
 *
 * The MCP tool wrapper in baget.ts that consumes these bytes is tested
 * separately in baget.test.ts (which exercises the outbox + messages_out
 * flow with the same client stub).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { generateImageBytes, type ImageGenClient } from './image-gen.js';

const ORIGINAL_API_KEY = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
const ORIGINAL_AI_KEY = process.env.GOOGLE_AI_API_KEY;
const ORIGINAL_GEMINI_KEY = process.env.GEMINI_API_KEY;
const ORIGINAL_MODEL = process.env.BAGET_IMAGE_MODEL;

beforeEach(() => {
  // Clean slate — let each test set what it needs.
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  delete process.env.GOOGLE_AI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.BAGET_IMAGE_MODEL;
});

afterEach(() => {
  if (ORIGINAL_API_KEY === undefined) delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  else process.env.GOOGLE_GENERATIVE_AI_API_KEY = ORIGINAL_API_KEY;
  if (ORIGINAL_AI_KEY === undefined) delete process.env.GOOGLE_AI_API_KEY;
  else process.env.GOOGLE_AI_API_KEY = ORIGINAL_AI_KEY;
  if (ORIGINAL_GEMINI_KEY === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = ORIGINAL_GEMINI_KEY;
  if (ORIGINAL_MODEL === undefined) delete process.env.BAGET_IMAGE_MODEL;
  else process.env.BAGET_IMAGE_MODEL = ORIGINAL_MODEL;
});

interface CapturedCall {
  model: string;
  prompt: string;
  config?: {
    numberOfImages?: number;
    aspectRatio?: string;
    outputMimeType?: string;
  };
}

function makeClient(opts: { imageBytesBase64?: string; mimeType?: string; noImages?: boolean; throwError?: Error }): {
  client: ImageGenClient;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const client: ImageGenClient = {
    models: {
      async generateImages(args) {
        calls.push({ model: args.model, prompt: args.prompt, config: args.config });
        if (opts.throwError) throw opts.throwError;
        if (opts.noImages) return { generatedImages: [] };
        return {
          generatedImages: [
            {
              image: {
                imageBytes: opts.imageBytesBase64 ?? Buffer.from('fake-png-bytes').toString('base64'),
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

describe('generateImageBytes — happy path', () => {
  it('returns decoded image bytes + mime type when Gemini returns an image', async () => {
    const { client, calls } = makeClient({
      imageBytesBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64'),
    });
    const result = await generateImageBytes({ prompt: 'a minimalist Vela logo' }, { client });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.bytes).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(result.mimeType).toBe('image/png');
    // Default config: 1 image, 1:1 aspect, png.
    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toBe('a minimalist Vela logo');
    expect(calls[0].config?.numberOfImages).toBe(1);
    expect(calls[0].config?.aspectRatio).toBe('1:1');
    expect(calls[0].config?.outputMimeType).toBe('image/png');
  });

  it('passes through the requested aspectRatio when valid', async () => {
    const { client, calls } = makeClient({});
    await generateImageBytes({ prompt: 'pitch slide cover', aspectRatio: '16:9' }, { client });
    expect(calls[0].config?.aspectRatio).toBe('16:9');
  });

  it('uses the default Imagen model when no override', async () => {
    const { client, calls } = makeClient({});
    await generateImageBytes({ prompt: 'test' }, { client });
    expect(calls[0].model).toBe('imagen-3.0-generate-002');
  });

  it('honors BAGET_IMAGE_MODEL env override', async () => {
    process.env.BAGET_IMAGE_MODEL = 'imagen-4.0-generate-001';
    const { client, calls } = makeClient({});
    await generateImageBytes({ prompt: 'test' }, { client });
    expect(calls[0].model).toBe('imagen-4.0-generate-001');
  });

  it('honors per-call model option (overrides env)', async () => {
    process.env.BAGET_IMAGE_MODEL = 'env-model';
    const { client, calls } = makeClient({});
    await generateImageBytes({ prompt: 'test', model: 'explicit-model' }, { client });
    expect(calls[0].model).toBe('explicit-model');
  });
});

describe('generateImageBytes — input validation', () => {
  it('rejects an empty / whitespace prompt', async () => {
    const { client } = makeClient({});
    expect((await generateImageBytes({ prompt: '' }, { client })).ok).toBe(false);
    expect((await generateImageBytes({ prompt: '   ' }, { client })).ok).toBe(false);
  });

  it('rejects a prompt over 2000 chars (Imagen limit)', async () => {
    const { client } = makeClient({});
    const result = await generateImageBytes({ prompt: 'a'.repeat(2001) }, { client });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('too long');
  });

  it('rejects an unsupported aspectRatio', async () => {
    const { client } = makeClient({});
    const result = await generateImageBytes({ prompt: 'test', aspectRatio: '21:9' as never }, { client });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('aspectRatio');
  });
});

describe('generateImageBytes — failure paths', () => {
  it('returns a friendly error when Gemini throws', async () => {
    const { client } = makeClient({ throwError: new Error('429 quota exceeded') });
    const result = await generateImageBytes({ prompt: 'test' }, { client });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('429 quota exceeded');
  });

  it('returns a friendly error when Gemini returns no images (model refusal / safety filter)', async () => {
    const { client } = makeClient({ noImages: true });
    const result = await generateImageBytes({ prompt: 'test' }, { client });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('no image bytes');
    expect(result.error).toContain('reword');
  });

  it('returns a friendly error when image bytes are present but empty (zero-length)', async () => {
    const { client } = makeClient({ imageBytesBase64: '' });
    const result = await generateImageBytes({ prompt: 'test' }, { client });
    expect(result.ok).toBe(false);
  });

  it('returns a friendly error when no API key in env AND no client injected', async () => {
    // No env vars set (beforeEach cleared them); no client passed.
    const result = await generateImageBytes({ prompt: 'test' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('No Gemini API key');
  });

  it('builds a default Gemini client from env when no client injected and key is present', async () => {
    // We can't easily prove the SDK was constructed without spinning
    // up a real network call, so just assert the no-key error path
    // is gone when the key IS set. The constructor is lazy enough
    // that calling generateImages with a fake key throws a network
    // error (caught by the SDK), which surfaces as ok:false with a
    // 'threw' message — that's the non-key-error signal we look for.
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'AIza-fake-key-for-test';
    const result = await generateImageBytes({ prompt: 'test' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    // NOT the no-key error — we got past key resolution into the SDK.
    expect(result.error).not.toContain('No Gemini API key');
  });
});
