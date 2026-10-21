import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp } from "./test-app.ts";

let app: Awaited<ReturnType<typeof startApp>>;

beforeAll(async () => {
  app = await startApp({ version: "1.2.3" });
});

afterAll(() => app.close());

describe("health and metrics", () => {
  it("answers liveness and readiness", async () => {
    expect((await fetch(`${app.base}/healthz`)).status).toBe(200);
    expect(await (await fetch(`${app.base}/readyz`)).json()).toEqual({ status: "ready" });
  });

  it("exposes Prometheus metrics", async () => {
    const res = await fetch(`${app.base}/metrics`);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toContain('openasy_build_info{product="identity",version="1.2.3"} 1');
  });

  it("sets security headers", async () => {
    const res = await fetch(`${app.base}/api/v1/version`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.json()).toEqual({ product: "identity", version: "1.2.3" });
  });

  it("returns Problem Details for unknown API paths", async () => {
    const res = await fetch(`${app.base}/api/v1/nope`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
  });

  it("offers the one-time owner link until there is an owner", () => {
    expect(app.auth.setupLink()).toMatch(/^http:\/\/localhost:\d+\//);
  });
});
