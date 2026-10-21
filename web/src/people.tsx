import { Badge, Button, Callout, PageHeader, Panel, TextField, type Column } from "@openasy/ui";
import { auth, useAuth } from "@openasy/auth/react";
import { UserPlus } from "lucide-react";
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
  const action = useAction();

  const invite = async (e: FormEvent) => {
    e.preventDefault();
    await action.run(async () => {
      const r = await auth.invite({ email, name: name || undefined, role: "user" });
      setLink({ email: r.member.email, link: r.link, expiresAt: r.linkExpiresAt });
      setEmail("");
      setName("");
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
      />
      {can("admin") && (
        <Panel title="Invite someone" description="They get a link to choose a password. They can sign in to the applications their groups allow, not manage Identity.">
          <form onSubmit={invite} className="flex flex-wrap items-end gap-2">
            <TextField label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} />
            <Button type="submit" variant="primary" icon={<UserPlus />} loading={action.busy} disabled={!email.includes("@")}>
              Invite
            </Button>
          </form>
        </Panel>
      )}
      {link && (
        <Callout tone="info" title={`Invitation for ${link.email}`} onDismiss={() => setLink(undefined)}>
          <span className="flex flex-col gap-2">
            <span>Send this link to them yourself; it works once, until {new Date(link.expiresAt).toLocaleString()}.</span>
            <Code label={`Invitation link for ${link.email}`}>{link.link}</Code>
          </span>
        </Callout>
      )}
      <Problem error={action.error} title="Not invited" />
      <Panel flush>
        <List label="People" rows={data?.people} columns={columns} empty="Nobody yet" getRowId={(p) => p.id} />
      </Panel>
    </>
  );
}
