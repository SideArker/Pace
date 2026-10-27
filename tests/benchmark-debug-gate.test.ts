import { expect, it, vi } from 'vitest';
vi.mock('../src/core/build-mode.js',()=>({isDebugBuild:false}));
it('denies CLI, services and direct drivers before any backend, fetch or inference',async()=>{
 const {commands,commandDescriptions}=await import('../src/components/app/commands.js');expect(commands).not.toContain('/benchmark');expect(commandDescriptions['/benchmark']).toBeUndefined();
 const {benchmarkCommand}=await import('../src/entrypoints/benchmark-cli.js');await expect(benchmarkCommand(['--help'])).rejects.toThrow('debug build');
 const {preflight}=await import('../src/benchmark/preflight.js');await expect(preflight({category:'routing',profile:'quick'})).rejects.toThrow('debug build');
 const {startRun,resumeRun}=await import('../src/benchmark/service.js');await expect(startRun({category:'diagnostics',profile:'quick'})).rejects.toThrow('debug build');await expect(resumeRun('missing')).rejects.toThrow('debug build');
 for(const load of [()=>import('../src/benchmark/drivers/runner/workflows.js'),()=>import('../src/benchmark/drivers/task-control.js'),()=>import('../src/benchmark/drivers/context-models.js'),()=>import('../src/benchmark/drivers/session-persistence.js')]){await expect((await load()).main([])).rejects.toThrow('debug build');}
 const {runRouting}=await import('../src/entrypoints/routing-benchmark-runner.js');await expect(runRouting({} as any)).rejects.toThrow('debug build');
 const {fetchDataset}=await import('../src/benchmark/datasets.js');await expect(fetchDataset({})).rejects.toThrow('debug build');
 const {listResults}=await import('../src/benchmark/results.js');await expect(listResults()).rejects.toThrow('debug build');
});
