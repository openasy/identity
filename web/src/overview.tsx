import { Button, EmptyState, KpiCard, KpiGrid, navigate, PageHeader, Panel, SelectField, useAgo, type Column } from "@openasy/ui";
import { useState } from "react";
import type { AuditEvent, Overview } from "./api.ts";
import { List, useData, type Call } from "./shared.tsx";
import { useT, type T } from "./i18n.ts";

const EVENT_NAMES = (t: T): Record<string, string> => ({
  "app-sign-in": t("eventNames.signedInToAnApplication"),
  "app-sign-in-refused": t("eventNames.refusedAtAnApplication"),
  "sign-in": t("eventNames.signedInToIdentity"),
  "sign-in-failed": "Sign-in failed",
  "sign-out": t("eventNames.signedOut"),
  "session-ended": t("eventNames.sessionEnded"),
  setup: t("eventNames.becameTheOwner"),
  "password-changed": t("eventNames.changedTheirPassword"),
  "mfa-enabled": t("eventNames.addedASecondFactor"),
  "mfa-removed": t("eventNames.removedASecondFactor"),
  "member-invited": t("eventNames.invitedSomeone"),
  "member-updated": t("eventNames.changedSomeone"),
  "member-removed": t("eventNames.removedSomeone"),
  "token-created": t("eventNames.createdAnApiToken"),
  "token-revoked": t("eventNames.revokedAnApiToken"),
  "provider-added": t("eventNames.addedAnIdentityProvider"),
  "provider-updated": t("eventNames.changedAnIdentityProvider"),
  "provider-removed": t("eventNames.removedAnIdentityProvider"),
  "application-added": t("eventNames.addedAnApplication"),
  "application-updated": t("eventNames.changedAnApplication"),
  "application-removed": t("eventNames.removedAnApplication"),
  "application-secret-replaced": t("eventNames.madeANewClientSecret"),
  "group-added": t("eventNames.addedAGroup"),
  "group-updated": t("eventNames.changedAGroup"),
  "group-removed": t("eventNames.removedAGroup"),
  "group-members-changed": t("eventNames.changedAGroupSMembers"),
});

const eventColumns = (t: T, ago: (iso: string | null | undefined) => string): Column<AuditEvent>[] => [
  { id: "at", header: t("eventcolumns.when"), width: "130px", cell: (e) => <span title={new Date(e.at).toLocaleString()}>{ago(e.at)}</span>, sortValue: (e) => e.at },
  { id: "who", header: t("eventcolumns.who"), width: "180px", cell: (e) => e.actorName ?? e.actor ?? <span className="text-fg-muted">{t("eventcolumns.unknown")}</span> },
  { id: "what", header: t("eventcolumns.what"), cell: (e) => EVENT_NAMES(t)[e.type] ?? e.type },
  { id: "application", header: t("eventcolumns.application"), width: "160px", cell: (e) => e.applicationName ?? e.application ?? "" },
  { id: "detail", header: t("eventcolumns.detail"), cell: (e) => <span className="text-fg-muted">{[e.method, e.detail].filter(Boolean).join(", ")}</span> },
  { id: "ip", header: t("eventcolumns.from"), width: "140px", mono: true, cell: (e) => e.ip ?? "" },
];

export function OverviewPage({ call }: { call: Call }) {
  const t = useT();
  const ago = useAgo();
  const o = useData<Overview>(call, "/api/v1/overview", 30_000).data;
  const recent = useData<{ events: AuditEvent[] }>(call, "/api/v1/audit?type=app-sign-in&limit=10", 30_000).data?.events;
  return (
    <>
      <PageHeader title={t("overviewPage.overview")} description={t("overviewPage.singleSignOnForOpenasy")} />
      <KpiGrid>
        <KpiCard label={t("overviewPage.signInsToApplications24")} value={o?.appSignIns24h ?? "–"} />
        <KpiCard label={t("overviewPage.refused24H")} value={o?.refused24h ?? "–"} tone={o?.refused24h ? "warning" : undefined} />
        <KpiCard label={t("overviewPage.failedSignIns24H")} value={o?.failedSignIns24h ?? "–"} tone={o?.failedSignIns24h ? "danger" : undefined} />
        <KpiCard label={t("overviewPage.withoutASecondFactor")} value={o?.withoutSecondFactor.length ?? "–"} unit={o ? t("overviewPage.ofPeople", { people: o.people }) : undefined} tone={o?.withoutSecondFactor.length ? "warning" : "success"} />
      </KpiGrid>
      {o && o.applications === 0 ? (
        <EmptyState
          title={t("overviewPage.startWithAnApplication")}
          action={
            <Button variant="primary" onClick={() => navigate("/applications")}>
              {t("overviewPage.addAnApplication")}
            </Button>
          }
        >
          {t("overviewPage.addAnApplicationChooseThe")}
        </EmptyState>
      ) : (
        <Panel title={t("overviewPage.latestSignInsToApplications")} flush actions={<Button size="sm" variant="ghost" onClick={() => navigate("/audit")}>{t("overviewPage.auditLog")}</Button>}>
          <List label={t("overviewPage.latestSignInsToApplications")} rows={recent} columns={eventColumns(t, ago).filter((c) => c.id !== "detail")} empty={t("overviewPage.nobodySignedInToAn")} getRowId={(e) => String(e.id)} />
        </Panel>
      )}
      {o && o.withoutSecondFactor.length > 0 && (
        <Panel title={t("overviewPage.signInWithAPassword")} description={t("overviewPage.noAuthenticatorAppNoPasskey")}>
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
  const ago = useAgo();
  const t = useT();
  const [type, setType] = useState("");
  const { data } = useData<{ events: AuditEvent[] }>(call, `/api/v1/audit?limit=500${type ? `&type=${type}` : ""}`, 30_000);
  return (
    <>
      <PageHeader
        title={t("auditPage.auditLog")}
        description={t("auditPage.signInsAndChangesNewest")}
        actions={
          <SelectField aria-label={t("auditPage.show")} value={type} onChange={(e) => setType(e.target.value)} options={[{ value: "", label: t("auditPage.everything") }, ...Object.entries(EVENT_NAMES(t)).map(([value, label]) => ({ value, label }))]} />
        }
      />
      <Panel flush>
        <List label={t("auditPage.auditLog")} rows={data?.events} columns={eventColumns(t, ago)} empty={t("auditPage.nothingYet")} getRowId={(e) => String(e.id)} />
      </Panel>
    </>
  );
}
