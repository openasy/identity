import { Badge, Button, Callout, Dialog, PageHeader, Panel, TextField, type Column } from "@openasy/ui";
import { auth, useAuth } from "@openasy/auth/react";
import { Check, UserPlus } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { Person } from "./api.ts";
import { Code, List, Problem, useAction, useData, type Call } from "./shared.tsx";
import { useT } from "./i18n.ts";

const ROLE: Record<Person["role"], string> = { user: "User", viewer: "Viewer", editor: "Editor", admin: "Admin", owner: "Owner" };

/** The directory: everyone who can sign in to applications, and their groups. */
export function PeoplePage({ call }: { call: Call }) {
  const t = useT();
  const { can } = useAuth();
  const { data, reload } = useData<{ people: Person[] }>(call, "/api/v1/people", 30_000);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [link, setLink] = useState<{ email: string; link: string; expiresAt: string }>();
  const [inviting, setInviting] = useState(false);
  const action = useAction();
  const close = () => (setInviting(false), setLink(undefined), setEmail(""), setName(""), action.clear());

  const invite = async (e: FormEvent) => {
    e.preventDefault();
    await action.run(async () => {
      const r = await auth.invite({ email, name: name || undefined, role: "user" });
      setLink({ email: r.member.email, link: r.link, expiresAt: r.linkExpiresAt });
      reload();
    });
  };

  const columns: Column<Person>[] = [
    { id: "name", header: t("peoplePage.name"), cell: (p) => p.name, sortValue: (p) => p.name },
    { id: "email", header: t("peoplePage.email"), mono: true, cell: (p) => p.email, sortValue: (p) => p.email },
    { id: "role", header: t("peoplePage.managesIdentity"), width: "150px", cell: (p) => (p.role === "user" ? <span className="text-fg-muted">{t("peoplePage.no")}</span> : ROLE[p.role]) },
    { id: "status", header: t("peoplePage.status"), width: "110px", cell: (p) => <Badge tone={p.status === "active" ? "success" : p.status === "invited" ? "info" : "neutral"}>{p.status}</Badge> },
    { id: "groups", header: t("peoplePage.groups"), cell: (p) => p.groups.join(", ") || <span className="text-fg-muted">none</span> },
  ];

  return (
    <>
      <PageHeader
        title={t("peoplePage.people")}
        description={t("peoplePage.everyoneWhoSignsInTo")}
        actions={
          can("admin") && (
            <Button variant="primary" icon={<UserPlus />} onClick={() => setInviting(true)}>
              {t("peoplePage.inviteSomeone")}
            </Button>
          )
        }
      />
      {link ? (
        <Dialog
          open={inviting}
          onOpenChange={(open) => !open && close()}
          icon={<Check aria-hidden className="size-4" />}
          iconTone="success"
          title={t("peoplePage.invitationFor", { email: link.email })}
          description={t("peoplePage.sendThisLinkToThem", { value: new Date(link.expiresAt).toLocaleString() })}
          footer={
            <Button variant="primary" onClick={close}>
              {t("peoplePage.done")}
            </Button>
          }
        >
          <Code label={t("peoplePage.invitationLinkFor", { email: link.email })}>{link.link}</Code>
          <Callout tone="warning" title={t("peoplePage.closingThisDialogHidesThe")} />
        </Dialog>
      ) : (
        <Dialog
          open={inviting}
          onOpenChange={(open) => !open && close()}
          title={t("peoplePage.inviteSomeone")}
          description={t("peoplePage.theyGetALinkTo")}
          onSubmit={invite}
          footer={
            <>
              <Button type="button" onClick={close}>
                {t("peoplePage.cancel")}
              </Button>
              <Button type="submit" variant="primary" loading={action.busy} disabled={!email.includes("@")}>
                {t("peoplePage.invite")}
              </Button>
            </>
          }
        >
          <Problem error={action.error} title={t("peoplePage.notInvited")} />
          <TextField label={t("peoplePage.email")} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <TextField label={t("peoplePage.name")} value={name} onChange={(e) => setName(e.target.value)} />
        </Dialog>
      )}
      <Panel flush>
        <List label={t("peoplePage.people")} rows={data?.people} columns={columns} empty={t("peoplePage.nobodyYet")} getRowId={(p) => p.id} />
      </Panel>
    </>
  );
}
