import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { AuthError, mergeOpenApi, sendProblem, type Auth, type Role } from "@openasy/auth";
import { log } from "./log.ts";
import type { Directory } from "./directory.ts";
import { countRequest, renderMetrics } from "./metrics.ts";
import type { Oidc } from "./oidc.ts";

export interface AppOptions {
  db: DatabaseSync;
  version: string;
  /** Sign-in, sessions, members and API tokens (ADR 0002, 0003). */
  auth: Auth;
  directory: Directory;
  oidc: Oidc;
  /** Built web UI; omit to run headless (ADR 0018). */
  webDir?: string;
  /** Built API reference (Swagger UI), served at /api/docs. */
  docsDir?: string;
  /** The OpenAPI description, served at /api/openapi.json with this release's version. */
  openapi?: Record<string, unknown>;
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

export function createApp({ db, version, auth, directory, oidc, webDir, docsDir, openapi }: AppOptions) {
  // The served description includes /api/v1/auth from @openasy/auth, so the API reference documents sign-in too.
  const spec = openapi && JSON.stringify({ ...mergeOpenApi(openapi), info: { ...(openapi.info as object), version } });

  const created = (res: ServerResponse, data: unknown) => (json(res, 201, data), undefined);
  const noContent = (res: ServerResponse) => (res.writeHead(204, SECURITY_HEADERS).end(), undefined);

  const routes: Route[] = [
    { method: "GET", path: "/api/v1/version", auth: "none", handle: () => ({ product: "identity", version }) },

    // Applications people sign in to (OpenID Connect clients). Admins change them: they decide who gets in.
    { method: "GET", path: "/api/v1/applications", auth: "viewer", handle: () => ({ applications: directory.listApplications(), issuer: oidc.provider.issuer }) },
    { method: "POST", path: "/api/v1/applications", auth: "admin", handle: async ({ res, body }) => created(res, directory.createApplication(await body())) },
    { method: "GET", path: "/api/v1/applications/:id", auth: "viewer", handle: ({ params }) => directory.application(params[0]!) },
    { method: "PATCH", path: "/api/v1/applications/:id", auth: "admin", handle: async ({ params, body }) => directory.updateApplication(params[0]!, await body()) },
    { method: "DELETE", path: "/api/v1/applications/:id", auth: "admin", handle: ({ res, params }) => (directory.deleteApplication(params[0]!), noContent(res)) },
    { method: "POST", path: "/api/v1/applications/:id/secret", auth: "admin", handle: ({ params }) => directory.newSecret(params[0]!) },

    // Groups and the people in them. Editors change them.
    { method: "GET", path: "/api/v1/groups", auth: "viewer", handle: () => ({ groups: directory.listGroups() }) },
    { method: "POST", path: "/api/v1/groups", auth: "editor", handle: async ({ res, body }) => created(res, directory.createGroup(await body())) },
    { method: "PATCH", path: "/api/v1/groups/:id", auth: "editor", handle: async ({ params, body }) => directory.updateGroup(params[0]!, await body()) },
    { method: "DELETE", path: "/api/v1/groups/:id", auth: "editor", handle: ({ res, params }) => (directory.deleteGroup(params[0]!), noContent(res)) },
    { method: "PUT", path: "/api/v1/groups/:id/members", auth: "editor", handle: async ({ params, body }) => directory.setMembers(params[0]!, (await body()).userIds) },

    // The directory: everyone who can sign in, with their groups.
    { method: "GET", path: "/api/v1/people", auth: "viewer", handle: () => ({ people: directory.listPeople() }) },
  ];

  const compiled = routes.map((r) => ({ ...r, re: new RegExp(`^${r.path.replace(/:[a-z]+/g, "([^/]+)")}$`) }));

  function authorize(req: IncomingMessage, access: Access) {
    if (access !== "none") auth.authorize(req, access);
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

    if (await auth.handle(req, res)) return auth.routeName(req) ?? "/api/v1/auth/*";

    for (const r of compiled) {
      const m = path.match(r.re);
      if (!m || r.method !== req.method) continue;
      try {
        authorize(req, r.auth);
        const params = m.slice(1).map(decodeURIComponent);
        const result = await r.handle({ req, res, params, body: () => readJson(req, r.bodyLimit) });
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

