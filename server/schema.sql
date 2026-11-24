CREATE TABLE IF NOT EXISTS stores (
  id uuid PRIMARY KEY, name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE stores ADD COLUMN IF NOT EXISTS profile jsonb NOT NULL DEFAULT '{}';
ALTER TABLE stores ADD COLUMN IF NOT EXISTS profile_version integer NOT NULL DEFAULT 0;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended'));
ALTER TABLE stores ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 0;
-- Only migration/recovery credentials may rotate this value. Ordinary business
-- requests hold a shared store lock through commit and cannot change it.
ALTER TABLE stores ADD COLUMN IF NOT EXISTS ledger_epoch uuid NOT NULL DEFAULT gen_random_uuid();
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY, store_id uuid NOT NULL REFERENCES stores(id),
  username text NOT NULL UNIQUE, display_name text NOT NULL, password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner','clerk','viewer')), active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), device_id text NOT NULL,
  access_hash text NOT NULL UNIQUE, refresh_hash text NOT NULL UNIQUE, previous_refresh_hash text,
  access_expires_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
  revoked boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS platform_disabled boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS historical_only boolean NOT NULL DEFAULT false;
-- Restored actor references can satisfy historical FKs, never become accounts.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='users_historical_frozen' AND conrelid='users'::regclass) THEN
    ALTER TABLE users ADD CONSTRAINT users_historical_frozen CHECK(NOT historical_only OR
      (NOT active AND role='viewer' AND username='~history~'||id::text AND password_hash='!restored-history-no-password'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS users_store_page ON users(store_id,created_at,id);
CREATE INDEX IF NOT EXISTS stores_name_prefix ON stores(lower(name) text_pattern_ops);
CREATE TABLE IF NOT EXISTS merchant_roles (id text PRIMARY KEY);
CREATE TABLE IF NOT EXISTS merchant_permissions (id text PRIMARY KEY);
CREATE TABLE IF NOT EXISTS merchant_role_permissions (
  role_id text REFERENCES merchant_roles(id), permission_id text REFERENCES merchant_permissions(id),
  PRIMARY KEY(role_id,permission_id)
);
INSERT INTO merchant_roles VALUES('owner'),('clerk'),('viewer') ON CONFLICT DO NOTHING;
INSERT INTO merchant_permissions VALUES('account.read'),('account.write'),('store.manage'),('users.manage'),('devices.manage'),('audit.read') ON CONFLICT DO NOTHING;
INSERT INTO merchant_role_permissions SELECT 'owner',id FROM merchant_permissions ON CONFLICT DO NOTHING;
INSERT INTO merchant_role_permissions VALUES('clerk','account.read'),('clerk','account.write'),('viewer','account.read') ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS platform_roles (id text PRIMARY KEY, name text NOT NULL);
CREATE TABLE IF NOT EXISTS platform_permissions (id text PRIMARY KEY);
CREATE TABLE IF NOT EXISTS platform_role_permissions (
  role_id text REFERENCES platform_roles(id), permission_id text REFERENCES platform_permissions(id),
  PRIMARY KEY(role_id,permission_id)
);
INSERT INTO platform_roles VALUES('superadmin','平台超级管理员'),('operator','运营管理员'),('developer','开发者'),('auditor','平台审计员') ON CONFLICT DO NOTHING;
INSERT INTO platform_permissions VALUES('stores.read'),('stores.write'),('users.read'),('users.write'),('licenses.read'),('licenses.write'),('logs.read'),('operators.read'),('operators.write'),('system.read') ON CONFLICT DO NOTHING;
INSERT INTO platform_role_permissions SELECT 'superadmin',id FROM platform_permissions ON CONFLICT DO NOTHING;
INSERT INTO platform_role_permissions SELECT 'operator',id FROM platform_permissions WHERE id IN ('stores.read','stores.write','users.read','users.write','licenses.read','licenses.write','logs.read') ON CONFLICT DO NOTHING;
INSERT INTO platform_role_permissions VALUES('developer','stores.read'),('developer','logs.read'),('developer','system.read'),('auditor','stores.read'),('auditor','licenses.read'),('auditor','logs.read') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS platform_users (
  id uuid PRIMARY KEY, username text NOT NULL UNIQUE, display_name text NOT NULL,
  password_hash text NOT NULL, role_id text NOT NULL REFERENCES platform_roles(id),
  active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS platform_sessions (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES platform_users(id), token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_sessions_expiry ON platform_sessions(expires_at);
CREATE TABLE IF NOT EXISTS store_licenses (
  id uuid PRIMARY KEY, store_id uuid NOT NULL UNIQUE REFERENCES stores(id),
  active boolean NOT NULL DEFAULT true, starts_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz,
  features jsonb NOT NULL CHECK(jsonb_typeof(features)='array'),
  offline_hours integer NOT NULL DEFAULT 168 CHECK(offline_hours BETWEEN 0 AND 8760),
  version integer NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(expires_at IS NULL OR expires_at>starts_at)
);
CREATE TABLE IF NOT EXISTS offline_licenses (
  id uuid PRIMARY KEY, store_id uuid NOT NULL REFERENCES stores(id), device_id text NOT NULL,
  key_id text NOT NULL, payload jsonb NOT NULL, code_hash text NOT NULL UNIQUE,
  issued_by uuid NOT NULL REFERENCES platform_users(id), issued_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS offline_licenses_store ON offline_licenses(store_id,issued_at DESC,id);
CREATE TABLE IF NOT EXISTS platform_audit_events (
  id bigserial PRIMARY KEY, actor_id uuid REFERENCES platform_users(id), store_id uuid REFERENCES stores(id),
  event text NOT NULL, details jsonb NOT NULL DEFAULT '{}', received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_audit_store_page ON platform_audit_events(store_id,id DESC);
CREATE INDEX IF NOT EXISTS platform_audit_retention ON platform_audit_events(received_at);
CREATE TABLE IF NOT EXISTS diagnostic_events (
  id bigserial PRIMARY KEY, request_id text NOT NULL, route text NOT NULL, status integer NOT NULL,
  duration_ms integer NOT NULL, error_code text, received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS diagnostic_events_retention ON diagnostic_events(received_at);
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
CREATE TABLE IF NOT EXISTS audit_events (
  id bigserial PRIMARY KEY, store_id uuid NOT NULL REFERENCES stores(id), user_id uuid REFERENCES users(id),
  device_id text, event text NOT NULL, details jsonb NOT NULL DEFAULT '{}', client_event_id text,
  occurred_at timestamptz, received_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS audit_client_event ON audit_events(store_id,client_event_id);
-- A logical event identity survives restore; the global bigserial is only a
-- local pagination key and may collide with unrelated stores in a new server.
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS event_id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS audit_event_identity ON audit_events(store_id,event_id);
CREATE INDEX IF NOT EXISTS audit_store_page ON audit_events(store_id,id DESC);
CREATE INDEX IF NOT EXISTS audit_business_entity ON audit_events(store_id,event,(COALESCE(details->>'commandId',details->>'taskId',details->>'memberId',details->>'batchId','store')));
CREATE TABLE IF NOT EXISTS releases (
  version_code integer PRIMARY KEY CHECK (version_code > 0), version_name text NOT NULL,
  app_id text NOT NULL, sha256 text NOT NULL, size bigint NOT NULL, file_name text NOT NULL,
  certificate_sha256 text NOT NULL, min_sdk integer NOT NULL DEFAULT 24,
  notes text NOT NULL DEFAULT '', published_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS store_settings (
  store_id uuid PRIMARY KEY REFERENCES stores(id),
  voice_config jsonb NOT NULL DEFAULT '{}',
  voice_config_version integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS voice_config_version integer NOT NULL DEFAULT 0;

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

-- Relational ledger v2. Business records are scoped by a composite store key.
CREATE TABLE IF NOT EXISTS member_profiles (
  store_id uuid NOT NULL REFERENCES stores(id), id text NOT NULL, name text NOT NULL,
  phone text NOT NULL DEFAULT '', phone_normalized text NOT NULL DEFAULT '', notes text NOT NULL DEFAULT '',
  profile_version bigint NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), archived_at timestamptz,
  PRIMARY KEY(store_id,id), CHECK(length(name) BETWEEN 1 AND 128),
  CHECK(length(phone)<=64), CHECK(length(notes)<=2000)
);
CREATE INDEX IF NOT EXISTS member_profiles_page ON member_profiles(store_id,created_at,id);
CREATE INDEX IF NOT EXISTS member_profiles_name ON member_profiles(store_id,lower(name),id);
CREATE INDEX IF NOT EXISTS member_profiles_phone ON member_profiles(store_id,phone_normalized,id);
CREATE INDEX IF NOT EXISTS member_profiles_active_phone ON member_profiles(store_id,(replace(phone_normalized,'+',''))) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS member_profiles_active_name ON member_profiles(store_id,(lower(btrim(regexp_replace(normalize(name,NFKC),'[[:space:]]+',' ','g')))),id) WHERE archived_at IS NULL;
CREATE TABLE IF NOT EXISTS member_tags (
  store_id uuid NOT NULL, member_id text NOT NULL, tag text NOT NULL,
  PRIMARY KEY(store_id,member_id,tag),
  FOREIGN KEY(store_id,member_id) REFERENCES member_profiles(store_id,id) ON DELETE CASCADE,
  CHECK(length(tag) BETWEEN 1 AND 128)
);
CREATE TABLE IF NOT EXISTS member_accounts (
  store_id uuid NOT NULL, member_id text NOT NULL, balance_cents bigint NOT NULL DEFAULT 0,
  version bigint NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(store_id,member_id),
  FOREIGN KEY(store_id,member_id) REFERENCES member_profiles(store_id,id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS account_opening_batches (
  store_id uuid NOT NULL REFERENCES stores(id), batch_id text NOT NULL, source_digest char(64) NOT NULL,
  member_count integer NOT NULL CHECK(member_count>0), payload_digest char(64) NOT NULL, net_balance_cents bigint NOT NULL,
  positive_balance_cents bigint NOT NULL CHECK(positive_balance_cents>=0),
  negative_balance_cents bigint NOT NULL CHECK(negative_balance_cents<=0),
  imported_by uuid NOT NULL REFERENCES users(id), imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(store_id,batch_id), UNIQUE(store_id,source_digest)
);
CREATE TABLE IF NOT EXISTS account_openings (
  store_id uuid NOT NULL, member_id text NOT NULL, batch_id text NOT NULL, source_member_id text,
  opening_balance_cents bigint NOT NULL, row_digest char(64) NOT NULL, confirmed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(store_id,member_id),
  FOREIGN KEY(store_id,member_id) REFERENCES member_profiles(store_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(store_id,batch_id) REFERENCES account_opening_batches(store_id,batch_id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS ledger_entries (
  store_id uuid NOT NULL, entry_id text NOT NULL, member_id text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('recharge','consume','adjustment','reversal')),
  account_version bigint NOT NULL CHECK(account_version>0),
  delta_cents bigint NOT NULL CHECK(delta_cents<>0), balance_before_cents bigint NOT NULL,
  balance_after_cents bigint NOT NULL, actual_pay_cents bigint NOT NULL DEFAULT 0 CHECK(actual_pay_cents>=0),
  gift_cents bigint NOT NULL DEFAULT 0 CHECK(gift_cents>=0), pay_method text NOT NULL DEFAULT '',
  items_summary text NOT NULL DEFAULT '', remark text NOT NULL DEFAULT '',
  actor_id uuid NOT NULL REFERENCES users(id), device_id text NOT NULL, occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(store_id,entry_id), UNIQUE(store_id,member_id,account_version),
  FOREIGN KEY(store_id,member_id) REFERENCES member_profiles(store_id,id) ON DELETE RESTRICT,
  CHECK(balance_after_cents::numeric = balance_before_cents::numeric + delta_cents::numeric),
  CHECK((kind='recharge' AND delta_cents::numeric=actual_pay_cents::numeric+gift_cents::numeric AND actual_pay_cents>0) OR
        (kind='consume' AND delta_cents<0 AND actual_pay_cents=0 AND gift_cents=0) OR
        (kind IN ('adjustment','reversal') AND actual_pay_cents=0 AND gift_cents=0)),
  CHECK(length(pay_method)<=64), CHECK(length(items_summary)<=512), CHECK(length(remark)<=8192)
);
CREATE INDEX IF NOT EXISTS ledger_entries_member_page ON ledger_entries(store_id,member_id,occurred_at DESC,entry_id DESC);
CREATE INDEX IF NOT EXISTS ledger_entries_member_kind_page ON ledger_entries(store_id,member_id,kind,occurred_at DESC,entry_id DESC);
CREATE INDEX IF NOT EXISTS ledger_entries_store_page ON ledger_entries(store_id,occurred_at DESC,entry_id DESC);
CREATE TABLE IF NOT EXISTS ledger_reversals (
  store_id uuid NOT NULL, original_entry_id text NOT NULL, reversal_entry_id text NOT NULL,
  reason text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(store_id,original_entry_id), UNIQUE(store_id,reversal_entry_id),
  FOREIGN KEY(store_id,original_entry_id) REFERENCES ledger_entries(store_id,entry_id) ON DELETE RESTRICT,
  FOREIGN KEY(store_id,reversal_entry_id) REFERENCES ledger_entries(store_id,entry_id) ON DELETE RESTRICT,
  CHECK(original_entry_id<>reversal_entry_id), CHECK(length(reason)<=4096)
);
CREATE TABLE IF NOT EXISTS service_catalog (
  store_id uuid NOT NULL REFERENCES stores(id), id text NOT NULL, name text NOT NULL,
  price_cents bigint NOT NULL CHECK(price_cents>=0), active boolean NOT NULL DEFAULT true,
  position integer NOT NULL DEFAULT 0, version bigint NOT NULL DEFAULT 0,
  PRIMARY KEY(store_id,id), CHECK(length(name) BETWEEN 1 AND 128)
);
CREATE INDEX IF NOT EXISTS service_catalog_order ON service_catalog(store_id,active,position,id);
CREATE TABLE IF NOT EXISTS recharge_plan_items (
  store_id uuid NOT NULL REFERENCES stores(id), id text NOT NULL, pay_cents bigint NOT NULL CHECK(pay_cents>0),
  gift_cents bigint NOT NULL CHECK(gift_cents>=0), position integer NOT NULL DEFAULT 0, active boolean NOT NULL DEFAULT true,
  PRIMARY KEY(store_id,id)
);
CREATE TABLE IF NOT EXISTS store_recharge_settings (
  store_id uuid PRIMARY KEY REFERENCES stores(id), gift_enabled boolean NOT NULL DEFAULT true,
  gift_rate_basis_points integer NOT NULL DEFAULT 1000 CHECK(gift_rate_basis_points BETWEEN 0 AND 10000),
  version bigint NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ledger_command_receipts (
  store_id uuid NOT NULL REFERENCES stores(id), command_id text NOT NULL, ledger_epoch uuid NOT NULL, actor_id uuid NOT NULL REFERENCES users(id),
  device_id text NOT NULL, request_hash char(64) NOT NULL, command_type text NOT NULL, result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(store_id,command_id)
);
-- Immutable per-task response, never a mutable member/configuration fact source.
CREATE TABLE IF NOT EXISTS application_task_receipts (
  store_id uuid NOT NULL REFERENCES stores(id), task_id text NOT NULL, ledger_epoch uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES users(id), device_id text NOT NULL, request_hash char(64) NOT NULL,
  task_type text NOT NULL CHECK(task_type IN ('member.create','member.update','member.archive','configuration.update')),
  entity_id text NOT NULL, result jsonb NOT NULL, completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(store_id,task_id)
);
-- Do not invent a captured epoch for pre-epoch development receipts. NULL
-- history remains readable by migration tooling but can never authorize retry.
ALTER TABLE ledger_command_receipts ADD COLUMN IF NOT EXISTS ledger_epoch uuid;
ALTER TABLE application_task_receipts ADD COLUMN IF NOT EXISTS ledger_epoch uuid;
CREATE TABLE IF NOT EXISTS ledger_restore_receipts (
  store_id uuid NOT NULL REFERENCES stores(id), task_id text NOT NULL,
  actor_id uuid NOT NULL REFERENCES users(id), device_id text NOT NULL,
  target_epoch uuid NOT NULL, source_epoch uuid NOT NULL, restored_epoch uuid NOT NULL,
  source_digest char(64) NOT NULL, member_count integer NOT NULL CHECK(member_count>=0),
  entry_count integer NOT NULL CHECK(entry_count>=0), completed_at timestamptz NOT NULL,
  PRIMARY KEY(store_id,task_id), CHECK(restored_epoch<>source_epoch AND restored_epoch<>target_epoch)
);
CREATE TABLE IF NOT EXISTS consumption_items (
  store_id uuid NOT NULL, entry_id text NOT NULL, position integer NOT NULL CHECK(position>=0),
  service_id text, name text NOT NULL CHECK(length(name) BETWEEN 1 AND 128),
  quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 9999), unit_price_cents bigint NOT NULL CHECK(unit_price_cents>=0),
  line_total_cents bigint NOT NULL CHECK(line_total_cents>=0 AND line_total_cents::numeric=unit_price_cents::numeric*quantity),
  PRIMARY KEY(store_id,entry_id,position), FOREIGN KEY(store_id,entry_id) REFERENCES ledger_entries(store_id,entry_id)
);
CREATE TABLE IF NOT EXISTS payment_records (
  store_id uuid NOT NULL, entry_id text NOT NULL, position integer NOT NULL CHECK(position>=0),
  method text NOT NULL CHECK(length(method) BETWEEN 1 AND 64), amount_cents bigint NOT NULL CHECK(amount_cents>0),
  PRIMARY KEY(store_id,entry_id,position), FOREIGN KEY(store_id,entry_id) REFERENCES ledger_entries(store_id,entry_id)
);
CREATE TABLE IF NOT EXISTS recharge_details (
  store_id uuid NOT NULL, entry_id text NOT NULL, configuration_version bigint NOT NULL CHECK(configuration_version>=0), plan_id text,
  actual_pay_cents bigint NOT NULL CHECK(actual_pay_cents>0), gift_cents bigint NOT NULL CHECK(gift_cents>=0),
  gift_enabled boolean NOT NULL, gift_rate_basis_points integer NOT NULL CHECK(gift_rate_basis_points BETWEEN 0 AND 10000),
  PRIMARY KEY(store_id,entry_id), FOREIGN KEY(store_id,entry_id) REFERENCES ledger_entries(store_id,entry_id),
  CHECK(gift_enabled OR gift_cents=0)
);
CREATE TABLE IF NOT EXISTS store_change_heads (
  store_id uuid PRIMARY KEY REFERENCES stores(id), head bigint NOT NULL DEFAULT 0 CHECK(head>=0)
);
CREATE TABLE IF NOT EXISTS store_changes (
  store_id uuid NOT NULL, cursor bigint NOT NULL, entity_type text NOT NULL, entity_id text NOT NULL,
  change_type text NOT NULL CHECK(change_type IN ('upsert','archive')), recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(store_id,cursor),
  FOREIGN KEY(store_id) REFERENCES stores(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS store_changes_entity ON store_changes(store_id,entity_type,entity_id,cursor);
INSERT INTO store_recharge_settings(store_id) SELECT id FROM stores ON CONFLICT(store_id) DO NOTHING;

-- FOR SHARE needs an UPDATE grant on one harmless column. Prevent those lock
-- grants from becoming actual identity/session/licence/device mutation rights.
CREATE OR REPLACE FUNCTION enforce_recovery_write_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user='member_recovery' THEN
    IF TG_OP='INSERT' AND TG_TABLE_NAME='users' THEN
      IF NOT NEW.historical_only THEN RAISE EXCEPTION 'recovery may only insert frozen historical actors' USING ERRCODE='42501'; END IF;
    ELSIF TG_OP='UPDATE' AND TG_TABLE_NAME IN ('users','sessions','store_licenses','app_devices') THEN
      IF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN RAISE EXCEPTION 'recovery lock grant cannot mutate authorization' USING ERRCODE='42501'; END IF;
    ELSIF TG_OP='UPDATE' AND TG_TABLE_NAME='stores' THEN
      IF (to_jsonb(NEW)-'ledger_epoch') IS DISTINCT FROM (to_jsonb(OLD)-'ledger_epoch') THEN RAISE EXCEPTION 'recovery may only rotate the ledger epoch' USING ERRCODE='42501'; END IF;
    ELSIF TG_OP='UPDATE' AND TG_TABLE_NAME='store_recharge_settings' THEN
      IF OLD.version<>0 OR NOT OLD.gift_enabled OR OLD.gift_rate_basis_points<>1000 THEN RAISE EXCEPTION 'recovery cannot replace business configuration' USING ERRCODE='42501'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS recovery_users_scope ON users;
CREATE TRIGGER recovery_users_scope BEFORE INSERT OR UPDATE ON users FOR EACH ROW EXECUTE FUNCTION enforce_recovery_write_scope();
DROP TRIGGER IF EXISTS recovery_sessions_scope ON sessions;
CREATE TRIGGER recovery_sessions_scope BEFORE UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION enforce_recovery_write_scope();
DROP TRIGGER IF EXISTS recovery_licenses_scope ON store_licenses;
CREATE TRIGGER recovery_licenses_scope BEFORE UPDATE ON store_licenses FOR EACH ROW EXECUTE FUNCTION enforce_recovery_write_scope();
DROP TRIGGER IF EXISTS recovery_devices_scope ON app_devices;
CREATE TRIGGER recovery_devices_scope BEFORE UPDATE ON app_devices FOR EACH ROW EXECUTE FUNCTION enforce_recovery_write_scope();
DROP TRIGGER IF EXISTS recovery_stores_scope ON stores;
CREATE TRIGGER recovery_stores_scope BEFORE UPDATE ON stores FOR EACH ROW EXECUTE FUNCTION enforce_recovery_write_scope();
DROP TRIGGER IF EXISTS recovery_configuration_scope ON store_recharge_settings;
CREATE TRIGGER recovery_configuration_scope BEFORE UPDATE ON store_recharge_settings FOR EACH ROW EXECUTE FUNCTION enforce_recovery_write_scope();

-- Durable typed profile batches; execution and cancellation share task/batch locks.
CREATE TABLE IF NOT EXISTS application_batches(store_id uuid NOT NULL REFERENCES stores(id),batch_id TEXT NOT NULL,ledger_epoch uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users(id),device_id TEXT NOT NULL,request_hash TEXT NOT NULL,source_digest TEXT,item_count integer NOT NULL CHECK(item_count BETWEEN 1 AND 500),created_at timestamptz NOT NULL,PRIMARY KEY(store_id,batch_id));
CREATE TABLE IF NOT EXISTS application_batch_items(store_id uuid NOT NULL,batch_id TEXT NOT NULL,position integer NOT NULL CHECK(position BETWEEN 0 AND 499),task_id TEXT NOT NULL,request_hash TEXT NOT NULL,task_type TEXT NOT NULL CHECK(task_type IN ('member.create','member.update','member.archive')),member_id TEXT,name TEXT,phone TEXT,notes TEXT,tags_present integer NOT NULL CHECK(tags_present IN (0,1)),expected_version bigint,PRIMARY KEY(store_id,task_id),UNIQUE(store_id,batch_id,position),FOREIGN KEY(store_id,batch_id) REFERENCES application_batches(store_id,batch_id),CHECK((task_type='member.create' AND member_id IS NULL AND name IS NOT NULL AND expected_version IS NULL) OR (task_type='member.update' AND member_id IS NOT NULL AND name IS NOT NULL AND expected_version>=0) OR (task_type='member.archive' AND member_id IS NOT NULL AND name IS NULL AND phone IS NULL AND notes IS NULL AND tags_present=0 AND expected_version IS NULL)));
CREATE TABLE IF NOT EXISTS application_batch_tags(store_id uuid NOT NULL,task_id TEXT NOT NULL,position integer NOT NULL CHECK(position BETWEEN 0 AND 31),tag TEXT NOT NULL,PRIMARY KEY(store_id,task_id,position),UNIQUE(store_id,task_id,tag),FOREIGN KEY(store_id,task_id) REFERENCES application_batch_items(store_id,task_id));
CREATE TABLE IF NOT EXISTS application_batch_controls(store_id uuid NOT NULL,batch_id TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('paused','active','cancelled')),version bigint NOT NULL CHECK(version>=0),PRIMARY KEY(store_id,batch_id),FOREIGN KEY(store_id,batch_id) REFERENCES application_batches(store_id,batch_id));
CREATE INDEX IF NOT EXISTS batch_identity_page ON application_batches(store_id,actor_id,device_id,ledger_epoch,batch_id);
CREATE OR REPLACE FUNCTION enforce_batch_control_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.store_id<>OLD.store_id OR NEW.batch_id<>OLD.batch_id OR NEW.version<>OLD.version+1 OR (OLD.state='cancelled' AND NEW.state<>'cancelled') THEN
    RAISE EXCEPTION 'invalid batch transition' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS batch_control_transition ON application_batch_controls;
CREATE TRIGGER batch_control_transition BEFORE UPDATE ON application_batch_controls FOR EACH ROW EXECUTE FUNCTION enforce_batch_control_transition();

-- Derived XLSX artifacts only. The small slot range is a hard total queue
-- and storage bound; artifacts are excluded from ledger backup and restore.
CREATE TABLE IF NOT EXISTS ledger_export_jobs (
  slot smallint PRIMARY KEY CHECK (slot BETWEEN 1 AND 8),
  store_id uuid NOT NULL UNIQUE REFERENCES stores(id), id uuid NOT NULL, ledger_epoch uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES users(id), device_id text NOT NULL, session_id uuid NOT NULL,
  from_at timestamptz NOT NULL, to_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'queued', snapshot_at timestamptz, row_count integer, artifact bytea, failure text,
  CHECK (from_at < to_at AND to_at - from_at <= interval '366 days'),
  CHECK (expires_at > created_at AND expires_at - created_at <= interval '15 minutes'),
  CHECK ((state IN ('queued','running') AND artifact IS NULL AND snapshot_at IS NULL AND row_count IS NULL AND failure IS NULL)
      OR (state='ready' AND artifact IS NOT NULL AND octet_length(artifact) BETWEEN 1 AND 8388608
          AND snapshot_at IS NOT NULL AND row_count IS NOT NULL AND row_count BETWEEN 0 AND 25000 AND failure IS NULL)
      OR (state='failed' AND artifact IS NULL AND snapshot_at IS NULL AND row_count IS NULL AND failure IS NOT NULL
          AND failure IN ('EXPORT_ROW_LIMIT','EXPORT_BYTES_LIMIT','EXPORT_TIMEOUT','EXPORT_CONTEXT_CHANGED','EXPORT_FAILED')))
);

-- A preview rolls back its rows, but may leave planner statistics describing
-- an empty table. In the subsequent import even FK lookups can then scan a
-- whole store through an unrelated index. Recovery may refresh these fixed
-- business tables, without receiving MAINTAIN, ownership, DDL or SQL arguments.
-- Resolve and quote the migration schema once; the definer never searches a
-- caller-controlled schema, including pg_temp.
DO $install$
BEGIN
  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION %1$I.refresh_recovery_statistics() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
    BEGIN
      ANALYZE %1$I.member_profiles, %1$I.ledger_entries,
        %1$I.account_opening_batches, %1$I.application_batches,
        %1$I.ledger_command_receipts, %1$I.store_changes, %1$I.audit_events;
    END;
    $body$
  $definition$, current_schema());
  EXECUTE format('REVOKE ALL ON FUNCTION %I.refresh_recovery_statistics() FROM PUBLIC', current_schema());
END;
$install$;
