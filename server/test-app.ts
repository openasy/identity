// Starts the app on a random port for tests, and a browser to use it with.
import { createHmac } from "node:crypto";
import { createServer, type RequestListener, type Server } from "node:http";
import { createAuth } from "@openasy/auth";
import type { AddressInfo } from "node:net";
import { createApp, type AppOptions } from "./app.ts";
import { createAudit } from "./audit.ts";
import { openDb } from "./db.ts";
import { createDirectory } from "./directory.ts";
import { createKeyring } from "./kek.ts";
import { createOidc } from "./oidc.ts";
import { createDirectories } from "./ldap.ts";
import { createScim } from "./scim.ts";

export const KEK = Buffer.alloc(32, 7);

export async function startApp(opts: Partial<AppOptions> & { version: string }) {
  const db = openDb(":memory:");
  // The origin is known once the port is, so the handler is set after listening.
  let handler: RequestListener = (_req, res) => res.writeHead(503).end();
  const server: Server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const keyring = createKeyring(KEK);
  const directory = createDirectory(db, keyring);
  const audit = createAudit(db);
  const directories = createDirectories({ db, keyring, audit });
  const auth = createAuth({ db, product: "identity", productName: "OpenAsy Identity", origin: base, secretsKey: KEK, users: true, externalPasswords: { managedBy: directories.managedBy, verify: directories.verify }, onEvent: (e) => audit.record(e), onOidcSignIn: (s) => directory.syncGroups(s.userId, s.provider, s.groups) });
  const oidc = createOidc({ db, keyring, directory, auth, audit, issuer: base });
  const scim = createScim({ db, audit, base });
  handler = createApp({ db, auth, directory, oidc, audit, scim, directories, ...opts });
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return { db, auth, directory, oidc, audit, scim, directories, base, close };
}

export const UA = "Mozilla/5.0 (Macintosh) Chrome/141.0";
export const PASSWORD = "correct horse battery";

/** fetch with a cookie jar, as a browser: cookies are kept by name, which is enough for one host. */
export class Browser {
  readonly cookies = new Map<string, string>();
  readonly base: string;
  constructor(base: string) {
    this.base = base;
  }
  async fetch(url: string, init: { method?: string; body?: unknown } = {}) {
    const res = await fetch(url.startsWith("http") ? url : this.base + url, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      redirect: "manual",
      headers: {
        origin: this.base,
        "user-agent": UA,
        cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        ...(init.body !== undefined && { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const name = pair!.slice(0, pair!.indexOf("="));
      const value = pair!.slice(pair!.indexOf("=") + 1);
      if (/max-age=0|expires=thu, 01 jan 1970/i.test(c)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }
  async json<T = Record<string, unknown>>(url: string, init: { method?: string; body?: unknown } = {}) {
    const res = await this.fetch(url, init);
    return { status: res.status, body: (res.status === 204 ? {} : await res.json()) as T };
  }
  /** Follows redirects on Identity until one leaves it, and returns where it goes. */
  async follow(url: string): Promise<URL> {
    let next = new URL(url, this.base);
    for (let i = 0; i < 10 && next.origin === this.base; i++) {
      const res = await this.fetch(next.href);
      const location = res.headers.get("location");
      if (!location) throw new Error(`${next.pathname} answered ${res.status}: ${await res.text()}`);
      next = new URL(location, next);
    }
    return next;
  }
}

export const totp = (secret: string) => {
  const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of secret.replace(/=+$/, "")) bits += a.indexOf(ch).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const h = createHmac("sha1", key).update(msg).digest();
  return String((h.readUInt32BE(h[19]! & 15) & 0x7fffffff) % 1e6).padStart(6, "0");
};

/** The owner, signed in with a password and an authenticator app, as the first start makes them. */
export async function createOwner(app: Awaited<ReturnType<typeof startApp>>) {
  const owner = new Browser(app.base);
  const token = new URL(app.auth.setupLink()!).searchParams.get("setup");
  await owner.json("/api/v1/auth/setup", { body: { token, name: "Olivia Owner", email: "owner@example.com", password: PASSWORD } });
  const { body } = await owner.json<{ secret: string }>("/api/v1/auth/me/totp", { body: {} });
  await owner.json("/api/v1/auth/me/totp/confirm", { body: { code: totp(body.secret) } });
  return owner;
}
