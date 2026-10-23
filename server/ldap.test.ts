// LDAP against a real server: e2e/ldap.sh starts lldap with Alice (in openasy-ops) and Bob, then runs this with
// LDAP_URL set (ADR 0034). Without it, only the checks that need no server run.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Browser, createOwner, startApp } from "./test-app.ts";

const LDAP = process.env.LDAP_URL;
let app: Awaited<ReturnType<typeof startApp>>;
let owner: Browser;

beforeAll(async () => {
  app = await startApp({ version: "1.2.3" });
  owner = await createOwner(app);
});
afterAll(() => app.close());

const settings = (extra: Record<string, unknown> = {}) => ({
  name: "Example LDAP",
  kind: "ldap",
  url: LDAP ?? "ldap://localhost:3890",
  bindDn: "uid=admin,ou=people,dc=example,dc=com",
  bindPassword: process.env.LDAP_ADMIN_PASSWORD ?? "x",
  baseDn: "ou=people,dc=example,dc=com",
  // lldap's own admin is a person too; it is not one of the people Identity should read.
  userFilter: "(&(objectClass=inetOrgPerson)(mail=*)(!(uid=admin)))",
  groupBaseDn: "ou=groups,dc=example,dc=com",
  groupFilter: "(cn=openasy-*)",
  ...extra,
});

describe("directories", () => {
  it("refuses a password that would cross the network in the clear", async () => {
    const r = await owner.json<{ detail: string }>("/api/v1/directories", { body: settings({ name: "Remote", url: "ldap://ldap.example.com" }) });
    expect(r.status).toBe(422);
    expect(r.body.detail).toMatch(/StartTLS/);
    expect((await owner.json("/api/v1/directories", { body: settings({ name: "TLS", url: "ldap://ldap.example.com", startTls: true }) })).status).toBe(201);
  });
});

describe.skipIf(!LDAP)("LDAP against lldap", () => {
  let id: string;

  it("checks the settings, then reads people and groups", async () => {
    const created = await owner.json<{ id: string }>("/api/v1/directories", { body: settings() });
    expect(created.status).toBe(201);
    id = created.body.id;
    expect(JSON.stringify(created.body)).not.toContain(process.env.LDAP_ADMIN_PASSWORD!);
    expect((await owner.json(`/api/v1/directories/${id}/check`, { body: {} })).body).toEqual({ ok: true, people: 2, groups: 1 });
    expect((await owner.json(`/api/v1/directories/${id}/sync`, { body: {} })).body).toEqual({ ok: true, people: 2, groups: 1, disabled: 0 });

    const { people } = (await owner.json<{ people: Array<{ email: string; name: string; role: string; status: string; groups: string[] }> }>("/api/v1/people"))
      .body;
    expect(people.filter((p) => p.role === "user").map((p) => [p.email, p.name, p.status, p.groups.join()])).toEqual([
      ["alice@example.com", "Alice Ader", "active", "openasy-ops"],
      ["bob@example.com", "Bob Bell", "active", ""],
    ]);
  });

  it("signs people in with the directory's password, and only that", async () => {
    const alice = new Browser(app.base);
    expect(
      (await alice.json<{ status: string }>("/api/v1/auth/login", { body: { email: "alice@example.com", password: "alice directory password" } })).body.status,
    ).toBe("signed-in");
    expect((await alice.json<{ passwordManagedBy: string }>("/api/v1/auth/me")).body.passwordManagedBy).toBe("Example LDAP");
    expect((await new Browser(app.base).json("/api/v1/auth/login", { body: { email: "alice@example.com", password: "wrong" } })).status).toBe(401);
    // An empty password would be an anonymous bind, which LDAP servers accept: it is never sent.
    expect((await new Browser(app.base).json("/api/v1/auth/login", { body: { email: "alice@example.com", password: "" } })).status).not.toBe(200);
    expect((await alice.json("/api/v1/auth/me/password", { body: { currentPassword: "x", newPassword: "a local password here" } })).status).toBe(409);
  });

  it("turns off people who leave the directory, and leaves the people who manage Identity alone", async () => {
    // The owner's email in the directory does not make them one of its people.
    const jwt = process.env.LLDAP_JWT!;
    const gql = (query: string) =>
      fetch("http://localhost:17170/api/graphql", {
        method: "POST",
        headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
        body: JSON.stringify({ query }),
      });
    await gql('mutation { createUser(user: {id: "olivia", email: "owner@example.com", displayName: "Not the owner"}) { id } }');
    await gql('mutation { deleteUser(userId: "bob") { ok } }');
    const r = (await owner.json<{ people: number; disabled: number }>(`/api/v1/directories/${id}/sync`, { body: {} })).body;
    expect(r).toMatchObject({ people: 1, disabled: 1 });

    const { people } = (await owner.json<{ people: Array<{ email: string; name: string; role: string; status: string }> }>("/api/v1/people")).body;
    expect(people.find((p) => p.email === "bob@example.com")?.status).toBe("disabled");
    expect(people.find((p) => p.email === "owner@example.com")).toMatchObject({ name: "Olivia Owner", role: "owner", status: "active" });
    expect((await new Browser(app.base).json("/api/v1/auth/login", { body: { email: "bob@example.com", password: "bob directory password" } })).status).toBe(
      401,
    );
  });

  it("turns its people off when it is removed", async () => {
    expect((await owner.json(`/api/v1/directories/${id}`, { method: "DELETE" })).status).toBe(204);
    const { people } = (await owner.json<{ people: Array<{ email: string; status: string }> }>("/api/v1/people")).body;
    expect(people.find((p) => p.email === "alice@example.com")?.status).toBe("disabled");
    const { events } = (await owner.json<{ events: Array<{ type: string }> }>("/api/v1/audit")).body;
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["directory-added", "directory-synced", "directory-removed"]));
  });
});
