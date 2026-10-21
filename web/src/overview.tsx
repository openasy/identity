import { Button, EmptyState, KpiCard, KpiGrid, navigate, PageHeader, Panel, SelectField, type Column } from "@openasy/ui";
import { useState } from "react";
import type { AuditEvent, Overview } from "./api.ts";
import { ago, List, useData, type Call } from "./shared.tsx";

const EVENT_NAMES: Record<string, string> = {
  "app-sign-in": "Signed in to an application",
  "app-sign-in-refused": "Refused at an application",
  "sign-in": "Signed in to Identity",
  "sign-in-failed": "Sign-in failed",
  "sign-out": "Signed out",
  "session-ended": "Session ended",
  setup: "Became the owner",
  "password-changed": "Changed their password",
  "mfa-enabled": "Added a second factor",
  "mfa-removed": "Removed a second factor",
  "member-invited": "Invited someone",
  "member-updated": "Changed someone",
  "member-removed": "Removed someone",
  "token-created": "Created an API token",
  "token-revoked": "Revoked an API token",
  "provider-added": "Added an identity provider",
  "provider-updated": "Changed an identity provider",
  "provider-removed": "Removed an identity provider",
  "application-added": "Added an application",
  "application-updated": "Changed an application",
  "application-removed": "Removed an application",
  "application-secret-replaced": "Made a new client secret",
  "group-added": "Added a group",
  "group-updated": "Changed a group",
  "group-removed": "Removed a group",
  "group-members-changed": "Changed a group's members",
};

const eventColumns: Column<AuditEvent>[] = [
  { id: "at", header: "When", width: "130px", cell: (e) => <span title={new Date(e.at).toLocaleString()}>{ago(e.at)}</span>, sortValue: (e) => e.at },
  { id: "who", header: "Who", width: "180px", cell: (e) => e.actorName ?? e.actor ?? <span className="text-fg-muted">unknown</span> },
  { id: "what", header: "What", cell: (e) => EVENT_NAMES[e.type] ?? e.type },
  { id: "application", header: "Application", width: "160px", cell: (e) => e.applicationName ?? e.application ?? "" },
  { id: "detail", header: "Detail", cell: (e) => <span className="text-fg-muted">{[e.method, e.detail].filter(Boolean).join(", ")}</span> },
  { id: "ip", header: "From", width: "140px", mono: true, cell: (e) => e.ip ?? "" },
];

export function OverviewPage({ call }: { call: Call }) {
  const o = useData<Overview>(call, "/api/v1/overview", 30_000).data;
  const recent = useData<{ events: AuditEvent[] }>(call, "/api/v1/audit?type=app-sign-in&limit=10", 30_000).data?.events;
  return (
    <>
      <PageHeader title="Overview" description="Single sign-on for OpenAsy products and any other application, with MFA and passkeys." />
      <KpiGrid>
        <KpiCard label="Sign-ins to applications · 24 h" value={o?.appSignIns24h ?? "–"} />
        <KpiCard label="Refused · 24 h" value={o?.refused24h ?? "–"} tone={o?.refused24h ? "warning" : undefined} />
        <KpiCard label="Failed sign-ins · 24 h" value={o?.failedSignIns24h ?? "–"} tone={o?.failedSignIns24h ? "danger" : undefined} />
        <KpiCard label="Without a second factor" value={o?.withoutSecondFactor.length ?? "–"} unit={o ? `of ${o.people} people` : undefined} tone={o?.withoutSecondFactor.length ? "warning" : "success"} />
      </KpiGrid>
      {o && o.applications === 0 ? (
        <EmptyState
          title="Start with an application"
          action={
            <Button variant="primary" onClick={() => navigate("/applications")}>
              Add an application
            </Button>
          }
        >
          Add an application, choose the groups that may use it, and people sign in to it with Identity.
        </EmptyState>
      ) : (
        <Panel title="Latest sign-ins to applications" flush actions={<Button size="sm" variant="ghost" onClick={() => navigate("/audit")}>Audit log</Button>}>
          <List label="Latest sign-ins to applications" rows={recent} columns={eventColumns.filter((c) => c.id !== "detail")} empty="Nobody signed in to an application yet" getRowId={(e) => String(e.id)} />
        </Panel>
      )}
      {o && o.withoutSecondFactor.length > 0 && (
        <Panel title="Sign in with a password alone" description="No authenticator app, no passkey and no identity provider. Groups that require a second factor send them to add one.">
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
            {o.withoutSecondFactor.map((p) => (
              <li key={p.id}>
                {p.name} <span className="font-mono text-xs text-fg-muted">{p.email}</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </>
  );
}

export function AuditPage({ call }: { call: Call }) {
  const [type, setType] = useState("");
  const { data } = useData<{ events: AuditEvent[] }>(call, `/api/v1/audit?limit=500${type ? `&type=${type}` : ""}`, 30_000);
  return (
    <>
      <PageHeader
        title="Audit log"
        description="Sign-ins and changes, newest first, kept 400 days. Each is also written to the log as JSON, for your SIEM."
        actions={
          <SelectField aria-label="Show" value={type} onChange={(e) => setType(e.target.value)} options={[{ value: "", label: "Everything" }, ...Object.entries(EVENT_NAMES).map(([value, label]) => ({ value, label }))]} />
        }
      />
      <Panel flush>
        <List label="Audit log" rows={data?.events} columns={eventColumns} empty="Nothing yet" getRowId={(e) => String(e.id)} />
      </Panel>
    </>
  );
}
