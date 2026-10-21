// The OpenID provider (ADR 0033): oidc-provider, an OpenID Certified implementation, with its storage in SQLite, its
// keys sealed with the key-encryption key, and people signed in by @openasy/auth. Identity's own sign-in is the
// single session: when someone signs out of Identity, applications ask them to sign in again.
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import type { Auth } from "@openasy/auth";
import { Provider, errors, interactionPolicy, type Adapter, type AdapterPayload, type KoaContextWithOIDC } from "oidc-provider";
import type { Audit } from "./audit.ts";
import type { Directory } from "./directory.ts";
import type { Keyring } from "./kek.ts";
import { log } from "./log.ts";

/** Who is signed in to Identity, and with what. */
interface Session {
  id: string;
  /** Opened with a second factor, a passkey, or through an identity provider. */
  strong: boolean;
  /** Opened with a passkey, alone or as the second step, or one was added during it. */
  passkey: boolean;
}

/** The address a request came from, as the access log has it. */
const clientIpOf = (req: IncomingMessage) => req.socket.remoteAddress ?? undefined;

/** Paths the provider answers, besides discovery at /.well-known/openid-configuration. */
export const OIDC_PREFIX = "/oidc";
const epoch = () => Math.floor(Date.now() / 1000);

/** oidc-provider's storage, one row per stored thing, as its memory adapter keeps them. */
class SqliteAdapter implements Adapter {
  readonly model: string;
  readonly db: DatabaseSync;
  constructor(model: string, db: DatabaseSync) {
    this.model = model;
    this.db = db;
  }
  async upsert(id: string, payload: AdapterPayload, expiresIn: number) {
    this.db
      .prepare(
        `INSERT INTO oidc_models (model, id, payload, grant_id, uid, user_code, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (model, id) DO UPDATE SET payload = excluded.payload, grant_id = excluded.grant_id, uid = excluded.uid, user_code = excluded.user_code, expires_at = excluded.expires_at`,
      )
      .run(this.model, id, JSON.stringify(payload), payload.grantId ?? null, payload.uid ?? null, payload.userCode ?? null, expiresIn ? epoch() + expiresIn : null);
  }
  private row(where: string, value: string): AdapterPayload | undefined {
    const r = this.db.prepare(`SELECT payload, expires_at, consumed_at FROM oidc_models WHERE model = ? AND ${where} = ?`).get(this.model, value) as
      | { payload: string; expires_at: number | null; consumed_at: number | null }
      | undefined;
    if (!r || (r.expires_at !== null && r.expires_at < epoch())) return undefined;
    return { ...(JSON.parse(r.payload) as AdapterPayload), ...(r.consumed_at !== null && { consumed: r.consumed_at }) };
  }
  async find(id: string) {
    return this.row("id", id);
  }
  async findByUid(uid: string) {
    return this.row("uid", uid);
  }
  async findByUserCode(userCode: string) {
    return this.row("user_code", userCode);
  }
  async consume(id: string) {
    this.db.prepare("UPDATE oidc_models SET consumed_at = ? WHERE model = ? AND id = ?").run(epoch(), this.model, id);
  }
  async destroy(id: string) {
    this.db.prepare("DELETE FROM oidc_models WHERE model = ? AND id = ?").run(this.model, id);
  }
  async revokeByGrantId(grantId: string) {
    this.db.prepare("DELETE FROM oidc_models WHERE grant_id = ?").run(grantId);
  }
}

/** Clients are Identity's applications: read from its table, never registered through the protocol. */
class ClientAdapter extends SqliteAdapter {
  readonly directory: Directory;
  constructor(db: DatabaseSync, directory: Directory) {
    super("Client", db);
    this.directory = directory;
  }
  override async find(id: string): Promise<AdapterPayload | undefined> {
    return this.directory.clientMetadata(id) as AdapterPayload | undefined;
  }
}

/** Keys that outlive restarts, sealed in settings: created on first start. */
function sealedSetting(db: DatabaseSync, keyring: Keyring, key: string, create: () => string): string {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  if (row) return keyring.open(row.value).toString("utf8");
  const value = create();
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(key, keyring.seal(value));
  return value;
}

function signingKeys(db: DatabaseSync, keyring: Keyring) {
  const jwk = sealedSetting(db, keyring, "oidc_signing_key", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    return JSON.stringify({ ...privateKey.export({ format: "jwk" }), kid: randomUUID(), alg: "RS256", use: "sig" });
  });
  const cookieKey = sealedSetting(db, keyring, "oidc_cookie_key", () => randomBytes(32).toString("base64url"));
  return { keys: [JSON.parse(jwk) as Record<string, string>], cookieKey };
}

