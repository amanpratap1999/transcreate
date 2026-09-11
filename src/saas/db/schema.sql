-- ============================================================================
-- TRANSCREATE SAAS — AUTHORITATIVE POSTGRESQL SCHEMA WITH ROW LEVEL SECURITY
-- Applied by: docker-entrypoint-initdb.d (compose), `transcreate db migrate` (CLI)
-- ============================================================================
-- DURABILITY/TENANCY MODEL
--   * The application connects as NON-superuser role `transcreate_app`
--     (no BYPASSRLS) — RLS is a real second tenant boundary.
--   * All tables below use FORCE ROW LEVEL SECURITY: even the table owner
--     is subject to policies.
--   * Tenant context is ONLY set via SET LOCAL inside explicit transactions
--     (see RealPostgreSqlDatabaseClient.withTenantTransaction).
-- ============================================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Enums
DO $$ BEGIN
  CREATE TYPE role_type AS ENUM ('owner', 'admin', 'editor', 'viewer');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE job_status_type AS ENUM ('queued', 'processing', 'review_ready', 'approved', 'completed', 'failed', 'cancelled');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE hunk_decision_type AS ENUM ('accepted', 'rejected', 'modified');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE glossary_category_type AS ENUM ('metaphor', 'code_identifier', 'terminology');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- 1. Organizations (Tenants)
