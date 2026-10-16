-- 045 — a market fact cannot exist without a source.
--
-- Market context is the difference between a report and business intelligence:
-- an employee that knows a lead went quiet is useful; one that knows it went
-- quiet in the month stamp duty changed is worth paying for.
--
-- It is also the fastest way to put a confident wrong number in front of a
-- customer. The agent is instructed to cite the source of any market fact it
-- relies on, and a fact with no source makes that instruction unfollowable —
-- the model either drops the citation or invents one.
--
-- market-context.js refuses an unsourced fact at write time, but a script is a
-- convention and this is a rule. Anything that can INSERT into org_memory can
-- bypass a script; nothing bypasses a constraint.
--
-- Scoped deliberately to kind='market'. A summary, an FAQ or an SOP is the
-- business describing itself and needs no external provenance; a claim about
-- the world outside does.
--
-- Idempotent: safe to re-run.

ALTER TABLE org_memory DROP CONSTRAINT IF EXISTS org_memory_market_needs_source;

ALTER TABLE org_memory ADD CONSTRAINT org_memory_market_needs_source
  CHECK (
    kind IS DISTINCT FROM 'market'
    OR (source_ref IS NOT NULL AND btrim(source_ref) <> '')
  );

COMMENT ON CONSTRAINT org_memory_market_needs_source ON org_memory IS
  'A market fact must name where it came from. The agent cites the source in any '
  'sentence relying on the fact, so an unsourced one makes that impossible and '
  'invites an invented citation.';
