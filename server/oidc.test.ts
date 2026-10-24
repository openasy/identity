// The OpenID provider end to end, with openid-client as the application: who gets in, what they are told, and that
// Identity's own sign-in is the session (ADR 0033).
import * as client from "openid-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Browser, createOwner, PASSWORD, startApp, totp } from "./test-app.ts";

const CALLBACK = "http://localhost:4999/callback";

let app: Awaited<ReturnType<typeof startApp>>;
let owner: Browser;
let rp: client.Configuration;
let appId: string;
let uma: { id: string; browser: Browser };

beforeAll(async () => {
  app = await startApp({ version: "1.2.3" });
  owner = await createOwner(app);

  await owner.json("/api/v1/groups", { body: { name: "Engineering" } });
  const created = await owner.json<{ application: { id: string }; clientSecret: string }>("/api/v1/applications", {
    body: { name: "Grafana", redirectUris: [CALLBACK], groups: ["Engineering"] },
  });
  expect(created.status).toBe(201);
  appId = created.body.application.id;
  rp = await client.discovery(new URL(app.base), appId, created.body.clientSecret, undefined, { execute: [client.allowInsecureRequests] });

  const invited = await owner.json<{ member: { id: string }; link: string }>("/api/v1/auth/members", {
    body: { email: "uma@example.com", name: "Uma", role: "user" },
  });
  const browser = new Browser(app.base);
  await browser.json(`/api/v1/auth/links/${new URL(invited.body.link).searchParams.get("link")}`, { body: { password: PASSWORD } });
  uma = { id: invited.body.member.id, browser };
});
afterAll(() => app.close());

/** Starts a sign-in at the application and returns where the browser ends up, with what the application must keep. */
async function signIn(b: Browser) {
  const verifier = client.randomPKCECodeVerifier();
  const state = client.randomState();
  const url = client.buildAuthorizationUrl(rp, {
    redirect_uri: CALLBACK,
    scope: "openid email profile groups",
    code_challenge: await client.calculatePKCECodeChallenge(verifier),
    code_challenge_method: "S256",
    state,
  });
  return { landed: await b.follow(url.href), verifier, state };
}

