import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdir, readdir, access } from 'node:fs/promises';
import { atomicJson, json, repositoryRoot } from './storage.js';
import type { Selection } from './types.js';
const file=join(homedir(),'.pace','benchmark-center.json');
export async function loadPreferences() {return json<Selection>(file).catch(()=>undefined);}
export async function savePreferences(selection:Selection) {await mkdir(dirname(file),{recursive:true});await atomicJson(file,selection);}
export async function baselineChoices() {
  const parent=dirname(repositoryRoot.replace(/\/$/,''));
  const choices:string[]=[];
  for(const entry of await readdir(parent,{withFileTypes:true})) {
    if(!entry.isDirectory())continue;
    const path=join(parent,entry.name);if(path===repositoryRoot.replace(/\/$/,''))continue;
    try {await access(join(path,'dist/core/orchestrator.js'));await access(join(path,'routing-prompts.default.json'));choices.push(path);}catch{}
  }
  return choices;
}
