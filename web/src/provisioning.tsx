import { Button, Callout, PageHeader, Panel } from "@openasy/ui";
import { KeyRound, Power } from "lucide-react";
import { useState } from "react";
import { Code, Problem, ago, useAction, useData, type Call } from "./shared.tsx";

interface Provisioning {
  url: string;
  tokenCreatedAt: string | null;
  lastUsedAt: string | null;
  token?: string;
}

/** Settings, Provisioning: the SCIM address and token an identity provider sends people and groups with (ADR 0034). */
export function ProvisioningPage({ call }: { call: Call }) {
  const { data, reload } = useData<Provisioning>(call, "/api/v1/provisioning", 30_000);
  const [token, setToken] = useState<string>();
  const action = useAction();
  const on = !!data?.tokenCreatedAt;
  return (
    <>
      <PageHeader
        title="Provisioning"
        description="Okta, Microsoft Entra ID and other identity providers create, change and remove people and groups here with SCIM 2.0. When someone leaves, the provider turns them off and they lose every application at once. It never changes the people who manage Identity."
      />
      <Panel title="SCIM" description={on ? `On since ${new Date(data!.tokenCreatedAt!).toLocaleDateString()}; last request ${ago(data!.lastUsedAt)}.` : "Off: make a token to turn it on."}>
        <div className="flex flex-col gap-3">
          {data && <Code label="SCIM base URL">{data.url}</Code>}
          <span className="flex gap-2">
            <Button
              variant={on ? "secondary" : "primary"}
              icon={<KeyRound />}
              loading={action.busy}
              onClick={() =>
                (!on || confirm("Make a new token? The provider's current one stops working at once.")) &&
                void action.run(async () => (setToken((await call<Provisioning>("/api/v1/provisioning/token", { method: "POST" })).token), reload()))
              }
            >
              {on ? "New token" : "Make a token"}
            </Button>
            {on && (
              <Button variant="ghost" icon={<Power />} onClick={() => confirm("Turn SCIM off? The provider can no longer change anyone here.") && void action.run(() => call("/api/v1/provisioning/token", { method: "DELETE" }).then(() => (setToken(undefined), reload())))}>
                Turn off
              </Button>
            )}
          </span>
          <Problem error={action.error} />
          {token && (
            <Callout tone="warning" title="Copy the token now" onDismiss={() => setToken(undefined)}>
              <span className="flex flex-col gap-2">
                <span>Identity keeps only its hash. Enter it in the provider as the bearer token, or secret token, with the base URL above.</span>
                <Code label="SCIM token">{token}</Code>
              </span>
            </Callout>
          )}
        </div>
      </Panel>
      <Panel title="At the provider">
        <ul className="m-0 flex list-disc flex-col gap-1.5 pl-5 text-sm">
          <li>Okta: in the app, Provisioning, choose SCIM 2.0 with HTTP header authentication, enter the base URL and the token, and turn on creating, updating and deactivating users and pushing groups.</li>
          <li>Microsoft Entra ID: in the enterprise application, Provisioning, choose Automatic, enter the base URL as the tenant URL and the token as the secret token, and test the connection.</li>
          <li>People provisioned this way sign in through that provider: add it under Sign-in, and they are matched by their verified email.</li>
        </ul>
      </Panel>
    </>
  );
}
