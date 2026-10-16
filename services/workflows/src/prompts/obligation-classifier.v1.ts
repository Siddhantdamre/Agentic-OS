export const OBLIGATION_CLASSIFIER_VERSION = 'obligation-classifier.v1';

export const OBLIGATION_CLASSIFIER_TEMPLATE = `Does this message contain a commitment — something one party says they
will do, send, check, or decide?

Return {"has_commitment": true} if there is any chance one exists.
Return {"has_commitment": false} only for messages that are clearly
acknowledgements, greetings, or pure questions with no promise attached.

When uncertain, return true.

Message:
{{message_text}}`;
