import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { atomicJson, json } from './storage.js';
import { getProfile } from './catalog.js';
import type { Selection } from './types.js';
const file=join(homedir(),'.pace','benchmark-center.json');
export async function loadPreferences() {return json<Selection>(file).then(value=>{getProfile(value.category,value.profile);return value;}).catch(()=>undefined);}
export async function savePreferences(selection:Selection) {await mkdir(dirname(file),{recursive:true});await atomicJson(file,selection);}
