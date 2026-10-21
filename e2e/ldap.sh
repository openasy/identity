#!/bin/bash
# Starts lldap, a small LDAP server, with two people and a group, and runs server/ldap.test.ts against it (ADR 0034).
# Needs Docker. Used by CI; run it locally the same way.
set -eu
cd "$(dirname "$0")/.."
NAME=openasy-ldap-test
IMAGE=lldap/lldap:v0.6.3-alpine
ADMIN_PASSWORD=$(openssl rand -hex 12)
docker rm -f "$NAME" >/dev/null 2>&1 || true
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT
docker run -d --name "$NAME" -p 3890:3890 -p 17170:17170 \
  -e LLDAP_JWT_SECRET="$(openssl rand -hex 32)" -e LLDAP_KEY_SEED="$(openssl rand -hex 32)" \
  -e LLDAP_LDAP_USER_PASS="$ADMIN_PASSWORD" -e LLDAP_LDAP_BASE_DN=dc=example,dc=com "$IMAGE" >/dev/null
for _ in $(seq 1 60); do curl -sf -o /dev/null -X POST -H 'content-type: application/json' -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PASSWORD\"}" localhost:17170/auth/simple/login && break; sleep 1; done
JWT=$(curl -sf -X POST -H 'content-type: application/json' -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PASSWORD\"}" localhost:17170/auth/simple/login | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
gql() { curl -sf -X POST -H "authorization: Bearer $JWT" -H 'content-type: application/json' -d "{\"query\":$(node -pe 'JSON.stringify(process.argv[1])' "$1")}" localhost:17170/api/graphql; }
gql 'mutation { createUser(user: {id: "alice", email: "alice@example.com", displayName: "Alice Ader"}) { id } }' >/dev/null
gql 'mutation { createUser(user: {id: "bob", email: "bob@example.com", displayName: "Bob Bell"}) { id } }' >/dev/null
GROUP=$(gql 'mutation { createGroup(name: "openasy-ops") { id } }' | node -pe 'JSON.parse(require("fs").readFileSync(0)).data.createGroup.id')
gql "mutation { addUserToGroup(userId: \"alice\", groupId: $GROUP) { ok } }" >/dev/null
for u in alice bob; do docker exec "$NAME" /app/lldap_set_password --base-url http://localhost:17170 --admin-username admin --admin-password "$ADMIN_PASSWORD" --username "$u" --password "$u directory password" >/dev/null; done
LDAP_URL=ldap://localhost:3890 LDAP_ADMIN_PASSWORD="$ADMIN_PASSWORD" LLDAP_JWT="$JWT" npx vitest run server/ldap.test.ts
