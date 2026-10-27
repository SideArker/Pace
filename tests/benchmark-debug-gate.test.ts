import { expect, it, vi } from 'vitest';
vi.mock('../src/core/build-mode.js',()=>({isDebugBuild:false}));
it('denies CLI, services and direct drivers before any backend, fetch or inference',async()=>{
 const {commands,commandDescriptions}=await import('../src/components/app/commands.js');expect(commands).not.toContain('/benchmark');expect(commandDescriptions['/benchmark']).toBeUndefined();
 const {benchmarkCommand}=await import('../src/entrypoints/benchmark-cli.js');await expect(benchmarkCommand(['--help'])).rejects.toThrow('debug build');
 const {preflight}=await import('../src/benchmark/preflight.js');await expect(preflight({category:'routing',profile:'quick'})).rejects.toThrow('debug build');
 const {startRun,resumeRun}=await import('../src/benchmark/service.js');await expect(startRun({category:'diagnostics',profile:'quick'})).rejects.toThrow('debug build');await expect(resumeRun('missing')).rejects.toThrow('debug build');
 const {runFreshCompletion}=await import('../src/benchmark/drivers/fresh-completion.js');await expect(runFreshCompletion({} as any)).rejects.toThrow('debug build');
 const {listResults}=await import('../src/benchmark/results.js');await expect(listResults()).rejects.toThrow('debug build');
});
