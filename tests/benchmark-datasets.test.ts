import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fetchDataset, prepareDatasetProject, validateDataset } from '../src/benchmark/datasets.js';
import { hash } from '../src/benchmark/storage.js';
const exec=promisify(execFile),roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function fixture(){const root=await mkdtemp(join(tmpdir(),'pace-dataset-test-'));roots.push(root);const repo=join(root,'remote');await mkdir(join(repo,'project'),{recursive:true});await mkdir(join(repo,'private'));
 await writeFile(join(repo,'project/main.js'),'export const x=1;');await writeFile(join(repo,'private/grader.js'),'SECRET_GRADER');await writeFile(join(repo,'private/memory.md'),'SECRET_MEMORY');
 for(const args of [['init','-q'],['add','.'],['-c','user.name=Test','-c','user.email=test@localhost','commit','-qm','fixture']])await exec('git',args,{cwd:repo});
 const commit=(await exec('git',['rev-parse','HEAD'],{cwd:repo})).stdout.trim();return {root,repo,manifest:{version:1 as const,repository:pathToFileURL(repo).href,commit,project:'project',scenariosVersion:'test-v1',checksums:{'private/grader.js':hash('SECRET_GRADER')}}};}
it('requires a full SHA and rejects traversal, moving branches and credentials',async()=>{const {manifest}=await fixture();expect(()=>validateDataset({...manifest,commit:'main'})).toThrow();expect(()=>validateDataset({...manifest,project:'../private'})).toThrow();expect(()=>validateDataset({...manifest,repository:'https://user:secret@example.com/repo'})).toThrow();});
it('fetches a pinned project, verifies offline cache, and creates unrelated Git history without graders or memory',async()=>{
 const {root,manifest}=await fixture(),cache=join(root,'cache');const fetched=await fetchDataset(manifest,{cache});expect((await fetchDataset(manifest,{cache,offline:true})).project).toBe(fetched.project);
 const workspace=await prepareDatasetProject(fetched.project,join(root,'working'));
 expect(await readdir(workspace)).toEqual(expect.arrayContaining(['.git','main.js']));await expect(readFile(join(workspace,'private/grader.js'))).rejects.toThrow();expect((await exec('git',['remote'],{cwd:workspace})).stdout).toBe('');
 await expect(exec('git',['cat-file','-e',manifest.commit],{cwd:workspace})).rejects.toThrow();expect(await readFile(join(workspace,'main.js'),'utf8')).toContain('x=1');
 await writeFile(join(fetched.project,'main.js'),'corrupted');await expect(fetchDataset(manifest,{cache,offline:true})).rejects.toThrow('corruption');
});
it('blocks a controlled run before download because no filesystem/network sandbox is proven',async()=>{const {root,manifest}=await fixture();await expect(fetchDataset(manifest,{cache:join(root,'never-created'),controlled:true})).rejects.toThrow('isolation');await expect(readdir(join(root,'never-created'))).rejects.toThrow();});
it('rejects checksum mismatch and symlink attempts to expose excluded materials',async()=>{
 const {root,repo,manifest}=await fixture();await expect(fetchDataset({...manifest,checksums:{'private/grader.js':hash('wrong')}},{cache:join(root,'bad')})).rejects.toThrow('checksum');
 await symlink('../private',join(repo,'project/leak'));await exec('git',['add','.'],{cwd:repo});await exec('git',['-c','user.name=Test','-c','user.email=test@localhost','commit','-qm','symlink'],{cwd:repo});const commit=(await exec('git',['rev-parse','HEAD'],{cwd:repo})).stdout.trim();await expect(fetchDataset({...manifest,commit},{cache:join(root,'symlink')})).rejects.toThrow('symlink');
 await expect(fetchDataset(manifest,{cache:join(root,'empty'),offline:true})).rejects.toThrow('offline');
});
