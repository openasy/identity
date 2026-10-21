// SAML 2.0 identity provider (ADR 0034), for applications that do not speak OpenID Connect, such as AWS IAM Identity
// Center, Jira or GitLab. samlify signs; the response is written here so it carries what the Web SSO profile asks for
// (an AuthnStatement) and people's email, name and groups. Identity answers only at the ACS address registered for
// the application, never at one a request names, and signs both the response and the assertion.
import "reflect-metadata";
import { randomBytes, randomUUID, webcrypto } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { inflateRawSync } from "node:zlib";
import * as x509 from "@peculiar/x509";
import { DOMParser } from "@xmldom/xmldom";
import * as samlify from "samlify";
import type { Audit } from "./audit.ts";
import type { Directory } from "./directory.ts";
import type { Keyring } from "./kek.ts";
import type { Oidc } from "./oidc.ts";

export const SAML_PREFIX = "/saml";
const POST_BINDING = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST";
const REDIRECT_BINDING = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect";
const NAME_ID = { email: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress", persistent: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent" };
const VALID_FOR_MS = 5 * 60_000;

/**
 * samlify checks incoming XML with a schema validator. Identity reads only a request's ID and Issuer, never trusts its
 * ACS address, and does not verify request signatures, so a full XSD check would guard nothing it relies on. This one
 * refuses document types (XML entity attacks) and anything that is not one SAML message.
 */
samlify.setSchemaValidator({
  validate: async (xml: string) => {
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("ERR_DOCTYPE_NOT_ALLOWED");
    if (!/^\s*(<\?xml[^>]*\?>\s*)?<([\w-]+:)?(AuthnRequest|Response|LogoutRequest|LogoutResponse)[\s>]/.test(xml)) throw new Error("ERR_NOT_A_SAML_MESSAGE");
    return "ok";
  },
});

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A key and a self-signed certificate for signing, made on first start and kept sealed. Applications pin the certificate. */
async function signingCertificate(db: DatabaseSync, keyring: Keyring, issuer: string) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'saml_signing'").get() as { value: string } | undefined;
  if (row) return JSON.parse(keyring.open(row.value).toString("utf8")) as { key: string; cert: string };
  x509.cryptoProvider.set(webcrypto as Crypto);
  const alg = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256", publicExponent: new Uint8Array([1, 0, 1]), modulusLength: 2048 };
  const keys = await webcrypto.subtle.generateKey(alg, true, ["sign", "verify"]);
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: randomBytes(8).toString("hex"),
    name: `CN=OpenAsy Identity, OU=${new URL(issuer).host}`,
    notBefore: new Date(),
    notAfter: new Date(Date.now() + 10 * 365 * 86_400_000),
    signingAlgorithm: alg,
    keys,
  });
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey("pkcs8", keys.privateKey)).toString("base64");
  const value = { key: `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`, cert: cert.toString("pem") };
  db.prepare("INSERT INTO settings (key, value) VALUES ('saml_signing', ?)").run(keyring.seal(JSON.stringify(value)));
  return value;
}

/** The ID and Issuer of an AuthnRequest, from the Redirect (deflated) or POST binding. */
function readRequest(encoded: string, deflated: boolean): { id: string; issuer: string } {
  const raw = Buffer.from(encoded, "base64");
  const xml = (deflated ? inflateRawSync(raw, { maxOutputLength: 256 * 1024 }) : raw).toString("utf8");
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("document types are not allowed");
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const root = doc.documentElement;
  if (!root || root.localName !== "AuthnRequest" || root.namespaceURI !== "urn:oasis:names:tc:SAML:2.0:protocol") throw new Error("not an AuthnRequest");
  const issuer = Array.from(root.childNodes).find((n) => (n as { localName?: string }).localName === "Issuer")?.textContent?.trim();
  const id = root.getAttribute("ID");
  if (!issuer || !id || !/^[A-Za-z_][\w.-]{0,255}$/.test(id)) throw new Error("the request has no Issuer or ID");
  return { id, issuer };
}

export interface SamlOptions {
  db: DatabaseSync;
  keyring: Keyring;
  directory: Directory;
  audit: Audit;
  issuer: string;
  /** Who is signed in to Identity here, and what their groups still ask of their session (oidc.ts). */
  signedIn: Oidc["signedIn"];
  missing: Oidc["missing"];
}

