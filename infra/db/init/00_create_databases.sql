-- Darex Postgres Init — runs on first container boot only
-- Creates all databases needed by the services, enables extensions.
-- File: infra/db/init/00_create_databases.sql

-- Create databases for services that need their own DB
CREATE DATABASE langfuse;
CREATE DATABASE nango;
CREATE DATABASE litellm;
CREATE DATABASE temporal_visibility;
CREATE DATABASE supertokens;

-- Connect to the primary darex DB and enable pgvector
\connect darex

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";

-- Enable Row Level Security at the session level by default
-- (individual tables must still have ENABLE ROW LEVEL SECURITY + policies)
ALTER DATABASE darex SET row_security = on;

-- Create the app role that the application uses (least-privilege)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'darex_app') THEN
    CREATE ROLE darex_app LOGIN PASSWORD 'darex_app_dev_secret';
  END IF;
END
$$;

-- Grant usage on the public schema to the app role
GRANT USAGE ON SCHEMA public TO darex_app;
GRANT CREATE ON SCHEMA public TO darex_app;
