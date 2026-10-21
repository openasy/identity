import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Forward-only migrations (ADR 0010): append new entries, never edit or remove old ones.
const MIGRATIONS = [
  // 0.1.0: settings, such as the signing keys of the OpenID provider, sealed with the key-encryption key (ADR 0021).
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  // 0.1.0: the directory and the OpenID provider (ADR 0033). People are @openasy/auth's auth_users; groups decide who
  // may sign in to which application, and go to applications in the groups claim.
  `CREATE TABLE groups (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL UNIQUE COLLATE NOCASE,
     description TEXT NOT NULL DEFAULT '',
     -- "<provider>:<group>": members come from that identity provider's group at each sign-in, not by hand.
     synced_from TEXT UNIQUE,
     created_at TEXT NOT NULL
   );
   CREATE TABLE group_members (
     group_id TEXT NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
     user_id TEXT NOT NULL,
     added_at TEXT NOT NULL,
     PRIMARY KEY (group_id, user_id)
   );
   CREATE INDEX group_members_user ON group_members (user_id);
   -- OpenID Connect clients. The secret is sealed: the provider needs it in the clear to check client_secret_basic.
   CREATE TABLE applications (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     template TEXT NOT NULL,
     client_secret TEXT NOT NULL,
     redirect_uris TEXT NOT NULL,
     post_logout_redirect_uris TEXT NOT NULL DEFAULT '[]',
     everyone INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL
   );
   CREATE TABLE application_groups (
     application_id TEXT NOT NULL REFERENCES applications (id) ON DELETE CASCADE,
     group_id TEXT NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
     PRIMARY KEY (application_id, group_id)
   );
   -- What oidc-provider stores: sessions, interactions, codes, tokens and grants, as JSON.
   CREATE TABLE oidc_models (
     model TEXT NOT NULL,
     id TEXT NOT NULL,
     payload TEXT NOT NULL,
     grant_id TEXT,
     uid TEXT,
     user_code TEXT,
     expires_at INTEGER,
     consumed_at INTEGER,
     PRIMARY KEY (model, id)
   );
   CREATE INDEX oidc_models_grant ON oidc_models (grant_id);
   CREATE INDEX oidc_models_uid ON oidc_models (uid);`,
  // 0.1.0: a second factor per group, and the audit log (ADR 0013): kept 400 days, also written to the JSON log.
  `ALTER TABLE groups ADD COLUMN mfa TEXT NOT NULL DEFAULT 'optional' CHECK (mfa IN ('optional', 'required'));
   CREATE TABLE audit (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at TEXT NOT NULL,
     type TEXT NOT NULL,
     actor TEXT,
     target TEXT,
     application TEXT,
     method TEXT,
     ip TEXT,
     detail TEXT
   );
   CREATE INDEX audit_at ON audit (at);`,
  // 0.1.0: groups that only accept a passkey (ADR 0034).
  `ALTER TABLE groups RENAME COLUMN mfa TO mfa_old;
   ALTER TABLE groups ADD COLUMN mfa TEXT NOT NULL DEFAULT 'optional' CHECK (mfa IN ('optional', 'required', 'passkey'));
   UPDATE groups SET mfa = mfa_old;
   ALTER TABLE groups DROP COLUMN mfa_old;`,
  // 0.1.0: SCIM (ADR 0034). People and groups an identity provider sends: their ids there, and which are its.
  `CREATE TABLE scim_users (
     user_id TEXT PRIMARY KEY,
     user_name TEXT NOT NULL UNIQUE COLLATE NOCASE,
     external_id TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   ALTER TABLE groups ADD COLUMN external_id TEXT;`,
  // 0.1.0: LDAP and Active Directory (ADR 0034). Each directory is read on a schedule; its people sign in with the
  // password it keeps, checked there.
  `CREATE TABLE directories (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL UNIQUE COLLATE NOCASE,
     kind TEXT NOT NULL CHECK (kind IN ('active-directory', 'ldap')),
     url TEXT NOT NULL,
     start_tls INTEGER NOT NULL DEFAULT 0,
     ca_cert TEXT,
     bind_dn TEXT NOT NULL,
     bind_password TEXT NOT NULL,
     base_dn TEXT NOT NULL,
     user_filter TEXT NOT NULL,
     email_attribute TEXT NOT NULL,
     name_attribute TEXT NOT NULL,
     group_base_dn TEXT,
     group_filter TEXT,
     sync_minutes INTEGER NOT NULL DEFAULT 60,
     last_sync_at TEXT,
     last_error TEXT,
     last_counts TEXT,
     created_at TEXT NOT NULL
   );
   CREATE TABLE directory_users (
     user_id TEXT PRIMARY KEY,
     directory_id TEXT NOT NULL REFERENCES directories (id) ON DELETE CASCADE,
     dn TEXT NOT NULL,
     seen_at TEXT NOT NULL
   );
   CREATE INDEX directory_users_directory ON directory_users (directory_id);`,
  // 0.1.0: SAML 2.0 applications (ADR 0034). Identity answers at the ACS address registered here, never at the one a
  // request names; a request waits here while its person signs in.
  `ALTER TABLE applications ADD COLUMN protocol TEXT NOT NULL DEFAULT 'oidc' CHECK (protocol IN ('oidc', 'saml'));
   ALTER TABLE applications ADD COLUMN saml_entity_id TEXT;
   ALTER TABLE applications ADD COLUMN saml_acs_url TEXT;
   ALTER TABLE applications ADD COLUMN saml_name_id TEXT CHECK (saml_name_id IN ('email', 'persistent'));
   CREATE UNIQUE INDEX applications_saml_entity ON applications (saml_entity_id) WHERE saml_entity_id IS NOT NULL;
   CREATE TABLE saml_requests (
     id TEXT PRIMARY KEY,
     application_id TEXT NOT NULL REFERENCES applications (id) ON DELETE CASCADE,
     request_id TEXT,
     relay_state TEXT,
     expires_at TEXT NOT NULL
   );`,
];

/** Opens the product's single SQLite file in WAL mode (ADR 0011) and migrates it forward. */
export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as { v: number };
  for (let v = row.v; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(v + 1, new Date().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return db;
}
