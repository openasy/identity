import {
  AppShell,
  BrandProvider,
  Button,
  Callout,
  EmptyState,
  navigate,
  PageHeader,
  PRODUCT_IDS,
  usePath,
  type ProductId,
  useThemePreference,
} from "@openasy/ui";
import { AccountSettings, AuthGate, MembersSettings, SignInSettings, TokensSettings, useAuth, useInstallBrand } from "@openasy/auth/react";
import colophon from "virtual:openasy-colophon";
import { AppWindow, ArrowRight, FolderTree, RefreshCw, KeyRound, LayoutDashboard, LogIn, LogOut, ScrollText, UserRound, Users, UsersRound } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { ProductLink } from "./api.ts";
import { ApplicationsPage } from "./applications.tsx";
import { DirectoriesPage } from "./directories.tsx";
import { GroupsPage } from "./groups.tsx";
import { AuditPage, OverviewPage } from "./overview.tsx";
import { PeoplePage } from "./people.tsx";
import { ProvisioningPage } from "./provisioning.tsx";
import { useApi } from "./shared.tsx";
import { useT } from "./i18n.ts";

export const PAGES = [
  "overview",
  "applications",
  "people",
  "groups",
  "audit",
  "account",
  "members",
  "signin",
  "provisioning",
  "directories",
  "tokens",
  "about",
] as const;
type Page = (typeof PAGES)[number];

function parsePage(path: string): Page {
  const page = path.split("/")[1] ?? "";
  return (PAGES as readonly string[]).includes(page) ? (page as Page) : "overview";
}

const SETTINGS = {
  account: ["Account", "Your profile, password, two-step verification and where you are signed in."],
  members: [
    "Members",
    "Who can manage this Identity, and with which role. Viewers see everything; editors also change groups; admins also manage applications, providers, members and tokens. People with the User role only sign in to applications.",
  ],
  signin: [
    "Sign-in",
    "Identity providers people can sign in to Identity with, such as Keycloak or Microsoft Entra ID, and which of their groups give which role.",
  ],
  tokens: ["API tokens", "For scripts. Each token has one role and an expiry; the secret is shown once."],
} as const;

// An application sent someone here to sign in (/?return=/interaction/<uid>, or /saml/continue/<id> for SAML): once
// they are signed in, they go back.
// Only that path is taken, so the link cannot send anyone to another site. With &mfa=required their groups ask for a
// second factor first.
const RETURN = "openasy-identity-return";
const MFA = "openasy-identity-mfa";
function keepReturn() {
  const url = new URL(location.href);
  const to = url.searchParams.get("return");
  if (!to) return;
  if (/^\/interaction\/[\w-]+$/.test(to) || /^\/saml\/continue\/[\w-]+$/.test(to)) {
    sessionStorage.setItem(RETURN, to);
    const mfa = url.searchParams.get("mfa");
    if (mfa === "required" || mfa === "passkey") sessionStorage.setItem(MFA, mfa);
    else sessionStorage.removeItem(MFA);
  }
  url.searchParams.delete("return");
  url.searchParams.delete("mfa");
  history.replaceState(history.state, "", url.pathname + url.search + url.hash);
}
keepReturn();

