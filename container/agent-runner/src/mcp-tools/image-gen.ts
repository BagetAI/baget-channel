/**
 * Image generation against the Gemini Imagen API.
 *
 * Why a separate module from `baget.ts`:
 *   - Pure: takes inputs, returns bytes. No filesystem, no DB, no
 *     destination resolution. The MCP tool wrapper in baget.ts owns
 *     the I/O so this stays unit-testable without mocks for Node fs
 *     or the outbound DB.
 *   - Injectable: the Gemini client is parameterizable via
 *     `GenerateImageDeps.client`. Production passes a freshly
 *     constructed `GoogleGenAI({apiKey})`; tests pass an in-memory
 *     stub that returns base64-encoded canned bytes.
 *
 * Why we call Gemini directly (not via baget.ai):
 *   - Image gen in chat is conversational scratchwork — the
 *     "what could this look like" exploration step. It's not a saved
 *     brand asset, doesn't need to land in the dashboard's library,
 *     and shouldn't cost a baget credit. The render-pdf path
 *     (which DOES go through baget.ai) is for PERSISTED documents —
 *     different threat / billing model.
 *   - The channel-runner already holds a Gemini API key for the agent
 *     loop's tool-call flow (when AI_PROVIDER=gemini). Reusing it
 *     keeps the substrate count down.
 *
 * Trade-off accepted: image gen here is OUTSIDE baget.ai's
 * audit/credit/quota rail. If usage spikes or abuse becomes a
 * problem, the right move is to add a `POST /api/companies/:id
 * /images/generate` endpoint on baget.ai (mirroring `/render-pdf`)
 * and have this tool call THAT instead of Gemini direct. Until then,
 * the channel-token revocation IS the abuse stop.
 */
import { GoogleGenAI } from '@google/genai';

/**
 * Aspect-ratio strings Imagen accepts. Square is the safe default
 * (works on every channel that supports inline media without
 * cropping) — pick a wider/taller ratio explicitly when the founder
 * asks for "landscape" / "story" / "portrait."
 */
export const ALLOWED_ASPECT_RATIOS = ['1:1', '3:4', '4:3', '9:16', '16:9'] as const;
export type AspectRatio = (typeof ALLOWED_ASPECT_RATIOS)[number];

export interface GenerateImageOptions {
  prompt: string;
  aspectRatio?: AspectRatio;
  /**
   * Imagen model id. Defaults to a stable Imagen 3 model. Override
   * via env (`BAGET_IMAGE_MODEL`) if a newer Imagen release is
   * available on the founder's API tier — the default is the safest
   * floor that paid Gemini API accounts have access to.
   */
  model?: string;
}

/**
 * Minimal Gemini-client surface this module needs. Decoupling from
 * the full `GoogleGenAI` type means tests don't have to construct
 * (or mock) the rest of the SDK.
 */
export interface ImageGenClient {
  models: {
    generateImages(args: {
      model: string;
      prompt: string;
      config?: {
        numberOfImages?: number;
        aspectRatio?: string;
        outputMimeType?: string;
      };
    }): Promise<{
      generatedImages?: Array<{
        image?: { imageBytes?: string; mimeType?: string };
      }>;
    }>;
  };
}

export interface GenerateImageDeps {
  /** Override for tests. Production uses a lazily-constructed `GoogleGenAI({apiKey})`. */
  client?: ImageGenClient;
  /** Override for tests. Production reads `GOOGLE_GENERATIVE_AI_API_KEY` / `GOOGLE_AI_API_KEY` from process.env. */
  apiKey?: string;
}

export interface GenerateImageOk {
  ok: true;
  bytes: Buffer;
  mimeType: string;
}

export interface GenerateImageErr {
  ok: false;
  error: string;
}

const DEFAULT_IMAGE_MODEL = 'imagen-3.0-generate-002';

function resolveApiKey(deps: GenerateImageDeps): string | null {
  if (deps.apiKey) return deps.apiKey;
  return (
    process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GOOGLE_AI_API_KEY || process.env.GEMINI_API_KEY || null
  );
}

function resolveModel(opts: GenerateImageOptions): string {
  return opts.model || process.env.BAGET_IMAGE_MODEL || DEFAULT_IMAGE_MODEL;
}

/**
 * Generate ONE image and return its bytes + mime type. Single-image
 * by design — the founder's chat ergonomic is "show me a mockup,"
 * one shot at a time. Multi-image picker would be a different UX.
 */
export async function generateImageBytes(
  opts: GenerateImageOptions,
  deps: GenerateImageDeps = {},
): Promise<GenerateImageOk | GenerateImageErr> {
  const prompt = opts.prompt.trim();
  if (!prompt) return { ok: false, error: 'prompt is required' };
  if (prompt.length > 2000) {
    return { ok: false, error: `prompt too long (${prompt.length} chars; max 2000)` };
  }

  const aspectRatio = opts.aspectRatio ?? '1:1';
  if (!ALLOWED_ASPECT_RATIOS.includes(aspectRatio as AspectRatio)) {
    return {
      ok: false,
      error: `aspectRatio must be one of ${ALLOWED_ASPECT_RATIOS.join(', ')}; got "${aspectRatio}"`,
    };
  }

  let client = deps.client;
  if (!client) {
    const apiKey = resolveApiKey(deps);
    if (!apiKey) {
      return {
        ok: false,
        error:
          'No Gemini API key in env. Set GOOGLE_GENERATIVE_AI_API_KEY (or GOOGLE_AI_API_KEY / GEMINI_API_KEY) on the agent container.',
      };
    }
    client = new GoogleGenAI({ apiKey }) as unknown as ImageGenClient;
  }

  const model = resolveModel(opts);

  let response;
  try {
    response = await client.models.generateImages({
      model,
      prompt,
      config: {
        numberOfImages: 1,
        aspectRatio,
        outputMimeType: 'image/png',
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Gemini generateImages threw: ${msg}` };
  }

  const first = response?.generatedImages?.[0]?.image;
  const b64 = first?.imageBytes;
  if (!b64 || typeof b64 !== 'string') {
    return {
      ok: false,
      error: 'Gemini returned no image bytes (the model may have refused the prompt — try rewording).',
    };
  }

  const bytes = Buffer.from(b64, 'base64');
  if (bytes.length === 0) {
    return { ok: false, error: 'Gemini returned empty image bytes.' };
  }

  return { ok: true, bytes, mimeType: first?.mimeType ?? 'image/png' };
}
