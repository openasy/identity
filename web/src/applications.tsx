import { Badge, Button, Callout, Checkbox, Dialog, PageHeader, Panel, SelectField, TextField, type Column } from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { Check, KeyRound, Plus, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { Application, ApplicationSecret, Group } from "./api.ts";
import { Code, List, Problem, useAction, useData, type Call } from "./shared.tsx";
import { useT, type T } from "./i18n.ts";

const TEMPLATES = (t: T): Record<Application["template"], { label: string; product?: string; saml?: true }> => ({
  "openasy-vpn": { label: t("templates.openasyVpn"), product: "VPN" },
  "openasy-infrastructure": { label: t("templates.openasyInfrastructure"), product: "Infrastructure" },
  "openasy-vulnerabilities": { label: t("templates.openasyVulnerabilities"), product: "Vulnerabilities" },
  oidc: { label: t("templates.anotherApplicationOpenidConnect") },
  aws: { label: t("templates.awsIamIdentityCenterSaml"), saml: true },
  saml: { label: t("templates.anotherApplicationSaml20"), saml: true },
});

/** What a SAML application is set up with: Identity's metadata, or its parts. */
function SamlDetails({ issuer, aws }: { issuer: string; aws: boolean }) {
  const t = useT();
  return (
    <>
      <Code label={t("samlDetails.identityForSaml")}>{`Metadata       ${issuer}/saml/metadata\nEntity ID      ${issuer}/saml\nSign-in URL    ${issuer}/saml/sso\nCertificate    ${issuer}/saml/certificate`}</Code>
      <span>
        {aws
          ? t("samlDetails.inIamIdentityCenterOpen")
          : t("samlDetails.giveTheApplicationIdentityS")}
      </span>
    </>
  );
}

/** The secret, once, and for an OpenAsy product what to enter there: in Settings, Sign-in, or its environment. */
function Created({ created, issuer, onDone }: { created: ApplicationSecret; issuer: string; onDone: () => void }) {
  const msg = useT();
  const { application: a, clientSecret } = created;
  const t = TEMPLATES(msg)[a.template];
  const done = (
    <Button variant="primary" onClick={onDone}>
      {msg("created.done")}
    </Button>
  );
  if (!clientSecret)
    return (
      <Dialog open onOpenChange={(open) => !open && onDone()} size="lg" icon={<Check aria-hidden className="size-4" />} iconTone="success" title={msg("created.setUpWithIdentity", { name: a.name })} footer={done}>
        <span className="flex flex-col gap-2">
          <SamlDetails issuer={issuer} aws={a.template === "aws"} />
        </span>
      </Dialog>
    );
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onDone()}
      size="lg"
      icon={<Check aria-hidden className="size-4" />}
      iconTone="success"
      title={msg("created.copyTheSecretForNow", { name: a.name })}
      description={msg("created.identityKeepsItEncryptedAnd")}
      footer={done}
    >
      <span className="flex flex-col gap-2">
        <Code label={msg("created.settingsFor", { name: a.name })}>{`Issuer         ${issuer}\nClient ID      ${a.id}\nClient secret  ${clientSecret}`}</Code>
        {t.product ? (
          <>
            <span>
              {msg("created.inOpenSettingsSignIn", { product: t.product })}</span>
            <Code label={msg("created.environmentFor", { name: a.name })}>{`OPENASY_OIDC_PROVIDER=openasy-identity\nOPENASY_OIDC_ISSUER=${issuer}\nOPENASY_OIDC_CLIENT_ID=${a.id}\nOPENASY_OIDC_CLIENT_SECRET=${clientSecret}\n# groups in Identity to roles in ${t.product}\nOPENASY_OIDC_ROLE_MAPPING=${a.groups[0] ?? "Engineering"}=admin`}</Code>
          </>
        ) : (
          <span>{msg("created.setTheApplicationUpWith")}</span>
        )}
      </span>
      <Callout tone="warning" title={msg("created.closingThisDialogHidesThe")} />
    </Dialog>
  );
}

