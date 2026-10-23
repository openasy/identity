import { Badge, Button, Callout, Checkbox, Dialog, PageHeader, Panel, SelectField, TextField, type Column, useAgo } from "@openasy/ui";
import { Plus, RefreshCw, SearchCheck, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { List, Problem, useAction, useData, type Call } from "./shared.tsx";
import { useT } from "./i18n.ts";

type Kind = "active-directory" | "ldap";

interface Directory {
  id: string;
  name: string;
  kind: Kind;
  url: string;
  baseDn: string;
  groupFilter: string | null;
  syncMinutes: number;
  lastSyncAt: string | null;
  lastError: string | null;
  lastCounts: { people: number; groups: number; disabled: number } | null;
  people: number;
}

interface Result {
  ok: boolean;
  people?: number;
  groups?: number;
  disabled?: number;
  error?: string;
}

/** What each kind usually needs; the server has the same (server/ldap.ts). */
const DEFAULTS: Record<Kind, { url: string; bindDn: string; baseDn: string; userFilter: string; emailAttribute: string; nameAttribute: string; groupFilter: string }> = {
  "active-directory": {
    url: "ldaps://dc1.corp.example.com:636",
    bindDn: "CN=openasy-reader,OU=Service Accounts,DC=corp,DC=example,DC=com",
    baseDn: "DC=corp,DC=example,DC=com",
    userFilter: "(&(objectCategory=person)(objectClass=user)(mail=*))",
    emailAttribute: "mail",
    nameAttribute: "displayName",
    groupFilter: "(&(objectClass=group)(cn=openasy-*))",
  },
  ldap: {
    url: "ldaps://ldap.example.com:636",
    bindDn: "cn=openasy-reader,dc=example,dc=com",
    baseDn: "ou=people,dc=example,dc=com",
    userFilter: "(&(objectClass=inetOrgPerson)(mail=*))",
    emailAttribute: "mail",
    nameAttribute: "cn",
    groupFilter: "(&(|(objectClass=groupOfNames)(objectClass=groupOfUniqueNames))(cn=openasy-*))",
  },
};

function AddDirectory({ call, onAdded, onCancel }: { call: Call; onAdded: () => void; onCancel: () => void }) {
  const t = useT();
  const [kind, setKind] = useState<Kind>("active-directory");
  const d = DEFAULTS[kind];
  const [f, setF] = useState<Record<string, string>>({});
  const [startTls, setStartTls] = useState(false);
  const action = useAction();
  const field = (name: string, label: string, opts: { hint?: string; type?: string; mono?: boolean } = {}) => (
    <TextField
      label={label}
      type={opts.type}
      mono={opts.mono ?? true}
      hint={opts.hint}
      placeholder={(d as Record<string, string>)[name] ?? ""}
      value={f[name] ?? ""}
      onChange={(e) => setF({ ...f, [name]: e.target.value })}
    />
  );
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await action.run(async () => {
      const body: Record<string, unknown> = { kind, startTls, name: f.name || (kind === "active-directory" ? "Active Directory" : "LDAP") };
      for (const [k, v] of Object.entries(f)) if (k !== "name" && v.trim()) body[k] = k === "syncMinutes" ? Number(v) : v.trim();
      await call("/api/v1/directories", { method: "POST", body: JSON.stringify(body) });
      setF({});
      onAdded();
    });
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onCancel()}
      size="lg"
      title={t("addDirectory.addADirectory")}
      description={t("addDirectory.useAReadOnlyService")}
      onSubmit={submit}
      footer={
        <>
          <Button type="button" onClick={onCancel}>
            {t("addDirectory.cancel")}
          </Button>
          <Button type="submit" variant="primary" loading={action.busy} disabled={!f.url || !f.bindDn || !f.bindPassword || !f.baseDn}>
            {t("addDirectory.addDirectory")}
          </Button>
        </>
      }
    >
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(16rem, 1fr))" }}>
        <SelectField
          label={t("addDirectory.kind")}
          value={kind}
          onChange={(e) => setKind(e.target.value as Kind)}
          options={[
            { value: "active-directory", label: t("addDirectory.activeDirectory") },
            { value: "ldap", label: t("addDirectory.ldapOpenldapFreeipaLldap") },
          ]}
        />
        {field("name", "Name", { mono: false, hint: t("addDirectory.shownToPeopleAsWhere") })}
        {field("url", "URL", { hint: "ldaps://, or ldap:// with StartTLS." })}
        {field("bindDn", "Service account (bind DN)")}
        {field("bindPassword", "Service account password", { type: "password", hint: t("addDirectory.keptEncryptedNeverShownAgain") })}
        {field("baseDn", "Where people are (base DN)")}
        {field("userFilter", "People filter")}
        {field("groupBaseDn", "Where groups are", { hint: t("addDirectory.emptyTheBaseDn") })}
        {field("groupFilter", "Groups filter", { hint: t("addDirectory.groupsThatMatchFollowThe") })}
        {field("syncMinutes", "Read every (minutes)", { mono: false, hint: t("addDirectory.from5To1440Default") })}
      </div>
      <Checkbox label="StartTLS" description="Encrypt an ldap:// connection before the password is sent." checked={startTls} onChange={(e) => setStartTls(e.target.checked)} />
      <Problem error={action.error} title={t("addDirectory.notAdded")} />
    </Dialog>
  );
}

