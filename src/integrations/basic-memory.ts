import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { atomicJson } from '../core/sessions.js';
import { BASIC_MEMORY_VERSION, MEMORY_POLICY, memoryRoot, type MemoryConfig } from '../core/memory/config.js';

const exec = promisify(execFile);
export type MemoryBackend = { call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>; close(): Promise<void> };
// Do not pass API credentials or another Basic Memory project's environment to this process.
export function basicMemoryEnvironment(config: MemoryConfig): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'SYSTEMROOT', 'WINDIR', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key]!;
  return { ...env, HOME: homedir(), BASIC_MEMORY_CONFIG_DIR: config.configDirectory, BASIC_MEMORY_HOME: config.dataDirectory,
    BASIC_MEMORY_MCP_PROJECT: config.backendProject, BASIC_MEMORY_FORCE_LOCAL: 'true', BASIC_MEMORY_EXPLICIT_ROUTING: 'true',
    BASIC_MEMORY_AUTO_UPDATE: 'false', BASIC_MEMORY_LOGFIRE_ENABLED: 'false', BASIC_MEMORY_LOGFIRE_SEND_TO_LOGFIRE: 'false',
    DO_NOT_TRACK: '1', HF_HUB_DISABLE_TELEMETRY: '1' };
}
export async function validateBasicMemory(executable: string, signal?: AbortSignal): Promise<void> {
  const { stdout } = await exec(executable, ['--version'], { signal, timeout: MEMORY_POLICY.timeoutMs, maxBuffer: 8000, env: { ...process.env, BASIC_MEMORY_AUTO_UPDATE: 'false' } });
  if (!new RegExp(`(?:^|\\s)${BASIC_MEMORY_VERSION.replaceAll('.', '\\.')}\\s*$`).test(stdout.trim()))
    throw new Error(`Pace requires Basic Memory ${BASIC_MEMORY_VERSION}; found ${stdout.trim() || 'unknown version'}`);
}
export async function detectBasicMemory(base?: string, signal?: AbortSignal): Promise<{ executable?: string; uv?: string; python?: string }> {
  const executableName = process.platform === 'win32' ? 'basic-memory.exe' : 'basic-memory';
  const uvName = process.platform === 'win32' ? 'uv.exe' : 'uv';
  const directories = (process.env.PATH ?? '').split(delimiter);
  const find = async (name: string, args: string[]) => {
    for (const directory of directories) {
      const executable = join(directory, name);
      try { await exec(executable, args, { signal, timeout: 5000, maxBuffer: 8000 }); return executable; } catch { signal?.throwIfAborted(); }
    }
    return undefined;
  };
  const managed = join(memoryRoot(base), 'runtime', BASIC_MEMORY_VERSION, process.platform === 'win32' ? 'Scripts' : 'bin', executableName);
  let executable: string | undefined;
  for (const path of [managed, ...directories.map(directory => join(directory, executableName))]) {
    try { await validateBasicMemory(path, signal); executable = path; break; } catch { signal?.throwIfAborted(); }
  }
  return { executable, uv: await find(uvName, ['--version']), python: await find(process.platform === 'win32' ? 'python.exe' : 'python3', ['--version']) };
}
export async function installBasicMemory(uv: string, base?: string, signal?: AbortSignal, onOutput?: (text: string) => void): Promise<string> {
  const directory = join(memoryRoot(base), 'runtime', BASIC_MEMORY_VERSION);
  await runOwned(uv, ['venv', '--python', '3.12', directory], { signal, onOutput });
  await runOwned(uv, ['pip', 'install', '--python', join(directory, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'), `basic-memory==${BASIC_MEMORY_VERSION}`], { signal, onOutput, timeout: 600_000 });
  const executable = join(directory, process.platform === 'win32' ? 'Scripts/basic-memory.exe' : 'bin/basic-memory');
  await validateBasicMemory(executable, signal);
  return executable;
}
export async function runOwned(command: string, args: string[], options: { signal?: AbortSignal; onOutput?: (text: string) => void; env?: Record<string, string>; timeout?: number } = {}): Promise<void> {
  options.signal?.throwIfAborted();
  const child = spawn(command, args, { env: options.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '', timedOut = false;
  const terminate = () => { child.kill(); };
  const timer = setTimeout(() => { timedOut = true; terminate(); }, options.timeout ?? 120_000);
  options.signal?.addEventListener('abort', terminate, { once: true });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-8000); options.onOutput?.(String(chunk)); });
  try {
    await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', code => {
      if (options.signal?.aborted) reject(new Error('Memory operation cancelled; installed files and notes were preserved'));
      else if (timedOut) reject(new Error('Memory operation timed out'));
      else if (code !== 0) reject(new Error(output || `Memory command exited ${code}`)); else resolve();
    }); });
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', terminate); }
}
export async function configureBasicMemory(config: MemoryConfig, signal?: AbortSignal, onOutput?: (text: string) => void): Promise<void> {
  await validateBasicMemory(config.executable, signal);
  await mkdir(config.configDirectory, { recursive: true, mode: 0o700 });
  // This directory is newly allocated by Pace. Never rewrite a user's global backend config.
  try { await readFile(join(config.configDirectory, 'config.json')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await atomicJson(join(config.configDirectory, 'config.json'), { projects: { [config.backendProject]: { path: config.dataDirectory, mode: 'local' } }, default_project: null, auto_update: false,
      database_backend: 'sqlite', semantic_embedding_provider: 'fastembed', semantic_embedding_model: 'bge-small-en-v1.5', reranker_enabled: false,
      logfire_enabled: false, logfire_send_to_logfire: false });
  }
  await runOwned(config.executable, ['project', 'index', config.backendProject], { env: basicMemoryEnvironment(config), signal, onOutput, timeout: 180_000 });
}
export async function connectBasicMemory(config: MemoryConfig, signal?: AbortSignal): Promise<MemoryBackend> {
  signal?.throwIfAborted();
  const client = new Client({ name: 'pace-memory', version: '1' });
  const transport = new StdioClientTransport({ command: config.executable, args: ['mcp', '--project', config.backendProject], env: basicMemoryEnvironment(config), stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-1000); });
  const close = async () => { await client.close(); };
  const abort = () => { void close().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, MEMORY_POLICY.timeoutMs);
  try { await client.connect(transport); signal?.throwIfAborted(); }
  catch (error) { await close().catch(() => {}); throw new Error(`Basic Memory connection failed: ${String(error)} ${stderr}`); }
  finally { clearTimeout(timeout); }
  return {
    async call(name, args, callSignal = signal) {
      callSignal?.throwIfAborted();
      const result = await client.callTool({ name, arguments: { ...args, project: config.backendProject, output_format: 'json' } }, undefined, { timeout: MEMORY_POLICY.timeoutMs, signal: callSignal });
      if (result.isError) throw new Error(`Basic Memory refused ${name}: ${JSON.stringify(result.content).slice(0, 1000)}`);
      if (result.structuredContent) return result.structuredContent;
      const content = result.content as { type: string; text?: string }[];
      const text = content.filter(item => item.type === 'text').map(item => item.text ?? '').join('\n');
      try { return JSON.parse(text); } catch { return text; }
    },
    async close() { signal?.removeEventListener('abort', abort); await close(); },
  };
}