function AddApplication({ call, groups, onCreated, onCancel }: { call: Call; groups: Group[]; onCreated: (c: ApplicationSecret) => void; onCancel: () => void }) {
  const msg = useT();
  const [template, setTemplate] = useState<Application["template"]>("openasy-vpn");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [redirects, setRedirects] = useState("");
  const [entityId, setEntityId] = useState("");
  const [acsUrl, setAcsUrl] = useState("");
  const [nameId, setNameId] = useState<"email" | "persistent">("email");
  const [everyone, setEveryone] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const action = useAction();
  const saml = !!TEMPLATES(msg)[template].saml;
  const product = !!TEMPLATES(msg)[template].product;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await action.run(async () => {
      const body = {
        name: name.trim() || TEMPLATES(msg)[template].label,
        template,
        everyone,
        groups: chosen,
        ...(saml ? { entityId: entityId.trim(), acsUrl: acsUrl.trim(), nameId } : product ? { url: url.trim() } : { redirectUris: redirects.split(/[\s,]+/).filter(Boolean) }),
      };
      onCreated(await call<ApplicationSecret>("/api/v1/applications", { method: "POST", body: JSON.stringify(body) }));
    });
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onCancel()}
      size="lg"
      title={msg("addApplication.addAnApplication")}
      description={msg("addApplication.peopleSignInToIt")}
      onSubmit={submit}
      footer={
        <>
          <Button type="button" onClick={onCancel}>
            {msg("addApplication.cancel")}
          </Button>
          <Button type="submit" variant="primary" loading={action.busy} disabled={saml ? !entityId.trim() || !acsUrl.trim() : product ? !url.trim() : !redirects.trim()}>
            {msg("addApplication.addApplication")}
          </Button>
        </>
      }
    >
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(16rem, 1fr))" }}>
        <SelectField label={msg("addApplication.application")} value={template} onChange={(e) => setTemplate(e.target.value as Application["template"])} options={Object.entries(TEMPLATES(msg)).map(([value, t]) => ({ value, label: t.label }))} />
        <TextField label={msg("addApplication.name")} placeholder={TEMPLATES(msg)[template].label} value={name} onChange={(e) => setName(e.target.value)} />
        {saml ? (
          <>
            <TextField
              label={template === "aws" ? msg("addApplication.iamIdentityCenterIssuerUrl") : msg("addApplication.entityId")}
              mono
              placeholder={template === "aws" ? "https://us-east-1.signin.aws.amazon.com/platform/saml/d-1234567890" : "https://jira.example.com"}
              hint={msg("addApplication.whoTheApplicationIsThe")}
              value={entityId}
              onChange={(e) => setEntityId(e.target.value)}
            />
            <TextField
              label={msg("addApplication.acsUrl")}
              mono
              placeholder={template === "aws" ? "https://us-east-1.signin.aws.amazon.com/platform/saml/acs/..." : "https://jira.example.com/plugins/servlet/samlconsumer"}
              hint={msg("addApplication.whereItReceivesAnswersIdentity")}
              value={acsUrl}
              onChange={(e) => setAcsUrl(e.target.value)}
            />
            <SelectField
              label={msg("addApplication.namePeopleBy")}
              value={nameId}
              onChange={(e) => setNameId(e.target.value as "email" | "persistent")}
              options={[
                { value: "email", label: msg("addApplication.emailAddress") },
                { value: "persistent", label: msg("addApplication.aStableIdThatNever") },
              ]}
            />
          </>
        ) : product ? (
          <TextField label={msg("addApplication.addressPeopleOpenItAt")} mono placeholder="https://vpn.example.com" hint={msg("addApplication.itsCallbackAddressesAreFilled")} value={url} onChange={(e) => setUrl(e.target.value)} />
        ) : (
          <TextField label={msg("addApplication.redirectUris")} mono placeholder="https://grafana.example.com/login/generic_oauth" hint={msg("addApplication.httpsOrHttpOnLocalhost")} value={redirects} onChange={(e) => setRedirects(e.target.value)} />
        )}
      </div>
      <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
        <legend className="mb-1 text-xs font-medium text-fg">{msg("addApplication.whoMaySignIn")}</legend>
        <Checkbox label={msg("addApplication.everyoneInTheDirectory")} checked={everyone} onChange={(e) => setEveryone(e.target.checked)} />
        {!everyone &&
          (groups.length ? (
            groups.map((g) => (
              <Checkbox key={g.id} label={g.name} description={g.description || undefined} checked={chosen.includes(g.name)} onChange={(e) => setChosen(e.target.checked ? [...chosen, g.name] : chosen.filter((n) => n !== g.name))} />
            ))
          ) : (
            <span className="text-xs text-fg-muted">{msg("addApplication.noGroupsYetAddOne")}</span>
          ))}
      </fieldset>
      <Problem error={action.error} title={msg("addApplication.notAdded")} />
    </Dialog>
  );
}

