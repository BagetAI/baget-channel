import { GoogleGenAI, type Content, type GenerateContentConfig, type GenerateContentResponse } from '@google/genai';

import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
const CONTINUATION_VERSION = 1;

interface StoredHistory {
  version: number;
  history: Content[];
}

interface ChatLike {
  sendMessageStream(params: { message: string }): Promise<AsyncGenerator<GenerateContentResponse>>;
  getHistory(curated?: boolean): Content[];
}

interface GeminiClientLike {
  chats: {
    create(params: { model: string; history?: Content[]; config?: GenerateContentConfig }): ChatLike;
  };
}

interface GeminiProviderDeps {
  client?: GeminiClientLike;
}

function log(message: string): void {
  console.error(`[gemini-provider] ${message}`);
}

function resolveApiKey(env: Record<string, string | undefined>): string {
  const apiKey = env.GOOGLE_GENERATIVE_AI_API_KEY || env.GOOGLE_AI_API_KEY;
  if (!apiKey) {
    throw new Error('Gemini provider requires GOOGLE_GENERATIVE_AI_API_KEY or GOOGLE_AI_API_KEY.');
  }
  return apiKey;
}

function resolveModel(env: Record<string, string | undefined>): string {
  return env.BAGET_GEMINI_MODEL || env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
}

function buildChatConfig(instructions?: string): GenerateContentConfig | undefined {
  if (!instructions) return undefined;
  return { systemInstruction: instructions };
}

function isLikelyContent(value: unknown): value is Content {
  if (!value || typeof value !== 'object') return false;
  const content = value as { role?: unknown; parts?: unknown };
  if (content.role !== undefined && typeof content.role !== 'string') return false;
  if (content.parts !== undefined && !Array.isArray(content.parts)) return false;
  return true;
}

function deserializeHistory(serialized?: string): Content[] {
  if (!serialized) return [];

  try {
    const parsed = JSON.parse(serialized) as StoredHistory | Content[];
    const history = Array.isArray(parsed)
      ? parsed
      : parsed?.version === CONTINUATION_VERSION && Array.isArray(parsed.history)
        ? parsed.history
        : null;

    if (!history) {
      log('Ignoring continuation with unsupported format');
      return [];
    }

    return history.filter(isLikelyContent);
  } catch {
    log('Ignoring malformed continuation payload');
    return [];
  }
}

function serializeHistory(history: Content[]): string {
  return JSON.stringify({
    version: CONTINUATION_VERSION,
    history,
  } satisfies StoredHistory);
}

function appendChunkText(accumulated: string, chunk: GenerateContentResponse): string {
  return typeof chunk.text === 'string' && chunk.text.length > 0 ? accumulated + chunk.text : accumulated;
}

export class GeminiProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private readonly client: GeminiClientLike;
  private readonly model: string;

  constructor(options: ProviderOptions = {}, deps: GeminiProviderDeps = {}) {
    const env = options.env ?? {};
    const apiKey = resolveApiKey(env);

    this.model = resolveModel(env);
    this.client = deps.client ?? new GoogleGenAI({ apiKey });
  }

  isSessionInvalid(_err: unknown): boolean {
    return false;
  }

  query(input: QueryInput): AgentQuery {
    const pending: string[] = [input.prompt];
    const chat = this.client.chats.create({
      model: this.model,
      history: deserializeHistory(input.continuation),
      config: buildChatConfig(input.systemContext?.instructions),
    });

    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;

    const wake = () => waiting?.();

    const events: AsyncIterable<ProviderEvent> = {
      async *[Symbol.asyncIterator]() {
        while (!aborted) {
          if (pending.length === 0) {
            if (ended) return;
            await new Promise<void>((resolve) => {
              waiting = resolve;
            });
            waiting = null;
            continue;
          }

          const message = pending.shift()!;
          yield { type: 'activity' };

          const stream = await chat.sendMessageStream({ message });
          let text = '';

          for await (const chunk of stream) {
            if (aborted) return;
            yield { type: 'activity' };
            text = appendChunkText(text, chunk);
          }

          yield {
            type: 'init',
            continuation: serializeHistory(chat.getHistory(true)),
          };
          yield { type: 'result', text: text || null };
        }
      },
    };

    return {
      push(message: string) {
        pending.push(message);
        wake();
      },
      end() {
        ended = true;
        wake();
      },
      events,
      abort() {
        aborted = true;
        ended = true;
        wake();
      },
    };
  }
}

registerProvider('gemini', (opts) => new GeminiProvider(opts));
