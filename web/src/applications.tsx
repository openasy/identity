import { Badge, Button, Callout, Checkbox, PageHeader, Panel, SelectField, TextField, type Column } from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { KeyRound, Plus, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { Application, ApplicationSecret, Group } from "./api.ts";
import { Code, List, Problem, useAction, useData, type Call } from "./shared.tsx";

const TEMPLATES: Record<Application["template"], { label: string; product?: string; prefix?: string }> = {
  "openasy-vpn": { label: "OpenAsy VPN", product: "VPN", prefix: "VPN_" },
  "openasy-infrastructure": { label: "OpenAsy Infrastructure", product: "Infrastructure", prefix: "INFRA_" },
  "openasy-vulnerabilities": { label: "OpenAsy Vulnerabilities", product: "Vulnerabilities", prefix: "VULNS_" },
  oidc: { label: "Another application (OpenID Connect)" },
};

/** The secret, once, and for an OpenAsy product what to enter there: in Settings, Sign-in, or its environment. */
function Created({ created, issuer, onDone }: { created: ApplicationSecret; issuer: string; onDone: () => void }) {
  const { application: a, clientSecret } = created;
  const t = TEMPLATES[a.template];
  return (
    <Callout
      tone="warning"
      title={`Copy the secret for ${a.name} now`}
      action={
        <Button size="sm" onClick={onDone}>
          Done
        </Button>
      }
    >
      <span className="flex flex-col gap-2">
        <span>Identity keeps it encrypted and does not show it again; a new one can be made later.</span>
        <Code label={`Settings for ${a.name}`}>{`Issuer         ${issuer}\nClient ID      ${a.id}\nClient secret  ${clientSecret}`}</Code>
        {t.prefix ? (
          <>
            <span>
              In {t.product}, open Settings, Sign-in, add a provider and choose OpenAsy Identity, then enter these. Or set them in its environment and restart it:
            </span>
            <Code label={`Environment for ${a.name}`}>{`${t.prefix}OIDC_PROVIDER=openasy-identity\n${t.prefix}OIDC_ISSUER=${issuer}\n${t.prefix}OIDC_CLIENT_ID=${a.id}\n${t.prefix}OIDC_CLIENT_SECRET=${clientSecret}\n# groups in Identity to roles in ${t.product}\n${t.prefix}OIDC_ROLE_MAPPING=${a.groups[0] ?? "Engineering"}=admin`}</Code>
          </>
        ) : (
          <span>Set the application up with them; it must send PKCE (S256), and asks for the scopes openid, email, profile and groups.</span>
        )}
      </span>
    </Callout>
  );
}

function AddApplication({ call, groups, onCreated }: { call: Call; groups: Group[]; onCreated: (c: ApplicationSecret) => void }) {
  const [template, setTemplate] = useState<Application["template"]>("openasy-vpn");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [redirects, setRedirects] = useState("");
  const [everyone, setEveryone] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const action = useAction();
  const product = template !== "oidc";
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await action.run(async () => {
      const body = {
        name: name.trim() || TEMPLATES[template].label,
        template,
        everyone,
        groups: chosen,
        ...(product ? { url: url.trim() } : { redirectUris: redirects.split(/[\s,]+/).filter(Boolean) }),
      };
      onCreated(await call<ApplicationSecret>("/api/v1/applications", { method: "POST", body: JSON.stringify(body) }));
      setName("");
      setUrl("");
      setRedirects("");
      setChosen([]);
      setEveryone(false);
    });
  };
  return (
    <Panel title="Add an application" description="People sign in to it with Identity. Choose who may.">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(16rem, 1fr))" }}>
          <SelectField label="Application" value={template} onChange={(e) => setTemplate(e.target.value as Application["template"])} options={Object.entries(TEMPLATES).map(([value, t]) => ({ value, label: t.label }))} />
          <TextField label="Name" placeholder={TEMPLATES[template].label} value={name} onChange={(e) => setName(e.target.value)} />
          {product ? (
            <TextField label="Address people open it at" mono placeholder="https://vpn.example.com" hint="Its callback addresses are filled in." value={url} onChange={(e) => setUrl(e.target.value)} />
          ) : (
            <TextField label="Redirect URIs" mono placeholder="https://grafana.example.com/login/generic_oauth" hint="https, or http on localhost; several separated by spaces." value={redirects} onChange={(e) => setRedirects(e.target.value)} />
          )}
        </div>
        <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
          <legend className="mb-1 text-xs font-medium text-fg">Who may sign in</legend>
          <Checkbox label="Everyone in the directory" checked={everyone} onChange={(e) => setEveryone(e.target.checked)} />
          {!everyone &&
            (groups.length ? (
              groups.map((g) => (
                <Checkbox key={g.id} label={g.name} description={g.description || undefined} checked={chosen.includes(g.name)} onChange={(e) => setChosen(e.target.checked ? [...chosen, g.name] : chosen.filter((n) => n !== g.name))} />
              ))
            ) : (
              <span className="text-xs text-fg-muted">No groups yet: add one under Groups, or let everyone in.</span>
            ))}
        </fieldset>
        <Problem error={action.error} title="Not added" />
        <span>
          <Button type="submit" variant="primary" icon={<Plus />} loading={action.busy} disabled={product ? !url.trim() : !redirects.trim()}>
            Add application
          </Button>
        </span>
      </form>
    </Panel>
  );
}

