-- RLS Isolation Test
-- Migration 002
-- Verify cross-tenant isolation with a stored procedure test.

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
  INSERT INTO orgs(name, slug) VALUES ('TestOrg Alpha', 'test-org-alpha-' || floor(random()*1000)::text) RETURNING id INTO org1_id;
  
  -- Set session context for org 1 before inserting user
  PERFORM set_config('app.current_org_id', org1_id::TEXT, true);
  INSERT INTO users(org_id, email, role) VALUES (org1_id, 'alice@alpha.com', 'owner') RETURNING id INTO user1_id;

  -- Create org 2
  INSERT INTO orgs(name, slug) VALUES ('TestOrg Beta', 'test-org-beta-' || floor(random()*1000)::text) RETURNING id INTO org2_id;
  
  -- Set session context for org 2 before inserting user
  PERFORM set_config('app.current_org_id', org2_id::TEXT, true);
  INSERT INTO users(org_id, email, role) VALUES (org2_id, 'bob@beta.com', 'owner') RETURNING id INTO user2_id;

  -- Verify session as org 1: must see exactly 1 user (alice)
  PERFORM set_config('app.current_org_id', org1_id::TEXT, true);
  SELECT COUNT(*) INTO visible_count FROM users;
  IF visible_count != 1 THEN
    RAISE EXCEPTION 'RLS ISOLATION FAILURE: org1 session sees % users, expected 1', visible_count;
  END IF;

  -- Verify session as org 2: must see exactly 1 user (bob)
  PERFORM set_config('app.current_org_id', org2_id::TEXT, true);
  SELECT COUNT(*) INTO visible_count FROM users;
  IF visible_count != 1 THEN
    RAISE EXCEPTION 'RLS ISOLATION FAILURE: org2 session sees % users, expected 1', visible_count;
  END IF;

  -- Cleanup test data
  PERFORM set_config('app.current_org_id', org1_id::TEXT, true);
  DELETE FROM users WHERE id = user1_id;
  PERFORM set_config('app.current_org_id', org2_id::TEXT, true);
  DELETE FROM users WHERE id = user2_id;

  DELETE FROM orgs WHERE id IN (org1_id, org2_id);

  RETURN 'PASS: RLS isolation verified — two orgs data never cross in a query';
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;

GRANT EXECUTE ON FUNCTION test_rls_isolation() TO darex_app;
