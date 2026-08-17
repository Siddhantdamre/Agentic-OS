-------------------------------------------------------------------------------
-- Two-org vector RLS isolation — run as darex_app (superuser bypasses RLS).
--
--   psql -U darex_app -d darex -f infra/scripts/check-memory-rls.sql
--   # or from superuser:
--   psql -U darex -d darex -c "SET ROLE darex_app" -f infra/scripts/check-memory-rls.sql
--
-- Expects migration 013 applied. Synthetic orgs only; cleaned up on success
-- or failure. No production data.
-------------------------------------------------------------------------------

SET ROLE darex_app;

DO $$
DECLARE
  org_a UUID;
  org_b UUID;
  mem_a UUID;
  mem_b UUID;
  src_a UUID;
  visible INTEGER;
  vec_a vector(1536);
  vec_b vector(1536);
  cross_insert_ok BOOLEAN := false;
BEGIN
  IF current_user <> 'darex_app' THEN
    RAISE EXCEPTION 'check-memory-rls must run as darex_app (got %); superuser bypasses RLS', current_user;
  END IF;

  vec_a := array_fill(0.001::float4, ARRAY[1536])::vector;
  vec_b := array_fill(0.002::float4, ARRAY[1536])::vector;

  INSERT INTO orgs (name, slug, status)
  VALUES (
    'Memory RLS Alpha',
    'mem-rls-a-' || substr(md5(random()::text), 1, 12),
    'active'
  )
  RETURNING id INTO org_a;

  INSERT INTO orgs (name, slug, status)
  VALUES (
    'Memory RLS Beta',
    'mem-rls-b-' || substr(md5(random()::text), 1, 12),
    'active'
  )
  RETURNING id INTO org_b;

  BEGIN
    PERFORM set_config('app.current_org_id', org_a::text, true);
    INSERT INTO org_memory (org_id, kind, title, body, embedding, source, source_ref, content_hash)
    VALUES (
      org_a,
      'faq',
      'Alpha snippet',
      'Org A stored memory for isolation test',
      vec_a,
      'upload',
      'check-memory-rls/a',
      md5('org-a-body')
    )
    RETURNING id INTO mem_a;

    INSERT INTO entity_memory (
      org_id, entity_type, entity_id, kind, title, body, embedding, source, source_ref, content_hash
    )
    VALUES (
      org_a,
      'contact',
      'alpha-1',
      'fact',
      'Alpha contact',
      'Prefers 3BHK Andheri West',
      vec_a,
      'extract',
      'check-memory-rls/entity-a',
      md5('org-a-entity')
    );

    INSERT INTO knowledge_sources (org_id, connector, path, content_hash, status)
    VALUES (org_a, 'upload', '/check/a.txt', md5('file-a'), 'ready')
    RETURNING id INTO src_a;

    INSERT INTO ingestion_jobs (org_id, source_id, state)
    VALUES (org_a, src_a, 'queued');

    INSERT INTO memory_edges (org_id, from_id, to_id, from_kind, to_kind, rel, weight)
    VALUES (org_a, mem_a, mem_a, 'org_memory', 'org_memory', 'self_test', 1.0);

    PERFORM set_config('app.current_org_id', org_b::text, true);
    INSERT INTO org_memory (org_id, kind, title, body, embedding, source, source_ref, content_hash)
    VALUES (
      org_b,
      'faq',
      'Beta snippet',
      'Org B stored memory for isolation test',
      vec_b,
      'upload',
      'check-memory-rls/b',
      md5('org-b-body')
    )
    RETURNING id INTO mem_b;

    -- Org A session: exactly one org_memory vector row, and it is A's.
    PERFORM set_config('app.current_org_id', org_a::text, true);

    SELECT count(*) INTO visible FROM org_memory;
    IF visible <> 1 THEN
      RAISE EXCEPTION 'RLS FAILURE: org A sees % org_memory rows, expected 1', visible;
    END IF;

    SELECT count(*) INTO visible FROM org_memory WHERE id = mem_b;
    IF visible <> 0 THEN
      RAISE EXCEPTION 'RLS FAILURE: org A can see org B vector row';
    END IF;

    SELECT count(*) INTO visible FROM org_memory WHERE embedding IS NOT NULL;
    IF visible <> 1 THEN
      RAISE EXCEPTION 'RLS FAILURE: org A vector visibility = %, expected 1', visible;
    END IF;

    SELECT count(*) INTO visible FROM entity_memory;
    IF visible <> 1 THEN
      RAISE EXCEPTION 'RLS FAILURE: org A sees % entity_memory rows, expected 1', visible;
    END IF;

    SELECT count(*) INTO visible FROM knowledge_sources;
    IF visible <> 1 THEN
      RAISE EXCEPTION 'RLS FAILURE: org A sees % knowledge_sources, expected 1', visible;
    END IF;

    SELECT count(*) INTO visible FROM ingestion_jobs;
    IF visible <> 1 THEN
      RAISE EXCEPTION 'RLS FAILURE: org A sees % ingestion_jobs, expected 1', visible;
    END IF;

    SELECT count(*) INTO visible FROM memory_edges;
    IF visible <> 1 THEN
      RAISE EXCEPTION 'RLS FAILURE: org A sees % memory_edges, expected 1', visible;
    END IF;

    -- WITH CHECK: darex_app must not insert a row for the other org.
    BEGIN
      INSERT INTO org_memory (org_id, kind, title, body, embedding, source, source_ref, content_hash)
      VALUES (
        org_b,
        'faq',
        'spoof',
        'cross-tenant write',
        vec_b,
        'upload',
        'check-memory-rls/spoof',
        md5('spoof')
      );
      cross_insert_ok := true;
    EXCEPTION
      WHEN insufficient_privilege OR check_violation OR others THEN
        -- new row violates row-level security policy (42501) lands in OTHERS
        IF SQLERRM LIKE '%row-level security%' OR SQLSTATE = '42501' THEN
          cross_insert_ok := false;
        ELSE
          RAISE;
        END IF;
    END;

    IF cross_insert_ok THEN
      RAISE EXCEPTION 'RLS FAILURE: org A was allowed to INSERT org B vector row';
    END IF;

    -- Org B session: only B's vector.
    PERFORM set_config('app.current_org_id', org_b::text, true);

    SELECT count(*) INTO visible FROM org_memory;
    IF visible <> 1 THEN
      RAISE EXCEPTION 'RLS FAILURE: org B sees % org_memory rows, expected 1', visible;
    END IF;

    SELECT count(*) INTO visible FROM org_memory WHERE id = mem_a;
    IF visible <> 0 THEN
      RAISE EXCEPTION 'RLS FAILURE: org B can see org A vector row';
    END IF;

    SELECT count(*) INTO visible FROM entity_memory;
    IF visible <> 0 THEN
      RAISE EXCEPTION 'RLS FAILURE: org B sees org A entity_memory';
    END IF;

    -- Unique content-hash upsert key (same org, same source tuple).
    PERFORM set_config('app.current_org_id', org_a::text, true);
    BEGIN
      INSERT INTO org_memory (org_id, kind, title, body, source, source_ref, content_hash)
      VALUES (org_a, 'faq', 'dup', 'dup', 'upload', 'check-memory-rls/a', md5('org-a-body'));
      RAISE EXCEPTION 'UNIQUE FAILURE: duplicate (org_id, source, source_ref, content_hash) allowed';
    EXCEPTION
      WHEN unique_violation THEN
        NULL;
    END;

    RAISE NOTICE 'PASS: two-org vector RLS — darex_app INSERT/SELECT own org only';
  EXCEPTION
    WHEN OTHERS THEN
      DELETE FROM orgs WHERE id IN (org_a, org_b);
      RAISE;
  END;

  DELETE FROM orgs WHERE id IN (org_a, org_b);
END
$$;

RESET ROLE;
