import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Browser, createOwner, startApp } from "./test-app.ts";

// Contract tests (ADR 0024): every response the API sends must match openapi.json.

type Spec = {
  info: { version: string };
  paths: Record<string, Record<string, { responses: Record<string, { $ref?: string; content?: Record<string, { schema: object }> }> }>>;
  components: { responses: Record<string, { content: Record<string, { schema: object }> }> };
};

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Spec;
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const ajv = new Ajv2020({ strict: false, validateFormats: false });
ajv.addSchema(spec, "openapi");

const docsDir = mkdtempSync(join(tmpdir(), "identity-docs-"));
writeFileSync(join(docsDir, "index.html"), "<!doctype html><title>API</title>");

let app: Awaited<ReturnType<typeof startApp>>;
let base: string;
const covered = new Set<string>();

beforeAll(async () => {
  app = await startApp({ version, openapi: spec, docsDir });
  base = app.base;
});

afterAll(() => app.close());

/** Calls the API and checks status, content type and body against the description. */
async function call(method: string, path: string, init: RequestInit = {}, concrete = path) {
  const res = await fetch(base + concrete, { ...init, method });
  const operation = spec.paths[path]?.[method.toLowerCase()];
  expect(operation, `${method} ${path} is not in openapi.json`).toBeDefined();
  covered.add(`${method} ${path}`);

  const declared = operation!.responses[String(res.status)];
  expect(declared, `${method} ${path} answered ${res.status}, which openapi.json does not list`).toBeDefined();
  // A response is either inline or a $ref to components/responses; build the JSON pointer to its schema either way.
  const shared = declared!.$ref?.split("/").pop();
  const response = shared ? spec.components.responses[shared]! : declared!;
  const at = shared ? `openapi#/components/responses/${shared}` : `openapi#/paths/${path.replaceAll("/", "~1")}/${method.toLowerCase()}/responses/${res.status}`;

  if (!response.content) {
    expect(res.headers.get("content-length") ?? "0", `${method} ${path} ${res.status} should have no body`).toBe("0");
    return { res, body: undefined };
  }
  const type = res.headers.get("content-type")!.split(";")[0]!;
  expect(response.content?.[type], `${method} ${path} ${res.status} sent ${type}, which openapi.json does not list`).toBeDefined();

  const body = type.endsWith("json") ? await res.json() : await res.text();
  const schema = `${at}/content/${type.replace("/", "~1")}/schema`;
  const validate = ajv.getSchema(schema)!;
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  return { res, body };
}

describe("openapi.json", () => {
  it("has the version of this release", () => {
    expect(spec.info.version).toBe(version);
  });

  it("is served with the running version", async () => {
    const served = (await (await fetch(`${base}/api/openapi.json`)).json()) as Spec;
    expect(served.info.version).toBe(version);
    // Identity's own operations, then sign-in from @openasy/auth (tested against its description in that package).
    expect(Object.keys(served.paths).filter((p) => !p.startsWith("/api/v1/auth/"))).toEqual(Object.keys(spec.paths));
    expect(served.paths["/api/v1/auth/login"]).toBeDefined();
  });

  it("serves the API reference at /api/docs/", async () => {
    expect((await fetch(`${base}/api/docs`, { redirect: "manual" })).headers.get("location")).toBe("/api/docs/");
    const res = await fetch(`${base}/api/docs/`);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect((await fetch(`${base}/api/docs/../../package.json`)).status).not.toBe(200);
  });
});

describe("responses match openapi.json", () => {
  it("product and health", async () => {
    await call("GET", "/api/v1/version");
    await call("GET", "/healthz");
    await call("GET", "/readyz");
    await call("GET", "/metrics");
  });

  it("applications, groups and people", async () => {
    const owner = await createOwner(app);
    const as = (b: Browser, body?: unknown, method?: string) => ({
      method,
      headers: { origin: b.base, "user-agent": "Mozilla/5.0 (Macintosh) Chrome/141.0", cookie: [...b.cookies].map(([k, v]) => `${k}=${v}`).join("; "), "content-type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    await call("GET", "/api/v1/applications", {});
    const group = (await call("POST", "/api/v1/groups", as(owner, { name: "Engineering", description: "Builds things" }))).body as { id: string };
    await call("POST", "/api/v1/groups", as(owner, { name: "Engineering" }));
    await call("POST", "/api/v1/groups", as(owner, { name: "" }));
    await call("POST", "/api/v1/groups", { ...as(owner), body: "nope" });
    await call("GET", "/api/v1/groups", as(owner));
    await call("PATCH", "/api/v1/groups/{id}", as(owner, { description: "Ships things" }), `/api/v1/groups/${group.id}`);
    await call("PATCH", "/api/v1/groups/{id}", as(owner, { syncedFrom: "not a provider" }), `/api/v1/groups/${group.id}`);
    await call("PATCH", "/api/v1/groups/{id}", as(owner, {}), "/api/v1/groups/missing");
    await call("PUT", "/api/v1/groups/{id}/members", as(owner, { userIds: [] }), `/api/v1/groups/${group.id}/members`);
    await call("PUT", "/api/v1/groups/{id}/members", as(owner, { userIds: ["nobody"] }), `/api/v1/groups/${group.id}/members`);
    await call("PUT", "/api/v1/groups/{id}/members", as(owner, { userIds: [] }), "/api/v1/groups/missing/members");
    await call("GET", "/api/v1/people", as(owner));
    await call("PATCH", "/api/v1/groups/{id}", as(owner, { mfa: "always" }), `/api/v1/groups/${group.id}`);
    await call("GET", "/api/v1/overview", as(owner));
    await call("GET", "/api/v1/overview", {});
    await call("GET", "/api/v1/audit", as(owner), "/api/v1/audit?type=group-added&limit=5");
    await call("GET", "/api/v1/audit", as(owner), "/api/v1/audit?limit=5000");

    const created = (await call("POST", "/api/v1/applications", as(owner, { name: "VPN", template: "openasy-vpn", url: "https://vpn.example.com", groups: ["Engineering"] }))).body as { application: { id: string } };
    await call("POST", "/api/v1/applications", as(owner, { name: "Bad", redirectUris: ["ftp://x"] }));
    await call("GET", "/api/v1/applications", as(owner));
    await call("GET", "/api/v1/applications/{id}", as(owner), `/api/v1/applications/${created.application.id}`);
    await call("GET", "/api/v1/applications/{id}", as(owner), "/api/v1/applications/missing");
    await call("PATCH", "/api/v1/applications/{id}", as(owner, { everyone: true }), `/api/v1/applications/${created.application.id}`);
    await call("PATCH", "/api/v1/applications/{id}", as(owner, { groups: ["Nope"] }), `/api/v1/applications/${created.application.id}`);
    await call("POST", "/api/v1/applications/{id}/secret", as(owner, {}), `/api/v1/applications/${created.application.id}/secret`);
    await call("DELETE", "/api/v1/applications/{id}", as(owner, undefined, "DELETE"), `/api/v1/applications/${created.application.id}`);
    await call("DELETE", "/api/v1/applications/{id}", as(owner, undefined, "DELETE"), `/api/v1/applications/${created.application.id}`);
    await call("DELETE", "/api/v1/groups/{id}", as(owner, undefined, "DELETE"), `/api/v1/groups/${group.id}`);
    await call("DELETE", "/api/v1/groups/{id}", as(owner, undefined, "DELETE"), `/api/v1/groups/${group.id}`);
  });

  it("covers every operation in openapi.json", () => {
    const all = Object.entries(spec.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`));
    expect([...covered].sort()).toEqual(all.sort());
  });
});