export function ApplicationsPage({ call }: { call: Call }) {
  const { can } = useAuth();
  const { data, reload } = useData<{ applications: Application[]; issuer: string }>(call, "/api/v1/applications", 30_000);
  const groups = useData<{ groups: Group[] }>(call, "/api/v1/groups", 0).data?.groups ?? [];
  const [created, setCreated] = useState<ApplicationSecret>();
  const action = useAction();
  const issuer = data?.issuer ?? "";

  const columns: Column<Application>[] = [
    { id: "name", header: "Application", cell: (a) => a.name, sortValue: (a) => a.name },
    { id: "kind", header: "Kind", width: "190px", cell: (a) => TEMPLATES[a.template].label },
    { id: "client", header: "Client ID", mono: true, width: "190px", cell: (a) => a.id },
    { id: "who", header: "Who may sign in", cell: (a) => (a.everyone ? <Badge tone="info">Everyone</Badge> : a.groups.length ? a.groups.join(", ") : <Badge tone="warning">Nobody yet</Badge>) },
    ...(can("admin")
      ? [
          {
            id: "actions",
            header: "",
            width: "220px",
            cell: (a: Application) => (
              <span className="flex gap-1 whitespace-nowrap">
                <Button
                  size="xs"
                  variant="ghost"
                  icon={<KeyRound />}
                  onClick={() => confirm(`Make a new secret for ${a.name}? The old one stops working at once.`) && void action.run(async () => setCreated(await call<ApplicationSecret>(`/api/v1/applications/${a.id}/secret`, { method: "POST" })))}
                >
                  New secret
                </Button>
                <Button size="xs" variant="ghost" icon={<Trash2 />} onClick={() => confirm(`Remove ${a.name}? Nobody can sign in to it with Identity any more.`) && void action.run(() => call(`/api/v1/applications/${a.id}`, { method: "DELETE" }).then(reload))}>
                  Remove
                </Button>
              </span>
            ),
          } satisfies Column<Application>,
        ]
      : []),
  ];

  return (
    <>
      <PageHeader title="Applications" description={issuer ? `Applications sign people in with OpenID Connect at the issuer ${issuer}.` : "Applications sign people in with OpenID Connect."} />
      {can("admin") && <AddApplication call={call} groups={groups} onCreated={(c) => (setCreated(c), reload())} />}
      {created && <Created created={created} issuer={issuer} onDone={() => setCreated(undefined)} />}
      <Problem error={action.error} />
      <Panel flush>
        <List label="Applications" rows={data?.applications} columns={columns} empty="No applications yet" getRowId={(a) => a.id} />
      </Panel>
    </>
  );
}
