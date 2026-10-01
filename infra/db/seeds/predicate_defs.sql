-------------------------------------------------------------------------------
-- Predicate vocabulary seed — the closed set the fact extractor may emit.
-- Idempotent. Packs own their keys; uninstalling a pack cascades its rows.
-- See docs/2-sept/21-spec-entity-graph.md §3.5 / §4 step 4.
--
-- requires_tool_evidence = a value from chat is only a claim (needs_attention);
-- it applies as a current fact only from source_kind='tool_result'.
-------------------------------------------------------------------------------

INSERT INTO predicate_defs
  (key, pack_id, entity_type, object_type, cardinality, extractable,
   min_confidence, requires_tool_evidence, blocked_data_class, description)
VALUES
  -- core-b2b: contacts and accounts --------------------------------------------
  ('core.contact.email',        'core-b2b', 'person',      'text',  'many', true,  0.75, false, NULL,  'Email address of a person'),
  ('core.contact.phone',        'core-b2b', 'person',      'text',  'many', true,  0.75, false, NULL,  'Phone number (E.164) of a person'),
  ('core.contact.full_name',    'core-b2b', 'person',      'text',  'one',  true,  0.70, false, NULL,  'Best-known full name'),
  ('core.contact.role',         'core-b2b', 'person',      'text',  'one',  true,  0.65, false, NULL,  'Job title or role at their account'),
  ('core.contact.works_for',    'core-b2b', 'person',      'ref',   'one',  true,  0.70, false, NULL,  'Account this person belongs to'),
  ('core.account.name',         'core-b2b', 'account',     'text',  'one',  true,  0.75, false, NULL,  'Company / account display name'),
  ('core.account.stage',        'core-b2b', 'account',     'text',  'one',  true,  0.60, false, NULL,  'Pipeline stage (lead, qualified, won, lost)'),
  ('core.account.owner',        'core-b2b', 'account',     'ref',   'one',  true,  0.70, false, NULL,  'Internal owner of the account'),

  -- core-b2b: commitments and obligations ------------------------------------
  ('core.commitment.due_date',  'core-b2b', 'commitment',  'date',  'one',  true,  0.70, false, NULL,  'When a promised action is due'),
  ('core.commitment.owner',     'core-b2b', 'commitment',  'ref',   'one',  true,  0.65, false, NULL,  'Who owns the commitment'),
  ('core.commitment.status',    'core-b2b', 'commitment',  'text',  'one',  true,  0.60, false, NULL,  'open | done | slipped'),
  ('core.obligation.amount',    'core-b2b', 'obligation',  'money', 'one',  true,  0.80, true,  NULL,  'Amount owed — requires tool evidence'),
  ('core.obligation.due_date',  'core-b2b', 'obligation',  'date',  'one',  true,  0.75, false, NULL,  'When an obligation falls due'),

  -- real-estate-brokerage: listings and buyers ------------------------------
  ('re.listing.price',          'real-estate-brokerage', 'asset',    'money', 'one',  true, 0.85, true,  NULL, 'List price — requires a Sheets/CRM tool read, never a chat claim'),
  ('re.listing.status',         'real-estate-brokerage', 'asset',    'text',  'one',  true, 0.70, false, NULL, 'available | under_offer | sold | withdrawn'),
  ('re.listing.locality',       'real-estate-brokerage', 'asset',    'text',  'one',  true, 0.70, false, NULL, 'Locality / micro-market of the listing'),
  ('re.listing.bedrooms',       'real-estate-brokerage', 'asset',    'number','one',  true, 0.75, false, NULL, 'Bedroom count / BHK'),
  ('re.listing.rera_id',        'real-estate-brokerage', 'asset',    'text',  'one',  true, 0.90, true,  NULL, 'RERA registration id — tool evidence only, never invented'),
  ('re.buyer.wants_locality',   'real-estate-brokerage', 'person',   'text',  'many', true, 0.65, false, NULL, 'A locality the buyer is interested in (buyers can want several)'),
  ('re.buyer.budget_max',       'real-estate-brokerage', 'person',   'money', 'one',  true, 0.70, false, NULL, 'Stated maximum budget'),
  ('re.buyer.wants_bedrooms',   'real-estate-brokerage', 'person',   'number','one',  true, 0.70, false, NULL, 'Desired bedroom count / BHK'),
  ('re.deal.stage',             'real-estate-brokerage', 'transaction','text','one',  true, 0.65, false, NULL, 'enquiry | viewing | negotiation | closed')
ON CONFLICT (key) DO UPDATE SET
  pack_id                = EXCLUDED.pack_id,
  entity_type            = EXCLUDED.entity_type,
  object_type            = EXCLUDED.object_type,
  cardinality            = EXCLUDED.cardinality,
  extractable            = EXCLUDED.extractable,
  min_confidence         = EXCLUDED.min_confidence,
  requires_tool_evidence = EXCLUDED.requires_tool_evidence,
  blocked_data_class     = EXCLUDED.blocked_data_class,
  description            = EXCLUDED.description;
