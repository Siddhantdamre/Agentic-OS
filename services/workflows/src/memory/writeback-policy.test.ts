import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyWriteBackEvent, isAllowedWriteBack } from './writeback-policy.js';

test('generated content is never a memory', () => {
  assert.equal(classifyWriteBackEvent({ generated: true, conversationClosed: true }), null);
  assert.equal(isAllowedWriteBack('model_summary'), false);
});

test('human correction is always written back', () => {
  assert.equal(classifyWriteBackEvent({ humanCorrected: true }), 'human_correction');
  assert.equal(isAllowedWriteBack('human_correction'), true);
});

test('closed conversation is allowed', () => {
  assert.equal(classifyWriteBackEvent({ conversationClosed: true }), 'conversation_closed');
});

test('raw inbound message with no event is not an allowed memory write', () => {
  assert.equal(isAllowedWriteBack(null), false);
  assert.equal(isAllowedWriteBack(undefined), false);
  assert.equal(classifyWriteBackEvent({}), null);
});
