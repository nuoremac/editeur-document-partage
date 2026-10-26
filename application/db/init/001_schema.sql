CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS people (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  email text NOT NULL UNIQUE,
  password_hash text,
  account_role text NOT NULL DEFAULT 'EDITOR' CHECK (account_role IN ('EDITOR', 'ADMIN')),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE people ADD COLUMN IF NOT EXISTS password_hash text;
ALTER TABLE people ADD COLUMN IF NOT EXISTS account_role text NOT NULL DEFAULT 'EDITOR';

CREATE TABLE IF NOT EXISTS sessions (
  id_hash text PRIMARY KEY,
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS abuse_attempts (
  id bigserial PRIMARY KEY,
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_abuse_attempts_person_time ON abuse_attempts(person_id, created_at DESC);

CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  owner_id uuid NOT NULL REFERENCES people(id),
  content text NOT NULL DEFAULT '',
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS document_members (
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('OWNER', 'EDITOR')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, person_id)
);

CREATE TABLE IF NOT EXISTS document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  revision bigint NOT NULL,
  title text NOT NULL,
  content text NOT NULL,
  state_update bytea,
  created_by uuid NOT NULL REFERENCES people(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, revision)
);
ALTER TABLE document_versions ADD COLUMN IF NOT EXISTS state_update bytea;

CREATE TABLE IF NOT EXISTS daily_credits (
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  period date NOT NULL,
  used_chars integer NOT NULL DEFAULT 0 CHECK (used_chars >= 0),
  limit_chars integer NOT NULL DEFAULT 10000 CHECK (limit_chars > 0),
  PRIMARY KEY (person_id, period),
  CHECK (used_chars <= limit_chars)
);

CREATE TABLE IF NOT EXISTS temporary_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  reason text NOT NULL,
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS download_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(24), 'hex'),
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  creator_id uuid NOT NULL REFERENCES people(id),
  initial_limit integer NOT NULL CHECK (initial_limit > 0),
  remaining integer NOT NULL CHECK (remaining >= 0 AND remaining <= initial_limit),
  state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'EXHAUSTED', 'EXPIRED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz
);

CREATE TABLE IF NOT EXISTS reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id uuid NOT NULL REFERENCES download_links(id) ON DELETE CASCADE,
  request_key text NOT NULL,
  document_revision bigint NOT NULL,
  captured_title text NOT NULL,
  captured_content text NOT NULL,
  state text NOT NULL DEFAULT 'QUEUED' CHECK (state IN ('QUEUED', 'PROCESSING', 'READY', 'FAILED')),
  pdf_key text,
  error_message text,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (link_id, request_key)
);

ALTER TABLE reservations ADD COLUMN IF NOT EXISTS lease_until timestamptz;
UPDATE reservations SET state = 'QUEUED' WHERE state = 'PROCESSING' AND lease_until IS NULL;

CREATE INDEX IF NOT EXISTS idx_document_members_person ON document_members(person_id);
CREATE INDEX IF NOT EXISTS idx_reservations_queue ON reservations(state, created_at);
CREATE INDEX IF NOT EXISTS idx_links_document ON download_links(document_id);

CREATE TABLE IF NOT EXISTS document_yjs_state (
  document_id uuid PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  state_update bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS collaboration_operations (
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL,
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, operation_id)
);

CREATE TABLE IF NOT EXISTS last_copy_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id uuid NOT NULL UNIQUE REFERENCES download_links(id) ON DELETE CASCADE,
  recipient_email text NOT NULL,
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'SENDING', 'SENT')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_last_copy_notification_queue ON last_copy_notifications(state, next_attempt_at);
