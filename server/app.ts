import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { AuthError, mergeOpenApi, sendProblem, type Auth, type Role } from "@openasy/auth";
import { log } from "./log.ts";
import type { Audit } from "./audit.ts";
import type { Directory } from "./directory.ts";
import { countRequest, renderMetrics } from "./metrics.ts";
import type { Oidc } from "./oidc.ts";
import type { ProductLink } from "./products.ts";
import type { Directories } from "./ldap.ts";
import type { Saml } from "./saml.ts";
import type { Scim } from "./scim.ts";

export interface AppOptions {
  db: DatabaseSync;
  version: string;
  /** Sign-in, sessions, members and API tokens (ADR 0002, 0003). */
  auth: Auth;
  directory: Directory;
  oidc: Oidc;
  audit: Audit;
  scim: Scim;
  directories: Directories;
  saml: Saml;
  /** Built web UI; omit to run headless (ADR 0018). */
  webDir?: string;
  /** Built API reference (Swagger UI), served at /api/docs. */
  docsDir?: string;
  /** The OpenAPI description, served at /api/openapi.json with this release's version. */
  openapi?: Record<string, unknown>;
  /** The install's OpenAsy products and their addresses, from OPENASY_PRODUCTS, for the product switcher. */
  products?: ProductLink[];
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'",
};

function send(res: ServerResponse, status: number, body: string | Buffer, type = "application/json", headers: Record<string, string> = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers, "content-type": type, "content-length": Buffer.byteLength(body) });
  res.end(body);
}

const json = (res: ServerResponse, status: number, data: unknown) => send(res, status, JSON.stringify(data));

type ProblemCode = "invalid-token" | "invalid-json" | "invalid-body" | "not-found" | "conflict" | "internal-error";

const TITLES: Record<ProblemCode, string> = {
  "invalid-token": "Invalid token",
  "invalid-json": "Invalid JSON",
  "invalid-body": "Invalid request body",
  "not-found": "Not found",
  conflict: "Conflict",
  "internal-error": "Internal error",
};

/** RFC 9457 Problem Details (ADR 0024). `code` is the stable part clients match on. */
function problem(res: ServerResponse, status: number, code: ProblemCode, detail?: string) {
  const body = { type: `https://openasy.github.io/problems/${code}`, title: TITLES[code], status, code, ...(detail && { detail }) };
  send(res, status, JSON.stringify(body), "application/problem+json");
}

export class HttpProblem extends Error {
  readonly status: number;
  readonly code: ProblemCode;
  constructor(status: number, code: ProblemCode, detail: string) {
    super(detail);
    this.status = status;
    this.code = code;
  }
}

/** Serves a file from dir, or returns false when the path is outside it or missing. */
async function serveFile(res: ServerResponse, dir: string, relative: string): Promise<boolean> {
  const file = normalize(join(dir, relative));
  if (!file.startsWith(normalize(dir)) || !extname(file)) return false;
  try {
    send(res, 200, await readFile(file), TYPES[extname(file)] ?? "application/octet-stream");
    return true;
  } catch {
    return false;
  }
}

async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
  const kib = Math.round(limit / 1024);
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpProblem(400, "invalid-json", `The body must be JSON, at most ${kib} KiB.`);
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
    return body as Record<string, unknown>;
  } catch {
    throw new HttpProblem(400, "invalid-json", "The body must be a JSON object.");
  }
}

/** The role a route needs (ADR 0003). */
type Access = "none" | Role;
interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: string[];
  body: () => Promise<Record<string, unknown>>;
  /** Writes to the audit log as whoever made the request. */
  record: (type: string, target: string, detail?: string) => void;
}
interface Route {
  method: string;
  /** Path pattern; each `:name` matches one segment. */
  path: string;
  auth: Access;
  /** Largest accepted body; 64 KiB by default. */
  bodyLimit?: number;
  handle: (ctx: Ctx) => unknown;
}

