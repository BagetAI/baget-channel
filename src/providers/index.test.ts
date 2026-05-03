import { describe, expect, it } from 'vitest';

import { getProviderContainerConfig, listProviderContainerConfigNames } from './provider-container-registry.js';
import './index.js';

describe('provider container registry', () => {
  it('registers the gemini host config and forwards auth/model env vars', () => {
    expect(listProviderContainerConfigNames()).toContain('gemini');

    const contribution = getProviderContainerConfig('gemini')!({
      sessionDir: '/tmp/session',
      agentGroupId: 'ag-1',
      hostEnv: {
        GOOGLE_GENERATIVE_AI_API_KEY: 'primary-key',
        GOOGLE_AI_API_KEY: 'fallback-key',
        BAGET_GEMINI_MODEL: 'gemini-2.5-flash',
      },
    });

    expect(contribution.env).toMatchObject({
      GOOGLE_GENERATIVE_AI_API_KEY: 'primary-key',
      GOOGLE_AI_API_KEY: 'fallback-key',
      BAGET_GEMINI_MODEL: 'gemini-2.5-flash',
    });
  });
});