export function ApplicationsPage({ call }: { call: Call }) {
  const t = useT();
  const { can } = useAuth();
  const { data, reload } = useData<{ applications: Application[]; issuer: string }>(call, "/api/v1/applications", 30_000);
  const groups = useData<{ groups: Group[] }>(call, "/api/v1/groups", 0).data?.groups ?? [];
  const [created, setCreated] = useState<ApplicationSecret>();
  const [adding, setAdding] = useState(false);
  const action = useAction();
  const issuer = data?.issuer ?? "";

  const columns: Column<Application>[] = [
    { id: "name", header: t("applicationsPage.application"), cell: (a) => a.name, sortValue: (a) => a.name },
    { id: "kind", header: t("applicationsPage.kind"), width: "190px", cell: (a) => TEMPLATES(t)[a.template].label },
    { id: "client", header: t("applicationsPage.clientIdOrEntityId"), mono: true, width: "240px", cell: (a) => a.saml?.entityId ?? a.id },
    { id: "who", header: t("applicationsPage.whoMaySignIn"), cell: (a) => (a.everyone ? <Badge tone="info">{t("applicationsPage.everyone")}</Badge> : a.groups.length ? a.groups.join(", ") : <Badge tone="warning">{t("applicationsPage.nobodyYet")}</Badge>) },
    ...(can("admin")
      ? [
          {
            id: "actions",
            header: "",
            width: "220px",
            cell: (a: Application) => (
              <span className="flex gap-1 whitespace-nowrap">
                {!a.saml && (
                  <Button
                    size="xs"
                    variant="ghost"
                    icon={<KeyRound />}
                    onClick={() => confirm(t("applicationsPage.makeANewSecretFor", { name: a.name })) && void action.run(async () => setCreated(await call<ApplicationSecret>(`/api/v1/applications/${a.id}/secret`, { method: "POST" })))}
                  >
                    {t("applicationsPage.newSecret")}
                  </Button>
                )}
                <Button size="xs" variant="ghost" icon={<Trash2 />} onClick={() => confirm(t("applicationsPage.removeNobodyCanSignIn", { name: a.name })) && void action.run(() => call(`/api/v1/applications/${a.id}`, { method: "DELETE" }).then(reload))}>
                  {t("applicationsPage.remove")}
                </Button>
              </span>
            ),
          } satisfies Column<Application>,
        ]
      : []),
  ];

  return (
    <>
      <PageHeader
        title={t("applicationsPage.applications")}
        description={issuer ? t("applicationsPage.applicationsSignPeopleInWith", { issuer }) : t("applicationsPage.applicationsSignPeopleInWith2")}
        actions={
          can("admin") && (
            <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>
              {t("applicationsPage.addApplication")}
            </Button>
          )
        }
      />
      {adding && <AddApplication call={call} groups={groups} onCreated={(c) => (setAdding(false), setCreated(c), reload())} onCancel={() => setAdding(false)} />}
      {created && <Created created={created} issuer={issuer} onDone={() => setCreated(undefined)} />}
      <Problem error={action.error} />
      <Panel flush>
        <List label={t("applicationsPage.applications")} rows={data?.applications} columns={columns} empty={t("applicationsPage.noApplicationsYet")} getRowId={(a) => a.id} />
      </Panel>
    </>
  );
}
