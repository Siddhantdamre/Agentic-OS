##############################################################################
# RLS Test — Migration 002
# Verify cross-tenant isolation with a stored procedure test.
# Run after 001_core_schema.sql.
# This migration is also the source of truth for Phase 1 exit criteria.
##############################################################################

\connect darex

-- Test function: inserts two orgs + users, then verifies RLS prevents cross-tenant reads.
-- Returns: 'PASS' or raises an exception with details.
CREATE OR REPLACE FUNCTION test_rls_isolation()
RETURNS TEXT AS $$
DECLARE
  org1_id UUID;
  org2_id UUID;
  user1_id UUID;
  user2_id UUID;
  visible_count INTEGER;
BEGIN
  -- Create org 1
  INSERT INTO orgs(name, slug) VALUES ('TestOrg Alpha', 'test-org-alpha') RETURNING id INTO org1_id;
  INSERT INTO users(org_id, email, role) VALUES (org1_id, 'alice@alpha.com', 'owner') RETURNING id INTO user1_id;

  -- Create org 2
  INSERT INTO orgs(name, slug) VALUES ('TestOrg Beta', 'test-org-beta') RETURNING id INTO org2_id;
  INSERT INTO users(org_id, email, role) VALUES (org2_id, 'bob@beta.com', 'owner') RETURNING id INTO user2_id;

  -- Simulate session as org 1
  PERFORM set_config('app.current_org_id', org1_id::TEXT, true);
  SELECT COUNT(*) INTO visible_count FROM users;

  -- Org 1 session must see exactly 1 user (alice only)
  IF visible_count != 1 THEN
    RAISE EXCEPTION 'RLS ISOLATION FAILURE: org1 session sees % users, expected 1', visible_count;
  END IF;

  -- Simulate session as org 2
  PERFORM set_config('app.current_org_id', org2_id::TEXT, true);
  SELECT COUNT(*) INTO visible_count FROM users;

  -- Org 2 session must see exactly 1 user (bob only)
  IF visible_count != 1 THEN
    RAISE EXCEPTION 'RLS ISOLATION FAILURE: org2 session sees % users, expected 1', visible_count;
  END IF;

  -- Cleanup test data
  DELETE FROM orgs WHERE id IN (org1_id, org2_id);

  RETURN 'PASS: RLS isolation verified — no cross-tenant data leakage';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Immediately run the test and display the result
SELECT test_rls_isolation() AS rls_test_result;
