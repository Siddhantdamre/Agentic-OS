import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { notion } from './notion.js';

describe('Notion Tool Module', () => {
  it('registers comprehensive set of Notion actions', () => {
    assert.ok(notion.actions.includes('create_page'));
    assert.ok(notion.actions.includes('read_page'));
    assert.ok(notion.actions.includes('append_page_content'));
    assert.ok(notion.actions.includes('query_database'));
    assert.ok(notion.actions.includes('search_workspace_docs'));
  });

  it('assigns correct risk levels to actions', () => {
    assert.equal(notion.risk('read_page'), 'read');
    assert.equal(notion.risk('search_workspace_docs'), 'read');
    assert.equal(notion.risk('query_database'), 'read');
    assert.equal(notion.risk('create_page'), 'draft');
    assert.equal(notion.risk('append_page_content'), 'draft');
  });

  it('returns notConnected when org has no Notion connection', async () => {
    const result = await notion.execute({
      tool: 'notion',
      action: 'read_page',
      actionName: 'read_page',
      payload: { pageId: 'test-page-123' },
      orgId: '00000000-0000-0000-0000-000000000000',
      timestamp: new Date().toISOString(),
    });

    assert.equal(result.status, 'error');
    assert.ok(result.message.includes('not connected') || result.message.includes('not signed in'));
    assert.equal(result.data?.connected, false);
  });
});
