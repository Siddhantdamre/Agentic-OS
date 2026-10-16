jest.mock('@/lib/litellm-client', () => ({
  chatCompletion: jest.fn(async () => '{"type":"COMPLEX","playbook":"core.stale_deal_chase"}'),
}));

import { classifyRequest } from '@/lib/classify';

describe('classifyRequest daily brief', () => {
  it.each(["Give me today's executive brief.", 'daily brief please', 'brief me for today'])(
    '%s stays a simple turn with no playbook',
    async (prompt) => {
      const result = await classifyRequest(prompt, 'org-1');
      expect(result.type).toBe('simple');
      expect(result.playbookId).toBeUndefined();
    },
  );

  it('a real stale-deal ask still gets its playbook', async () => {
    const result = await classifyRequest('chase the stale deal leads', 'org-1');
    expect(result.playbookId).toBe('core.stale_deal_chase');
  });
});
