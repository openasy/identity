import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOwner, startApp } from "./test-app.ts";

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

describe("other products", () => {
  it("lists the configured products to anyone signed in", async () => {
    const products = [{ id: "infrastructure", url: "https://infra.example.com" }];
    const linked = await startApp({ version: "1.2.3", products });
    const owner = await createOwner(linked);
    expect(await owner.json("/api/v1/products")).toEqual({ status: 200, body: { products } });
    expect((await fetch(`${linked.base}/api/v1/products`)).status).toBe(401);
    await linked.close();
  });
});
