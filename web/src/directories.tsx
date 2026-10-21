import { Badge, Button, Callout, Checkbox, PageHeader, Panel, SelectField, TextField, type Column } from "@openasy/ui";
import { Plus, RefreshCw, SearchCheck, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { ago, List, Problem, useAction, useData, type Call } from "./shared.tsx";

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

function AddDirectory({ call, onAdded }: { call: Call; onAdded: () => void }) {
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
    <Panel title="Add a directory" description="Use a read-only service account. Filters left empty use the ones shown.">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(16rem, 1fr))" }}>
          <SelectField
            label="Kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as Kind)}
            options={[
              { value: "active-directory", label: "Active Directory" },
              { value: "ldap", label: "LDAP (OpenLDAP, FreeIPA, lldap...)" },
            ]}
          />
          {field("name", "Name", { mono: false, hint: "Shown to people as where their password is kept." })}
          {field("url", "URL", { hint: "ldaps://, or ldap:// with StartTLS." })}
          {field("bindDn", "Service account (bind DN)")}
          {field("bindPassword", "Service account password", { type: "password", hint: "Kept encrypted; never shown again." })}
          {field("baseDn", "Where people are (base DN)")}
          {field("userFilter", "People filter")}
          {field("groupBaseDn", "Where groups are", { hint: "Empty: the base DN." })}
          {field("groupFilter", "Groups filter", { hint: "Groups that match follow the directory, with their members." })}
          {field("syncMinutes", "Read every (minutes)", { mono: false, hint: "From 5 to 1440; default 60." })}
        </div>
        <Checkbox label="StartTLS" description="Encrypt an ldap:// connection before the password is sent." checked={startTls} onChange={(e) => setStartTls(e.target.checked)} />
        <Problem error={action.error} title="Not added" />
        <span>
          <Button type="submit" variant="primary" icon={<Plus />} loading={action.busy} disabled={!f.url || !f.bindDn || !f.bindPassword || !f.baseDn}>
            Add directory
          </Button>
        </span>
      </form>
    </Panel>
  );
}

/** Settings, Directories: LDAP and Active Directory, read on a schedule; their people sign in with its password (ADR 0034). */
export function DirectoriesPage({ call }: { call: Call }) {
  const { data, reload } = useData<{ directories: Directory[] }>(call, "/api/v1/directories", 30_000);
  const [adding, setAdding] = useState(false);
  const [result, setResult] = useState<{ name: string; what: string; r: Result }>();
  const action = useAction();
  const run = (d: Directory, what: "check" | "sync") => action.run(async () => (setResult({ name: d.name, what, r: await call<Result>(`/api/v1/directories/${d.id}/${what}`, { method: "POST" }) }), reload()));

  const columns: Column<Directory>[] = [
    { id: "name", header: "Directory", cell: (d) => d.name, sortValue: (d) => d.name },
    { id: "url", header: "URL", mono: true, cell: (d) => d.url },
    { id: "people", header: "People", width: "90px", align: "right", cell: (d) => d.people },
    {
      id: "state",
      header: "Last read",
      width: "200px",
      cell: (d) =>
        d.lastError ? (
          <Badge tone="danger" title={d.lastError}>
            Failed {ago(d.lastSyncAt)}
          </Badge>
        ) : d.lastSyncAt ? (
          <span title={d.lastCounts ? `${d.lastCounts.people} people, ${d.lastCounts.groups} groups, ${d.lastCounts.disabled} turned off` : undefined}>{ago(d.lastSyncAt)}</span>
        ) : (
          <Badge tone="info">Not read yet</Badge>
        ),
    },
    {
      id: "actions",
      header: "",
      width: "270px",
      cell: (d) => (
        <span className="flex gap-1 whitespace-nowrap">
          <Button size="xs" variant="ghost" icon={<SearchCheck />} onClick={() => void run(d, "check")}>
            Check
          </Button>
          <Button size="xs" variant="ghost" icon={<RefreshCw />} onClick={() => void run(d, "sync")}>
            Read now
          </Button>
          <Button size="xs" variant="ghost" icon={<Trash2 />} onClick={() => confirm(`Remove ${d.name}? Its ${d.people} people are turned off: their password was its.`) && void action.run(() => call(`/api/v1/directories/${d.id}`, { method: "DELETE" }).then(reload))}>
            Remove
          </Button>
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Directories"
        description="Identity reads people and groups from Active Directory or LDAP on a schedule. Its people sign in with the password it keeps, checked there; people who leave or are disabled there are turned off here. People who manage Identity are never changed by it."
        actions={
          !adding && (
            <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>
              Add a directory
            </Button>
          )
        }
      />
      {adding && <AddDirectory call={call} onAdded={() => (setAdding(false), reload())} />}
      {result && (
        <Callout tone={result.r.ok ? "success" : "danger"} title={`${result.what === "check" ? "Checked" : "Read"} ${result.name}`} onDismiss={() => setResult(undefined)}>
          {result.r.ok
            ? `${result.r.people} people and ${result.r.groups} groups${result.r.disabled !== undefined ? `; ${result.r.disabled} turned off` : ""}.`
            : result.r.error}
        </Callout>
      )}
      <Problem error={action.error} />
      <Panel flush>
        <List label="Directories" rows={data?.directories} columns={columns} empty="No directories" getRowId={(d) => d.id} />
      </Panel>
    </>
  );
}
