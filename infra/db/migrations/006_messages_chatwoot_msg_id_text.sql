-- Meta Cloud API message IDs are strings like "wamid.1786359347590".
-- chatwoot_msg_id was integer, which rejected them. Make it text.
ALTER TABLE messages ALTER COLUMN chatwoot_msg_id TYPE text USING chatwoot_msg_id::text;
