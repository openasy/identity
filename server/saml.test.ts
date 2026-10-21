// The SAML identity provider end to end, with samlify's service provider as the application: it sends a real
// AuthnRequest and checks Identity's signature, audience and attributes as an application would (ADR 0034).
import { deflateRawSync } from "node:zlib";
import * as samlify from "samlify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Browser, createOwner, PASSWORD, startApp } from "./test-app.ts";

const SP = { entityID: "https://jira.example.com/sp", acs: "https://jira.example.com/plugins/servlet/samlconsumer" };
const POST = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST";

let app: Awaited<ReturnType<typeof startApp>>;
let owner: Browser;
let uma: Browser;
let idp: ReturnType<typeof samlify.IdentityProvider>;
const sp = samlify.ServiceProvider({ entityID: SP.entityID, assertionConsumerService: [{ Binding: POST, Location: SP.acs }], wantAssertionsSigned: true });

beforeAll(async () => {
  app = await startApp({ version: "1.2.3" });
  owner = await createOwner(app);
  const group = (await owner.json<{ id: string }>("/api/v1/groups", { body: { name: "Engineering" } })).body;
  const created = await owner.json<{ application: { protocol: string; saml: unknown }; clientSecret: string | null }>("/api/v1/applications", {
    body: { name: "Jira", template: "saml", entityId: SP.entityID, acsUrl: SP.acs, groups: ["Engineering"] },
  });
  expect(created.body).toMatchObject({ application: { protocol: "saml", saml: { entityId: SP.entityID, acsUrl: SP.acs, nameId: "email" } }, clientSecret: null });

  const invited = await owner.json<{ member: { id: string }; link: string }>("/api/v1/auth/members", { body: { email: "uma@example.com", name: "Uma Ito", role: "user" } });
  uma = new Browser(app.base);
  await uma.json(`/api/v1/auth/links/${new URL(invited.body.link).searchParams.get("link")}`, { body: { password: PASSWORD } });
  await owner.json(`/api/v1/groups/${group.id}/members`, { method: "PUT", body: { userIds: [invited.body.member.id] } });

  const metadata = await (await fetch(`${app.base}/saml/metadata`)).text();
  idp = samlify.IdentityProvider({ metadata });
});
afterAll(() => app.close());

/** The application asks Identity to sign someone in, and the page that comes back. */
async function request(b: Browser) {
  const { id, context } = sp.createLoginRequest(idp, "redirect", { relayState: "/browse/OPS-1" }) as { id: string; context: string };
  const url = new URL(context);
  return { id, res: await b.fetch(url.pathname + url.search) };
}

/** What the browser would post to the application. */
const posted = (html: string) => ({
  action: html.match(/<form method="post" action="([^"]+)"/)?.[1]?.replaceAll("&#38;", "&"),
  SAMLResponse: html.match(/name="SAMLResponse" value="([^"]+)"/)?.[1],
  RelayState: html.match(/name="RelayState" value="([^"]+)"/)?.[1]?.replaceAll("&#47;", "/"),
});

