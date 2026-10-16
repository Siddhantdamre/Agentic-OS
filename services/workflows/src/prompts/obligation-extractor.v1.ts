export const OBLIGATION_EXTRACTOR_VERSION = 'obligation-extractor.v1';

export const OBLIGATION_EXTRACTOR_TEMPLATE = `Extract every explicit commitment from this message.

A commitment is a specific thing someone said they would do. It is NOT a
question, a hope, a suggestion, or a general statement of capability.

For each commitment, identify:
- obligor: "us" if {{org_name}} or its staff made the promise,
           "them" if the customer did.
- action: what was promised, in one clause.
- quote: the exact text from the message that contains the promise.
         This MUST appear verbatim in the message. Do not paraphrase.
- due_text: the deadline exactly as written ("by Friday", "tomorrow"),
            or null if none was stated.
- confidence: 0-1, how certain you are this is a real commitment.

Return {"obligations": []} if there are none. That is a normal, correct
answer — most messages contain no commitment.

Never infer a commitment from context outside this message.
Never invent a deadline that was not stated.

Sender: {{sender_role}}   Org: {{org_name}}
Message timestamp: {{iso_ts}}  Org timezone: {{tz}}
Message:
{{message_text}}`;
