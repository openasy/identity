// SCIM as Okta and Microsoft Entra ID send it: they look people up, create them, change them, turn them off and
// group them (ADR 0034).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOwner, startApp, type Browser } from "./test-app.ts";

let app: Awaited<ReturnType<typeof startApp>>;
let owner: Browser;
let token: string;

beforeAll(async () => {
  app = await startApp({ version: "1.2.3" });
  owner = await createOwner(app);
  token = (await owner.json<{ token: string }>("/api/v1/provisioning/token", { body: {} })).body.token;
});
afterAll(() => app.close());

type Json = Record<string, unknown>;
async function scim<T = Json>(method: string, path: string, body?: unknown, auth = token) {
  const res = await fetch(`${app.base}/scim/v2${path}`, {
    method,
    headers: { authorization: `Bearer ${auth}`, "content-type": "application/scim+json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(res.status === 204 || res.headers.get("content-type") === "application/scim+json").toBe(true);
  return { status: res.status, body: (res.status === 204 ? {} : await res.json()) as T };
}
const PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

describe("SCIM", () => {
  it("refuses anyone without the token, in SCIM's error format", async () => {
    const r = await scim("GET", "/Users", undefined, "wrong");
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], status: "401" });
    expect((await owner.json<{ url: string; tokenCreatedAt: string }>("/api/v1/provisioning")).body).toMatchObject({ url: `${app.base}/scim/v2`, tokenCreatedAt: expect.any(String) });
  });

  it("describes what it supports", async () => {
    expect((await scim<Json>("GET", "/ServiceProviderConfig")).body).toMatchObject({ patch: { supported: true }, filter: { supported: true }, bulk: { supported: false } });
    expect((await scim<{ Resources: Json[] }>("GET", "/ResourceTypes")).body.Resources.map((r) => r.id)).toEqual(["User", "Group"]);
  });

  it("creates, finds, turns off and changes people as Okta does", async () => {
    expect((await scim<{ totalResults: number }>("GET", '/Users?filter=userName eq "ann@example.com"&startIndex=1&count=100')).body.totalResults).toBe(0);
    const created = await scim<Json>("POST", "/Users", {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: "ann@example.com",
      name: { givenName: "Ann", familyName: "Lee" },
      emails: [{ primary: true, value: "ann@example.com", type: "work" }],
      active: true,
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ userName: "ann@example.com", displayName: "Ann Lee", active: true, emails: [{ value: "ann@example.com" }] });
    const id = created.body.id as string;
    expect((await scim<{ Resources: Json[] }>("GET", '/Users?filter=userName eq "ANN@example.com"')).body.Resources.map((r) => r.id)).toEqual([id]);
    expect((await scim("POST", "/Users", { userName: "ann@example.com", emails: [{ value: "ann@example.com" }] })).status).toBe(409);

    // Turned off: their sessions end at once.
    app.db.prepare("INSERT INTO auth_sessions (id_hash, id, user_id, method, created_at, last_seen_at, expires_at) VALUES ('h', 's', ?, 'oidc:okta', 'x', 'x', 'x')").run(id);
    const off = await scim<Json>("PATCH", `/Users/${id}`, { schemas: [PATCH], Operations: [{ op: "replace", value: { active: false } }] });
    expect(off.body.active).toBe(false);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM auth_sessions WHERE user_id = ?").get(id)).toEqual({ n: 0 });
    expect((await owner.json<{ people: Array<{ id: string; status: string }> }>("/api/v1/people")).body.people.find((p) => p.id === id)?.status).toBe("disabled");

    const put = await scim<Json>("PUT", `/Users/${id}`, { userName: "ann@example.com", name: { formatted: "Ann Lee-Park" }, emails: [{ primary: true, value: "ann@example.com" }], active: true });
    expect(put.body).toMatchObject({ displayName: "Ann Lee-Park", active: true });
  });

  it("takes Microsoft Entra ID's ways: externalId, capital ops and booleans as text", async () => {
    const created = await scim<Json>("POST", "/Users", {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      externalId: "8f2b-entra",
      userName: "bo@contoso.onmicrosoft.com",
      active: true,
      displayName: "Bo Diaz",
      emails: [{ primary: true, type: "work", value: "bo@contoso.com" }],
    });
    const id = created.body.id as string;
    expect((await scim<{ totalResults: number }>("GET", '/Users?filter=externalId eq "8f2b-entra"')).body.totalResults).toBe(1);
    const r = await scim<Json>("PATCH", `/Users/${id}`, {
      schemas: [PATCH],
      Operations: [
        { op: "Replace", path: "active", value: "False" },
        { op: "Replace", path: "displayName", value: "Bo Díaz" },
        { op: "Replace", path: 'emails[type eq "work"].value', value: "bo.diaz@contoso.com" },
      ],
    });
    expect(r.body).toMatchObject({ active: false, displayName: "Bo Díaz", emails: [{ value: "bo.diaz@contoso.com" }], userName: "bo@contoso.onmicrosoft.com" });
    expect((await scim("DELETE", `/Users/${id}`)).status).toBe(204);
    expect((await scim("GET", `/Users/${id}`)).status).toBe(404);
  });

  it("never reaches the people who manage Identity", async () => {
    const { people } = (await owner.json<{ people: Array<{ id: string; role: string }> }>("/api/v1/people")).body;
    const ownerId = people.find((p) => p.role === "owner")!.id;
    expect((await scim("GET", `/Users/${ownerId}`)).status).toBe(404);
    expect((await scim("PATCH", `/Users/${ownerId}`, { schemas: [PATCH], Operations: [{ op: "replace", value: { active: false } }] })).status).toBe(404);
    expect((await scim("POST", "/Users", { userName: "owner@example.com", emails: [{ value: "owner@example.com" }] })).status).toBe(409);
    expect((await scim<{ Resources: Json[] }>("GET", "/Users")).body.Resources.some((u) => u.id === ownerId)).toBe(false);
  });

  it("keeps groups and their members, as both providers change them", async () => {
    const ann = (await scim<{ Resources: Json[] }>("GET", '/Users?filter=userName eq "ann@example.com"')).body.Resources[0]!.id as string;
    const cy = (await scim<Json>("POST", "/Users", { userName: "cy@example.com", emails: [{ value: "cy@example.com" }] })).body.id as string;
    const g = await scim<Json>("POST", "/Groups", { schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"], displayName: "Ops", members: [{ value: ann }] });
    expect(g.status).toBe(201);
    const gid = g.body.id as string;
    const members = async () => ((await scim<{ members: Array<{ value: string }> }>("GET", `/Groups/${gid}`)).body.members ?? []).map((m) => m.value).sort();

    await scim("PATCH", `/Groups/${gid}`, { schemas: [PATCH], Operations: [{ op: "Add", path: "members", value: [{ value: cy }] }] });
    expect(await members()).toEqual([ann, cy].sort());
    // Okta removes one member by path, Microsoft Entra ID by value.
    await scim("PATCH", `/Groups/${gid}`, { schemas: [PATCH], Operations: [{ op: "remove", path: `members[value eq "${ann}"]` }] });
    expect(await members()).toEqual([cy]);
    await scim("PATCH", `/Groups/${gid}`, { schemas: [PATCH], Operations: [{ op: "Remove", path: "members", value: [{ value: cy }] }] });
    expect(await members()).toEqual([]);
    await scim("PATCH", `/Groups/${gid}`, { schemas: [PATCH], Operations: [{ op: "replace", value: { id: gid, displayName: "Operations" } }] });
    expect((await scim<{ totalResults: number }>("GET", '/Groups?filter=displayName eq "Operations"')).body.totalResults).toBe(1);

    // Its members are the provider's: Identity's own screens cannot change them, and its people show the group.
    await scim("PUT", `/Groups/${gid}`, { displayName: "Operations", members: [{ value: ann }] });
    expect((await owner.json(`/api/v1/groups/${gid}/members`, { method: "PUT", body: { userIds: [] } })).status).toBe(409);
    expect((await scim<{ groups: Array<{ display: string }> }>("GET", `/Users/${ann}`)).body.groups).toEqual([expect.objectContaining({ display: "Operations" })]);

    expect((await scim("PATCH", `/Groups/${gid}`, { Operations: [{ op: "move", path: "x" }] })).status).toBe(400);
    expect((await scim("GET", '/Users?filter=name.givenName sw "A"')).status).toBe(400);
    expect((await scim("DELETE", `/Groups/${gid}`)).status).toBe(204);
  });

  it("writes what it did to the audit log, and stops with its token", async () => {
    const { events } = (await owner.json<{ events: Array<{ type: string; actor?: string }> }>("/api/v1/audit")).body;
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["scim-user-created", "scim-user-deactivated", "scim-user-deleted", "scim-group-created", "scim-group-deleted", "scim-token-created"]));
    expect((await owner.json("/api/v1/provisioning/token", { method: "DELETE" })).status).toBe(204);
    expect((await scim("GET", "/Users")).status).toBe(401);
  });
});
