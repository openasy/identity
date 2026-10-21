// LDAP and Active Directory (ADR 0034): Identity reads people and groups from a directory on a schedule, and people
// sign in with the password the directory keeps, checked by binding as them. The password never reaches Identity's
// database. Only people with the user role are touched: the people who manage Identity keep their own sign-in.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Client, type Entry } from "ldapts";
import { HttpProblem } from "./app.ts";
import type { Audit } from "./audit.ts";
import type { Keyring } from "./kek.ts";
import { log } from "./log.ts";

const now = () => new Date().toISOString();
const invalid = (m: string) => new HttpProblem(422, "invalid-body", m);

export type DirectoryKind = "active-directory" | "ldap";

/** What each kind of directory usually needs. */
export const DIRECTORY_DEFAULTS: Record<DirectoryKind, { userFilter: string; emailAttribute: string; nameAttribute: string; groupFilter: string }> = {
  "active-directory": {
    // People only, not computers or service accounts without a mailbox.
    userFilter: "(&(objectCategory=person)(objectClass=user)(mail=*))",
    emailAttribute: "mail",
    nameAttribute: "displayName",
    groupFilter: "(objectClass=group)",
  },
  ldap: { userFilter: "(&(objectClass=inetOrgPerson)(mail=*))", emailAttribute: "mail", nameAttribute: "cn", groupFilter: "(|(objectClass=groupOfNames)(objectClass=groupOfUniqueNames))" },
};

export interface Directory {
  id: string;
  name: string;
  kind: DirectoryKind;
  url: string;
  startTls: boolean;
  caCert: string | null;
  bindDn: string;
  baseDn: string;
  userFilter: string;
  emailAttribute: string;
  nameAttribute: string;
  groupBaseDn: string | null;
  groupFilter: string | null;
  syncMinutes: number;
  lastSyncAt: string | null;
  lastError: string | null;
  lastCounts: { people: number; groups: number; disabled: number } | null;
  people: number;
  createdAt: string;
}

type Row = {
  id: string;
  name: string;
  kind: DirectoryKind;
  url: string;
  start_tls: number;
  ca_cert: string | null;
  bind_dn: string;
  bind_password: string;
  base_dn: string;
  user_filter: string;
  email_attribute: string;
  name_attribute: string;
  group_base_dn: string | null;
  group_filter: string | null;
  sync_minutes: number;
  last_sync_at: string | null;
  last_error: string | null;
  last_counts: string | null;
  created_at: string;
};

const first = (v: Entry[string] | undefined): string | undefined => {
  const x = Array.isArray(v) ? v[0] : v;
  return x === undefined ? undefined : Buffer.isBuffer(x) ? x.toString("utf8") : String(x);
};
const all = (v: Entry[string] | undefined): string[] => (v === undefined ? [] : (Array.isArray(v) ? v : [v]).map((x) => (Buffer.isBuffer(x) ? x.toString("utf8") : String(x))));
/** DNs compare without case and spaces after commas, as directories write them differently. */
const dnKey = (dn: string) => dn.toLowerCase().replace(/,\s+/g, ",");

