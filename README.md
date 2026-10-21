# identity

The [OpenAsy](https://github.com/openasy) Identity product: single sign-on with OpenID Connect, MFA and passkeys, for
OpenAsy products and any other application. One container with its API and web UI, one version, its data in one
SQLite file (ADR 0018, 0033).

> **Not released yet.** This is the skeleton the first release grows from: sign-in for the people who manage Identity,
> health, metrics and the API reference. The OpenID provider, applications, users, groups, MFA policies and upstream
> providers come next; see [ADR 0033](https://github.com/openasy/openasy.github.io/blob/main/docs/decisions/0033-identity.md).

## Run

```bash
openssl rand -hex 32 > openasy-kek
docker compose up -d
docker compose logs identity | grep 'no owner yet'
```

Open the link from the log once to create the owner account; there is no default password (ADR 0013). The UI and API
are on http://localhost:8080; the API reference is at http://localhost:8080/api/docs/.

> The signing keys, client secrets and sign-in secrets are sealed with `openasy-kek` (ADR 0021). Keep that file apart
> from the data volume and with your backups: Identity does not start without it.

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `IDENTITY_DB` | `/data/identity.db` | SQLite file (WAL), on the `/data` volume |
| `IDENTITY_PUBLIC_URL` | `http://localhost:8080` | The address people and applications open, with `https://` behind your TLS proxy. It is the OpenID issuer: keep it fixed once applications use it |
| `IDENTITY_SECRETS_KEY_FILE` | `/run/secrets/openasy-kek` | 32-byte key-encryption key; required |
| `IDENTITY_PASSWORD_SIGN_IN` | `true` | `false` when the people who manage Identity sign in through another provider |
| `IDENTITY_OIDC_*` | | Sign in to Identity itself through another provider, as in every OpenAsy product; owners can also add providers under Settings, Sign-in |
| `IDENTITY_HEADLESS` | `false` | `true` serves only the API |

## Sign-in

Sign-in to manage Identity comes from [@openasy/auth](https://github.com/openasy/auth), the same in every OpenAsy
product (ADR 0002). Viewers see everything; editors also change users and groups; admins also manage applications,
providers, members and API tokens; owners also manage owners. Owners and admins who sign in with a password must add
an authenticator app or a passkey.

## Endpoints

| Path | |
| --- | --- |
| `/healthz`, `/readyz` | Liveness and readiness |
| `/metrics` | Prometheus metrics |
| `GET /api/v1/version` | Product and version |
| `/api/docs/` | Interactive API reference (Swagger UI), bundled in the image |
| `/api/openapi.json` | OpenAPI 3.1 description |

The description lives in [`openapi.json`](./openapi.json) and is the contract: `server/openapi.test.ts` calls every
operation and fails if a response does not match it.

## Develop

```bash
npm ci
IDENTITY_DB=./data/identity.db IDENTITY_SECRETS_KEY_FILE=./data/kek npm start   # API on :8080
npm run dev    # web UI on :5173, proxies /api
npm run typecheck && npm test
```

Create the key once with `mkdir -p data && openssl rand -hex 32 > data/kek`. Node runs the TypeScript sources in
`server/` directly; there is no build step for the server.

## Release

1. Set `version` in `package.json`, merge to `main`.
2. Push the tag: `git tag v0.1.0 && git push origin v0.1.0`.
3. GitHub Actions tests, builds `linux/amd64` and `linux/arm64`, pushes `ghcr.io/openasy/identity:0.1.0` and `:0.1` to
   GitHub Container Registry (never `latest`), signs it, attaches the SBOM and provenance, and creates the GitHub release.

## Design decisions

See [openasy.github.io/principles](https://openasy.github.io/principles) and the records in [openasy.github.io `docs/decisions`](https://github.com/openasy/openasy.github.io/tree/main/docs/decisions).

## Licence

[AGPL-3.0](./LICENSE). You may use, change and share it; if you run a changed version for others, including as a
hosted service, you must offer them your source code under the same licence. A commercial licence without these
obligations is available: see [ADR 0008](https://github.com/openasy/openasy.github.io/blob/main/docs/decisions/0008-open-source.md).
"OpenAsy" and its logo are trademarks and are not covered by the licence.
