import { AppShell, BrandProvider, Button, EmptyState, PageHeader } from "@openasy/ui";
import { AccountSettings, AuthGate, MembersSettings, SignInSettings, TokensSettings, useAuth } from "@openasy/auth/react";
import { AppWindow, KeyRound, LayoutDashboard, LogIn, LogOut, UserRound, Users, UsersRound } from "lucide-react";
import { useEffect, useState } from "react";
import { ApplicationsPage } from "./applications.tsx";
import { GroupsPage } from "./groups.tsx";
import { PeoplePage } from "./people.tsx";
import { useApi } from "./shared.tsx";

const PAGES = ["overview", "applications", "people", "groups", "account", "members", "signin", "tokens"] as const;
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
// Only that path is taken, so the link cannot send anyone to another site.
const RETURN = "openasy-identity-return";
function keepReturn() {
  const url = new URL(location.href);
  const to = url.searchParams.get("return");
  if (!to) return;
  if (/^\/interaction\/[\w-]+$/.test(to)) sessionStorage.setItem(RETURN, to);
  url.searchParams.delete("return");
  history.replaceState(history.state, "", url.pathname + url.search + url.hash);
}
keepReturn();

function Product() {
  const { me, can, signOut } = useAuth();
  const call = useApi();
  const [page, setPage] = useState<Page>(() => parsePage(window.location.hash));
  const [returning] = useState(() => sessionStorage.getItem(RETURN));

  useEffect(() => {
    if (returning) {
      sessionStorage.removeItem(RETURN);
      location.replace(returning);
    }
    const onHash = () => setPage(parsePage(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [returning]);

  if (returning) return null;
  const manages = can("viewer");
  const shown: Page = manages ? page : "account";
  const nav = manages
    ? [
        { id: "overview", label: "Overview", icon: LayoutDashboard },
        { id: "applications", label: "Applications", icon: AppWindow },
        { id: "people", label: "People", icon: UsersRound },
        { id: "groups", label: "Groups", icon: Users },
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
        <>
          <PageHeader title="Overview" description="Single sign-on for OpenAsy products and any other application, with MFA and passkeys." />
          <EmptyState
            title="Start with an application"
            action={
              <Button variant="primary" onClick={() => (window.location.hash = "#/applications")}>
                Add an application
              </Button>
            }
          >
            Add an application, choose the groups that may use it, and people sign in to it with Identity.
          </EmptyState>
        </>
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
