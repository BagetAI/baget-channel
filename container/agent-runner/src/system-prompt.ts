import fs from 'fs';
import path from 'path';

import { workspaceAgentDir } from './workspace-paths.js';

const IMPORT_RE = /^@(.+)$/;

function readPromptFile(filePath: string, seen: Set<string>): string {
  if (!fs.existsSync(filePath)) return '';

  let realPath = filePath;
  try {
    realPath = fs.realpathSync(filePath);
  } catch {
    // Fall back to the unresolved path if the filesystem entry disappears
    // between existsSync() and readFileSync().
  }
  if (seen.has(realPath)) return '';
  seen.add(realPath);

  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  const rendered: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    const match = trimmed.match(IMPORT_RE);
    if (match) {
      const ref = match[1]?.trim();
      if (!ref) continue;
      const target = path.isAbsolute(ref) ? ref : path.resolve(path.dirname(filePath), ref);
      const imported = readPromptFile(target, seen).trim();
      if (imported) rendered.push(imported, '');
      continue;
    }
    rendered.push(line);
  }

  return rendered
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function loadWorkspacePromptBundle(agentDir = workspaceAgentDir()): string {
  const seen = new Set<string>();
  const sections: string[] = [];

  const composed = readPromptFile(path.join(agentDir, 'CLAUDE.md'), seen);
  if (composed) sections.push(composed);

  const local = readPromptFile(path.join(agentDir, 'CLAUDE.local.md'), seen);
  if (local) sections.push(local);

  return sections.filter((s) => s.trim().length > 0).join('\n\n').trim();
}

export function buildProviderSystemInstructions(
  providerName: string,
  runtimeAddendum: string,
  agentDir = workspaceAgentDir(),
): string {
  if (providerName === 'claude') return runtimeAddendum;

  const bundle = loadWorkspacePromptBundle(agentDir);
  if (!bundle) return runtimeAddendum;

  return [
    '## Persona And Operating Instructions',
    '',
    'The workspace prompt files below are authoritative.',
    'Follow them over generic model defaults.',
    'Do not describe yourself as Google, Gemini, or a language model unless these instructions explicitly require it.',
    '',
    bundle,
    '',
    runtimeAddendum,
  ]
    .filter((s) => s.trim().length > 0)
    .join('\n');
}
