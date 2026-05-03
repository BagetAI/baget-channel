import { describe, expect, it } from 'bun:test';

import { GeminiProvider } from './gemini.js';

interface FakeHistoryEntry {
  role: 'user' | 'model';
  parts: Array<{ text: string }>;
}

function parseContinuation(serialized: string): FakeHistoryEntry[] {
  const parsed = JSON.parse(serialized) as { version: number; history: FakeHistoryEntry[] };
  return parsed.history;
}

function makeFakeClient(onCreate?: (args: { model: string; history: FakeHistoryEntry[]; config?: { systemInstruction?: string } }) => void) {
  return {
    chats: {
      create(args: { model: string; history?: FakeHistoryEntry[]; config?: { systemInstruction?: string } }) {
        const history = [...(args.history ?? [])];
        onCreate?.({
          model: args.model,
          history: history.map((entry) => ({
            role: entry.role,
            parts: entry.parts.map((part) => ({ ...part })),
          })),
          config: args.config,
        });

        return {
          async sendMessageStream({ message }: { message: string }) {
            history.push({ role: 'user', parts: [{ text: message }] });
            const reply = `Gemini says: ${message}`;
            history.push({ role: 'model', parts: [{ text: reply }] });

            return {
              async *[Symbol.asyncIterator]() {
                yield { text: 'Gemini says: ' };
                yield { text: message };
              },
            };
          },
          getHistory() {
            return history;
          },
        };
      },
    },
  };
}

async function readTurn(
  iterator: AsyncIterator<unknown>,
): Promise<Array<{ type: string; [key: string]: unknown }>> {
  const events: Array<{ type: string; [key: string]: unknown }> = [];
  while (true) {
    const next = await iterator.next();
    if (next.done) return events;
    const event = next.value as { type: string; [key: string]: unknown };
    events.push(event);
    if (event.type === 'result') {
      return events;
    }
  }
}

describe('GeminiProvider', () => {
  it('requires a Google API key', () => {
    expect(() => new GeminiProvider()).toThrow(/GOOGLE_GENERATIVE_AI_API_KEY|GOOGLE_AI_API_KEY/);
  });

  it('uses the configured model, system instruction, and persists history across turns', async () => {
    const createCalls: Array<{ model: string; history: FakeHistoryEntry[]; config?: { systemInstruction?: string } }> = [];
    const provider = new GeminiProvider(
      {
        env: {
          GOOGLE_GENERATIVE_AI_API_KEY: 'test-key',
          BAGET_GEMINI_MODEL: 'gemini-2.5-flash',
        },
      },
      { client: makeFakeClient((args) => createCalls.push(args)) },
    );

    const query = provider.query({
      prompt: '<message from="founder">hello</message>',
      cwd: '/tmp/workspace',
      systemContext: { instructions: 'Reply as Louis.' },
    });

    const iterator = query.events[Symbol.asyncIterator]();
    const firstTurn = await readTurn(iterator);

    const firstInit = firstTurn.find((event) => event.type === 'init') as { continuation: string } | undefined;
    const firstResult = firstTurn.find((event) => event.type === 'result') as { text: string } | undefined;

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]?.model).toBe('gemini-2.5-flash');
    expect(createCalls[0]?.config).toEqual({ systemInstruction: 'Reply as Louis.' });
    expect(firstResult?.text).toBe('Gemini says: <message from="founder">hello</message>');
    expect(firstInit).toBeDefined();
    expect(parseContinuation(firstInit!.continuation)).toEqual([
      { role: 'user', parts: [{ text: '<message from="founder">hello</message>' }] },
      { role: 'model', parts: [{ text: 'Gemini says: <message from="founder">hello</message>' }] },
    ]);

    query.push('<message from="founder">follow up</message>');
    const secondTurn = await readTurn(iterator);
    const secondInit = secondTurn.find((event) => event.type === 'init') as { continuation: string } | undefined;
    const secondResult = secondTurn.find((event) => event.type === 'result') as { text: string } | undefined;

    expect(secondResult?.text).toBe('Gemini says: <message from="founder">follow up</message>');
    expect(parseContinuation(secondInit!.continuation)).toEqual([
      { role: 'user', parts: [{ text: '<message from="founder">hello</message>' }] },
      { role: 'model', parts: [{ text: 'Gemini says: <message from="founder">hello</message>' }] },
      { role: 'user', parts: [{ text: '<message from="founder">follow up</message>' }] },
      { role: 'model', parts: [{ text: 'Gemini says: <message from="founder">follow up</message>' }] },
    ]);

    query.abort();
  });

  it('starts fresh when the stored continuation is malformed', async () => {
    const createCalls: Array<{ model: string; history: FakeHistoryEntry[]; config?: { systemInstruction?: string } }> = [];
    const provider = new GeminiProvider(
      {
        env: {
          GOOGLE_AI_API_KEY: 'test-key',
        },
      },
      { client: makeFakeClient((args) => createCalls.push(args)) },
    );

    const query = provider.query({
      prompt: '<message from="founder">fresh start</message>',
      continuation: 'not-json',
      cwd: '/tmp/workspace',
    });

    const iterator = query.events[Symbol.asyncIterator]();
    const turn = await readTurn(iterator);
    const result = turn.find((event) => event.type === 'result') as { text: string } | undefined;

    expect(result?.text).toBe('Gemini says: <message from="founder">fresh start</message>');
    const init = turn.find((event) => event.type === 'init') as { continuation: string } | undefined;
    expect(parseContinuation(init!.continuation)).toEqual([
      { role: 'user', parts: [{ text: '<message from="founder">fresh start</message>' }] },
      { role: 'model', parts: [{ text: 'Gemini says: <message from="founder">fresh start</message>' }] },
    ]);

    query.abort();
  });
});
