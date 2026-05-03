import { describe, it, expect } from 'bun:test';

import { createProvider, type ProviderName } from './factory.js';
import { ClaudeProvider } from './claude.js';
import { GeminiProvider } from './gemini.js';
import { MockProvider } from './mock.js';

describe('createProvider', () => {
  it('returns ClaudeProvider for claude', () => {
    expect(createProvider('claude')).toBeInstanceOf(ClaudeProvider);
  });

  it('returns MockProvider for mock', () => {
    expect(createProvider('mock')).toBeInstanceOf(MockProvider);
  });

  it('returns GeminiProvider for gemini', () => {
    expect(
      createProvider('gemini', {
        env: { GOOGLE_GENERATIVE_AI_API_KEY: 'test-key' },
      }),
    ).toBeInstanceOf(GeminiProvider);
  });

  it('throws for unknown name', () => {
    expect(() => createProvider('bogus' as ProviderName)).toThrow(/Unknown provider/);
  });
});
