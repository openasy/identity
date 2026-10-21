import { AppShell, BrandProvider, Button, Callout, EmptyState, PageHeader } from "@openasy/ui";
import { AccountSettings, AuthGate, MembersSettings, SignInSettings, TokensSettings, useAuth } from "@openasy/auth/react";
import { AppWindow, ArrowRight, KeyRound, LayoutDashboard, LogIn, LogOut, ScrollText, UserRound, Users, UsersRound } from "lucide-react";
import { useEffect, useState } from "react";
import { ApplicationsPage } from "./applications.tsx";
import { GroupsPage } from "./groups.tsx";
import { AuditPage, OverviewPage } from "./overview.tsx";
import { PeoplePage } from "./people.tsx";
import { useApi } from "./shared.tsx";

const PAGES = ["overview", "applications", "people", "groups", "audit", "account", "members", "signin", "tokens"] as const;
type Page = (typeof PAGES)[number];

function parsePage(hash: string): Page {
  const page = hash.replace(/^#\/?/, "").split("/")[0] ?? "";
  return (PAGES as readonly string[]).includes(page) ? (page as Page) : "overview";
}

const SETTINGS = {
  account: ["Account", "Your profile, password, two-step verification and where you are signed in."],
  members: ["Members", "Who can manage this Identity, and with which role. Viewers see everything; editors also change groups; admins also manage applications, providers, members and tokens. People with the User role only sign in to applications."],
  signin: ["Sign-in", "Identity providers people can sign in to Identity with, such as Keycloak or Microsoft Entra ID, and which of their groups give which role."],
  tokens: ["API tokens", "For scripts. Each token has one role and an expiry; the secret is shown once."],
} as const;

// An application sent someone here to sign in (/?return=/interaction/<uid>): once they are signed in, they go back.
// Only that path is taken, so the link cannot send anyone to another site. With &mfa=required their groups ask for a
// second factor first.
const RETURN = "openasy-identity-return";
const MFA = "openasy-identity-mfa";
function keepReturn() {
  const url = new URL(location.href);
  const to = url.searchParams.get("return");
  if (!to) return;
  if (/^\/interaction\/[\w-]+$/.test(to)) {
    sessionStorage.setItem(RETURN, to);
    if (url.searchParams.get("mfa") === "required") sessionStorage.setItem(MFA, "1");
    else sessionStorage.removeItem(MFA);
  }
  url.searchParams.delete("return");
  url.searchParams.delete("mfa");
  history.replaceState(history.state, "", url.pathname + url.search + url.hash);
}
keepReturn();

function Product() {
  const { me, can, signOut } = useAuth();
  const call = useApi();
  const [page, setPage] = useState<Page>(() => parsePage(window.location.hash));
  const [returning] = useState(() => sessionStorage.getItem(RETURN));
  // A session opened with a second factor, a passkey or an identity provider is strong enough for every group.
  const strong = me.session.mfa || me.session.method === "passkey" || me.session.method.startsWith("oidc:");
  const waitForFactor = !!returning && sessionStorage.getItem(MFA) === "1" && !strong;
  const continueToApp = () => {
    sessionStorage.removeItem(RETURN);
    sessionStorage.removeItem(MFA);
    location.replace(returning!);
  };

  useEffect(() => {
    if (returning && !waitForFactor) continueToApp();
    const onHash = () => setPage(parsePage(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [returning, waitForFactor]);

  if (returning && !waitForFactor) return null;
  const manages = can("viewer");
  const shown: Page = waitForFactor || !manages ? "account" : page;
  const nav = manages
    ? [
        { id: "overview", label: "Overview", icon: LayoutDashboard },
        { id: "applications", label: "Applications", icon: AppWindow },
        { id: "people", label: "People", icon: UsersRound },
        { id: "groups", label: "Groups", icon: Users },
        { id: "audit", label: "Audit log", icon: ScrollText },
      ]
    : [];
  const footerNav = [
    ...(can("admin")
      ? [
          { id: "members", label: "Members", icon: Users },
          { id: "signin", label: "Sign-in", icon: LogIn },
          { id: "tokens", label: "API tokens", icon: KeyRound },
        ]
      : []),
    { id: "account", label: "Account", icon: UserRound },
  ];
  const roleName = me.user.role.charAt(0).toUpperCase() + me.user.role.slice(1);

  return (
    <AppShell product="identity" nav={nav} activeNav={shown} onNavigate={(id) => (window.location.hash = `#/${id}`)} footerNav={footerNav} user={{ name: me.user.name, role: roleName }}>
      {shown === "overview" ? (
        <OverviewPage call={call} />
      ) : shown === "audit" ? (
        <AuditPage call={call} />
      ) : shown === "applications" ? (
        <ApplicationsPage call={call} />
      ) : shown === "people" ? (
        <PeoplePage call={call} />
      ) : shown === "groups" ? (
        <GroupsPage call={call} />
      ) : shown !== "account" && !can("admin") ? (
        <EmptyState title="Admins only">Ask an admin of this Identity for access.</EmptyState>
      ) : (
        <>
          <PageHeader
            title={manages ? SETTINGS[shown][0] : "Your account"}
            description={manages ? SETTINGS[shown][1] : "You sign in to your applications with this account. Keep a second factor here: an authenticator app or a passkey."}
            actions={
              shown === "account" && (
                <Button icon={<LogOut />} onClick={() => void signOut()}>
                  Sign out
                </Button>
              )
            }
          />
          {waitForFactor && (
            <Callout tone="warning" title="Add a second factor to continue" className="mb-3">
              <span className="flex flex-col items-start gap-2">
                <span>The application you are signing in to asks for one. Add an authenticator app or a passkey below, then continue.</span>
                <Button variant="primary" iconRight={<ArrowRight />} onClick={continueToApp}>
                  Continue to the application
                </Button>
              </span>
            </Callout>
          )}
          {shown === "account" ? <AccountSettings /> : shown === "members" ? <MembersSettings /> : shown === "signin" ? <SignInSettings /> : <TokensSettings />}
        </>
      )}
    </AppShell>
  );
}

export function App() {
  return (
    // No organization until branding is configurable (ADR 0004); the library's default is a placeholder.
    <BrandProvider brand={{ name: "OpenAsy", organization: undefined }} className="min-h-screen">
      <AuthGate product="OpenAsy Identity">
        <Product />
      </AuthGate>
    </BrandProvider>
  );
}