/** Settings, Directories: LDAP and Active Directory, read on a schedule; their people sign in with its password (ADR 0034). */
export function DirectoriesPage({ call }: { call: Call }) {
  const ago = useAgo();
  const t = useT();
  const { data, reload } = useData<{ directories: Directory[] }>(call, "/api/v1/directories", 30_000);
  const [adding, setAdding] = useState(false);
  const [result, setResult] = useState<{ name: string; what: string; r: Result }>();
  const action = useAction();
  const run = (d: Directory, what: "check" | "sync") => action.run(async () => (setResult({ name: d.name, what, r: await call<Result>(`/api/v1/directories/${d.id}/${what}`, { method: "POST" }) }), reload()));

  const columns: Column<Directory>[] = [
    { id: "name", header: t("directoriesPage.directory"), cell: (d) => d.name, sortValue: (d) => d.name },
    { id: "url", header: "URL", mono: true, cell: (d) => d.url },
    { id: "people", header: t("directoriesPage.people"), width: "90px", align: "right", cell: (d) => d.people },
    {
      id: "state",
      header: t("directoriesPage.lastRead"),
      width: "200px",
      cell: (d) =>
        d.lastError ? (
          <Badge tone="danger" title={d.lastError}>
            {t("directoriesPage.failed", { ago: ago(d.lastSyncAt) })}</Badge>
        ) : d.lastSyncAt ? (
          <span title={d.lastCounts ? t("directoriesPage.peopleGroupsTurnedOff", { people: d.lastCounts.people, groups: d.lastCounts.groups, disabled: d.lastCounts.disabled }) : undefined}>{ago(d.lastSyncAt)}</span>
        ) : (
          <Badge tone="info">{t("directoriesPage.notReadYet")}</Badge>
        ),
    },
    {
      id: "actions",
      header: "",
      width: "270px",
      cell: (d) => (
        <span className="flex gap-1 whitespace-nowrap">
          <Button size="xs" variant="ghost" icon={<SearchCheck />} onClick={() => void run(d, "check")}>
            {t("directoriesPage.check")}
          </Button>
          <Button size="xs" variant="ghost" icon={<RefreshCw />} onClick={() => void run(d, "sync")}>
            {t("directoriesPage.readNow")}
          </Button>
          <Button size="xs" variant="ghost" icon={<Trash2 />} onClick={() => confirm(t("directoriesPage.removeItsPeopleAreTurned", { name: d.name, people: d.people })) && void action.run(() => call(`/api/v1/directories/${d.id}`, { method: "DELETE" }).then(reload))}>
            {t("directoriesPage.remove")}
          </Button>
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title={t("directoriesPage.directories")}
        description={t("directoriesPage.identityReadsPeopleAndGroups")}
        actions={
          <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>
            {t("directoriesPage.addADirectory")}
          </Button>
        }
      />
      {adding && <AddDirectory call={call} onAdded={() => (setAdding(false), reload())} onCancel={() => setAdding(false)} />}
      {result && (
        <Callout tone={result.r.ok ? "success" : "danger"} title={`${result.what === "check" ? "Checked" : "Read"} ${result.name}`} onDismiss={() => setResult(undefined)}>
          {result.r.ok
            ? t("directoriesPage.peopleAndGroups", { people: String(result.r.people), groups: String(result.r.groups), value: result.r.disabled !== undefined ? `; ${result.r.disabled} turned off` : "" })
            : result.r.error}
        </Callout>
      )}
      <Problem error={action.error} />
      <Panel flush>
        <List label={t("directoriesPage.directories")} rows={data?.directories} columns={columns} empty={t("directoriesPage.noDirectories")} getRowId={(d) => d.id} />
      </Panel>
    </>
  );
}