export function createApp({ db, version, auth, directory, oidc, audit, scim, directories, saml, webDir, docsDir, openapi, products = [] }: AppOptions) {
  // The served description includes /api/v1/auth from @openasy/auth, so the API reference documents sign-in too.
  const spec = openapi && JSON.stringify({ ...mergeOpenApi(openapi), info: { ...(openapi.info as object), version } });

  const created = (res: ServerResponse, data: unknown) => (json(res, 201, data), undefined);
  const noContent = (res: ServerResponse) => (res.writeHead(204, SECURITY_HEADERS).end(), undefined);

  const routes: Route[] = [
    { method: "GET", path: "/api/v1/version", auth: "none", handle: () => ({ product: "identity", version }) },
    { method: "GET", path: "/api/v1/products", auth: "viewer", handle: () => ({ products }) },

    // Applications people sign in to (OpenID Connect clients). Admins change them: they decide who gets in.
    {
      method: "GET",
      path: "/api/v1/applications",
      auth: "viewer",
      handle: () => ({ applications: directory.listApplications(), issuer: oidc.provider.issuer }),
    },
    {
      method: "POST",
      path: "/api/v1/applications",
      auth: "admin",
      handle: async ({ res, body, record }) => {
        const c = directory.createApplication(await body());
        record("application-added", c.application.id, c.application.name);
        return created(res, c);
      },
    },
    { method: "GET", path: "/api/v1/applications/:id", auth: "viewer", handle: ({ params }) => directory.application(params[0]!) },
    {
      method: "PATCH",
      path: "/api/v1/applications/:id",
      auth: "admin",
      handle: async ({ params, body, record }) => {
        const a = directory.updateApplication(params[0]!, await body());
        record("application-updated", a.id, a.name);
        return a;
      },
    },
    {
      method: "DELETE",
      path: "/api/v1/applications/:id",
      auth: "admin",
      handle: ({ res, params, record }) => {
        const a = directory.application(params[0]!);
        directory.deleteApplication(a.id);
        record("application-removed", a.id, a.name);
        return noContent(res);
      },
    },
    {
      method: "POST",
      path: "/api/v1/applications/:id/secret",
      auth: "admin",
      handle: ({ params, record }) => {
        const c = directory.newSecret(params[0]!);
        record("application-secret-replaced", c.application.id, c.application.name);
        return c;
      },
    },

    // Groups and the people in them. Editors change them.
    { method: "GET", path: "/api/v1/groups", auth: "viewer", handle: () => ({ groups: directory.listGroups() }) },
    {
      method: "POST",
      path: "/api/v1/groups",
      auth: "editor",
      handle: async ({ res, body, record }) => {
        const g = directory.createGroup(await body());
        record("group-added", g.id, g.name);
        return created(res, g);
      },
    },
    {
      method: "PATCH",
      path: "/api/v1/groups/:id",
      auth: "editor",
      handle: async ({ params, body, record }) => {
        const g = directory.updateGroup(params[0]!, await body());
        record("group-updated", g.id, `${g.name}, second factor ${g.mfa}${g.syncedFrom ? `, members from ${g.syncedFrom}` : ""}`);
        return g;
      },
    },
    {
      method: "DELETE",
      path: "/api/v1/groups/:id",
      auth: "editor",
      handle: ({ res, params, record }) => {
        const g = directory.group(params[0]!);
        directory.deleteGroup(g.id);
        record("group-removed", g.id, g.name);
        return noContent(res);
      },
    },
    {
      method: "PUT",
      path: "/api/v1/groups/:id/members",
      auth: "editor",
      handle: async ({ params, body, record }) => {
        const g = directory.setMembers(params[0]!, (await body()).userIds);
        record("group-members-changed", g.id, `${g.name}: ${g.members} ${g.members === 1 ? "member" : "members"}`);
        return g;
      },
    },

    // The directory: everyone who can sign in, with their groups.
    { method: "GET", path: "/api/v1/people", auth: "viewer", handle: () => ({ people: directory.listPeople() }) },

    // Provisioning: the SCIM endpoint an identity provider sends people and groups to, and its token (ADR 0034).
    { method: "GET", path: "/api/v1/provisioning", auth: "admin", handle: () => scim.status() },
    {
      method: "POST",
      path: "/api/v1/provisioning/token",
      auth: "admin",
      handle: ({ record }) => {
        const token = scim.newToken();
        record("scim-token-created", "scim");
        return { ...scim.status(), token };
      },
    },
    {
      method: "DELETE",
      path: "/api/v1/provisioning/token",
      auth: "admin",
      handle: ({ res, record }) => {
        scim.removeToken();
        record("scim-token-removed", "scim");
        return noContent(res);
      },
    },

    // LDAP and Active Directory: read on a schedule; their people sign in with its password (ADR 0034).
    { method: "GET", path: "/api/v1/directories", auth: "admin", handle: () => ({ directories: directories.list() }) },
    {
      method: "POST",
      path: "/api/v1/directories",
      auth: "admin",
      handle: async ({ res, body, record }) => {
        const d = directories.create(await body());
        record("directory-added", d.id, `${d.name} (${d.url})`);
        return created(res, d);
      },
    },
    {
      method: "PATCH",
      path: "/api/v1/directories/:id",
      auth: "admin",
      handle: async ({ params, body, record }) => {
        const d = directories.update(params[0]!, await body());
        record("directory-updated", d.id, d.name);
        return d;
      },
    },
    {
      method: "DELETE",
      path: "/api/v1/directories/:id",
      auth: "admin",
      handle: ({ res, params, record }) => {
        const d = directories.directory(params[0]!);
        directories.remove(d.id);
        record("directory-removed", d.id, `${d.name}: ${d.people} people turned off`);
        return noContent(res);
      },
    },
    { method: "POST", path: "/api/v1/directories/:id/check", auth: "admin", handle: ({ params }) => directories.check(params[0]!) },
    { method: "POST", path: "/api/v1/directories/:id/sync", auth: "admin", handle: ({ params }) => directories.sync(params[0]!) },

    // What happened: sign-ins, refusals and changes, newest first (ADR 0013).
    {
      method: "GET",
      path: "/api/v1/audit",
      auth: "viewer",
      handle: ({ req }) => {
        const q = new URL(req.url ?? "/", "http://localhost").searchParams;
        const limit = Number(q.get("limit") ?? 200);
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new HttpProblem(422, "invalid-body", "limit is a whole number from 1 to 1000.");
        return { events: audit.list({ limit, type: q.get("type") ?? undefined }) };
      },
    },
    {
      method: "GET",
      path: "/api/v1/overview",
      auth: "viewer",
      handle: () => {
        const day = new Date(Date.now() - 86_400_000).toISOString();
        const people = directory.listPeople();
        const hourly = audit.hourly(["app-sign-in", "app-sign-in-refused", "sign-in-failed"]);
        return {
          people: people.length,
          applications: directory.listApplications().length,
          groups: directory.listGroups().length,
          appSignIns24h: audit.count("app-sign-in", day),
          refused24h: audit.count("app-sign-in-refused", day),
          failedSignIns24h: audit.count("sign-in-failed", day),
          // The same three per hour, for the charts on the overview.
          hourly: {
            hours: hourly.hours,
            appSignIns: hourly.series["app-sign-in"],
            refused: hourly.series["app-sign-in-refused"],
            failedSignIns: hourly.series["sign-in-failed"],
          },
          byApplication: audit.byApplication(day).map((a) => ({ id: a.id, name: a.name ?? a.id, signIns: a.signIns })),
          // People who sign in with a password alone: no second factor, and no identity provider to ask for one.
          withoutSecondFactor: people
            .filter((p) => p.status === "active" && !p.secondFactor && p.providers.length === 0)
            .map((p) => ({ id: p.id, name: p.name, email: p.email })),
        };
      },
    },
  ];

  const compiled = routes.map((r) => ({ ...r, re: new RegExp(`^${r.path.replace(/:[a-z]+/g, "([^/]+)")}$`) }));

  /** Who is asking, for the audit log; undefined for routes anyone may call. */
  function authorize(req: IncomingMessage, access: Access): string | undefined {
    if (access === "none") return undefined;
    const p = auth.authorize(req, access);
    return p.kind === "session" ? p.user.id : `token:${p.tokenId}`;
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<string> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path === "/healthz") return (json(res, 200, { status: "ok" }), "/healthz");

    if (path === "/readyz") {
      try {
        db.prepare("SELECT 1").get();
        json(res, 200, { status: "ready" });
      } catch {
        json(res, 503, { status: "database unavailable" });
      }
      return "/readyz";
    }

    if (path === "/metrics") return (send(res, 200, renderMetrics(version), "text/plain; version=0.0.4"), "/metrics");

    if (path === "/api/openapi.json" && spec) return (send(res, 200, spec), "/api/openapi.json");

    if (docsDir && (path === "/api/docs" || path.startsWith("/api/docs/"))) {
      if (path === "/api/docs") {
        res.writeHead(301, { ...SECURITY_HEADERS, location: "/api/docs/" }).end();
        return "/api/docs";
      }
      const relative = path.slice("/api/docs/".length) || "index.html";
      if (!(await serveFile(res, docsDir, relative))) problem(res, 404, "not-found");
      return "/api/docs";
    }

    if (await oidc.handle(req, res, path)) return path.startsWith("/interaction/") ? "/interaction/:uid" : "/oidc";

    if (await scim.handle(req, res, path)) return "/scim/v2";

    if (await saml.handle(req, res, path)) return "/saml";

    if (await auth.handle(req, res)) return auth.routeName(req) ?? "/api/v1/auth/*";

    for (const r of compiled) {
      const m = path.match(r.re);
      if (!m || r.method !== req.method) continue;
      try {
        const actor = authorize(req, r.auth);
        const params = m.slice(1).map(decodeURIComponent);
        const record = (type: string, target: string, detail?: string) => audit.record({ type, actor, target, detail, ip: req.socket.remoteAddress });
        const result = await r.handle({ req, res, params, record, body: () => readJson(req, r.bodyLimit) });
        if (!res.headersSent && result !== undefined) json(res, 200, result);
      } catch (err) {
        if (err instanceof AuthError) sendProblem(res, err);
        else if (err instanceof HttpProblem) problem(res, err.status, err.code, err.message);
        else throw err;
      }
      return r.path;
    }

    if (path.startsWith("/api/")) return (problem(res, 404, "not-found"), "/api/*");

    if (webDir && (req.method === "GET" || req.method === "HEAD")) {
      // Unknown paths fall back to the single-page app.
      if (!(await serveFile(res, webDir, path === "/" ? "index.html" : path))) send(res, 200, await readFile(join(webDir, "index.html")), TYPES[".html"]);
      return "/web";
    }

    problem(res, 404, "not-found");
    return "unmatched";
  }

  return async (req: IncomingMessage, res: ServerResponse) => {
    const started = performance.now();
    let routeName = "error";
    try {
      routeName = await route(req, res);
    } catch (err) {
      log("error", "request failed", { error: String(err), path: req.url });
      if (!res.headersSent) problem(res, 500, "internal-error");
    }
    countRequest(req.method ?? "GET", routeName, res.statusCode);
    if (routeName !== "/healthz" && routeName !== "/metrics") {
      log("info", "request", { method: req.method, path: req.url, status: res.statusCode, ms: Math.round(performance.now() - started) });
    }
  };
}
