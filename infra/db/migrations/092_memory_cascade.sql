-------------------------------------------------------------------------------
-- Memory vector invalidation on body edit (gap26sept / Subagent 5)
--
-- There is no separate memory_embeddings table: pgvector lives on
-- org_memory / employee_memory / entity_memory / conversation_memory as
-- column `embedding`. DELETE of a memory row already removes its vector.
--
-- This migration adds BEFORE UPDATE triggers so a body (or summary) change
-- clears embedding immediately — agents cannot cite a stale vector while
-- re-embed is in flight. Application code still enqueues re-embed after edit.
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION clear_memory_embedding_on_body_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'conversation_memory' THEN
    IF NEW.body IS DISTINCT FROM OLD.body
       OR NEW.summary IS DISTINCT FROM OLD.summary THEN
      NEW.embedding := NULL;
    END IF;
  ELSE
    IF NEW.body IS DISTINCT FROM OLD.body THEN
      NEW.embedding := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_org_memory_clear_embedding ON org_memory;
CREATE TRIGGER trg_org_memory_clear_embedding
  BEFORE UPDATE OF body ON org_memory
  FOR EACH ROW EXECUTE FUNCTION clear_memory_embedding_on_body_change();

DROP TRIGGER IF EXISTS trg_employee_memory_clear_embedding ON employee_memory;
CREATE TRIGGER trg_employee_memory_clear_embedding
  BEFORE UPDATE OF body ON employee_memory
  FOR EACH ROW EXECUTE FUNCTION clear_memory_embedding_on_body_change();

DROP TRIGGER IF EXISTS trg_entity_memory_clear_embedding ON entity_memory;
CREATE TRIGGER trg_entity_memory_clear_embedding
  BEFORE UPDATE OF body ON entity_memory
  FOR EACH ROW EXECUTE FUNCTION clear_memory_embedding_on_body_change();

DROP TRIGGER IF EXISTS trg_conversation_memory_clear_embedding ON conversation_memory;
CREATE TRIGGER trg_conversation_memory_clear_embedding
  BEFORE UPDATE OF body, summary ON conversation_memory
  FOR EACH ROW EXECUTE FUNCTION clear_memory_embedding_on_body_change();

COMMENT ON FUNCTION clear_memory_embedding_on_body_change() IS
  'Nulls pgvector embedding when memory prose changes so retrieval cannot cite stale vectors until re-embed.';
