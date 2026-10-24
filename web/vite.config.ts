import react from "@vitejs/plugin-react";
import { colophon } from "@openasy/ui/vite";
import { defineConfig } from "vite";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [
    react(),
    colophon({
      roles: {
        "oidc-provider": "The OpenID Connect provider, OpenID Certified",
        samlify: "SAML 2.0 for applications that need it",
        ldapts: "LDAP and Active Directory",
        "@peculiar/x509": "Certificates for SAML",
        "@xmldom/xmldom": "Reading SAML messages",
      },
    }),
  ],
  build: { outDir: "../dist/web", emptyOutDir: true },
  // The API only takes cookie requests from its own origin, so the dev server presents itself as that origin.
  server: { proxy: { "/api": { target: "http://localhost:8080", headers: { origin: "http://localhost:8080" } } } },
});
