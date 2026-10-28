import { execFile } from 'node:child_process';
import { mkdir, copyFile, realpath, stat, writeFile, readFile, unlink, symlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { codexCommand } from '../integrations/codex-cli.js';
import { AppServer, type AppServerLaunch } from '../integrations/app-server-process.js';

const exec = promisify(execFile);
export async function isolatedCommand(workspace: string, command: string, commandArgs: string[], signal?: AbortSignal) {
  const node = await realpath(process.execPath);
  const args = ['--die-with-parent', '--unshare-pid', '--unshare-ipc', '--unshare-net', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp'];
  for (const path of ['/usr', '/lib', '/lib64', node]) if (await stat(path).catch(() => undefined)) args.push('--ro-bind', path, path);
  args.push('--bind', workspace, workspace, '--chdir', workspace, command, ...commandArgs);
  return exec('bwrap', args, { signal, timeout: 20_000, maxBuffer: 1_000_000,
    env: { PATH: '/usr/bin', HOME: '/tmp', LANG: 'C.UTF-8', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' } });
}
export async function checkMemoryIsolation(): Promise<void> {
  if (process.platform !== 'linux') throw new Error('Memory benchmarks require Linux bubblewrap isolation; no uncontrolled fallback is permitted');
  try { await exec('bwrap', ['--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib', '--ro-bind-try', '/lib64', '/lib64', '--proc', '/proc', '--dev', '/dev', '--unshare-net', '/usr/bin/true'], { timeout: 5000 }); }
  catch (error) { throw new Error(`Memory isolation is unavailable: ${String(error)}`); }
}
export async function isolatedAppServer(workspace: string, root: string): Promise<AppServerLaunch> {
  await checkMemoryIsolation();
  const home = join(root, 'home'), codexHome = join(home, '.codex');
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  // Copy authentication only. No host config, memories, sessions, plugins or previous transcripts.
  await copyFile(join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json'), join(codexHome, 'auth.json'));
  const node = await realpath(process.execPath);
  const target = process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : undefined;
  if (!target) throw new Error('Unsupported Codex sandbox architecture');
  const sandbox = await realpath(join(dirname(codexCommand()), '..', '..', `codex-linux-${process.arch}`, 'vendor', `${target}-unknown-linux-musl`, 'bin', 'codex'));
  await writeFile(join(codexHome, 'config.toml'), `web_search = "disabled"\ndefault_permissions = "pace-memory"\n[permissions.pace-memory]\nextends = ":workspace"\n[permissions.pace-memory.filesystem]\n":root" = "deny"\n":minimal" = "read"\n":tmpdir" = "deny"\n":slash_tmp" = "deny"\n${JSON.stringify(node)} = "read"\n${JSON.stringify(sandbox)} = "read"\n[permissions.pace-memory.filesystem.":workspace_roots"]\n"." = "write"\n[permissions.pace-memory.network]\nenabled = false\n`);
  const historyProfile = `\n[permissions.pace-memory-history]\nextends = ":read-only"\n[permissions.pace-memory-history.filesystem]\n":root" = "deny"\n":minimal" = "read"\n":tmpdir" = "deny"\n":slash_tmp" = "deny"\n${JSON.stringify(node)} = "read"\n${JSON.stringify(sandbox)} = "read"\n[permissions.pace-memory-history.filesystem.":workspace_roots"]\n"." = "read"\n[permissions.pace-memory-history.network]\nenabled = false\n`;
  const configFile = join(codexHome, 'config.toml');
  await writeFile(configFile, (await readFile(configFile, 'utf8')) + historyProfile);
  const managedRuntime = Object.fromEntries(['CODEX_MANAGED_PACKAGE_ROOT', 'CODEX_MANAGED_BY_NPM', 'CODEX_VERSION', 'HL_INITIAL_WORKSPACE_TOKEN'].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
  // The model transport keeps host routing; Codex enforces this profile on every agent command.
  const launch = { command: process.execPath, prefix: [], direct: true, cwd: workspace, env: { ...managedRuntime, HOME: homedir(), CODEX_HOME: codexHome, PATH: `/usr/bin:${dirname(node)}`, LANG: 'C.UTF-8', TERM: 'dumb' } };
  await verifyAppServerIsolation(workspace, root, launch);
  return launch;
}
async function verifyAppServerIsolation(workspace: string, root: string, launch: AppServerLaunch) {
  const id = randomUUID(), secret = join(root, `host-${id}`), link = join(workspace, `.pace-isolation-${id}`), output = join(workspace, `.pace-write-${id}`);
  await writeFile(secret, id, { mode: 0o600 }); await symlink(secret, link);
  const listener = createServer(); await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const address = listener.address(); if (!address || typeof address === 'string') throw new Error('Isolation network probe could not start');
  const server = new AppServer(() => {}, () => {}, false, launch);
  const timer = setTimeout(() => server.kill(), 20_000);
  try {
    await server.request('initialize', { clientInfo: { name: 'pace-isolation', version: '1' }, capabilities: { experimentalApi: true } });
    server.notify('initialized', {});
    const script = `import{readFileSync,writeFileSync}from'node:fs';import{connect}from'node:net';for(const p of ${JSON.stringify([secret, link, join(launch.env.CODEX_HOME!, 'auth.json')])}){let readable=false;try{readFileSync(p);readable=true}catch{};if(readable)throw Error('Host/seed filesystem isolation failed')}writeFileSync(${JSON.stringify(output)},'ok');await new Promise((resolve,reject)=>{const s=connect(${address.port},'127.0.0.1');s.once('connect',()=>{s.destroy();reject(Error('Agent network isolation failed'))});s.once('error',()=>{s.destroy();resolve()});s.setTimeout(2000,()=>{s.destroy();resolve()})});console.log('pace-isolation-ok')`;
    const result = await server.request('command/exec', { command: [process.execPath, '--input-type=module', '-e', script], cwd: workspace, timeoutMs: 10_000 }) as { exitCode?: number; stdout?: string; stderr?: string };
    if (result.exitCode !== 0 || !result.stdout?.includes('pace-isolation-ok')) throw new Error(`Codex command isolation failed: ${result.stderr ?? JSON.stringify(result)}`);
    await unlink(output);
    const readOnly = await server.request('command/exec', { command: [process.execPath, '--input-type=module', '-e', `import{writeFileSync}from'node:fs';let wrote=false;try{writeFileSync(${JSON.stringify(output)},'forbidden');wrote=true}catch{};if(wrote)throw Error('Historical code is writable');console.log('pace-readonly-ok')`], cwd: workspace, timeoutMs: 10_000, permissionProfile: 'pace-memory-history' }) as { exitCode?: number; stdout?: string; stderr?: string };
    if (readOnly.exitCode !== 0 || !readOnly.stdout?.includes('pace-readonly-ok')) throw new Error(`Historical workspace isolation failed: ${readOnly.stderr}`);
  } finally {
    clearTimeout(timer); server.kill(); listener.close();
    await Promise.all([secret, link, output].map(path => unlink(path).catch(() => {})));
  }
}
