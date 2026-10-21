import { it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { remainingPlan, verifyFrozenSources } from '../benchmark/context-models-continue.js';
it('skips only completed trials and preserves original repetition and rotated order',()=>{
 const plan=[{case:'x',family:'A' as const,repeat:1,variant:'resume'},{case:'x',family:'A' as const,repeat:1,variant:'fresh_checkpoint'},{case:'x',family:'A' as const,repeat:2,variant:'fresh_checkpoint'},{case:'x',family:'A' as const,repeat:2,variant:'resume'}];
 expect(remainingPlan(plan,[{...plan[0]!,completed:true},{...plan[1]!,completed:true},{...plan[2]!,completed:false}])).toEqual(plan.slice(2));
});
it('does not replay a successful trial when an earlier attempt with the same key failed',()=>{const p={case:'x',family:'B' as const,repeat:2,variant:'luna_side'};expect(remainingPlan([p],[{...p,completed:false},{...p,completed:true}])).toEqual([]);});
it('rejects changed frozen sources before execution',async()=>{const root=await mkdtemp(join(tmpdir(),'pace-frozen-test-'));await writeFile(join(root,'source.ts'),'original');const hashes={'source.ts':createHash('sha256').update('original').digest('hex')};await expect(verifyFrozenSources(hashes,root)).resolves.toBeUndefined();await writeFile(join(root,'source.ts'),'changed');await expect(verifyFrozenSources(hashes,root)).rejects.toThrow('Frozen source changed');});
