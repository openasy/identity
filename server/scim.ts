// SCIM 2.0 (RFC 7643, 7644; ADR 0034): an identity provider such as Okta or Microsoft Entra ID creates, changes and
// removes people and groups here, so leavers lose access when they leave. It reaches only people with the user role:
// the people who manage Identity are never changed by it. They sign in through that provider, by verified email.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import type { Audit } from "./audit.ts";

export const SCIM_PREFIX = "/scim/v2";
const USER = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";
const LIST = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const ERROR = "urn:ietf:params:scim:api:messages:2.0:Error";
const PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const now = () => new Date().toISOString();

class ScimError extends Error {
  readonly status: number;
  readonly scimType?: string;
  constructor(status: number, detail: string, scimType?: string) {
    super(detail);
    this.status = status;
    this.scimType = scimType;
  }
}

type Json = Record<string, unknown>;
type UserRow = { id: string; email: string; name: string; status: string; created_at: string; user_name: string | null; external_id: string | null; updated_at: string | null };
type GroupRow = { id: string; name: string; external_id: string | null; created_at: string };

/** SCIM sends booleans as strings now and then (Microsoft Entra ID: "False"). */
const bool = (v: unknown) => (typeof v === "string" ? v.toLowerCase() === "true" : v === true);

export function createScim({ db, audit, base }: { db: DatabaseSync; audit: Audit; base: string }) {
  const setting = (key: string) => (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  const putSetting = (key: string, value: string) => db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);

  // ---- the token -------------------------------------------------------------------------------------------------

  /** A new token for the provider, shown once; the old one stops working. Only its hash is kept. */
  function newToken(): string {
    const token = `oisc_${randomBytes(32).toString("base64url")}`;
    putSetting("scim_token_hash", sha256(token));
    putSetting("scim_token_created", now());
    return token;
  }
  function removeToken() {
    db.prepare("DELETE FROM settings WHERE key IN ('scim_token_hash', 'scim_token_created', 'scim_last_used')").run();
  }
  const status = () => ({ url: `${base}${SCIM_PREFIX}`, tokenCreatedAt: setting("scim_token_created") ?? null, lastUsedAt: setting("scim_last_used") ?? null });

  function authorize(req: IncomingMessage) {
    const header = req.headers.authorization ?? "";
    const expected = setting("scim_token_hash");
    const given = Buffer.from(sha256(header.startsWith("Bearer ") ? header.slice(7) : ""));
    if (!expected || !timingSafeEqual(given, Buffer.from(expected))) throw new ScimError(401, "Send the SCIM token from Identity, Settings, Provisioning, as a bearer token.");
    putSetting("scim_last_used", now());
  }

  // ---- people ----------------------------------------------------------------------------------------------------

  const userSelect = `SELECT u.id, u.email, u.name, u.status, u.created_at, s.user_name, s.external_id, s.updated_at
     FROM auth_users u LEFT JOIN scim_users s ON s.user_id = u.id WHERE u.role = 'user'`;
  const userRow = (id: string) => db.prepare(`${userSelect} AND u.id = ?`).get(id) as UserRow | undefined;
  function requireUser(id: string) {
    const u = userRow(id);
    if (!u) throw new ScimError(404, `No user ${id}.`);
    return u;
  }

  const groupsOf = (userId: string) =>
    db.prepare("SELECT g.id, g.name FROM group_members m JOIN groups g ON g.id = m.group_id WHERE m.user_id = ? ORDER BY g.name").all(userId) as Array<{ id: string; name: string }>;

  function toUser(u: UserRow): Json {
    return {
      schemas: [USER],
      id: u.id,
      ...(u.external_id && { externalId: u.external_id }),
      userName: u.user_name ?? u.email,
      name: { formatted: u.name },
      displayName: u.name,
      emails: [{ value: u.email, type: "work", primary: true }],
      active: u.status === "active",
      groups: groupsOf(u.id).map((g) => ({ value: g.id, display: g.name, $ref: `${base}${SCIM_PREFIX}/Groups/${g.id}` })),
      meta: { resourceType: "User", created: u.created_at, lastModified: u.updated_at ?? u.created_at, location: `${base}${SCIM_PREFIX}/Users/${u.id}` },
    };
  }

  /** What a SCIM user says about a person, as Identity keeps it. */
  function readUser(b: Json, current?: UserRow) {
    const emails = Array.isArray(b.emails) ? (b.emails as Json[]) : [];
    const email = String(emails.find((e) => bool(e.primary))?.value ?? emails[0]?.value ?? (String(b.userName ?? "").includes("@") ? b.userName : current?.email) ?? "")
      .trim()
      .toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ScimError(400, "A user needs an email address, in emails or as userName.", "invalidValue");
    const name = b.name as Json | undefined;
    const display = String(b.displayName ?? name?.formatted ?? ([name?.givenName, name?.familyName].filter(Boolean).join(" ") || current?.name || email)).trim();
    const userName = String(b.userName ?? current?.user_name ?? email).trim();
    return { email, name: display.slice(0, 128), userName, externalId: typeof b.externalId === "string" ? b.externalId : (current?.external_id ?? null), active: b.active === undefined ? current?.status !== "disabled" : bool(b.active) };
  }

  function saveUser(id: string, v: ReturnType<typeof readUser>, created: boolean) {
    const taken = db.prepare("SELECT 1 FROM auth_users WHERE email = ? AND id != ?").get(v.email, id);
    if (taken) throw new ScimError(409, `${v.email} is someone else here.`, "uniqueness");
    const at = now();
    db.prepare("UPDATE auth_users SET email = ?, name = ?, status = ? WHERE id = ?").run(v.email, v.name, v.active ? "active" : "disabled", id);
    // Turned off at the provider: their sessions end now, and with them their applications.
    if (!v.active) db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(id);
    db.prepare(
      "INSERT INTO scim_users (user_id, user_name, external_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET user_name = excluded.user_name, external_id = excluded.external_id, updated_at = excluded.updated_at",
    ).run(id, v.userName, v.externalId, at, at);
    audit.record({ type: created ? "scim-user-created" : v.active ? "scim-user-updated" : "scim-user-deactivated", actor: "scim", target: id, detail: v.email });
  }

  function createUser(b: Json): Json {
    const v = readUser(b);
    const existing = db.prepare("SELECT id, role FROM auth_users WHERE email = ?").get(v.email) as { id: string; role: string } | undefined;
    if (existing && existing.role !== "user") throw new ScimError(409, `${v.email} manages Identity; SCIM leaves them alone.`, "uniqueness");
    if (existing && db.prepare("SELECT 1 FROM scim_users WHERE user_id = ?").get(existing.id)) throw new ScimError(409, `${v.email} exists.`, "uniqueness");
    if (db.prepare("SELECT 1 FROM scim_users WHERE user_name = ?").get(v.userName)) throw new ScimError(409, `${v.userName} exists.`, "uniqueness");
    // Someone already in the directory, for example invited before, is taken over rather than duplicated.
    const id = existing?.id ?? randomUUID();
    if (!existing) db.prepare("INSERT INTO auth_users (id, email, name, role, status, created_at) VALUES (?, ?, ?, 'user', 'active', ?)").run(id, v.email, v.name, now());
    saveUser(id, v, true);
    return toUser(requireUser(id));
  }

  /** PATCH (RFC 7644 3.5.2) as Okta and Microsoft Entra ID send it: with or without a path, any case for op. */
  function patchUser(id: string, b: Json): Json {
    const u = requireUser(id);
    const next: Json = { ...toUser(u) };
    for (const op of operations(b)) {
      if (op.op === "remove") continue;
      const set = (path: string, value: unknown) => {
        const p = path.toLowerCase();
        if (p === "active") next.active = bool(value);
        else if (p === "displayname") next.displayName = value;
        else if (p === "username") next.userName = value;
        else if (p === "externalid") next.externalId = value;
        else if (p === "name.formatted") next.displayName = value;
        else if (p === "name.givenname" || p === "name.familyname") next.name = { ...(next.name as Json), [p === "name.givenname" ? "givenName" : "familyName"]: value, formatted: undefined };
        else if (p.startsWith("emails")) next.emails = [{ value, primary: true }];
        else if (p === "name") next.name = value;
        else if (p === "emails") next.emails = value;
      };
      if (op.path) set(op.path, op.value);
      else if (op.value && typeof op.value === "object") for (const [k, v] of Object.entries(op.value as Json)) set(k, v);
    }
    // A changed given or family name rebuilds the display name, unless one was given.
    const n = next.name as Json | undefined;
    if (n && n.formatted === undefined && (n.givenName || n.familyName) && next.displayName === toUser(u).displayName) next.displayName = [n.givenName, n.familyName].filter(Boolean).join(" ");
    saveUser(id, readUser(next, u), false);
    return toUser(requireUser(id));
  }

  function deleteUser(id: string) {
    const u = requireUser(id);
    db.prepare("DELETE FROM group_members WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM scim_users WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM auth_users WHERE id = ?").run(id);
    audit.record({ type: "scim-user-deleted", actor: "scim", target: id, detail: u.email });
  }

  // ---- groups ----------------------------------------------------------------------------------------------------

  // Groups SCIM sends are its own: their members come from it, as groups that follow a provider (directory.ts).
  const groupSelect = "SELECT id, name, external_id, created_at FROM groups WHERE synced_from LIKE 'scim:%'";
  const groupRow = (id: string) => db.prepare(`${groupSelect} AND id = ?`).get(id) as GroupRow | undefined;
  function requireGroup(id: string) {
    const g = groupRow(id);
    if (!g) throw new ScimError(404, `No group ${id}.`);
    return g;
  }
  const membersOf = (id: string) =>
    db.prepare("SELECT u.id, u.name FROM group_members m JOIN auth_users u ON u.id = m.user_id WHERE m.group_id = ? ORDER BY u.name").all(id) as Array<{ id: string; name: string }>;

  const toGroup = (g: GroupRow): Json => ({
    schemas: [GROUP],
    id: g.id,
    ...(g.external_id && { externalId: g.external_id }),
    displayName: g.name,
    members: membersOf(g.id).map((m) => ({ value: m.id, display: m.name, $ref: `${base}${SCIM_PREFIX}/Users/${m.id}` })),
    meta: { resourceType: "Group", created: g.created_at, lastModified: g.created_at, location: `${base}${SCIM_PREFIX}/Groups/${g.id}` },
  });

  function memberIds(value: unknown): string[] {
    const list = Array.isArray(value) ? value : value ? [value] : [];
    return list.map((m) => {
      const id = String((m as Json).value ?? m);
      if (!userRow(id)) throw new ScimError(400, `No user ${id}.`, "invalidValue");
      return id;
    });
  }
  const addMembers = (groupId: string, ids: string[]) => {
    for (const u of ids) db.prepare("INSERT OR IGNORE INTO group_members (group_id, user_id, added_at) VALUES (?, ?, ?)").run(groupId, u, now());
  };
  const removeMembers = (groupId: string, ids: string[]) => {
    for (const u of ids) db.prepare("DELETE FROM group_members WHERE group_id = ? AND user_id = ?").run(groupId, u);
  };

  function groupName(v: unknown, id?: string) {
    const name = typeof v === "string" ? v.trim() : "";
    if (!name || name.length > 100) throw new ScimError(400, "displayName is required, at most 100 characters.", "invalidValue");
    if (db.prepare("SELECT 1 FROM groups WHERE name = ? AND id != ?").get(name, id ?? "")) throw new ScimError(409, `A group named ${name} exists.`, "uniqueness");
    return name;
  }

  function createGroup(b: Json): Json {
    const name = groupName(b.displayName);
    const id = randomUUID();
    db.prepare("INSERT INTO groups (id, name, description, synced_from, external_id, created_at) VALUES (?, ?, '', ?, ?, ?)").run(
      id,
      name,
      `scim:${id}`,
      typeof b.externalId === "string" ? b.externalId : null,
      now(),
    );
    addMembers(id, memberIds(b.members));
    audit.record({ type: "scim-group-created", actor: "scim", target: id, detail: name });
    return toGroup(requireGroup(id));
  }

  function replaceGroup(id: string, b: Json): Json {
    requireGroup(id);
    db.prepare("UPDATE groups SET name = ?, external_id = COALESCE(?, external_id) WHERE id = ?").run(groupName(b.displayName, id), typeof b.externalId === "string" ? b.externalId : null, id);
    const ids = memberIds(b.members);
    db.prepare("DELETE FROM group_members WHERE group_id = ?").run(id);
    addMembers(id, ids);
    audit.record({ type: "scim-group-updated", actor: "scim", target: id });
    return toGroup(requireGroup(id));
  }

  function patchGroup(id: string, b: Json): Json {
    requireGroup(id);
    for (const op of operations(b)) {
      const path = op.path?.toLowerCase() ?? "";
      // members[value eq "<id>"]: one member, as Okta removes them.
      const one = op.path?.match(/^members\[value eq "([^"]+)"\]$/i)?.[1];
      if (op.op === "remove" && one) removeMembers(id, [one]);
      else if (op.op === "remove" && path === "members") (op.value === undefined ? db.prepare("DELETE FROM group_members WHERE group_id = ?").run(id) : removeMembers(id, memberIds(op.value)));
      else if (op.op === "add" && path === "members") addMembers(id, memberIds(op.value));
      else if (op.op === "replace" && path === "members") (db.prepare("DELETE FROM group_members WHERE group_id = ?").run(id), addMembers(id, memberIds(op.value)));
      else if (op.op === "replace" && path === "displayname") db.prepare("UPDATE groups SET name = ? WHERE id = ?").run(groupName(op.value, id), id);
      else if ((op.op === "replace" || op.op === "add") && !path && op.value && typeof op.value === "object") {
        const v = op.value as Json;
        if (v.displayName !== undefined) db.prepare("UPDATE groups SET name = ? WHERE id = ?").run(groupName(v.displayName, id), id);
        if (v.members !== undefined) (db.prepare("DELETE FROM group_members WHERE group_id = ?").run(id), addMembers(id, memberIds(v.members)));
      } else if (op.op === "replace" && path === "externalid") db.prepare("UPDATE groups SET external_id = ? WHERE id = ?").run(String(op.value), id);
      else throw new ScimError(400, `This PATCH operation is not supported: ${op.op} ${op.path ?? ""}`, "invalidPath");
    }
    audit.record({ type: "scim-group-updated", actor: "scim", target: id });
    return toGroup(requireGroup(id));
  }

  function deleteGroup(id: string) {
    const g = requireGroup(id);
    db.prepare("DELETE FROM groups WHERE id = ?").run(id);
    audit.record({ type: "scim-group-deleted", actor: "scim", target: id, detail: g.name });
  }

  // ---- protocol --------------------------------------------------------------------------------------------------

  function operations(b: Json): Array<{ op: string; path?: string; value?: unknown }> {
    if (!Array.isArray(b.Operations)) throw new ScimError(400, `PATCH needs Operations, with the schema ${PATCH}.`, "invalidSyntax");
    return (b.Operations as Json[]).map((o) => ({ op: String(o.op ?? "").toLowerCase(), path: typeof o.path === "string" ? o.path : undefined, value: o.value }));
  }

  /** The filters providers send to find someone before they create them: attribute eq "value". */
  function filterOf(q: URLSearchParams, allowed: Record<string, string>) {
    const f = q.get("filter");
    if (!f) return undefined;
    const m = f.match(/^\s*([\w.]+)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i);
    const column = m && allowed[m[1]!.toLowerCase()];
    if (!m || !column) throw new ScimError(400, `Filters are ${Object.keys(allowed).join(", ")} eq "value".`, "invalidFilter");
    return { column, value: m[2]!.replace(/\\(.)/g, "$1") };
  }

  function list(rows: Json[], q: URLSearchParams) {
    const start = Math.max(1, Number(q.get("startIndex") ?? 1) || 1);
    const count = Math.min(200, Math.max(0, Number(q.get("count") ?? 100) || 0));
    const page = rows.slice(start - 1, start - 1 + count);
    return { schemas: [LIST], totalResults: rows.length, startIndex: start, itemsPerPage: page.length, Resources: page };
  }

  function listUsers(q: URLSearchParams) {
    const f = filterOf(q, { username: "COALESCE(s.user_name, u.email)", externalid: "s.external_id", "emails.value": "u.email" });
    const rows = (f ? db.prepare(`${userSelect} AND ${f.column} = ? COLLATE NOCASE ORDER BY u.created_at`).all(f.value) : db.prepare(`${userSelect} ORDER BY u.created_at`).all()) as UserRow[];
    return list(rows.map(toUser), q);
  }

  function listGroups(q: URLSearchParams) {
    const f = filterOf(q, { displayname: "name", externalid: "external_id" });
    const rows = (f ? db.prepare(`${groupSelect} AND ${f.column} = ? COLLATE NOCASE ORDER BY created_at`).all(f.value) : db.prepare(`${groupSelect} ORDER BY created_at`).all()) as GroupRow[];
    return list(rows.map(toGroup), q);
  }

  const serviceProviderConfig = () => ({
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
    documentationUri: "https://github.com/openasy/identity#scim",
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [{ type: "oauthbearertoken", name: "Bearer token", description: "The token from Identity, Settings, Provisioning.", primary: true }],
  });
  const resourceTypes = () => ({
    schemas: [LIST],
    totalResults: 2,
    Resources: [
      { schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"], id: "User", name: "User", endpoint: "/Users", schema: USER },
      { schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"], id: "Group", name: "Group", endpoint: "/Groups", schema: GROUP },
    ],
  });

  const send = (res: ServerResponse, status: number, body?: unknown) => {
    if (body === undefined) return void res.writeHead(status).end();
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/scim+json", "content-length": Buffer.byteLength(text) }).end(text);
  };

  async function readBody(req: IncomingMessage): Promise<Json> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const c of req) {
      size += c.length;
      if (size > 1024 * 1024) throw new ScimError(413, "The body must be at most 1 MiB.");
      chunks.push(c);
    }
    try {
      const v = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
      return v as Json;
    } catch {
      throw new ScimError(400, "The body must be a JSON object.", "invalidSyntax");
    }
  }

  /** Answers /scim/v2/* and returns true; false for every other path. */
  async function handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    if (path !== SCIM_PREFIX && !path.startsWith(`${SCIM_PREFIX}/`)) return false;
    const q = new URL(req.url ?? "/", "http://localhost").searchParams;
    const [, kind, id, extra] = path.slice(SCIM_PREFIX.length).split("/");
    const m = req.method ?? "GET";
    try {
      authorize(req);
      if (extra !== undefined) throw new ScimError(404, "Not found.");
      db.exec("BEGIN IMMEDIATE");
      try {
        let out: [number, unknown];
        if (kind === "ServiceProviderConfig" && m === "GET") out = [200, serviceProviderConfig()];
        else if (kind === "ResourceTypes" && m === "GET") out = [200, resourceTypes()];
        else if (kind === "Schemas" && m === "GET") out = [200, { schemas: [LIST], totalResults: 0, Resources: [] }];
        else if (kind === "Users" && !id && m === "GET") out = [200, listUsers(q)];
        else if (kind === "Users" && !id && m === "POST") out = [201, createUser(await readBody(req))];
        else if (kind === "Users" && id && m === "GET") out = [200, toUser(requireUser(id))];
        else if (kind === "Users" && id && m === "PUT") out = [200, (saveUser(id, readUser(await readBody(req), requireUser(id)), false), toUser(requireUser(id)))];
        else if (kind === "Users" && id && m === "PATCH") out = [200, patchUser(id, await readBody(req))];
        else if (kind === "Users" && id && m === "DELETE") out = [204, (deleteUser(id), undefined)];
        else if (kind === "Groups" && !id && m === "GET") out = [200, listGroups(q)];
        else if (kind === "Groups" && !id && m === "POST") out = [201, createGroup(await readBody(req))];
        else if (kind === "Groups" && id && m === "GET") out = [200, toGroup(requireGroup(id))];
        else if (kind === "Groups" && id && m === "PUT") out = [200, replaceGroup(id, await readBody(req))];
        else if (kind === "Groups" && id && m === "PATCH") out = [200, patchGroup(id, await readBody(req))];
        else if (kind === "Groups" && id && m === "DELETE") out = [204, (deleteGroup(id), undefined)];
        else throw new ScimError(404, "Not found.");
        db.exec("COMMIT");
        send(res, out[0], out[1]);
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    } catch (err) {
      if (!(err instanceof ScimError)) throw err;
      if (!req.complete) req.resume();
      send(res, err.status, { schemas: [ERROR], status: String(err.status), ...(err.scimType && { scimType: err.scimType }), detail: err.message });
    }
    return true;
  }

  return { handle, newToken, removeToken, status };
}

export type Scim = ReturnType<typeof createScim>;