describe("the OpenID provider", () => {
  it("publishes its discovery document with PKCE", () => {
    const m = rp.serverMetadata();
    expect(m.issuer).toBe(app.base);
    expect(m.authorization_endpoint).toBe(`${app.base}/oidc/auth`);
    expect(m.code_challenge_methods_supported).toContain("S256");
    expect(m.scopes_supported).toEqual(expect.arrayContaining(["openid", "email", "profile", "groups"]));
  });

  it("refuses people outside the application's groups", async () => {
    const { landed } = await signIn(uma.browser);
    expect(landed.origin + landed.pathname).toBe(CALLBACK);
    expect(landed.searchParams.get("error")).toBe("access_denied");
  });

  it("signs in a member of its groups, and tells the application who they are", async () => {
    await owner.json(`/api/v1/groups/${(await owner.json<{ groups: Array<{ id: string }> }>("/api/v1/groups")).body.groups[0]!.id}/members`, {
      method: "PUT",
      body: { userIds: [uma.id] },
    });
    const { landed, verifier, state } = await signIn(uma.browser);
    expect(landed.searchParams.get("code")).toBeTruthy();
    const tokens = await client.authorizationCodeGrant(rp, landed, { pkceCodeVerifier: verifier, expectedState: state });
    expect(tokens.claims()).toMatchObject({
      iss: app.base,
      aud: appId,
      sub: uma.id,
      email: "uma@example.com",
      email_verified: true,
      name: "Uma",
      groups: ["Engineering"],
    });
    const info = await client.fetchUserInfo(rp, tokens.access_token, uma.id);
    expect(info).toMatchObject({ email: "uma@example.com", groups: ["Engineering"] });
  });

  it("sends people who are not signed in to Identity's sign-in, and back", async () => {
    const stranger = new Browser(app.base);
    const verifier = client.randomPKCECodeVerifier();
    const url = client.buildAuthorizationUrl(rp, {
      redirect_uri: CALLBACK,
      scope: "openid",
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
      state: "s",
    });
    const first = await stranger.fetch(url.href);
    const interaction = new URL(first.headers.get("location")!, app.base);
    expect(interaction.pathname).toMatch(/^\/interaction\/[\w-]+$/);
    const toSignIn = await stranger.fetch(interaction.pathname);
    expect(toSignIn.headers.get("location")).toBe(`/?return=${encodeURIComponent(interaction.pathname)}`);
  });

  it("asks again once someone signed out of Identity", async () => {
    expect((await signIn(uma.browser)).landed.searchParams.get("code")).toBeTruthy();
    await uma.browser.json("/api/v1/auth/logout", { body: {} });
    const verifier = client.randomPKCECodeVerifier();
    const url = client.buildAuthorizationUrl(rp, {
      redirect_uri: CALLBACK,
      scope: "openid",
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
      state: "s",
    });
    const first = await uma.browser.fetch(url.href);
    const interaction = new URL(first.headers.get("location")!, app.base).pathname;
    expect(interaction).toMatch(/^\/interaction\//);
    expect((await uma.browser.fetch(interaction)).headers.get("location")).toMatch(/^\/\?return=/);
  });

  it("refuses an application's request without PKCE", async () => {
    const url = client.buildAuthorizationUrl(rp, { redirect_uri: CALLBACK, scope: "openid", state: "s" });
    const landed = await new Browser(app.base).follow(url.href);
    expect(landed.searchParams.get("error")).toBe("invalid_request");
  });
});

describe("a second factor per group", () => {
  it("sends people without one to add it, then lets them in", async () => {
    const eng = (await owner.json<{ groups: Array<{ id: string; name: string }> }>("/api/v1/groups")).body.groups.find((g) => g.name === "Engineering")!;
    expect((await owner.json<{ mfa: string }>(`/api/v1/groups/${eng.id}`, { method: "PATCH", body: { mfa: "required" } })).body.mfa).toBe("required");
    await uma.browser.json("/api/v1/auth/login", { body: { email: "uma@example.com", password: PASSWORD } });

    const verifier = client.randomPKCECodeVerifier();
    const url = client.buildAuthorizationUrl(rp, {
      redirect_uri: CALLBACK,
      scope: "openid",
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
      state: "s",
    });
    const interaction = new URL((await uma.browser.fetch(url.href)).headers.get("location")!, app.base).pathname;
    expect((await uma.browser.fetch(interaction)).headers.get("location")).toBe(`/?return=${encodeURIComponent(interaction)}&mfa=required`);

    // Adding a factor makes this session strong: the same sign-in continues.
    const { body } = await uma.browser.json<{ secret: string }>("/api/v1/auth/me/totp", { body: {} });
    await uma.browser.json("/api/v1/auth/me/totp/confirm", { body: { code: totp(body.secret) } });
    expect((await signIn(uma.browser)).landed.searchParams.get("code")).toBeTruthy();
    await owner.json(`/api/v1/groups/${eng.id}`, { method: "PATCH", body: { mfa: "optional" } });
  });
});

describe("passkey-only groups", () => {
  it("ask for a passkey even after an authenticator app, and let a passkey session in", async () => {
    const eng = (await owner.json<{ groups: Array<{ id: string; name: string }> }>("/api/v1/groups")).body.groups.find((g) => g.name === "Engineering")!;
    await owner.json(`/api/v1/groups/${eng.id}`, { method: "PATCH", body: { mfa: "passkey" } });
    const verifier = client.randomPKCECodeVerifier();
    const url = client.buildAuthorizationUrl(rp, {
      redirect_uri: CALLBACK,
      scope: "openid",
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
      state: "s",
    });
    const interaction = new URL((await uma.browser.fetch(url.href)).headers.get("location")!, app.base).pathname;
    // Uma's session has an authenticator app: strong, but not a passkey.
    expect((await uma.browser.fetch(interaction)).headers.get("location")).toBe(`/?return=${encodeURIComponent(interaction)}&mfa=passkey`);

    // A session opened with a passkey (as @openasy/auth records it) gets through.
    app.db.prepare("UPDATE auth_sessions SET factor = 'passkey' WHERE user_id = ?").run(uma.id);
    expect((await signIn(uma.browser)).landed.searchParams.get("code")).toBeTruthy();
    await owner.json(`/api/v1/groups/${eng.id}`, { method: "PATCH", body: { mfa: "optional" } });
  });
});

describe("the audit log", () => {
  it("keeps sign-ins to applications, refusals and changes, with who did them", async () => {
    const { events } = (
      await owner.json<{ events: Array<{ type: string; actorName: string | null; applicationName: string | null; detail?: string }> }>("/api/v1/audit")
    ).body;
    const types = events.map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["app-sign-in", "app-sign-in-refused", "application-added", "group-added", "sign-in", "member-invited"]));
    expect(events.find((e) => e.type === "app-sign-in")).toMatchObject({ actorName: "Uma", applicationName: "Grafana" });
    expect(events.find((e) => e.type === "application-added")).toMatchObject({ actorName: "Olivia Owner" });
    expect(events.find((e) => e.type === "app-sign-in-refused" && e.detail === "second factor needed")).toBeDefined();
    expect(events.find((e) => e.type === "app-sign-in-refused" && e.detail === "passkey needed")).toBeDefined();
    expect((await owner.json<{ events: unknown[] }>("/api/v1/audit?type=app-sign-in&limit=1")).body.events).toHaveLength(1);
    expect((await owner.json("/api/v1/audit?limit=0")).status).toBe(422);
  });

  it("sums up the last day on the overview", async () => {
    const o = (await owner.json<Record<string, unknown>>("/api/v1/overview")).body;
    expect(o).toMatchObject({ people: 2, applications: 1, groups: 1 });
    // A sign-in counts once the application exchanged its code: one test here does.
    expect(o.appSignIns24h).toBe(1);
    expect(o.refused24h).toBeGreaterThanOrEqual(1);
    // The same counts per hour for the charts: 24 hours up to the current one, where everything here happened.
    const hourly = o.hourly as { hours: string[]; appSignIns: number[]; refused: number[]; failedSignIns: number[] };
    expect(hourly.hours).toHaveLength(24);
    expect(hourly.hours.at(-1)!.slice(0, 13)).toBe(new Date().toISOString().slice(0, 13));
    for (const s of [hourly.appSignIns, hourly.refused, hourly.failedSignIns]) expect(s).toHaveLength(24);
    expect(hourly.appSignIns.reduce((a, b) => a + b, 0)).toBe(1);
    expect(hourly.refused.reduce((a, b) => a + b, 0)).toBe(o.refused24h);
    expect(o.byApplication).toEqual([{ id: expect.any(String), name: expect.any(String), signIns: 1 }]);
    // Uma has an authenticator app now and the owner had one from the start.
    expect(o.withoutSecondFactor).toEqual([]);
  });
});

