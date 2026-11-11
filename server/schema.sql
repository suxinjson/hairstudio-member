CREATE TABLE IF NOT EXISTS stores (
  id uuid PRIMARY KEY, name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE stores ADD COLUMN IF NOT EXISTS profile jsonb NOT NULL DEFAULT '{}';
ALTER TABLE stores ADD COLUMN IF NOT EXISTS profile_version integer NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY, store_id uuid NOT NULL REFERENCES stores(id),
  username text NOT NULL UNIQUE, display_name text NOT NULL, password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner','clerk','viewer')), active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS accounts (
  store_id uuid PRIMARY KEY REFERENCES stores(id), revision integer NOT NULL DEFAULT 0,
  data jsonb NOT NULL, integrity text NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), device_id text NOT NULL,
  access_hash text NOT NULL UNIQUE, refresh_hash text NOT NULL UNIQUE, previous_refresh_hash text,
  access_expires_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
  revoked boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_previous_refresh ON sessions(previous_refresh_hash);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS client_kind text NOT NULL DEFAULT 'web';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS previous_access_hash text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS previous_access_expires_at timestamptz NOT NULL DEFAULT 'epoch';
CREATE TABLE IF NOT EXISTS app_devices (
  store_id uuid NOT NULL REFERENCES stores(id), device_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('native','web')), label text NOT NULL DEFAULT '',
  last_user_id uuid REFERENCES users(id), active boolean NOT NULL DEFAULT true,
  offline_hours integer NOT NULL DEFAULT 168 CHECK (offline_hours BETWEEN 0 AND 8760),
  authorized_until timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(store_id,device_id)
);
ALTER TABLE app_devices ADD COLUMN IF NOT EXISTS hardware_fingerprint text;
ALTER TABLE app_devices ADD COLUMN IF NOT EXISTS device_name text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS app_device_fingerprint ON app_devices(store_id,hardware_fingerprint);
CREATE TABLE IF NOT EXISTS login_limits (
  bucket text PRIMARY KEY, failures integer NOT NULL, window_start timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS operations (
  store_id uuid NOT NULL REFERENCES stores(id), id text NOT NULL, user_id uuid NOT NULL REFERENCES users(id),
  device_id text NOT NULL, method text NOT NULL, request_hash text NOT NULL, result jsonb NOT NULL,
  revision integer NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id,id)
);
CREATE TABLE IF NOT EXISTS audit_events (
  id bigserial PRIMARY KEY, store_id uuid NOT NULL REFERENCES stores(id), user_id uuid REFERENCES users(id),
  device_id text, event text NOT NULL, details jsonb NOT NULL DEFAULT '{}', client_event_id text,
  occurred_at timestamptz, received_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS audit_client_event ON audit_events(store_id,client_event_id);
CREATE INDEX IF NOT EXISTS audit_store_page ON audit_events(store_id,id DESC);
CREATE TABLE IF NOT EXISTS releases (
  version_code integer PRIMARY KEY CHECK (version_code > 0), version_name text NOT NULL,
  app_id text NOT NULL, sha256 text NOT NULL, size bigint NOT NULL, file_name text NOT NULL,
  certificate_sha256 text NOT NULL, min_sdk integer NOT NULL DEFAULT 24,
  notes text NOT NULL DEFAULT '', published_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS store_settings (
  store_id uuid PRIMARY KEY REFERENCES stores(id),
  voice_config jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Pending preview and response are committed atomically with voice financial writes.
CREATE TABLE IF NOT EXISTS voice_dialogs (
  store_id uuid NOT NULL REFERENCES stores(id), scope text NOT NULL,
  pending jsonb NOT NULL, expires_at timestamptz NOT NULL,
  PRIMARY KEY(store_id,scope)
);
CREATE TABLE IF NOT EXISTS voice_requests (
  store_id uuid NOT NULL REFERENCES stores(id), id text NOT NULL,
  request_hash text NOT NULL, response jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(store_id,id)
);
CREATE INDEX IF NOT EXISTS voice_request_expiry ON voice_requests(store_id,received_at);

-- Recent authenticated devices awaiting an explicit owner whitelist update.
CREATE TABLE IF NOT EXISTS voice_device_candidates (
  store_id uuid NOT NULL REFERENCES stores(id), device_open_id text NOT NULL,
  credential_scope text NOT NULL, request_id text NOT NULL, intent_name text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(store_id,device_open_id)
);
