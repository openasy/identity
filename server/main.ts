import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createAuth, oidcFromEnv, readSecretsKey } from "@openasy/auth";
import { createApp } from "./app.ts";
import { createAudit } from "./audit.ts";
import { openDb } from "./db.ts";
import { createDirectory } from "./directory.ts";
import { createKeyring } from "./kek.ts";
import { log } from "./log.ts";
import { createOidc } from "./oidc.ts";
import { createScim } from "./scim.ts";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const port = Number(process.env.PORT ?? 8080);
const dbPath = process.env.IDENTITY_DB ?? "/data/identity.db";
const webDir = new URL("../dist/web", import.meta.url).pathname;
const docsDir = new URL("../dist/docs", import.meta.url).pathname;
const openapi = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Record<string, unknown>;
const headless = process.env.IDENTITY_HEADLESS === "true";

// The key-encryption key (ADR 0021) seals the provider's signing keys, client secrets and sign-in secrets. It lives
// outside /data, so a copy of the volume or a backup holds none of them in the clear.
const secretsKeyFile = process.env.IDENTITY_SECRETS_KEY_FILE ?? "/run/secrets/openasy-kek";
let kek: Buffer | undefined;
try {
  kek = readSecretsKey(secretsKeyFile);
} catch (err) {
  log("error", `the key-encryption key cannot be read: ${(err as Error).message}`, { file: secretsKeyFile });
  process.exit(1);
}
if (!kek) {
  log("error", "no key-encryption key: mount 32 random bytes (openssl rand -hex 32) and set IDENTITY_SECRETS_KEY_FILE if not at the default", { file: secretsKeyFile });
  process.exit(1);
}

const db = openDb(dbPath);
const directory = createDirectory(db, createKeyring(kek));
const audit = createAudit(db);
// The address people open Identity at, behind the TLS proxy (ADR 0026). It is also the OpenID issuer, so it must not
// change once applications use it.
const publicUrl = (process.env.IDENTITY_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
const auth = createAuth({
  db,
  product: "identity",
  productName: "OpenAsy Identity",
  origin: publicUrl,
  trustedOrigins: publicUrl.startsWith("http://localhost:") ? [publicUrl.replace("localhost", "127.0.0.1")] : [],
  passwords: process.env.IDENTITY_PASSWORD_SIGN_IN !== "false",
  // The directory: people who sign in to applications have the user role and do not manage Identity.
  users: true,
  oidc: oidcFromEnv(process.env, "IDENTITY_"),
  // Groups that follow an identity provider's group get their members at each sign-in.
  onOidcSignIn: (s) => directory.syncGroups(s.userId, s.provider, s.groups),
  secretsKey: kek,
  // Audit log (ADR 0013): every sign-in, failure and change to members, tokens and providers.
  onEvent: (event) => audit.record(event),
});
const oidc = createOidc({ db, keyring: createKeyring(kek), directory, auth, audit, issuer: publicUrl });
const server = createServer(
  createApp({
    db,
    version,
    auth,
    directory,
    oidc,
    audit,
    scim: createScim({ db, audit, base: publicUrl }),
    webDir: !headless && existsSync(webDir) ? webDir : undefined,
    docsDir: existsSync(docsDir) ? docsDir : undefined,
    openapi,
  }),
);

server.listen(port, () => log("info", "identity started", { version, port, db: dbPath, headless }));
if (!publicUrl.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(publicUrl)) {
  log("warn", "IDENTITY_PUBLIC_URL is not https: browsers will not keep secure cookies or allow passkeys, and applications refuse an http issuer. Put Identity behind TLS (ADR 0026)", { url: publicUrl });
}
const setup = auth.setupLink();
// No default password (ADR 0013): the first person to open this link becomes the owner.
if (setup) log("info", "no owner yet: open this link once to create the owner account", { url: setup });
const purge = setInterval(() => (auth.purge(), oidc.purge(), audit.purge()), 5 * 60_000);

function shutdown(signal: string) {
  log("info", "shutting down", { signal });
  clearInterval(purge);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
