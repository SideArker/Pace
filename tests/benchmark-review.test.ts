import { expect, it } from 'vitest';
import { familyComparisons, type ReviewItem } from '../src/benchmark/results.js';

it('requires matching inputs, thread identities, checks and manual context/quality decisions before cost comparison', () => {
  const row = (arm: string): ReviewItem => ({ path: arm, sha256: 'a', label: arm,
    run: { id: 'case', repetition: 1, pairId: 'matched-pair', arm, completed: true, checksPassed: true, promptSha256: 'p', handoffSha256: 'h', fixtureSha256: 'f', verificationSha256: 'v', commit: 'c', route: { model: 'm', effort: 'low' }, input: [{ type: 'text', text: 'same' }], threadId: arm === 'same-thread' ? 'old' : 'new', historyThreadId: 'old', estimatedCostUsd: arm === 'same-thread' ? 1 : 0.8 },
    review: { pass: true, preservedContext: true, notes: 'Reviewed answer and diff', severity: 'minor', evidence: 'Checks + diff', affectedBehavior: 'All constraints retained' } });
  const same = row('same-thread'), fresh = row('fresh-thread');
  expect(familyComparisons([same, fresh])[0]?.deltaCostUsd).toBeCloseTo(-0.2);
  for (const changed of [{ ...fresh, review: undefined }, { ...fresh, run: { ...fresh.run, input: [] } }, { ...fresh, run: { ...fresh.run, checksPassed: false } }, { ...fresh, run: { ...fresh.run, threadId: 'old' } }]) expect(familyComparisons([same, changed])[0]?.deltaCostUsd).toBeNull();
});

it('does not pair a completion from an interrupted pair with a completion from its retry', () => {
  const rows = ['same-thread','fresh-thread'].map((arm,index) => ({ path: String(index), sha256: 'a', label: arm, run: { id: 'case', repetition: 1, pairId: `attempt-${index}`, arm } }));
  expect(familyComparisons(rows).every(pair => !pair.compatible)).toBe(true);
});
