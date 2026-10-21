// The directory (ADR 0033): groups, who is in them, and the applications people sign in to. People themselves are
// @openasy/auth's members, so passwords, second factors and providers work the same as in every product.
import { randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { HttpProblem } from "./app.ts";
import type { Keyring } from "./kek.ts";

const now = () => new Date().toISOString();
const invalid = (m: string) => new HttpProblem(422, "invalid-body", m);
const notFound = (what: string) => new HttpProblem(404, "not-found", `${what} does not exist.`);

export interface Group {
  id: string;
  name: string;
  description: string;
  syncedFrom: string | null;
  members: number;
  createdAt: string;
}

export interface Application {
  id: string;
  name: string;
  template: string;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  everyone: boolean;
  groups: string[];
  createdAt: string;
}

export interface Person {
  id: string;
  email: string;
  name: string;
  role: string;
  status: string;
  groups: string[];
}

/** Applications that start from a template: OpenAsy products fill in their callback address. */
export const TEMPLATES = ["openasy-vpn", "openasy-infrastructure", "openasy-vulnerabilities", "oidc"] as const;
export type Template = (typeof TEMPLATES)[number];

/**
 * Where an OpenAsy product receives Identity's answer, given the address people open it at (@openasy/auth): as a
 * provider added under Settings, Sign-in (id openasy-identity), or set in its environment (id sso).
 */
export const productCallbacks = (url: string) => ["openasy-identity", "sso"].map((id) => `${url.replace(/\/$/, "")}/api/v1/auth/oidc/${id}/callback`);

type AppRow = { id: string; name: string; template: string; client_secret: string; redirect_uris: string; post_logout_redirect_uris: string; everyone: number; created_at: string };

export function createDirectory(db: DatabaseSync, keyring: Keyring) {
  // ---- groups ---------------------------------------------------------------------------------------------------

  const toGroup = (r: { id: string; name: string; description: string; synced_from: string | null; created_at: string }): Group => ({
    id: r.id,
    name: r.name,
    description: r.description,
    syncedFrom: r.synced_from,
    members: (db.prepare("SELECT COUNT(*) AS n FROM group_members WHERE group_id = ?").get(r.id) as { n: number }).n,
    createdAt: r.created_at,
  });
  const groupRow = (id: string) => db.prepare("SELECT * FROM groups WHERE id = ?").get(id) as Parameters<typeof toGroup>[0] | undefined;
  const listGroups = (): Group[] => (db.prepare("SELECT * FROM groups ORDER BY name COLLATE NOCASE").all() as Array<Parameters<typeof toGroup>[0]>).map(toGroup);

  function group(id: string): Group {
    const r = groupRow(id);
    if (!r) throw notFound("Group");
    return toGroup(r);
  }

  function text(v: unknown, name: string, max: number, optional = false): string | undefined {
    if (v === undefined && optional) return undefined;
    if (typeof v !== "string" || !v.trim() || v.length > max) throw invalid(`${name} is required, at most ${max} characters.`);
    return v.trim();
  }

  function syncedFrom(v: unknown): string | null {
    if (v === undefined || v === null || v === "") return null;
    if (typeof v !== "string" || !/^[a-z0-9-]{1,32}:.{1,256}$/.test(v)) throw invalid('syncedFrom is "<provider id>:<group at the provider>", for example keycloak:ops-admins.');
    return v;
  }

  function createGroup(b: Record<string, unknown>): Group {
    const name = text(b.name, "name", 100)!;
    if (db.prepare("SELECT 1 FROM groups WHERE name = ?").get(name)) throw new HttpProblem(409, "conflict", `A group named ${name} exists.`);
    const from = syncedFrom(b.syncedFrom);
    if (from && db.prepare("SELECT 1 FROM groups WHERE synced_from = ?").get(from)) throw new HttpProblem(409, "conflict", `A group already follows ${from}.`);
    const id = randomUUID();
    db.prepare("INSERT INTO groups (id, name, description, synced_from, created_at) VALUES (?, ?, ?, ?, ?)").run(id, name, text(b.description, "description", 500, true) ?? "", from, now());
    return group(id);
  }

  function updateGroup(id: string, b: Record<string, unknown>): Group {
    const current = group(id);
    const name = text(b.name, "name", 100, true) ?? current.name;
    if (name !== current.name && db.prepare("SELECT 1 FROM groups WHERE name = ? AND id != ?").get(name, id)) throw new HttpProblem(409, "conflict", `A group named ${name} exists.`);
    const description = b.description === undefined ? current.description : (text(b.description, "description", 500, true) ?? "");
    const from = b.syncedFrom === undefined ? current.syncedFrom : syncedFrom(b.syncedFrom);
    db.prepare("UPDATE groups SET name = ?, description = ?, synced_from = ? WHERE id = ?").run(name, description, from, id);
    // A group that starts following a provider gets its members from there, at each person's next sign-in.
    if (from && from !== current.syncedFrom) db.prepare("DELETE FROM group_members WHERE group_id = ?").run(id);
    return group(id);
  }

  function deleteGroup(id: string) {
    if (db.prepare("DELETE FROM groups WHERE id = ?").run(id).changes === 0) throw notFound("Group");
  }

  const groupsOf = (userId: string) =>
    (db.prepare("SELECT g.name FROM group_members m JOIN groups g ON g.id = m.group_id WHERE m.user_id = ? ORDER BY g.name COLLATE NOCASE").all(userId) as Array<{ name: string }>).map(
      (g) => g.name,
    );

  function setMembers(groupId: string, userIds: unknown) {
    const g = group(groupId);
    if (g.syncedFrom) throw new HttpProblem(409, "conflict", `${g.name} follows ${g.syncedFrom}: change its members at the provider.`);
    if (!Array.isArray(userIds) || userIds.some((u) => typeof u !== "string")) throw invalid("userIds must be a list of user ids.");
    for (const u of userIds as string[]) if (!db.prepare("SELECT 1 FROM auth_users WHERE id = ?").get(u)) throw invalid(`No user ${u}.`);
    db.exec("BEGIN");
    try {
      db.prepare("DELETE FROM group_members WHERE group_id = ?").run(groupId);
      for (const u of new Set(userIds as string[])) db.prepare("INSERT INTO group_members (group_id, user_id, added_at) VALUES (?, ?, ?)").run(groupId, u, now());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return group(groupId);
  }

  /** After a sign-in through a provider: groups that follow it get exactly the groups it sent. */
  function syncGroups(userId: string, provider: string, sent: string[]) {
    const followed = db.prepare("SELECT id, synced_from FROM groups WHERE synced_from LIKE ?").all(`${provider}:%`) as Array<{ id: string; synced_from: string }>;
    const wanted = new Set(sent.map((g) => `${provider}:${g}`));
    for (const g of followed) {
      if (wanted.has(g.synced_from)) db.prepare("INSERT OR IGNORE INTO group_members (group_id, user_id, added_at) VALUES (?, ?, ?)").run(g.id, userId, now());
      else db.prepare("DELETE FROM group_members WHERE group_id = ? AND user_id = ?").run(g.id, userId);
    }
  }

  // ---- people ---------------------------------------------------------------------------------------------------

  const listPeople = (): Person[] =>
    (db.prepare("SELECT id, email, name, role, status FROM auth_users ORDER BY name COLLATE NOCASE").all() as Array<Omit<Person, "groups">>).map((p) => ({ ...p, groups: groupsOf(p.id) }));

  /** What applications learn about someone, by scope. Only active people sign in. */
  function account(userId: string) {
    const r = db.prepare("SELECT id, email, name, status FROM auth_users WHERE id = ?").get(userId) as { id: string; email: string; name: string; status: string } | undefined;
    if (!r || r.status !== "active") return undefined;
    return { sub: r.id, email: r.email, email_verified: true, name: r.name, groups: groupsOf(r.id) };
  }

  // ---- applications ---------------------------------------------------------------------------------------------

  const appGroups = (id: string) =>
    (db.prepare("SELECT g.name FROM application_groups a JOIN groups g ON g.id = a.group_id WHERE a.application_id = ? ORDER BY g.name COLLATE NOCASE").all(id) as Array<{ name: string }>).map(
      (g) => g.name,
    );
  const toApp = (r: AppRow): Application => ({
    id: r.id,
    name: r.name,
    template: r.template,
    redirectUris: JSON.parse(r.redirect_uris) as string[],
    postLogoutRedirectUris: JSON.parse(r.post_logout_redirect_uris) as string[],
    everyone: r.everyone === 1,
    groups: appGroups(r.id),
    createdAt: r.created_at,
  });
  const appRow = (id: string) => db.prepare("SELECT * FROM applications WHERE id = ?").get(id) as AppRow | undefined;
  const listApplications = () => (db.prepare("SELECT * FROM applications ORDER BY name COLLATE NOCASE").all() as AppRow[]).map(toApp);

  function application(id: string): Application {
    const r = appRow(id);
    if (!r) throw notFound("Application");
    return toApp(r);
  }

  function uris(v: unknown, name: string): string[] {
    if (!Array.isArray(v) || v.length > 20 || v.some((u) => typeof u !== "string")) throw invalid(`${name} must be a list of addresses.`);
    return (v as string[]).map((u) => {
      let url: URL;
      try {
        url = new URL(u.trim());
      } catch {
        throw invalid(`"${u}" is not an address.`);
      }
      const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
      if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw invalid(`"${u}" must use https, or http on localhost.`);
      if (url.hash) throw invalid(`"${u}" must not have a #fragment.`);
      return url.href;
    });
  }

  function setAppGroups(id: string, names: unknown) {
    if (!Array.isArray(names) || names.some((n) => typeof n !== "string")) throw invalid("groups must be a list of group names.");
    const ids = (names as string[]).map((n) => {
      const g = db.prepare("SELECT id FROM groups WHERE name = ?").get(n) as { id: string } | undefined;
      if (!g) throw invalid(`Group "${n}" does not exist.`);
      return g.id;
    });
    db.prepare("DELETE FROM application_groups WHERE application_id = ?").run(id);
    for (const g of new Set(ids)) db.prepare("INSERT INTO application_groups (application_id, group_id) VALUES (?, ?)").run(id, g);
  }

  /** The redirect address of an application made from a template: the product's address, or the addresses given. */
  function redirects(template: Template, b: Record<string, unknown>): string[] {
    if (template === "oidc") return uris(b.redirectUris, "redirectUris");
    const url = text(b.url, "url", 512)!;
    return uris(productCallbacks(url), "url");
  }

  /** A new application and its client secret, shown once. */
  function createApplication(b: Record<string, unknown>) {
    const template = (b.template ?? "oidc") as Template;
    if (!TEMPLATES.includes(template)) throw invalid(`template must be one of ${TEMPLATES.join(", ")}.`);
    const name = text(b.name, "name", 100)!;
    const redirectUris = redirects(template, b);
    const post = b.postLogoutRedirectUris === undefined ? [] : uris(b.postLogoutRedirectUris, "postLogoutRedirectUris");
    if (b.everyone !== undefined && typeof b.everyone !== "boolean") throw invalid("everyone must be true or false.");
    const id = `oa-${randomBytes(9).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "x")}`;
    const secret = `ois_${randomBytes(32).toString("base64url")}`;
    db.exec("BEGIN");
    try {
      db.prepare("INSERT INTO applications (id, name, template, client_secret, redirect_uris, post_logout_redirect_uris, everyone, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
        id,
        name,
        template,
        keyring.seal(secret),
        JSON.stringify(redirectUris),
        JSON.stringify(post),
        b.everyone === true ? 1 : 0,
        now(),
      );
      setAppGroups(id, b.groups ?? []);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return { application: application(id), clientSecret: secret };
  }

  function updateApplication(id: string, b: Record<string, unknown>): Application {
    const current = application(id);
    const name = text(b.name, "name", 100, true) ?? current.name;
    const redirectUris = b.redirectUris === undefined && b.url === undefined ? current.redirectUris : redirects(current.template as Template, b);
    const post = b.postLogoutRedirectUris === undefined ? current.postLogoutRedirectUris : uris(b.postLogoutRedirectUris, "postLogoutRedirectUris");
    if (b.everyone !== undefined && typeof b.everyone !== "boolean") throw invalid("everyone must be true or false.");
    const everyone = b.everyone === undefined ? current.everyone : b.everyone;
    db.exec("BEGIN");
    try {
      db.prepare("UPDATE applications SET name = ?, redirect_uris = ?, post_logout_redirect_uris = ?, everyone = ? WHERE id = ?").run(name, JSON.stringify(redirectUris), JSON.stringify(post), everyone ? 1 : 0, id);
      if (b.groups !== undefined) setAppGroups(id, b.groups);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return application(id);
  }

  /** A new client secret; the old one stops working at once. */
  function newSecret(id: string) {
    application(id);
    const secret = `ois_${randomBytes(32).toString("base64url")}`;
    db.prepare("UPDATE applications SET client_secret = ? WHERE id = ?").run(keyring.seal(secret), id);
    return { application: application(id), clientSecret: secret };
  }

  function deleteApplication(id: string) {
    if (db.prepare("DELETE FROM applications WHERE id = ?").run(id).changes === 0) throw notFound("Application");
  }

  /** The client metadata oidc-provider needs, with the secret in the clear. */
  function clientMetadata(id: string) {
    const r = appRow(id);
    if (!r) return undefined;
    return {
      client_id: r.id,
      client_name: r.name,
      client_secret: keyring.open(r.client_secret).toString("utf8"),
      redirect_uris: JSON.parse(r.redirect_uris) as string[],
      post_logout_redirect_uris: JSON.parse(r.post_logout_redirect_uris) as string[],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_basic",
    };
  }

  /** Whether someone may sign in to an application: everyone, or a member of one of its groups. */
  function mayUse(applicationId: string, userId: string): boolean {
    const r = appRow(applicationId);
    if (!r) return false;
    if (r.everyone === 1) return true;
    return !!db.prepare("SELECT 1 FROM application_groups a JOIN group_members m ON m.group_id = a.group_id WHERE a.application_id = ? AND m.user_id = ?").get(applicationId, userId);
  }

  return {
    listGroups,
    group,
    createGroup,
    updateGroup,
    deleteGroup,
    setMembers,
    syncGroups,
    listPeople,
    account,
    listApplications,
    application,
    createApplication,
    updateApplication,
    newSecret,
    deleteApplication,
    clientMetadata,
    mayUse,
  };
}

export type Directory = ReturnType<typeof createDirectory>;
