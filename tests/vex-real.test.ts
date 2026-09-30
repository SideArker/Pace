import { expect, it } from 'vitest';
import { VexRouter, vexServerPath } from '../src/core/vex/client.js';

// Run explicitly with PACE_REAL_VEX=1 npx vitest run tests/vex-real.test.ts.
// This connects to the installed MCP process and validates its tool interface;
// it does not request a routing decision or contact a model provider.
it.skipIf(process.env.PACE_REAL_VEX !== '1')('connects to the installed Vex MCP server', async () => {
  const path = vexServerPath();
  expect(path, 'Install @sidearker/vex-mcp or set VEX_SERVER_PATH').toBeTruthy();
  const router = new VexRouter(path);
  try {
    await router.verify();
    expect(router.connected).toBe(true);
  } finally {
    await router.close();
  }
}, 20_000);