describe("the directory", () => {
  it("keeps groups that follow an identity provider in step with it", async () => {
    const g = await owner.json<{ id: string }>("/api/v1/groups", { body: { name: "Ops", syncedFrom: "corp:ops-admins" } });
    app.directory.syncGroups(uma.id, "corp", ["ops-admins", "staff"]);
    expect(app.directory.group(g.body.id).members).toBe(1);
    expect((await owner.json<{ status: number }>(`/api/v1/groups/${g.body.id}/members`, { method: "PUT", body: { userIds: [] } })).status).toBe(409);
    app.directory.syncGroups(uma.id, "corp", ["staff"]);
    expect(app.directory.group(g.body.id).members).toBe(0);
  });

  it("lets only admins change applications, and shows the secret once", async () => {
    const editorLink = await owner.json<{ member: { id: string }; link: string }>("/api/v1/auth/members", {
      body: { email: "ed@example.com", role: "editor" },
    });
    const ed = new Browser(app.base);
    await ed.json(`/api/v1/auth/links/${new URL(editorLink.body.link).searchParams.get("link")}`, { body: { password: PASSWORD } });
    expect((await ed.json("/api/v1/applications")).status).toBe(200);
    expect((await ed.json("/api/v1/applications", { body: { name: "x", redirectUris: [CALLBACK] } })).status).toBe(403);
    // People with the user role sign in to applications, not to Identity's API.
    expect((await uma.browser.json("/api/v1/applications")).status).toBe(403);

    const list = await owner.json<{ applications: Array<Record<string, unknown>>; issuer: string }>("/api/v1/applications");
    expect(list.body.issuer).toBe(app.base);
    expect(JSON.stringify(list.body)).not.toContain("ois_");
    const vpn = await owner.json<{ application: { redirectUris: string[] }; clientSecret: string }>("/api/v1/applications", {
      body: { name: "VPN", template: "openasy-vpn", url: "https://vpn.example.com/" },
    });
    expect(vpn.body.application.redirectUris).toEqual([
      "https://vpn.example.com/api/v1/auth/oidc/openasy-identity/callback",
      "https://vpn.example.com/api/v1/auth/oidc/sso/callback",
    ]);
    expect((await owner.json("/api/v1/applications", { body: { name: "Bad", redirectUris: ["http://evil.example.com/cb"] } })).status).toBe(422);
  });
});