describe("the SAML identity provider", () => {
  it("publishes metadata with its signing certificate", async () => {
    const xml = await (await fetch(`${app.base}/saml/metadata`)).text();
    expect(xml).toContain(`entityID="${app.base}/saml"`);
    expect(xml).toContain(`Location="${app.base}/saml/sso"`);
    expect(xml).toContain("<ds:X509Certificate>");
    expect(await (await fetch(`${app.base}/saml/certificate`)).text()).toMatch(/^-----BEGIN CERTIFICATE-----/);
  });

  it("signs a member of the application's groups in, with a response the application accepts", async () => {
    const { id, res } = await request(uma);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toMatch(/form-action https:\/\/jira\.example\.com/);
    const form = posted(await res.text());
    expect(form.action).toBe(SP.acs);
    expect(form.RelayState).toBe("/browse/OPS-1");

    const { extract } = (await sp.parseLoginResponse(idp, "post", { body: { SAMLResponse: form.SAMLResponse } })) as unknown as {
      extract: { nameID: string; attributes: Record<string, unknown>; response: { inResponseTo: string }; audience: string };
    };
    expect(extract.nameID).toBe("uma@example.com");
    expect(extract.attributes).toMatchObject({ email: "uma@example.com", name: "Uma Ito", groups: "Engineering" });
    expect(extract.response.inResponseTo).toBe(id);
    expect(extract.audience).toBe(SP.entityID);
    const xml = Buffer.from(form.SAMLResponse!, "base64").toString("utf8");
    expect(xml).toContain("<saml:AuthnStatement");
  });

  it("refuses a response someone changed on the way", async () => {
    const form = posted(await (await request(uma)).res.text());
    const xml = Buffer.from(form.SAMLResponse!, "base64").toString("utf8").replace("uma@example.com</saml:NameID>", "eve@example.com</saml:NameID>");
    await expect(sp.parseLoginResponse(idp, "post", { body: { SAMLResponse: Buffer.from(xml).toString("base64") } })).rejects.toBeDefined();
  });

  it("answers only at the registered ACS address, whatever the request names", async () => {
    const xml = `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_evil1" Version="2.0" IssueInstant="${new Date().toISOString()}" AssertionConsumerServiceURL="https://evil.example.com/steal"><saml:Issuer>${SP.entityID}</saml:Issuer></samlp:AuthnRequest>`;
    const res = await uma.fetch(`/saml/sso?SAMLRequest=${encodeURIComponent(deflateRawSync(xml).toString("base64"))}`);
    expect(posted(await res.text()).action).toBe(SP.acs);
  });

  it("sends people who are not signed in to sign in first, and refuses the rest", async () => {
    const stranger = await request(new Browser(app.base));
    expect(stranger.res.status).toBe(303);
    expect(stranger.res.headers.get("location")).toMatch(/^\/\?return=%2Fsaml%2Fcontinue%2F[\w-]+$/);

    const invited = await owner.json<{ link: string }>("/api/v1/auth/members", { body: { email: "ned@example.com", role: "user" } });
    const ned = new Browser(app.base);
    await ned.json(`/api/v1/auth/links/${new URL(invited.body.link).searchParams.get("link")}`, { body: { password: PASSWORD } });
    expect((await request(ned)).res.status).toBe(403);

    const unknown = `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_x" Version="2.0"><saml:Issuer>https://unknown.example.com</saml:Issuer></samlp:AuthnRequest>`;
    expect((await uma.fetch(`/saml/sso?SAMLRequest=${encodeURIComponent(deflateRawSync(unknown).toString("base64"))}`)).status).toBe(400);
    const entity = `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_y"><Issuer>&e;</Issuer></samlp:AuthnRequest>`;
    expect((await uma.fetch(`/saml/sso?SAMLRequest=${encodeURIComponent(deflateRawSync(entity).toString("base64"))}`)).status).toBe(400);
  });

  it("asks for what the groups ask, as for OpenID Connect", async () => {
    const eng = (await owner.json<{ groups: Array<{ id: string; name: string }> }>("/api/v1/groups")).body.groups.find((g) => g.name === "Engineering")!;
    await owner.json(`/api/v1/groups/${eng.id}`, { method: "PATCH", body: { mfa: "required" } });
    expect((await request(uma)).res.headers.get("location")).toMatch(/&mfa=required$/);
    await owner.json(`/api/v1/groups/${eng.id}`, { method: "PATCH", body: { mfa: "optional" } });
  });

  it("keeps a SAML application apart from OpenID Connect clients", async () => {
    const { applications } = (await owner.json<{ applications: Array<{ id: string }> }>("/api/v1/applications")).body;
    expect((await owner.json(`/api/v1/applications/${applications[0]!.id}/secret`, { body: {} })).status).toBe(409);
    expect(app.directory.clientMetadata(applications[0]!.id)).toBeUndefined();
    const { events } = (await owner.json<{ events: Array<{ type: string; method?: string }> }>("/api/v1/audit?type=app-sign-in")).body;
    expect(events.some((e) => e.method === "saml")).toBe(true);
  });
});
