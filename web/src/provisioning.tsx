import { Button, Callout, PageHeader, Panel, useAgo } from "@openasy/ui";
import { KeyRound, Power } from "lucide-react";
import { useState } from "react";
import { Code, Problem, useAction, useData, type Call } from "./shared.tsx";
import { useT } from "./i18n.ts";

interface Provisioning {
  url: string;
  tokenCreatedAt: string | null;
  lastUsedAt: string | null;
  token?: string;
}

/** Settings, Provisioning: the SCIM address and token an identity provider sends people and groups with (ADR 0034). */
export function ProvisioningPage({ call }: { call: Call }) {
  const ago = useAgo();
  const t = useT();
  const { data, reload } = useData<Provisioning>(call, "/api/v1/provisioning", 30_000);
  const [token, setToken] = useState<string>();
  const action = useAction();
  const on = !!data?.tokenCreatedAt;
  return (
    <>
      <PageHeader
        title={t("provisioningPage.provisioning")}
        description={t("provisioningPage.oktaMicrosoftEntraIdAnd")}
      />
      <Panel title="SCIM" description={on ? t("provisioningPage.onSinceLastRequest", { value: new Date(data!.tokenCreatedAt!).toLocaleDateString(), ago: ago(data!.lastUsedAt) }) : t("provisioningPage.offMakeATokenTo")}>
        <div className="flex flex-col gap-3">
          {data && <Code label={t("provisioningPage.scimBaseUrl")}>{data.url}</Code>}
          <span className="flex gap-2">
            <Button
              variant={on ? "secondary" : "primary"}
              icon={<KeyRound />}
              loading={action.busy}
              onClick={() =>
                (!on || confirm(t("provisioningPage.makeANewTokenThe"))) &&
                void action.run(async () => (setToken((await call<Provisioning>("/api/v1/provisioning/token", { method: "POST" })).token), reload()))
              }
            >
              {on ? t("provisioningPage.newToken") : t("provisioningPage.makeAToken")}
            </Button>
            {on && (
              <Button variant="ghost" icon={<Power />} onClick={() => confirm(t("provisioningPage.turnScimOffTheProvider")) && void action.run(() => call("/api/v1/provisioning/token", { method: "DELETE" }).then(() => (setToken(undefined), reload())))}>
                {t("provisioningPage.turnOff")}
              </Button>
            )}
          </span>
          <Problem error={action.error} />
          {token && (
            <Callout tone="warning" title={t("provisioningPage.copyTheTokenNow")} onDismiss={() => setToken(undefined)}>
              <span className="flex flex-col gap-2">
                <span>{t("provisioningPage.identityKeepsOnlyItsHash")}</span>
                <Code label={t("provisioningPage.scimToken")}>{token}</Code>
              </span>
            </Callout>
          )}
        </div>
      </Panel>
      <Panel title={t("provisioningPage.atTheProvider")}>
        <ul className="m-0 flex list-disc flex-col gap-1.5 pl-5 text-sm">
          <li>{t("provisioningPage.oktaInTheAppProvisioning")}</li>
          <li>{t("provisioningPage.microsoftEntraIdInThe")}</li>
          <li>{t("provisioningPage.peopleProvisionedThisWaySign")}</li>
        </ul>
      </Panel>
    </>
  );
}