export interface OidcOptions {
  db: DatabaseSync;
  keyring: Keyring;
  directory: Directory;
  auth: Auth;
  audit: Audit;
  /** Identity's public address; the issuer applications trust. */
  issuer: string;
}

export function createOidc({ db, keyring, directory, auth, audit, issuer }: OidcOptions) {
  const { keys, cookieKey } = signingKeys(db, keyring);

  /**
   * Who is signed in to Identity in this browser, if anyone, and whether that session is strong: opened with a second
   * factor or a passkey, or through an identity provider, which handles its own (ADR 0002).
   */
  const signedIn = (req: IncomingMessage): Session | undefined => {
    try {
      const p = auth.authorize(req, "user");
      return p.kind === "session" ? { id: p.user.id, strong: p.mfa || p.method === "passkey" || p.method.startsWith("oidc:"), passkey: p.factor === "passkey" } : undefined;
    } catch {
      return undefined;
    }
  };
  /** What someone's groups ask of this session that it does not have: a passkey, a second factor, or nothing. */
  function missing(s: Session): "passkey" | "required" | undefined {
    const level = directory.mfaRequired(s.id);
    if (level === "passkey") return s.passkey ? undefined : "passkey";
    if (level === "required") return s.strong ? undefined : "required";
    return undefined;
  }

  // Identity's sign-in is the session: the provider asks again when it no longer matches, or when someone's groups
  // now ask for a second factor their session does not have.
  const policy = interactionPolicy.base();
  policy.get("login")!.checks.add(
    new interactionPolicy.Check("identity_session", "Sign in to Identity", (ctx) => {
      const accountId = ctx.oidc.session?.accountId;
      const s = signedIn(ctx.req);
      return !accountId || s?.id !== accountId || missing(s) ? interactionPolicy.Check.REQUEST_PROMPT : interactionPolicy.Check.NO_NEED_TO_PROMPT;
    }),
  );
  const refused = (application: string, actor: string, detail: string, ip?: string) => audit.record({ type: "app-sign-in-refused", application, actor, detail, ip });

  const provider = new Provider(issuer, {
    adapter: (name: string) => (name === "Client" ? new ClientAdapter(db, directory) : new SqliteAdapter(name, db)),
    jwks: { keys },
    cookies: { keys: [cookieKey] },
    routes: {
      authorization: `${OIDC_PREFIX}/auth`,
      token: `${OIDC_PREFIX}/token`,
      userinfo: `${OIDC_PREFIX}/me`,
      jwks: `${OIDC_PREFIX}/jwks`,
      end_session: `${OIDC_PREFIX}/session/end`,
      revocation: `${OIDC_PREFIX}/token/revocation`,
      introspection: `${OIDC_PREFIX}/token/introspection`,
      pushed_authorization_request: `${OIDC_PREFIX}/request`,
      registration: `${OIDC_PREFIX}/reg`,
      code_verification: `${OIDC_PREFIX}/device`,
      device_authorization: `${OIDC_PREFIX}/device/auth`,
      backchannel_authentication: `${OIDC_PREFIX}/backchannel`,
      challenge: `${OIDC_PREFIX}/challenge`,
      credential: `${OIDC_PREFIX}/credential`,
    },
    scopes: ["openid", "offline_access", "email", "profile", "groups"],
    // The ID token carries the claims of the scopes asked for, as Keycloak's does: many applications, @openasy/auth
    // among them, read email, name and groups from it and never call userinfo.
    conformIdTokenClaims: false,
    claims: { openid: ["sub"], email: ["email", "email_verified"], profile: ["name"], groups: ["groups"] },
    // Every application proves its code with PKCE, not only public ones.
    pkce: { required: () => true },
    features: { devInteractions: { enabled: false }, revocation: { enabled: true }, rpInitiatedLogout: { enabled: true } },
    interactions: { policy, url: (_ctx, interaction) => `/interaction/${interaction.uid}` },
    async findAccount(_ctx, sub) {
      const a = directory.account(sub);
      return a && { accountId: sub, claims: async () => a };
    },
    // Applications are added by an admin, so there is no consent screen; who may use one is checked here too, for
    // people who are already signed in and never see an interaction.
    async loadExistingGrant(ctx: KoaContextWithOIDC) {
      const { client, session } = ctx.oidc;
      const accountId = session?.accountId;
      if (!client || !accountId) return undefined;
      if (!directory.mayUse(client.clientId, accountId)) {
        refused(client.clientId, accountId, "not in its groups", ctx.ip);
        throw new errors.AccessDenied(`You may not use ${client.clientName ?? "this application"}. Ask an admin to add you to one of its groups.`);
      }
      const grantId = ctx.oidc.result?.consent?.grantId ?? session.grantIdFor(client.clientId);
      if (grantId) {
        const existing = await ctx.oidc.provider.Grant.find(grantId);
        if (existing) return existing;
      }
      const grant = new ctx.oidc.provider.Grant({ clientId: client.clientId, accountId });
      grant.addOIDCScope("openid offline_access email profile groups");
      await grant.save();
      return grant;
    },
    issueRefreshToken: async (_ctx, client, code) => client.grantTypeAllowed("refresh_token") && code.scopes.has("offline_access"),
    ttl: { AccessToken: 600, AuthorizationCode: 60, IdToken: 600, Interaction: 600, Session: 12 * 3600, Grant: 30 * 86_400, RefreshToken: 30 * 86_400 },
    async renderError(ctx, out) {
      ctx.type = "html";
      const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
      ctx.body = `<!doctype html><meta charset="utf-8"><title>Sign-in failed · OpenAsy Identity</title><main style="font:16px system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1 style="font-size:1.25rem">Sign-in failed</h1><p>${esc(out.error_description ?? out.error)}</p></main>`;
    },
  });
  // Behind the TLS proxy (ADR 0026), the provider reads the scheme and host from X-Forwarded-* headers.
  provider.proxy = issuer.startsWith("https://");
  provider.on("server_error", (_ctx, err) => log("error", "openid provider", { error: String(err) }));
  // A code exchanged for tokens: someone signed in to an application.
  provider.on("grant.success", (ctx) => {
    if (ctx.oidc.params?.grant_type === "authorization_code") audit.record({ type: "app-sign-in", application: ctx.oidc.client?.clientId, actor: ctx.oidc.entities.AuthorizationCode?.accountId, ip: ctx.ip });
  });

  const handler = provider.callback();

  /**
   * After the provider sends the browser here: someone signed in to Identity continues to the application; anyone else
   * signs in first and comes back.
   */
  async function interaction(req: IncomingMessage, res: ServerResponse, uid: string) {
    const details = await provider.interactionDetails(req, res).catch(() => undefined);
    if (!details || details.uid !== uid) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("This sign-in expired. Go back to the application and start again.");
      return;
    }
    const back = encodeURIComponent(`/interaction/${uid}`);
    const s = signedIn(req);
    if (!s) {
      res.writeHead(303, { location: `/?return=${back}` }).end();
      return;
    }
    const clientId = String(details.params.client_id);
    if (!directory.mayUse(clientId, s.id)) {
      refused(clientId, s.id, "not in its groups", clientIpOf(req));
      await provider.interactionFinished(req, res, { error: "access_denied", error_description: "You may not use this application. Ask an admin to add you to one of its groups." }, { mergeWithLastSubmission: false });
      return;
    }
    // Their groups ask for a second factor or a passkey: they add it, or sign in again with it, and come back here.
    const need = missing(s);
    if (need) {
      refused(clientId, s.id, need === "passkey" ? "passkey needed" : "second factor needed", clientIpOf(req));
      res.writeHead(303, { location: `/?return=${back}&mfa=${need}` }).end();
      return;
    }
    await provider.interactionFinished(req, res, { login: { accountId: s.id } }, { mergeWithLastSubmission: false });
  }

  return {
    provider,
    /** Answers the provider's paths and returns true; false for everything else. */
    async handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
      const m = path.match(/^\/interaction\/([A-Za-z0-9_-]+)$/);
      if (m && req.method === "GET") {
        await interaction(req, res, m[1]!);
        return true;
      }
      if (path === "/.well-known/openid-configuration" || path.startsWith(`${OIDC_PREFIX}/`)) {
        await handler(req, res);
        return true;
      }
      return false;
    },
    /** Deletes expired codes, tokens and sessions. */
    purge() {
      db.prepare("DELETE FROM oidc_models WHERE expires_at IS NOT NULL AND expires_at < ?").run(epoch());
    },
  };
}

export type Oidc = ReturnType<typeof createOidc>;
