import { Badge, Button, Callout, Dialog, PageHeader, Panel, TextField, type Column } from "@openasy/ui";
import { auth, useAuth } from "@openasy/auth/react";
import { Check, UserPlus } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { Person } from "./api.ts";
import { Code, List, Problem, useAction, useData, type Call } from "./shared.tsx";

const ROLE: Record<Person["role"], string> = { user: "User", viewer: "Viewer", editor: "Editor", admin: "Admin", owner: "Owner" };

/** The directory: everyone who can sign in to applications, and their groups. */
export function PeoplePage({ call }: { call: Call }) {
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
    { id: "name", header: "Name", cell: (p) => p.name, sortValue: (p) => p.name },
    { id: "email", header: "Email", mono: true, cell: (p) => p.email, sortValue: (p) => p.email },
    { id: "role", header: "Manages Identity", width: "150px", cell: (p) => (p.role === "user" ? <span className="text-fg-muted">No</span> : ROLE[p.role]) },
    { id: "status", header: "Status", width: "110px", cell: (p) => <Badge tone={p.status === "active" ? "success" : p.status === "invited" ? "info" : "neutral"}>{p.status}</Badge> },
    { id: "groups", header: "Groups", cell: (p) => p.groups.join(", ") || <span className="text-fg-muted">none</span> },
  ];

  return (
    <>
      <PageHeader
        title="People"
        description="Everyone who signs in to applications with Identity. People from an identity provider appear after their first sign-in; disable or remove someone under Members."
        actions={
          can("admin") && (
            <Button variant="primary" icon={<UserPlus />} onClick={() => setInviting(true)}>
              Invite someone
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
          title={`Invitation for ${link.email}`}
          description={`Send this link to them yourself; it works once, until ${new Date(link.expiresAt).toLocaleString()}.`}
          footer={
            <Button variant="primary" onClick={close}>
              Done
            </Button>
          }
        >
          <Code label={`Invitation link for ${link.email}`}>{link.link}</Code>
          <Callout tone="warning" title="Closing this dialog hides the link" />
        </Dialog>
      ) : (
        <Dialog
          open={inviting}
          onOpenChange={(open) => !open && close()}
          title="Invite someone"
          description="They get a link to choose a password. They can sign in to the applications their groups allow, not manage Identity."
          onSubmit={invite}
          footer={
            <>
              <Button type="button" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" loading={action.busy} disabled={!email.includes("@")}>
                Invite
              </Button>
            </>
          }
        >
          <Problem error={action.error} title="Not invited" />
          <TextField label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} />
        </Dialog>
      )}
      <Panel flush>
        <List label="People" rows={data?.people} columns={columns} empty="Nobody yet" getRowId={(p) => p.id} />
      </Panel>
    </>
  );
}
