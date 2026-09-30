import { expect, it } from 'vitest';
import { formatLatestRoute } from '../src/components/route-format.js';
import type { ModelOption, TurnSummary } from '../src/shared/types.js';

it('uses the recorded Vex choice label after the model list is reordered', () => {
  const turn: TurnSummary = {
    prompt: 'Fix the parser', result: 'Done', at: '2026-01-01',
    route: { model: 'gpt-6-sol', effort: 'high' },
    routing: [{ objective: 'Complete request', choice: '0:high',
      choiceLabel: 'gpt-6-sol at high reasoning', confidence: 0.8,
      probabilities: { '0:high': 0.8, '1:low': 0.2 }, attempts: 1 }],
  };
  const reordered: ModelOption[] = [
    { model: 'gpt-6-luna', efforts: ['high'] },
    { model: 'gpt-6-sol', efforts: ['low'] },
  ];
  expect(formatLatestRoute([turn], reordered).join('\n')).toContain('gpt-6-sol at high reasoning');
  expect(formatLatestRoute([turn], reordered).join('\n')).not.toContain('GPT-6 Luna High');
});

it('does not infer a legacy choice label from current model settings', () => {
  const turn: TurnSummary = {
    prompt: 'Fix the parser', result: 'Done', at: '2026-01-01',
    routing: [{ objective: 'Complete request', choice: '0:high', confidence: 0.8,
      probabilities: { '0:high': 0.8, '1:low': 0.2 }, attempts: 1 }],
  };
  const models: ModelOption[] = [{ model: 'gpt-6-luna', efforts: ['high'] }];
  expect(formatLatestRoute([turn], models).join('\n')).toContain('saved choice 0:high (model label unavailable)');
});
