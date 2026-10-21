import { AppShell, BrandProvider, Button, EmptyState, PageHeader } from "@openasy/ui";
import { AccountSettings, AuthGate, MembersSettings, TokensSettings, useAuth } from "@openasy/auth/react";
import { KeyRound, LayoutDashboard, LogOut, UserRound, Users } from "lucide-react";
import { useEffect, useState } from "react";

const PAGES = ["overview", "account", "members", "tokens"] as const;
type Page = (typeof PAGES)[number];

function parsePage(hash: string): Page {
  const page = hash.replace(/^#\/?/, "").split("/")[0] ?? "";
  return (PAGES as readonly string[]).includes(page) ? (page as Page) : "overview";
}

const SETTINGS = {
  account: ["Account", "Your profile, password, two-step verification and where you are signed in."],
  members: ["Members", "Who can manage this Identity, and with which role. Viewers see everything; editors also change users and groups; admins also manage applications, providers, members and tokens."],
  tokens: ["API tokens", "For scripts. Each token has one role and an expiry; the secret is shown once."],
} as const;

function Product() {
  const { me, can, signOut } = useAuth();
  const [page, setPage] = useState<Page>(() => parsePage(window.location.hash));

  useEffect(() => {
    const onHash = () => setPage(parsePage(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const footerNav = [
    ...(can("admin")
      ? [
          { id: "members", label: "Members", icon: Users },
          { id: "tokens", label: "API tokens", icon: KeyRound },
        ]
      : []),
    { id: "account", label: "Account", icon: UserRound },
  ];
  const roleName = me.user.role.charAt(0).toUpperCase() + me.user.role.slice(1);

  return (
    <AppShell
      product="identity"
      nav={[{ id: "overview", label: "Overview", icon: LayoutDashboard }]}
      activeNav={page}
      onNavigate={(id) => (window.location.hash = `#/${id}`)}
      footerNav={footerNav}
      user={{ name: me.user.name, role: roleName }}
    >
      {page === "overview" ? (
        <>
          <PageHeader title="Overview" description="Single sign-on for OpenAsy products and any other application, with MFA and passkeys." />
          <EmptyState title="Nothing to sign in to yet">Applications, users, groups and upstream providers come in the next releases.</EmptyState>
        </>
      ) : page !== "account" && !can("admin") ? (
        <EmptyState title="Admins only">Ask an admin of this Identity for access.</EmptyState>
      ) : (
        <>
          <PageHeader
            title={SETTINGS[page][0]}
            description={SETTINGS[page][1]}
            actions={
              page === "account" && (
                <Button icon={<LogOut />} onClick={() => void signOut()}>
                  Sign out
                </Button>
              )
            }
          />
          {page === "account" ? <AccountSettings /> : page === "members" ? <MembersSettings /> : <TokensSettings />}
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
