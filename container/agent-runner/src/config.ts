/**
 * Runner config — reads <workspace>/agent/container.json at startup.
 *
 * In docker mode, this file is mounted read-only inside the container.
 * In single-process mode, it lives on the host filesystem at the path
 * resolved by `workspaceContainerConfigPath()` (override via BAGET_WORKSPACE).
 * Either way the runner only reads. All NanoClaw-specific configuration
 * lives here instead of environment variables.
 */
import fs from 'fs';

import { workspaceContainerConfigPath } from './workspace-paths.js';

export interface RunnerConfig {
  provider: string;
  assistantName: string;
  groupName: string;
  agentGroupId: string;
  maxMessagesPerPrompt: number;
  mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
}

const DEFAULT_MAX_MESSAGES = 10;

let _config: RunnerConfig | null = null;

/**
 * Load config from container.json. Called once at startup.
 * Falls back to sensible defaults for any missing field.
 */
export function loadConfig(): RunnerConfig {
  if (_config) return _config;

  const configPath = workspaceContainerConfigPath();
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    console.error(`[config] Failed to read ${configPath}, using defaults`);
  }

  _config = {
    provider: (raw.provider as string) || 'claude',
    assistantName: (raw.assistantName as string) || '',
    groupName: (raw.groupName as string) || '',
    agentGroupId: (raw.agentGroupId as string) || '',
    maxMessagesPerPrompt: (raw.maxMessagesPerPrompt as number) || DEFAULT_MAX_MESSAGES,
    mcpServers: (raw.mcpServers as RunnerConfig['mcpServers']) || {},
  };

  return _config;
}

/** Get the loaded config. Throws if loadConfig() hasn't been called. */
export function getConfig(): RunnerConfig {
  if (!_config) throw new Error('Config not loaded — call loadConfig() first');
  return _config;
}
