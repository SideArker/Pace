import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, rename, writeFile, readdir, lstat } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { assertDebug, atomicJson, hash, inside, inventory, json } from './storage.js';
const exec=promisify(execFile);
export type Dataset = { version: 1; repository: string; commit: string; project: string; scenariosVersion: string; checksums?: Record<string,string> };
export const isolationUnavailable='The current benchmark runners do not enforce filesystem and network isolation from host datasets, memory and graders. A controlled profile is unavailable in this environment.';
function safePath(path: string) { if (!path || path.startsWith('-') || path.includes('\\') || path.split('/').some(p=>!p || p==='.' || p==='..') || path.startsWith('/')) throw new Error(`Unsafe dataset path: ${path}`); }
export function validateDataset(value: unknown): Dataset {
  if(!value || typeof value!=='object') throw new Error('Dataset manifest must be an object');
  const data=value as Dataset;
  if(data.version!==1 || typeof data.repository!=='string' || typeof data.commit!=='string' || !/^[0-9a-f]{40}$/.test(data.commit) || typeof data.project!=='string' || typeof data.scenariosVersion!=='string' || !data.scenariosVersion.trim()) throw new Error('Dataset needs version 1, a repository, full commit SHA, project subdirectory and scenariosVersion');
  if(data.checksums!==undefined&&(!data.checksums||typeof data.checksums!=='object'||Array.isArray(data.checksums)))throw new Error('Dataset checksums must be a path-to-SHA-256 object');
  const url=new URL(data.repository);
  if(!['https:','file:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Dataset repository must be credential-free HTTPS or file URL');
  safePath(data.project);
  for(const [path,digest] of Object.entries(data.checksums??{})) { safePath(path); if(!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`Invalid checksum: ${path}`); }
  return data;
}
async function treeHash(root: string):Promise<string> {
  const rows:[string,string][]=[];
  async function visit(path:string,prefix=''):Promise<void> {
    for(const item of await readdir(path,{withFileTypes:true})) {
      if(item.isSymbolicLink())throw new Error('Dataset cache symlink');
      const name=prefix+item.name,full=join(path,item.name);
      if(item.isDirectory())await visit(full,name+'/');else if(item.isFile())rows.push([name,`${(await lstat(full)).mode&0o111?'100755':'100644'}:${hash(await readFile(full))}`]);else throw new Error('Dataset cache contains an unsupported file type');
    }
  }
  await visit(root);return hash(JSON.stringify(rows.sort(([a],[b])=>a.localeCompare(b))));
}
export async function fetchDataset(value: unknown, options: { cache?: string; offline?: boolean; controlled?: boolean; signal?: AbortSignal; onEvent?: (kind: string)=>void }={}) {
  assertDebug(); if(options.controlled) throw new Error(isolationUnavailable);
  const data=validateDataset(value), cache=options.cache??join(homedir(),'.cache/pace/benchmark-datasets'), id=hash(JSON.stringify(data)), target=join(cache,id);
  const verify=async()=>{
    if((await lstat(target)).isSymbolicLink()) throw new Error('Dataset cache symlink');
    if((await lstat(join(target,'project'))).isSymbolicLink())throw new Error('Dataset cache project symlink');
    const receipt=await json<{dataset:Dataset;projectHash:string}>(join(target,'verified.json'));
    if(JSON.stringify(receipt.dataset)!==JSON.stringify(data) || await treeHash(join(target,'project'))!==receipt.projectHash) throw new Error('Dataset cache corruption; remove this cache entry and fetch again');
    for(const file of await inventory(join(target,'project'))) if((await lstat(file)).isSymbolicLink()) throw new Error('Dataset cache symlink');
    return {root:target,project:join(target,'project'),dataset:data};
  };
  const exists=await lstat(target).then(()=>true).catch(error=>{if(error.code==='ENOENT')return false;throw error;});
  if(exists) {try{return await verify();}catch(error){throw new Error(`Dataset cache corruption: ${String(error)}`);}}
  if(options.offline) throw new Error('Verified dataset is not cached; offline fetch refused');
  await mkdir(cache,{recursive:true}); const staging=await mkdtemp(join(cache,'.download-'));
  const git=async(args:string[])=>exec('git',args,{cwd:staging,signal:options.signal,maxBuffer:64*1024*1024,env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'}});
  try {
    options.onEvent?.('dataset-download-started');
    await git(['init','--bare','repository']);
    await git(['--git-dir=repository','-c','protocol.file.allow=always','fetch','--no-tags','--depth=1','--',data.repository,data.commit]);
    const actual=(await git(['--git-dir=repository','rev-parse','FETCH_HEAD^{commit}'])).stdout.trim(); if(actual!==data.commit) throw new Error('Pinned dataset commit mismatch');
    options.onEvent?.('dataset-prepare-started');
    const entries=(await git(['--git-dir=repository','ls-tree','-rz',data.commit,'--',data.project])).stdout.split('\0').filter(Boolean);
    if(!entries.length) throw new Error('Dataset project subdirectory is empty or missing');
    const project=join(staging,'project'); await mkdir(project);
    for(const entry of entries) {
      const [meta,path]=entry.split('\t'); const [mode,type,blob]=meta!.split(' ');
      if(!path?.startsWith(data.project+'/') || type!=='blob' || !['100644','100755'].includes(mode!)) throw new Error('Dataset project contains a symlink, submodule or invalid entry');
      const name=path.slice(data.project.length+1); safePath(name); if(name.split('/').some(p=>p.toLowerCase()==='.git')) throw new Error('Dataset project contains Git metadata');
      const file=inside(project,name); await mkdir(dirname(file),{recursive:true});
      const content=await exec('git',['--git-dir=repository','cat-file','blob',blob!],{cwd:staging,encoding:'buffer',maxBuffer:64*1024*1024,signal:options.signal});
      await writeFile(file,content.stdout,{mode:mode==='100755'?0o755:0o644});
    }
    for(const [path,digest] of Object.entries(data.checksums??{})) {
      const bytes=(await exec('git',['--git-dir=repository','show',`${data.commit}:${path}`],{cwd:staging,encoding:'buffer',maxBuffer:64*1024*1024})).stdout;
      if(hash(bytes)!==digest) throw new Error(`Dataset checksum mismatch: ${path}`);
    }
    await rm(join(staging,'repository'),{recursive:true,force:true});
    await atomicJson(join(staging,'verified.json'),{dataset:data,projectHash:await treeHash(project)});
    await rename(staging,target); options.onEvent?.('dataset-verified'); return await verify();
  } finally { await rm(staging,{recursive:true,force:true}); }
}
export async function prepareDatasetProject(cached: string, target?: string) {
  assertDebug();
  const root=target??await mkdtemp(join(tmpdir(),'pace-dataset-project-'));
  await mkdir(root,{recursive:true});
  if((await readdir(root)).length)throw new Error('Dataset working copy must be empty');
  async function copy(from:string,to:string) {
    for(const item of await readdir(from,{withFileTypes:true})) {
      if(item.isSymbolicLink() || item.name==='.git') throw new Error('Dataset working copy cannot contain symlinks or source Git history');
      const source=join(from,item.name),dest=join(to,item.name);
      if(item.isDirectory()) { await mkdir(dest); await copy(source,dest); } else if(item.isFile())await writeFile(dest,await readFile(source),{mode:(await lstat(source)).mode});else throw new Error('Dataset working copy contains an unsupported file type');
    }
  }
  await copy(resolve(cached),root);
  for(const args of [['init','-q'],['add','.'],['-c','user.name=Pace Benchmark','-c','user.email=benchmark@localhost','commit','-qm','Pinned project only']]) await exec('git',args,{cwd:root,env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_AUTHOR_DATE:'2000-01-01T00:00:00Z',GIT_COMMITTER_DATE:'2000-01-01T00:00:00Z'}});
  return root;
}