export async function createSaml({ db, keyring, directory, audit, issuer, signedIn, missing }: SamlOptions) {
  const { key, cert } = await signingCertificate(db, keyring, issuer);
  const entityId = `${issuer}${SAML_PREFIX}`;
  const idp = samlify.IdentityProvider({
    entityID: entityId,
    privateKey: key,
    signingCert: cert,
    nameIDFormat: [NAME_ID.email, NAME_ID.persistent],
    singleSignOnService: [
      { Binding: REDIRECT_BINDING, Location: `${issuer}${SAML_PREFIX}/sso` },
      { Binding: POST_BINDING, Location: `${issuer}${SAML_PREFIX}/sso` },
    ],
    requestSignatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
  });

  const page = (res: ServerResponse, status: number, title: string, text: string) => {
    const body = `<!doctype html><meta charset="utf-8"><title>${esc(title)} · OpenAsy Identity</title><main style="font:16px system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1 style="font-size:1.25rem">${esc(title)}</h1><p>${esc(text)}</p></main>`;
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" }).end(body);
  };

  /** The signed response, posted to the application's registered ACS address by the browser. */
  async function respond(res: ServerResponse, appId: string, userId: string, requestId: string | null, relayState: string | null) {
    const app = directory.application(appId);
    const account = directory.account(userId)!;
    const s = app.saml!;
    const sp = samlify.ServiceProvider({
      entityID: s.entityId,
      assertionConsumerService: [{ Binding: POST_BINDING, Location: s.acsUrl }],
      wantAssertionsSigned: true,
      wantMessageSigned: true,
      nameIDFormat: [NAME_ID[s.nameId]],
    });
    const t = new Date();
    const iso = (ms = 0) => new Date(t.getTime() + ms).toISOString();
    const id = `_${randomUUID()}`;
    const attribute = (name: string, values: string[]) =>
      `<saml:Attribute Name="${esc(name)}" NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:basic">${values.map((v) => `<saml:AttributeValue xsi:type="xs:string">${esc(v)}</saml:AttributeValue>`).join("")}</saml:Attribute>`;
    const result = await idp.createLoginResponse(
      sp,
      { extract: { request: { id: requestId ?? undefined } } } as unknown as Parameters<typeof idp.createLoginResponse>[1],
      "post",
      { email: account.email },
      {
        relayState: relayState ?? undefined,
        // The whole response, with every value escaped; samlify signs it.
        customTagReplacement: (template: string) => ({
          id,
          context: template
            .replace(
              "{AuthnStatement}",
              `<saml:AuthnStatement AuthnInstant="${iso()}" SessionIndex="${id}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>`,
            )
            .replace("{AttributeStatement}", `<saml:AttributeStatement>${attribute("email", [account.email])}${attribute("name", [account.name])}${attribute("groups", account.groups)}</saml:AttributeStatement>`)
            .replace(/ InResponseTo="\{InResponseTo\}"/g, requestId ? ` InResponseTo="${esc(requestId)}"` : "")
            .replace(/\{(\w+)\}/g, (_m, tag: string) => {
              const values: Record<string, string> = {
                ID: id,
                AssertionID: `_${randomUUID()}`,
                IssueInstant: iso(),
                Destination: s.acsUrl,
                SubjectRecipient: s.acsUrl,
                Issuer: entityId,
                Audience: s.entityId,
                StatusCode: "urn:oasis:names:tc:SAML:2.0:status:Success",
                NameIDFormat: NAME_ID[s.nameId],
                NameID: s.nameId === "email" ? account.email : account.sub,
                ConditionsNotBefore: iso(-60_000),
                ConditionsNotOnOrAfter: iso(VALID_FOR_MS),
                SubjectConfirmationDataNotOnOrAfter: iso(VALID_FOR_MS),
              };
              if (!(tag in values)) throw new Error(`SAML template tag ${tag} has no value`);
              return esc(values[tag]!);
            }),
        }),
      },
    );
    const ctx = result as { context: string };
    audit.record({ type: "app-sign-in", application: appId, actor: userId, method: "saml" });
    // The browser posts the response to the application. The page's one script is allowed by its nonce.
    const nonce = randomBytes(16).toString("base64");
    const html = `<!doctype html><meta charset="utf-8"><title>Signing in · OpenAsy Identity</title>
<form method="post" action="${esc(s.acsUrl)}"><input type="hidden" name="SAMLResponse" value="${esc(ctx.context)}">${relayState ? `<input type="hidden" name="RelayState" value="${esc(relayState)}">` : ""}<noscript><button type="submit">Continue to ${esc(app.name)}</button></noscript></form>
<script nonce="${nonce}">document.forms[0].submit()</script>`;
    res
      .writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; form-action ${new URL(s.acsUrl).origin}`,
      })
      .end(html);
  }

  /** Someone signed in, allowed and strong enough continues to the application; anyone else signs in first. */
  async function continueRequest(req: IncomingMessage, res: ServerResponse, pendingId: string) {
    const p = db.prepare("SELECT * FROM saml_requests WHERE id = ? AND expires_at > ?").get(pendingId, new Date().toISOString()) as
      | { id: string; application_id: string; request_id: string | null; relay_state: string | null }
      | undefined;
    if (!p) return page(res, 400, "This sign-in expired", "Go back to the application and start again.");
    const back = encodeURIComponent(`${SAML_PREFIX}/continue/${p.id}`);
    const s = signedIn(req);
    if (!s) return void res.writeHead(303, { location: `/?return=${back}` }).end();
    if (!directory.mayUse(p.application_id, s.id)) {
      audit.record({ type: "app-sign-in-refused", application: p.application_id, actor: s.id, detail: "not in its groups" });
      return page(res, 403, "Not for you", `You may not use ${directory.application(p.application_id).name}. Ask an admin to add you to one of its groups.`);
    }
    const need = missing(s);
    if (need) {
      audit.record({ type: "app-sign-in-refused", application: p.application_id, actor: s.id, detail: need === "passkey" ? "passkey needed" : "second factor needed" });
      return void res.writeHead(303, { location: `/?return=${back}&mfa=${need}` }).end();
    }
    db.prepare("DELETE FROM saml_requests WHERE id = ?").run(p.id);
    await respond(res, p.application_id, s.id, p.request_id, p.relay_state);
  }

  /** An application's AuthnRequest, by Redirect or POST: kept while its person signs in. */
  async function sso(req: IncomingMessage, res: ServerResponse) {
    let params: URLSearchParams;
    if (req.method === "POST") {
      let raw = "";
      for await (const c of req) {
        raw += c;
        if (raw.length > 512 * 1024) return page(res, 413, "Request too large", "The application sent too much.");
      }
      params = new URLSearchParams(raw);
    } else params = new URL(req.url ?? "/", "http://localhost").searchParams;
    const encoded = params.get("SAMLRequest");
    if (!encoded) return page(res, 400, "No sign-in request", "Start from the application.");
    let request: { id: string; issuer: string };
    try {
      request = readRequest(encoded, req.method !== "POST");
    } catch (err) {
      return page(res, 400, "Sign-in request not understood", (err as Error).message);
    }
    const appId = directory.samlApplication(request.issuer);
    if (!appId) return page(res, 400, "Unknown application", `No application here has the entity ID ${request.issuer}. An admin adds it under Applications.`);
    const relay = params.get("RelayState");
    const pendingId = randomUUID();
    db.prepare("INSERT INTO saml_requests (id, application_id, request_id, relay_state, expires_at) VALUES (?, ?, ?, ?, ?)").run(
      pendingId,
      appId,
      request.id,
      relay && relay.length <= 1024 ? relay : null,
      new Date(Date.now() + 10 * 60_000).toISOString(),
    );
    await continueRequest(req, res, pendingId);
  }

  /** IdP-initiated: from Identity, straight into an application, without a request from it. */
  async function start(req: IncomingMessage, res: ServerResponse, appId: string) {
    const app = (() => {
      try {
        return directory.application(appId);
      } catch {
        return undefined;
      }
    })();
    if (!app?.saml) return page(res, 404, "Unknown application", "No SAML application here has this id.");
    const pendingId = randomUUID();
    db.prepare("INSERT INTO saml_requests (id, application_id, expires_at) VALUES (?, ?, ?)").run(pendingId, appId, new Date(Date.now() + 10 * 60_000).toISOString());
    await continueRequest(req, res, pendingId);
  }

  return {
    entityId,
    certificate: cert,
    async handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
      if (!path.startsWith(`${SAML_PREFIX}/`)) return false;
      if (path === `${SAML_PREFIX}/metadata` && req.method === "GET") {
        const xml = idp.getMetadata();
        res.writeHead(200, { "content-type": "application/samlmetadata+xml", "cache-control": "no-store" }).end(xml);
      } else if (path === `${SAML_PREFIX}/certificate` && req.method === "GET") {
        res.writeHead(200, { "content-type": "application/x-pem-file", "content-disposition": 'attachment; filename="openasy-identity-saml.pem"' }).end(cert);
      } else if (path === `${SAML_PREFIX}/sso` && (req.method === "GET" || req.method === "POST")) await sso(req, res);
      else if (path.startsWith(`${SAML_PREFIX}/continue/`) && req.method === "GET") await continueRequest(req, res, path.slice(`${SAML_PREFIX}/continue/`.length));
      else if (path.startsWith(`${SAML_PREFIX}/start/`) && req.method === "GET") await start(req, res, path.slice(`${SAML_PREFIX}/start/`.length));
      else page(res, 404, "Not found", "There is nothing here.");
      return true;
    },
    purge() {
      db.prepare("DELETE FROM saml_requests WHERE expires_at < ?").run(new Date().toISOString());
    },
  };
}

export type Saml = Awaited<ReturnType<typeof createSaml>>;
