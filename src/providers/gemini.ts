/**
 * Gemini provider container config.
 *
 * The single-process runner uses an explicit env allowlist, so Gemini auth and
 * model selection must be forwarded here or the child process will boot
 * without its API key even when the Railway service has one configured.
 *
 * Prefer host `process.env` (what Railway injects at runtime), then fall back
 * to local `.env` values for developer smoke tests.
 */
import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

registerProviderContainerConfig('gemini', ({ hostEnv }) => {
  const dotenv = readEnvFile([
    'GOOGLE_GENERATIVE_AI_API_KEY',
    'GOOGLE_AI_API_KEY',
    'BAGET_GEMINI_MODEL',
    'GEMINI_MODEL',
  ]);

  const env: Record<string, string> = {};

  const primaryKey = hostEnv.GOOGLE_GENERATIVE_AI_API_KEY || dotenv.GOOGLE_GENERATIVE_AI_API_KEY;
  const fallbackKey = hostEnv.GOOGLE_AI_API_KEY || dotenv.GOOGLE_AI_API_KEY;
  const bagetModel = hostEnv.BAGET_GEMINI_MODEL || dotenv.BAGET_GEMINI_MODEL;
  const genericModel = hostEnv.GEMINI_MODEL || dotenv.GEMINI_MODEL;

  if (primaryKey) env.GOOGLE_GENERATIVE_AI_API_KEY = primaryKey;
  if (fallbackKey) env.GOOGLE_AI_API_KEY = fallbackKey;
  if (bagetModel) env.BAGET_GEMINI_MODEL = bagetModel;
  if (genericModel) env.GEMINI_MODEL = genericModel;

  return { env };
});
