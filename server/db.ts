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
