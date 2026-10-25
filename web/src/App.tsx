import {
  AppShell,
  BrandProvider,
  Button,
  Callout,
  EmptyState,
  navigate,
  PageHeader,
  PRODUCT_IDS,
  PRODUCTS,
  usePath,
  type ProductId,
  useThemePreference,
  toLocale,
  useLocalePreference,
} from "@openasy/ui";
import { AccountSettings, AuthGate, MembersSettings, SignInSettings, TokensSettings, useAccountMenu, useAuth, useInstallBrand } from "@openasy/auth/react";
import colophon from "virtual:openasy-colophon";
import {
  AppWindow,
  ArrowLeft,
  ArrowRight,
  FolderTree,
  RefreshCw,
  KeyRound,
  LayoutDashboard,
  LogIn,
  LogOut,
  ScrollText,
  UserRound,
  Users,
  UsersRound,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ProductLink } from "./api.ts";
import { ApplicationsPage } from "./applications.tsx";
import { DirectoriesPage } from "./directories.tsx";
import { GroupsPage } from "./groups.tsx";
import { AuditPage, OverviewPage } from "./overview.tsx";
import { PeoplePage } from "./people.tsx";
import { ProvisioningPage } from "./provisioning.tsx";
import { useApi } from "./shared.tsx";
import { useT, type T } from "./i18n.ts";
import { search } from "./search.ts";

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

const SETTINGS = (t: T) =>
  ({
    account: [t("settings.account"), t("settings.accountText")],
    members: [t("settings.members"), t("settings.membersText")],
    signin: [t("settings.signin"), t("settings.signinText")],
    tokens: [t("settings.tokens"), t("settings.tokensText")],
  }) as const;

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

// A product sent someone here for their account or its members (?from=<the product's page>, @openasy/auth 0.11.1):
// the page offers the way back while they are here. Only to a product of this install, so the link goes nowhere else.
const FROM = "openasy-identity-from";
function keepFrom() {
  const url = new URL(location.href);
  const from = url.searchParams.get("from");
  if (!from) return;
  if (/^https?:\/\//.test(from)) sessionStorage.setItem(FROM, from);
  url.searchParams.delete("from");
  history.replaceState(history.state, "", url.pathname + url.search + url.hash);
}
keepFrom();
const originOf = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

function Product() {
  const t = useT();
  const [theme, setTheme] = useThemePreference();
  const [, setLocale] = useLocalePreference();
  const { me, can, signOut } = useAuth();
  const account = useAccountMenu();
  const call = useApi();
  const onSearch = useMemo(() => search(call, t), [call, t]);
  const page = parsePage(usePath());
  const [returning] = useState(() => sessionStorage.getItem(RETURN));
  const [products, setProducts] = useState<Array<ProductLink & { id: ProductId }>>([]);
  const [from, setFrom] = useState(() => sessionStorage.getItem(FROM));
  const back = from ? products.find((p) => originOf(p.url) === originOf(from)) : undefined;
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
    void call<{ products: ProductLink[] }>("/api/v1/products").then(
      (r) =>
        setProducts(r.products.filter((p): p is ProductLink & { id: ProductId } => p.id !== "identity" && (PRODUCT_IDS as readonly string[]).includes(p.id))),
      () => {},
    );
  }, [call]);

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
      // People who only sign in to applications cannot read the directory, so they search pages alone.
      onSearch={manages ? onSearch : undefined}
      about={colophon}
      nav={nav}
      activeNav={shown}
      onNavigate={(id) => navigate(`/${id}`)}
      connectedProducts={manages ? products.map((p) => p.id) : []}
      onSwitchProduct={(id) => {
        const to = products.find((p) => p.id === id);
        if (to) window.location.assign(to.url);
      }}
      footerNav={account.settings(footerNav)}
      user={{ name: me.user.name, role: roleName, ...account.user }}
      theme={theme}
      onThemeChange={setTheme}
      onLanguageChange={(code) => setLocale(toLocale(code))}
    >
      {back && (
        <Callout
          tone="info"
          title={t("product.youCameFrom", { product: PRODUCTS[back.id].name })}
          action={
            <Button size="sm" icon={<ArrowLeft />} onClick={() => location.assign(from!)}>
              {t("product.backTo", { product: PRODUCTS[back.id].name })}
            </Button>
          }
          onDismiss={() => (sessionStorage.removeItem(FROM), setFrom(null))}
          className="mb-3"
        />
      )}
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
            title={manages ? SETTINGS(t)[shown][0] : t("product.yourAccount")}
            description={manages ? SETTINGS(t)[shown][1] : t("product.youSignInToYour")}
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
  const [locale] = useLocalePreference();
  return (
    // The install's brand from config/brand.env (ADR 0053); OpenAsy's own look where it sets none.
    <BrandProvider theme={theme} locale={locale} brand={{ name: "OpenAsy", organization: undefined, ...installBrand }} className="min-h-screen">
      <AuthGate product="OpenAsy Identity">
        <Product />
      </AuthGate>
    </BrandProvider>
  );
}
