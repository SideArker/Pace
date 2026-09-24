import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';
import type { ModelOption } from '../types.js';
export function findJev(): { executable: string; prefix: string[] } | undefined {
  const explicit = process.env.JEV_COMMAND;
  const candidates = explicit ? [explicit] : [
    ...((process.env.PATH ?? '').split(delimiter).flatMap(dir => process.platform === 'win32' ? [join(dir, 'jev.exe'), join(dir, 'jev.ps1')] : [join(dir, 'jev')])),
    ...(process.platform === 'win32' ? [join(homedir(), '.local', 'bin', 'jev.ps1')] : []),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    if (path.toLowerCase().endsWith('.ps1')) return { executable: 'powershell.exe', prefix: ['-NoProfile', '-NonInteractive', '-File', path] };
    if (!path.toLowerCase().endsWith('.cmd') && !path.toLowerCase().endsWith('.bat')) return { executable: path, prefix: [] };
  }
  return undefined;
}
export function routeRequest(prompt: string, models: ModelOption[]): object {
  // Never send the prompt or repository content to Jev.
  const category = /\b(test|bug|fix|error|fail|regression)\b/i.test(prompt) ? 'debugging' : /\b(refactor|migrate|rename|cleanup)\b/i.test(prompt) ? 'refactoring' : 'coding';
  const words = prompt.trim().split(/\s+/).length;
  const size = words < 12 ? 'short' : words < 40 ? 'medium' : 'long';
  const multiFile = /\b(all|multiple|several)\s+files?\b/i.test(prompt);
  const asksTests = /\b(tests?|specs?)\b/i.test(prompt);
  return { model: 'typesafe/jev-1.13', state: `Choose one configured Codex route for a ${category} task. Request length: ${size}; multiple files mentioned: ${multiFile}; tests mentioned: ${asksTests}. No task text or repository content supplied.`, questions: { route: { type: 'choice', instructions: 'Choose a suitable option.', criteria: Object.fromEntries(models.map((m, i) => [String(i), `Model ${m.model}, effort ${m.defaultEffort ?? m.efforts[0]}`])) } } };
}
export function parseJevOutput(output: string): unknown {
  try {
    const value: unknown = JSON.parse(output);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid shape');
    return value;
  } catch { throw new Error('jev returned invalid JSON'); }
}
export async function askJev(prompt: string, models: ModelOption[], timeoutMs = 12000): Promise<unknown> {
  if (models.length < 2) return undefined;
  const command = findJev();
  if (!command) throw new Error('jev executable was not found');
  const input = JSON.stringify(routeRequest(prompt, models));
  return new Promise((resolve, reject) => {
    // Jev defaults its input file to stdin; omitting '-' also avoids PowerShell -File treating it as a parameter name.
    const child = spawn(command.executable, [...command.prefix, 'run', '--raw'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 65536) child.kill(); });
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 4096) child.kill(); });
    child.stdin.on('error', () => { /* Process exit is reported by close/error. */ });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); if (code !== 0) return reject(new Error(stderr.trim().slice(0, 200) || 'jev failed or timed out')); try { resolve(parseJevOutput(stdout)); } catch (error) { reject(error); } });
    child.stdin.end(input);
  });
}
