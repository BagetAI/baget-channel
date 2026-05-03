import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildProviderSystemInstructions, loadWorkspacePromptBundle } from './system-prompt.js';

const tmpDirs: string[] = [];

function makeWorkspace(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baget-system-prompt-'));
  tmpDirs.push(dir);

  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = path.join(dir, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }

  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('system prompt loading', () => {
  it('resolves composed CLAUDE imports and appends CLAUDE.local.md', () => {
    const agentDir = makeWorkspace({
      'CLAUDE.md': ['@./.claude-shared.md', '@./.claude-fragments/module-core.md'].join('\n'),
      '.claude-shared.md': 'Shared base instructions.',
      '.claude-fragments/module-core.md': 'Module instructions.',
      'CLAUDE.local.md': 'Baget persona instructions.',
    });

    expect(loadWorkspacePromptBundle(agentDir)).toBe(
      ['Shared base instructions.', 'Module instructions.', 'Baget persona instructions.'].join('\n\n'),
    );
  });

  it('injects workspace persona instructions for gemini providers', () => {
    const agentDir = makeWorkspace({
      'CLAUDE.md': '@./.claude-shared.md',
      '.claude-shared.md': 'Shared base instructions.',
      'CLAUDE.local.md': 'cos: Answer as Louis.',
    });

    const instructions = buildProviderSystemInstructions('gemini', '## Sending messages\nJust reply directly.', agentDir);

    expect(instructions).toContain('The workspace prompt files below are authoritative.');
    expect(instructions).toContain('cos: Answer as Louis.');
    expect(instructions).toContain('Do not describe yourself as Google, Gemini, or a language model');
    expect(instructions).toContain('## Sending messages');
  });

  it('keeps claude on the runtime addendum only because Claude Code auto-loads prompt files', () => {
    const agentDir = makeWorkspace({
      'CLAUDE.md': '@./.claude-shared.md',
      '.claude-shared.md': 'Shared base instructions.',
      'CLAUDE.local.md': 'Baget persona instructions.',
    });

    expect(buildProviderSystemInstructions('claude', 'runtime addendum', agentDir)).toBe('runtime addendum');
  });
});
