import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink, readdir, lstat, open, rm } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';
import { isDebugBuild } from '../core/build-mode.js';
export const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
export const resultsRoot = join(repositoryRoot,'benchmark/results');
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function assertDebug() { if (!isDebugBuild) throw new Error('Benchmark Center is available only in a debug build of Pace.'); }
export function inside(root: string, path: string) {
  const result=resolve(root,path), rel=relative(root,result);
  if (!rel || rel.split(/[\\/]/)[0]==='..' || isAbsolute(rel)) throw new Error(`Unsafe benchmark path: ${path}`);
  return result;
}
export async function atomicWrite(path: string, text: string) {
  const temporary=`${path}.${randomUUID()}.tmp`;
  try {
    const file=await open(temporary,'wx',0o600);
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
    await rename(temporary,path);
  } finally { await unlink(temporary).catch(()=>{}); }
}
export async function atomicJson(path: string, value: unknown) {await atomicWrite(path,JSON.stringify(value,null,2)+'\n');}
export async function json<T>(path: string): Promise<T> { return JSON.parse(await readFile(path,'utf8')) as T; }
export async function inventory(root: string): Promise<string[]> {
  const files:string[]=[];
  for (const entry of await readdir(root,{withFileTypes:true})) {
    const path=join(root,entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) files.push(...await inventory(path)); else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}
export async function runDirectory(id: string, root=resultsRoot) {
  if (!id || id==='.' || id==='..' || /[\\/\0]/.test(id)) throw new Error('Invalid benchmark run ID');
  const dir=inside(root,id);
  if ((await lstat(dir)).isSymbolicLink()) throw new Error('Run directory cannot be a symlink');
  return dir;
}
async function processIdentity(pid: number) {
  if(process.platform!=='linux')return undefined;
  const fields=(await readFile(`/proc/${pid}/stat`,'utf8')).split(') ')[1]!.split(' ');
  return {start:fields[19],zombie:fields[0]==='Z'};
}
async function owner(pid:number) {return (await processIdentity(pid))?.start;}
async function ownerIsLive(item:{pid:number;start?:string}) {
  if(!Number.isSafeInteger(item.pid)||item.pid<=0)throw new Error('Invalid benchmark lock owner; inspect lock before recovery');
  try {
    process.kill(item.pid,0);
    const identity=await processIdentity(item.pid);
    return !identity?.zombie&&(!item.start||!identity||identity.start===item.start);
  } catch(error) {
    if(['ESRCH','ENOENT'].includes((error as NodeJS.ErrnoException).code??''))return false;
    throw error;
  }
}
export async function acquireLock(root: string) {
  await mkdir(root,{recursive:true});
  const path=join(root,'.benchmark-lock');
  const identity:{pid:number;host:string;start?:string;nonce:string;runId?:string;child?:{pid:number;start?:string}}={pid:process.pid,host:hostname(),start:await owner(process.pid),nonce:randomUUID()};
  for (let attempt=0;attempt<2;attempt++) {
    try { const file=await open(path,'wx',0o600); try { await file.writeFile(JSON.stringify(identity)); } finally { await file.close(); }
      const release=async()=>{ const current=await json<typeof identity>(path); if(current.nonce===identity.nonce) await unlink(path); };
      return Object.assign(release,{setRun:async(id:string)=>{identity.runId=id;await atomicJson(path,identity);},registerChild:async(pid:number)=>{identity.child={pid,start:await owner(pid)};await atomicJson(path,identity);}});
    } catch(error) {
      if((error as NodeJS.ErrnoException).code!=='EEXIST') throw error;
      const saved=await json<typeof identity>(path);
      if(saved.host!==hostname()) throw new Error(`Benchmark resource locked on ${saved.host}`);
      if(typeof saved.nonce!=='string'||!/^[a-zA-Z0-9-]+$/.test(saved.nonce))throw new Error('Invalid lock identity; inspect the lock before recovery');
      const recovery=join(root,`.benchmark-recovery-${saved.nonce}`);
      try {await mkdir(recovery);}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new Error(`Benchmark lock recovery is already claimed; inspect ${recovery} if its owner crashed`);throw error;}
      try {
        await atomicJson(join(recovery,'owner.json'),identity);
        const current=await json<typeof identity>(path).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;});
        if(!current||current.nonce!==saved.nonce)continue;
        if(await ownerIsLive(current))throw new Error(`Benchmark resource owned by PID ${current.pid}`);
        if(current.child&&await ownerIsLive(current.child))throw new Error(`Benchmark worker still owned by PID ${current.child.pid}; wait for it before recovery`);
        await unlink(path);
      } finally {await rm(recovery,{recursive:true,force:true});}
    }
  }
  throw new Error('Could not acquire benchmark resource lock');
}

export async function resourceIsLive(root: string, id?:string) {
  const lock = await json<{pid:number;start?:string;host:string;runId?:string;child?:{pid:number;start?:string}}>(join(root,'.benchmark-lock')).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;});
  if(!lock||id&&lock.runId!==id)return false;
  if(lock.host!==hostname())return true;
  for(const item of [lock,lock.child])if(item&&await ownerIsLive(item))return true;
  return false;
}