CREATE TABLE IF NOT EXISTS organizations (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(100) UNIQUE NOT NULL,
  plan VARCHAR(50) DEFAULT 'pro' NOT NULL,
  token_quota_monthly BIGINT DEFAULT 1000000 NOT NULL,
  tokens_used_this_month BIGINT DEFAULT 0 NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- 2. Users
CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(64) PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  full_name VARCHAR(255) NOT NULL,
  is_superadmin BOOLEAN DEFAULT FALSE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- 3. Memberships (Tenant <-> User mapping with RBAC)
CREATE TABLE IF NOT EXISTS memberships (
  id VARCHAR(64) PRIMARY KEY,
  org_id VARCHAR(64) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role role_type DEFAULT 'editor' NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  CONSTRAINT uq_membership_org_user UNIQUE (org_id, user_id)
);

-- 4. Projects
CREATE TABLE IF NOT EXISTS projects (
  id VARCHAR(64) PRIMARY KEY,
  org_id VARCHAR(64) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(100) NOT NULL,
  source_locale VARCHAR(10) NOT NULL,
  target_locales TEXT[] NOT NULL,
  vcs_repository_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  CONSTRAINT uq_project_org_slug UNIQUE (org_id, slug)
);

-- 5. Documents
CREATE TABLE IF NOT EXISTS documents (
  id VARCHAR(64) PRIMARY KEY,
  org_id VARCHAR(64) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id VARCHAR(64) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  file_path VARCHAR(1024) NOT NULL,
  title VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  CONSTRAINT uq_document_project_path UNIQUE (project_id, file_path)
);

-- 6. Document Versions (content persisted to S3; s3_storage_key references it)
CREATE TABLE IF NOT EXISTS document_versions (
  id VARCHAR(64) PRIMARY KEY,
  org_id VARCHAR(64) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  document_id VARCHAR(64) NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_number INT NOT NULL,
  content_hash VARCHAR(128) NOT NULL,
  content TEXT NOT NULL,
  s3_storage_key VARCHAR(1024),
  created_by VARCHAR(64) REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  CONSTRAINT uq_document_version UNIQUE (document_id, version_number)
);

-- 7. Transcreation Jobs
CREATE TABLE IF NOT EXISTS transcreation_jobs (
  id VARCHAR(64) PRIMARY KEY,
  org_id VARCHAR(64) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id VARCHAR(64) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  document_id VARCHAR(64) NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  document_version_id VARCHAR(64) NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  target_locale VARCHAR(10) NOT NULL,
  status job_status_type DEFAULT 'queued' NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL,
  progress_percent INT DEFAULT 0 NOT NULL,
  model_used VARCHAR(100),
  prompt_tokens INT DEFAULT 0 NOT NULL,
  completion_tokens INT DEFAULT 0 NOT NULL,
  estimated_cost_cents NUMERIC(10, 4) DEFAULT 0 NOT NULL,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  CONSTRAINT uq_job_org_idempotency UNIQUE (org_id, idempotency_key)
);

-- 8. Intent Cards
CREATE TABLE IF NOT EXISTS intent_cards (
  id VARCHAR(64) PRIMARY KEY,
  org_id VARCHAR(64) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  job_id VARCHAR(64) NOT NULL REFERENCES transcreation_jobs(id) ON DELETE CASCADE,
  section_index INT NOT NULL,
  code_block_index INT,
  original_metaphor TEXT NOT NULL,
  target_metaphor TEXT NOT NULL,
  mismatch_reason TEXT NOT NULL,
  rationale TEXT NOT NULL,
  cultural_context TEXT NOT NULL,
  confidence NUMERIC(3, 2) DEFAULT 0.90 NOT NULL,
  alternatives JSONB DEFAULT '[]'::jsonb NOT NULL,
  selected_alternative_id VARCHAR(64),
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- 9. Hunk Decisions
CREATE TABLE IF NOT EXISTS hunk_decisions (
  id VARCHAR(64) PRIMARY KEY,
  org_id VARCHAR(64) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  job_id VARCHAR(64) NOT NULL REFERENCES transcreation_jobs(id) ON DELETE CASCADE,
  hunk_index INT NOT NULL,
  hunk_type VARCHAR(20) NOT NULL,
  decision hunk_decision_type NOT NULL,
  original_text TEXT NOT NULL,
  suggested_text TEXT NOT NULL,
  final_text TEXT NOT NULL,
  reviewer_id VARCHAR(64) REFERENCES users(id),
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  CONSTRAINT uq_hunk_decision_job_index UNIQUE (job_id, hunk_index)
);

-- 10. Glossary Entries (Project & Organization Level Analogy Memory)
CREATE TABLE IF NOT EXISTS glossary_entries (
  id VARCHAR(64) PRIMARY KEY,
  org_id VARCHAR(64) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id VARCHAR(64) REFERENCES projects(id) ON DELETE CASCADE,
  target_locale VARCHAR(10) NOT NULL,
  category glossary_category_type NOT NULL,
  source_term VARCHAR(255) NOT NULL,
  target_term VARCHAR(255) NOT NULL,
  rationale TEXT,
  is_approved BOOLEAN DEFAULT TRUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- 11. Audit Logs
CREATE TABLE IF NOT EXISTS audit_logs (
  id VARCHAR(64) PRIMARY KEY,
  org_id VARCHAR(64) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id VARCHAR(64) REFERENCES users(id),
  action VARCHAR(100) NOT NULL,
  resource_type VARCHAR(50) NOT NULL,
  resource_id VARCHAR(64) NOT NULL,
  metadata JSONB DEFAULT '{}'::jsonb NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- 12. Auth Sessions (durable login sessions; revocation is authoritative here)
CREATE TABLE IF NOT EXISTS auth_sessions (
  jti VARCHAR(64) PRIMARY KEY,
  org_id VARCHAR(64) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role role_type NOT NULL,
  user_agent TEXT,
  ip_address VARCHAR(64),
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

-- 13. Tenant LLM usage / budget records (per org, per month)
CREATE TABLE IF NOT EXISTS tenant_usage (
  id VARCHAR(64) PRIMARY KEY,
  org_id VARCHAR(64) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  month VARCHAR(7) NOT NULL, -- 'YYYY-MM'
  total_prompt_tokens BIGINT DEFAULT 0 NOT NULL,
  total_completion_tokens BIGINT DEFAULT 0 NOT NULL,
  total_cost_cents NUMERIC(12, 4) DEFAULT 0 NOT NULL,
  request_count BIGINT DEFAULT 0 NOT NULL,
  last_used_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  CONSTRAINT uq_tenant_usage_org_month UNIQUE (org_id, month)
);

-- 14. Transactional outbox for DB->queue consistency
CREATE TABLE IF NOT EXISTS job_outbox (
  id VARCHAR(64) PRIMARY KEY,
  org_id VARCHAR(64) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  job_id VARCHAR(64) NOT NULL REFERENCES transcreation_jobs(id) ON DELETE CASCADE,
  dispatched_at TIMESTAMPTZ,
  attempts INT DEFAULT 0 NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- ============================================================================
-- INDEXES FOR HIGH-THROUGHPUT SAAS OPERATIONS
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(org_id);
CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project_id);
CREATE INDEX IF NOT EXISTS idx_document_versions_doc ON document_versions(document_id);
CREATE INDEX IF NOT EXISTS idx_jobs_org_status ON transcreation_jobs(org_id, status);
CREATE INDEX IF NOT EXISTS idx_intent_cards_job ON intent_cards(job_id);
CREATE INDEX IF NOT EXISTS idx_hunk_decisions_job ON hunk_decisions(job_id);
CREATE INDEX IF NOT EXISTS idx_glossary_locale ON glossary_entries(org_id, target_locale, project_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_org_created ON audit_logs(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON job_outbox(dispatched_at) WHERE dispatched_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_stuck_queued ON transcreation_jobs(status, created_at) WHERE status = 'queued';

-- ============================================================================
-- ROW LEVEL SECURITY (RLS) — SECOND INDEPENDENT TENANT BOUNDARY
-- Strict database-level isolation: queries without current_setting('app.current_org_id')
-- return ZERO rows. FORCE = even table owner is subject to policies.
-- ============================================================================
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE transcreation_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE intent_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE hunk_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE glossary_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_outbox ENABLE ROW LEVEL SECURITY;

-- NOTE: users is intentionally NOT RLS-scoped (users are global identities;
-- memberships bind them to tenants and are RLS-protected). Password hashes are
-- never returned by the API surface.

DO $$ BEGIN
  ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
  ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
  ALTER TABLE projects FORCE ROW LEVEL SECURITY;
  ALTER TABLE documents FORCE ROW LEVEL SECURITY;
  ALTER TABLE document_versions FORCE ROW LEVEL SECURITY;
  ALTER TABLE transcreation_jobs FORCE ROW LEVEL SECURITY;
  ALTER TABLE intent_cards FORCE ROW LEVEL SECURITY;
  ALTER TABLE hunk_decisions FORCE ROW LEVEL SECURITY;
  ALTER TABLE glossary_entries FORCE ROW LEVEL SECURITY;
  ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
  ALTER TABLE auth_sessions FORCE ROW LEVEL SECURITY;
  ALTER TABLE tenant_usage FORCE ROW LEVEL SECURITY;
  ALTER TABLE job_outbox FORCE ROW LEVEL SECURITY;
EXCEPTION
  WHEN OTHERS THEN RAISE NOTICE 'FORCE RLS already applied: %', SQLERRM;
END $$;

-- Policy helper: tenant id from session, NULL when unset (=> zero rows).
CREATE OR REPLACE FUNCTION app_tenant() RETURNS VARCHAR(64) AS $$
  SELECT NULLIF(current_setting('app.current_org_id', true), '')::varchar(64);
$$ LANGUAGE sql STABLE;

CREATE POLICY rls_organizations ON organizations
  FOR ALL USING (id = app_tenant());

CREATE POLICY rls_memberships ON memberships
  FOR ALL USING (org_id = app_tenant());

CREATE POLICY rls_projects ON projects
  FOR ALL USING (org_id = app_tenant());

CREATE POLICY rls_documents ON documents
  FOR ALL USING (org_id = app_tenant());

CREATE POLICY rls_document_versions ON document_versions
  FOR ALL USING (org_id = app_tenant());

CREATE POLICY rls_transcreation_jobs ON transcreation_jobs
  FOR ALL USING (org_id = app_tenant());

CREATE POLICY rls_intent_cards ON intent_cards
  FOR ALL USING (org_id = app_tenant());

CREATE POLICY rls_hunk_decisions ON hunk_decisions
  FOR ALL USING (org_id = app_tenant());

CREATE POLICY rls_glossary_entries ON glossary_entries
  FOR ALL USING (org_id = app_tenant());

CREATE POLICY rls_audit_logs ON audit_logs
  FOR ALL USING (org_id = app_tenant());

CREATE POLICY rls_auth_sessions ON auth_sessions
  FOR ALL USING (org_id = app_tenant());

CREATE POLICY rls_tenant_usage ON tenant_usage
  FOR ALL USING (org_id = app_tenant());

CREATE POLICY rls_job_outbox ON job_outbox
  FOR ALL USING (org_id = app_tenant());

-- ============================================================================
-- APPLICATION ROLE (non-superuser, no BYPASSRLS)
-- ============================================================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'transcreate_app') THEN
    CREATE ROLE transcreate_app LOGIN PASSWORD 'transcreate_app_local_password' NOBYPASSRLS NOSUPERUSER;
  END IF;
EXCEPTION
  WHEN OTHERS THEN RAISE NOTICE 'role handling skipped: %', SQLERRM;
END $$;

GRANT USAGE ON SCHEMA public TO transcreate_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO transcreate_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO transcreate_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO transcreate_app;