function Product() {
  const t = useT();
  const [theme, setTheme] = useThemePreference();
  const { me, can, signOut } = useAuth();
  const call = useApi();
  const page = parsePage(usePath());
  const [returning] = useState(() => sessionStorage.getItem(RETURN));
  const [products, setProducts] = useState<Array<ProductLink & { id: ProductId }>>([]);
  // What the application's groups ask for: a session with a second factor (or a passkey, or through an identity
  // provider), or one with a passkey.
  const asked = sessionStorage.getItem(MFA);
  const strong = me.session.mfa || me.session.method === "passkey" || me.session.method.startsWith("oidc:");
  const waitForFactor = !!returning && (asked === "passkey" ? me.session.factor !== "passkey" : asked === "required" && !strong);
  const continueToApp = useCallback(() => {
    sessionStorage.removeItem(RETURN);
    sessionStorage.removeItem(MFA);
    location.replace(returning!);
  }, [returning]);

  useEffect(() => {
    if (returning && !waitForFactor) continueToApp();
  }, [returning, waitForFactor, continueToApp]);
  // The install's other products (OPENASY_PRODUCTS), for the switcher; ids this UI does not know are left out.
  const manages = can("viewer");
  useEffect(() => {
    if (!manages) return;
    void call<{ products: ProductLink[] }>("/api/v1/products").then(
      (r) =>
        setProducts(r.products.filter((p): p is ProductLink & { id: ProductId } => p.id !== "identity" && (PRODUCT_IDS as readonly string[]).includes(p.id))),
      () => {},
    );
  }, [call, manages]);

  if (returning && !waitForFactor) return null;
  const shown: Page = waitForFactor || !manages ? "account" : page;
  const nav = manages
    ? [
        { id: "overview", label: t("product.overview"), icon: LayoutDashboard },
        { id: "applications", label: t("product.applications"), icon: AppWindow },
        { id: "people", label: t("product.people"), icon: UsersRound },
        { id: "groups", label: t("product.groups"), icon: Users },
        { id: "audit", label: t("product.auditLog"), icon: ScrollText },
      ]
    : [];
  const footerNav = [
    ...(can("admin")
      ? [
          { id: "members", label: t("product.members"), icon: Users },
          { id: "signin", label: t("product.signIn"), icon: LogIn },
          { id: "provisioning", label: t("product.provisioning"), icon: RefreshCw },
          { id: "directories", label: t("product.directories"), icon: FolderTree },
          { id: "tokens", label: t("product.apiTokens"), icon: KeyRound },
        ]
      : []),
    { id: "account", label: t("product.account"), icon: UserRound },
  ];
  const roleName = me.user.role.charAt(0).toUpperCase() + me.user.role.slice(1);

  return (
    <AppShell
      product="identity"
      about={colophon}
      nav={nav}
      activeNav={shown}
      onNavigate={(id) => navigate(`/${id}`)}
      connectedProducts={products.map((p) => p.id)}
      onSwitchProduct={(id) => {
        const to = products.find((p) => p.id === id);
        if (to) window.location.assign(to.url);
      }}
      footerNav={footerNav}
      user={{ name: me.user.name, role: roleName }}
      theme={theme}
      onThemeChange={setTheme}
    >
      {shown === "about" ? null : shown === "overview" ? (
        <OverviewPage call={call} />
      ) : shown === "audit" ? (
        <AuditPage call={call} />
      ) : shown === "applications" ? (
        <ApplicationsPage call={call} />
      ) : shown === "people" ? (
        <PeoplePage call={call} />
      ) : shown === "groups" ? (
        <GroupsPage call={call} />
      ) : shown === "directories" ? (
        can("admin") ? (
          <DirectoriesPage call={call} />
        ) : (
          <EmptyState title={t("product.adminsOnly")}>{t("product.askAnAdminOfThis")}</EmptyState>
        )
      ) : shown === "provisioning" ? (
        can("admin") ? (
          <ProvisioningPage call={call} />
        ) : (
          <EmptyState title={t("product.adminsOnly")}>{t("product.askAnAdminOfThis")}</EmptyState>
        )
      ) : shown !== "account" && !can("admin") ? (
        <EmptyState title={t("product.adminsOnly")}>{t("product.askAnAdminOfThis")}</EmptyState>
      ) : (
        <>
          <PageHeader
            title={manages ? SETTINGS[shown][0] : t("product.yourAccount")}
            description={manages ? SETTINGS[shown][1] : t("product.youSignInToYour")}
            actions={
              shown === "account" && (
                <Button icon={<LogOut />} onClick={() => void signOut()}>
                  {t("product.signOut")}
                </Button>
              )
            }
          />
          {waitForFactor && (
            <Callout tone="warning" title={asked === "passkey" ? t("product.useAPasskeyToContinue") : t("product.addASecondFactorTo")} className="mb-3">
              <span className="flex flex-col items-start gap-2">
                <span>{asked === "passkey" ? t("product.theApplicationYouAreSigning") : t("product.theApplicationYouAreSigning2")}</span>
                <Button variant="primary" iconRight={<ArrowRight />} onClick={continueToApp}>
                  {t("product.continueToTheApplication")}
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
  const installBrand = useInstallBrand();
  const [theme] = useThemePreference();
  return (
    // The install's brand from config/brand.env (ADR 0053); OpenAsy's own look where it sets none.
    <BrandProvider theme={theme} brand={{ name: "OpenAsy", organization: undefined, ...installBrand }} className="min-h-screen">
      <AuthGate product="OpenAsy Identity">
        <Product />
      </AuthGate>
    </BrandProvider>
  );
}
