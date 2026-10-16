/** Coarse bucket — always derivable, never null. The fallback. */
export type ActionBucket = 'read' | 'draft' | 'internal_write' | 'external_send' | 'irreversible';

/** Specific action type — what employee_autonomy_rules keys on. */
export type ActionType = string;

export type Reversibility = 'reversible' | 'visible' | 'irreversible';

/** Every seeded action type maps to exactly one bucket. */
export const ACTION_BUCKETS: Record<string, ActionBucket> = {
  'read_*': 'read',
  'search_*': 'read',
  'list_*': 'read',
  draft_email: 'draft',
  prepare_brief: 'draft',
  recommend_merge: 'draft',
  create_task: 'internal_write',
  assign_owner: 'internal_write',
  update_field: 'internal_write',
  update_status: 'internal_write',
  send_internal_reminder: 'internal_write',
  answer_faq: 'internal_write',
  reschedule_appointment: 'external_send',
  send_external_email: 'external_send',
  send_external_message: 'external_send',
  refund_payment: 'irreversible',
  create_charge: 'irreversible',
  create_payment: 'irreversible',
  delete_record: 'irreversible',
};

/** Bucket → the reversibility class from 11 §1. */
export const BUCKET_REVERSIBILITY: Record<ActionBucket, Reversibility> = {
  read: 'reversible',
  draft: 'reversible',
  internal_write: 'reversible',
  external_send: 'visible',
  irreversible: 'irreversible',
};

export function bucketRuleKey(bucket: ActionBucket): string {
  return `bucket:${bucket}`;
}

const READ_ONLY_TOOLS = new Set(['database_query', 'db_query', 'sql_analytics', 'web_extract']);

export function resolveActionType(
  tool: string,
  action: string,
): { actionType: ActionType; bucket: ActionBucket } {
  const a = `${tool}.${action}`.toLowerCase();

  if (/refund/.test(a)) return t('refund_payment');
  if (/(create_charge|\.charge\b|charge_|_charge)/.test(a) || /\bcharge\b/.test(a)) return t('create_charge');
  if (/(payout|payment[_\s-]?link|create_payment)/.test(a)) return t('create_payment');
  if (/(delete|remove|purge|destroy)/.test(a)) return t('delete_record');
  if (/reschedul/.test(a)) return t('reschedule_appointment');
  if (/(draft|compose)/.test(a)) return t('draft_email');
  if (/(brief|digest|summar)/.test(a)) return t('prepare_brief');
  if (/merge/.test(a)) return t('recommend_merge');

  // Read-only by construction (READ ONLY transaction, org-scoped RLS role, or no
  // side effects), but their names carry none of the read verbs below.
  if (READ_ONLY_TOOLS.has(tool.toLowerCase().split(/[./:]/).pop() ?? '')) {
    return { actionType: 'read_*', bucket: 'read' };
  }
  if (/(search|list|get|fetch|read|lookup|report|metrics)/.test(a)) {
    return { actionType: 'read_*', bucket: 'read' };
  }
  if (/(send|reply|post|email|message|whatsapp|sms)/.test(a)) {
    return { actionType: 'send_external_message', bucket: 'external_send' };
  }
  if (/(create|update|assign|move|set|status)/.test(a)) {
    return { actionType: 'update_field', bucket: 'internal_write' };
  }

  // Unknown is the tool most likely to surprise you — ask, don't auto-run.
  return { actionType: 'unknown', bucket: 'external_send' };

  function t(x: ActionType): { actionType: ActionType; bucket: ActionBucket } {
    return { actionType: x, bucket: ACTION_BUCKETS[x] ?? 'external_send' };
  }
}