export function createDirectories({ db, keyring, audit }: { db: DatabaseSync; keyring: Keyring; audit: Audit }) {
  const row = (id: string) => db.prepare("SELECT * FROM directories WHERE id = ?").get(id) as Row | undefined;
  function requireRow(id: string) {
    const r = row(id);
    if (!r) throw new HttpProblem(404, "not-found", "Directory does not exist.");
    return r;
  }
  const toDirectory = (r: Row): Directory => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    url: r.url,
    startTls: r.start_tls === 1,
    caCert: r.ca_cert,
    bindDn: r.bind_dn,
    baseDn: r.base_dn,
    userFilter: r.user_filter,
    emailAttribute: r.email_attribute,
    nameAttribute: r.name_attribute,
    groupBaseDn: r.group_base_dn,
    groupFilter: r.group_filter,
    syncMinutes: r.sync_minutes,
    lastSyncAt: r.last_sync_at,
    lastError: r.last_error,
    lastCounts: r.last_counts ? (JSON.parse(r.last_counts) as Directory["lastCounts"]) : null,
    people: (db.prepare("SELECT COUNT(*) AS n FROM directory_users WHERE directory_id = ?").get(r.id) as { n: number }).n,
    createdAt: r.created_at,
  });
  const list = () => (db.prepare("SELECT * FROM directories ORDER BY name COLLATE NOCASE").all() as Row[]).map(toDirectory);

  // ---- settings --------------------------------------------------------------------------------------------------

  function read(b: Record<string, unknown>, current?: Row) {
    const text = (name: string, max: number, fallback?: string | null) => {
      const v = b[name];
      if (v === undefined) {
        if (fallback === undefined || fallback === null) throw invalid(`${name} is required.`);
        return fallback;
      }
      if (typeof v !== "string" || !v.trim() || v.length > max) throw invalid(`${name} must be text, at most ${max} characters.`);
      return v.trim();
    };
    const optional = (name: string, fallback: string | null) => (b[name] === undefined ? fallback : b[name] === null || b[name] === "" ? null : text(name, 4096));
    const kind = (b.kind ?? current?.kind ?? "active-directory") as DirectoryKind;
    if (!(kind in DIRECTORY_DEFAULTS)) throw invalid('kind must be "active-directory" or "ldap".');
    const d = DIRECTORY_DEFAULTS[kind];
    const url = text("url", 512, current?.url);
    if (!/^ldaps?:\/\/[^\s/]+(:\d+)?\/?$/.test(url)) throw invalid("url is ldaps://host:636 or ldap://host:389.");
    const startTls = b.startTls === undefined ? current?.start_tls === 1 : b.startTls === true;
    // A password sent in the clear would be readable on the network: plain ldap:// needs StartTLS, except in tests.
    if (url.startsWith("ldap://") && !startTls && !/^ldap:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(url)) throw invalid("Use ldaps://, or ldap:// with StartTLS: passwords must not cross the network in the clear.");
    const syncMinutes = b.syncMinutes === undefined ? (current?.sync_minutes ?? 60) : Number(b.syncMinutes);
    if (!Number.isInteger(syncMinutes) || syncMinutes < 5 || syncMinutes > 1440) throw invalid("syncMinutes is a whole number from 5 to 1440.");
    const password = b.bindPassword === undefined ? current?.bind_password : keyring.seal(text("bindPassword", 1024));
    if (!password) throw invalid("bindPassword is required.");
    return {
      name: text("name", 100, current?.name),
      kind,
      url,
      startTls,
      caCert: optional("caCert", current?.ca_cert ?? null),
      bindDn: text("bindDn", 1024, current?.bind_dn),
      bindPassword: password,
      baseDn: text("baseDn", 1024, current?.base_dn),
      userFilter: text("userFilter", 2048, current?.user_filter ?? d.userFilter),
      emailAttribute: text("emailAttribute", 64, current?.email_attribute ?? d.emailAttribute),
      nameAttribute: text("nameAttribute", 64, current?.name_attribute ?? d.nameAttribute),
      groupBaseDn: optional("groupBaseDn", current?.group_base_dn ?? null),
      groupFilter: optional("groupFilter", current ? current.group_filter : d.groupFilter),
      syncMinutes,
    };
  }

  function create(b: Record<string, unknown>): Directory {
    const v = read(b);
    if (db.prepare("SELECT 1 FROM directories WHERE name = ?").get(v.name)) throw new HttpProblem(409, "conflict", `A directory named ${v.name} exists.`);
    const id = randomUUID().slice(0, 8);
    db.prepare(
      `INSERT INTO directories (id, name, kind, url, start_tls, ca_cert, bind_dn, bind_password, base_dn, user_filter, email_attribute, name_attribute, group_base_dn, group_filter, sync_minutes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, v.name, v.kind, v.url, v.startTls ? 1 : 0, v.caCert, v.bindDn, v.bindPassword, v.baseDn, v.userFilter, v.emailAttribute, v.nameAttribute, v.groupBaseDn, v.groupFilter, v.syncMinutes, now());
    return toDirectory(requireRow(id));
  }

  function update(id: string, b: Record<string, unknown>): Directory {
    const v = read(b, requireRow(id));
    db.prepare(
      `UPDATE directories SET name = ?, kind = ?, url = ?, start_tls = ?, ca_cert = ?, bind_dn = ?, bind_password = ?, base_dn = ?, user_filter = ?, email_attribute = ?, name_attribute = ?,
       group_base_dn = ?, group_filter = ?, sync_minutes = ? WHERE id = ?`,
    ).run(v.name, v.kind, v.url, v.startTls ? 1 : 0, v.caCert, v.bindDn, v.bindPassword, v.baseDn, v.userFilter, v.emailAttribute, v.nameAttribute, v.groupBaseDn, v.groupFilter, v.syncMinutes, id);
    return toDirectory(requireRow(id));
  }

  /** Removing a directory turns its people off: their password was its. Groups that followed it go. */
  function remove(id: string) {
    requireRow(id);
    for (const { user_id } of db.prepare("SELECT user_id FROM directory_users WHERE directory_id = ?").all(id) as Array<{ user_id: string }>) disable(user_id);
    db.prepare("DELETE FROM groups WHERE synced_from LIKE ?").run(`${id}:%`);
    db.prepare("DELETE FROM directories WHERE id = ?").run(id);
  }

  // ---- talking to the directory ----------------------------------------------------------------------------------

  async function connect(r: Row) {
    const tlsOptions = { ...(r.ca_cert && { ca: [r.ca_cert] }), minVersion: "TLSv1.2" as const };
    const client = new Client({ url: r.url, timeout: 15_000, connectTimeout: 10_000, ...(r.url.startsWith("ldaps://") && { tlsOptions }) });
    if (r.start_tls) await client.startTLS(tlsOptions);
    return client;
  }

  async function withService<T>(r: Row, fn: (c: Client) => Promise<T>): Promise<T> {
    const c = await connect(r);
    try {
      await c.bind(r.bind_dn, keyring.open(r.bind_password).toString("utf8"));
      return await fn(c);
    } finally {
      await c.unbind().catch(() => {});
    }
  }

  async function searchPeople(c: Client, r: Row) {
    const { searchEntries } = await c.search(r.base_dn, {
      scope: "sub",
      filter: r.user_filter,
      attributes: ["dn", r.email_attribute, r.name_attribute, "userAccountControl"],
      paged: { pageSize: 500 },
    });
    return searchEntries.flatMap((e) => {
      const email = first(e[r.email_attribute])?.trim().toLowerCase();
      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return [];
      // Active Directory marks a disabled account with bit 2 of userAccountControl.
      const uac = Number(first(e.userAccountControl) ?? 0);
      return [{ dn: e.dn, email, name: (first(e[r.name_attribute]) ?? email).slice(0, 128), disabled: (uac & 2) === 2 }];
    });
  }

  /** Checks the settings: binds, and counts what the filters find. Nothing is written. */
  async function check(id: string) {
    const r = requireRow(id);
    try {
      return await withService(r, async (c) => {
        const people = await searchPeople(c, r);
        const groups = r.group_filter ? (await c.search(r.group_base_dn ?? r.base_dn, { scope: "sub", filter: r.group_filter, attributes: ["cn"], paged: { pageSize: 500 } })).searchEntries.length : 0;
        return { ok: true as const, people: people.length, groups };
      });
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    }
  }

  function disable(userId: string) {
    db.prepare("UPDATE auth_users SET status = 'disabled' WHERE id = ? AND role = 'user'").run(userId);
    db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(userId);
  }

  /**
   * Reads people and groups. People found are added or updated with the user role; people gone from it, or disabled
   * in Active Directory, are turned off and signed out. Groups found follow it, with their members.
   */
  async function sync(id: string) {
    const r = requireRow(id);
    try {
      const counts = await withService(r, async (c) => {
        const people = await searchPeople(c, r);
        const at = now();
        const byDn = new Map<string, string>();
        let disabled = 0;
        db.exec("BEGIN IMMEDIATE");
        try {
          for (const p of people) {
            const linked = db.prepare("SELECT user_id FROM directory_users WHERE directory_id = ? AND dn = ? COLLATE NOCASE").get(r.id, p.dn) as { user_id: string } | undefined;
            const byEmail = db.prepare("SELECT id, role FROM auth_users WHERE email = ?").get(p.email) as { id: string; role: string } | undefined;
            // The people who manage Identity keep their own sign-in, even when the directory has them too.
            if (byEmail && byEmail.role !== "user") continue;
            const otherDirectory = byEmail && db.prepare("SELECT 1 FROM directory_users WHERE user_id = ? AND directory_id != ?").get(byEmail.id, r.id);
            if (otherDirectory) continue;
            const userId = linked?.user_id ?? byEmail?.id ?? randomUUID();
            if (!linked && !byEmail) db.prepare("INSERT INTO auth_users (id, email, name, role, status, created_at) VALUES (?, ?, ?, 'user', 'active', ?)").run(userId, p.email, p.name, at);
            db.prepare("UPDATE auth_users SET email = ?, name = ?, status = ?, password_hash = NULL WHERE id = ? AND role = 'user'").run(p.email, p.name, p.disabled ? "disabled" : "active", userId);
            if (p.disabled) (disable(userId), disabled++);
            db.prepare("INSERT INTO directory_users (user_id, directory_id, dn, seen_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET dn = excluded.dn, seen_at = excluded.seen_at").run(userId, r.id, p.dn, at);
            byDn.set(dnKey(p.dn), userId);
          }
          // Gone from the directory, or out of the filter: turned off, not deleted, so their history stays.
          for (const gone of db.prepare("SELECT user_id FROM directory_users WHERE directory_id = ? AND seen_at < ?").all(r.id, at) as Array<{ user_id: string }>) (disable(gone.user_id), disabled++);
          db.exec("COMMIT");
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }

        let groups = 0;
        if (r.group_filter) {
          const { searchEntries } = await c.search(r.group_base_dn ?? r.base_dn, { scope: "sub", filter: r.group_filter, attributes: ["cn", "member", "uniqueMember"], paged: { pageSize: 500 } });
          db.exec("BEGIN IMMEDIATE");
          try {
            const seen = new Set<string>();
            for (const g of searchEntries) {
              const cn = first(g.cn);
              if (!cn) continue;
              const key = `${r.id}:${cn}`;
              seen.add(key);
              let groupId = (db.prepare("SELECT id FROM groups WHERE synced_from = ?").get(key) as { id: string } | undefined)?.id;
              if (!groupId) {
                groupId = randomUUID();
                // A group of the same name made here keeps its name; this one is told apart by the directory's.
                const name = db.prepare("SELECT 1 FROM groups WHERE name = ?").get(cn) ? `${cn} (${r.name})` : cn;
                db.prepare("INSERT INTO groups (id, name, description, synced_from, created_at) VALUES (?, ?, ?, ?, ?)").run(groupId, name, `From ${r.name}`, key, now());
              }
              const members = [...all(g.member), ...all(g.uniqueMember)].map((dn) => byDn.get(dnKey(dn))).filter((u): u is string => !!u);
              db.prepare("DELETE FROM group_members WHERE group_id = ?").run(groupId);
              for (const u of new Set(members)) db.prepare("INSERT INTO group_members (group_id, user_id, added_at) VALUES (?, ?, ?)").run(groupId, u, now());
              groups++;
            }
            // Groups no longer in the directory, or out of the filter, go.
            for (const g of db.prepare("SELECT id, synced_from FROM groups WHERE synced_from LIKE ?").all(`${r.id}:%`) as Array<{ id: string; synced_from: string }>) {
              if (!seen.has(g.synced_from)) db.prepare("DELETE FROM groups WHERE id = ?").run(g.id);
            }
            db.exec("COMMIT");
          } catch (err) {
            db.exec("ROLLBACK");
            throw err;
          }
        }
        return { people: byDn.size, groups, disabled };
      });
      db.prepare("UPDATE directories SET last_sync_at = ?, last_error = NULL, last_counts = ? WHERE id = ?").run(now(), JSON.stringify(counts), id);
      audit.record({ type: "directory-synced", actor: "directory", target: id, detail: `${r.name}: ${counts.people} people, ${counts.groups} groups, ${counts.disabled} turned off` });
      return { ok: true as const, ...counts };
    } catch (err) {
      const error = (err as Error).message;
      db.prepare("UPDATE directories SET last_sync_at = ?, last_error = ? WHERE id = ?").run(now(), error, id);
      audit.record({ type: "directory-sync-failed", actor: "directory", target: id, detail: `${r.name}: ${error}` });
      log("warn", "directory sync failed", { directory: r.name, error });
      return { ok: false as const, error };
    }
  }

  /** Directories whose next read is due. */
  async function syncDue() {
    for (const r of db.prepare("SELECT * FROM directories").all() as Row[]) {
      if (!r.last_sync_at || Date.parse(r.last_sync_at) + r.sync_minutes * 60_000 <= Date.now()) await sync(r.id);
    }
  }

  // ---- signing in ------------------------------------------------------------------------------------------------

  /** The directory that keeps someone's password, by name, for @openasy/auth's externalPasswords. */
  const managedBy = (userId: string) =>
    (db.prepare("SELECT d.name FROM directory_users u JOIN directories d ON d.id = u.directory_id WHERE u.user_id = ?").get(userId) as { name: string } | undefined)?.name;

  /** Binds as the person: the directory says whether the password is theirs. */
  async function verify(userId: string, password: string): Promise<boolean> {
    if (!password) return false;
    const r = db.prepare("SELECT d.*, u.dn AS user_dn FROM directory_users u JOIN directories d ON d.id = u.directory_id WHERE u.user_id = ?").get(userId) as (Row & { user_dn: string }) | undefined;
    if (!r) return false;
    const c = await connect(r);
    try {
      await c.bind(r.user_dn, password);
      return true;
    } catch {
      return false;
    } finally {
      await c.unbind().catch(() => {});
    }
  }

  return { list, directory: (id: string) => toDirectory(requireRow(id)), create, update, remove, check, sync, syncDue, managedBy, verify };
}

export type Directories = ReturnType<typeof createDirectories>;
