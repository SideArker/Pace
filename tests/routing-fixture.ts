import type { VexRequest } from '../src/core/vex/client.js';

export function decision(request: VexRequest, choice: string) {
  const probabilities = Object.fromEntries(request.options.map(option => [option.id, option.id === choice ? 0.9 : 0.1 / (request.options.length - 1)]));
  return { contractVersion: '1', abstained: false, choice, confidence: 0.9, probabilities };
}
export function singleVex(route: string) {
  return { verify: async () => {}, choose: async (request: VexRequest) => decision(request, request.options.some(option => option.id === 'closed') ? 'unknown' : request.options[0]?.id === 'continue' ? 'replace' : request.options[0]?.id === 'single' ? 'single' : route) };
}
