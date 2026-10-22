import { Badge, Button, Checkbox, Dialog, PageHeader, Panel, SelectField, TextField, type Column } from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { Plus, Trash2, Users } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { Group, Person } from "./api.ts";
import { List, Problem, useAction, useData, type Call } from "./shared.tsx";

const MFA_OPTIONS = [
  { value: "optional", label: "Optional" },
  { value: "required", label: "Required" },
  { value: "passkey", label: "Passkey only" },
];

/** Choosing a group's members by hand; groups that follow a provider take theirs from it. */
function Members({ call, group, people, onDone }: { call: Call; group: Group; people: Person[]; onDone: () => void }) {
  const [chosen, setChosen] = useState(() => people.filter((p) => p.groups.includes(group.name)).map((p) => p.id));
  const action = useAction();
  const save = () => action.run(() => call(`/api/v1/groups/${group.id}/members`, { method: "PUT", body: JSON.stringify({ userIds: chosen }) }).then(onDone));
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onDone()}
      title={`Members of ${group.name}`}
      description="They can sign in to the applications this group may use, and the group goes to those applications in the groups claim."
      footer={
        <>
          <Button onClick={onDone}>Cancel</Button>
          <Button variant="primary" loading={action.busy} onClick={() => void save()}>
            Save members
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-1.5">
        {people.map((p) => (
          <Checkbox key={p.id} label={p.name} description={p.email} checked={chosen.includes(p.id)} onChange={(e) => setChosen(e.target.checked ? [...chosen, p.id] : chosen.filter((id) => id !== p.id))} />
        ))}
      </div>
      <Problem error={action.error} title="Not saved" />
    </Dialog>
  );
}

export function GroupsPage({ call }: { call: Call }) {
  const { can } = useAuth();
  const { data, reload } = useData<{ groups: Group[] }>(call, "/api/v1/groups", 30_000);
  const people = useData<{ people: Person[] }>(call, "/api/v1/people", 0);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [syncedFrom, setSyncedFrom] = useState("");
  const [mfa, setMfa] = useState<Group["mfa"]>("optional");
  const [editing, setEditing] = useState<Group>();
  const [adding, setAdding] = useState(false);
  const action = useAction();
  const close = () => (setAdding(false), setName(""), setDescription(""), setSyncedFrom(""), setMfa("optional"), action.clear());

  const add = async (e: FormEvent) => {
    e.preventDefault();
    await action.run(async () => {
      await call("/api/v1/groups", { method: "POST", body: JSON.stringify({ name, description, mfa, syncedFrom: syncedFrom.trim() || null }) });
      close();
      reload();
    });
  };

  const columns: Column<Group>[] = [
    { id: "name", header: "Group", cell: (g) => g.name, sortValue: (g) => g.name },
    { id: "description", header: "Description", cell: (g) => g.description || <span className="text-fg-muted">none</span> },
    { id: "members", header: "Members", width: "100px", align: "right", cell: (g) => g.members, sortValue: (g) => g.members },
    { id: "source", header: "Members from", width: "200px", cell: (g) => (g.syncedFrom ? <Badge tone="info">{g.syncedFrom}</Badge> : "Chosen here") },
    {
      id: "mfa",
      header: "Second factor",
      width: "160px",
      cell: (g) =>
        can("editor") ? (
          <SelectField
            aria-label={`Second factor for ${g.name}`}
            value={g.mfa}
            options={MFA_OPTIONS}
            onChange={(e) => void action.run(() => call(`/api/v1/groups/${g.id}`, { method: "PATCH", body: JSON.stringify({ mfa: e.target.value }) }).then(reload))}
          />
        ) : (
          MFA_OPTIONS.find((o) => o.value === g.mfa)!.label
        ),
    },
    ...(can("editor")
      ? [
          {
            id: "actions",
            header: "",
            width: "200px",
            cell: (g: Group) => (
              <span className="flex gap-1 whitespace-nowrap">
                {!g.syncedFrom && (
                  <Button size="xs" variant="ghost" icon={<Users />} onClick={() => setEditing(g)}>
                    Members
                  </Button>
                )}
                <Button size="xs" variant="ghost" icon={<Trash2 />} onClick={() => confirm(`Remove ${g.name}? Its members lose the applications only it gave them.`) && void action.run(() => call(`/api/v1/groups/${g.id}`, { method: "DELETE" }).then(reload))}>
                  Remove
                </Button>
              </span>
            ),
          } satisfies Column<Group>,
        ]
      : []),
  ];

  return (
    <>
      <PageHeader
        title="Groups"
        description="Groups decide who may sign in to which application, and applications receive them to give people roles. Where a second factor is required, members sign in to applications with an authenticator app, a passkey or an identity provider."
        actions={
          can("editor") && (
            <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>
              Add group
            </Button>
          )
        }
      />
      <Dialog
        open={adding}
        onOpenChange={(open) => !open && close()}
        title="Add a group"
        description="Then choose its members, and which applications it may sign in to."
        onSubmit={add}
        footer={
          <>
            <Button type="button" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={action.busy} disabled={!name.trim()}>
              Add group
            </Button>
          </>
        }
      >
        <Problem error={action.error} title="Not added" />
        <TextField label="Name" placeholder="Engineering" value={name} onChange={(e) => setName(e.target.value)} />
        <TextField label="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
        <SelectField label="Second factor" value={mfa} options={MFA_OPTIONS} onChange={(e) => setMfa(e.target.value as Group["mfa"])} />
        <TextField
          label="Members from a provider"
          mono
          placeholder="keycloak:ops-admins"
          hint="Optional: <provider id>:<group there>. Members then follow that group at each sign-in."
          value={syncedFrom}
          onChange={(e) => setSyncedFrom(e.target.value)}
        />
      </Dialog>
      {editing && people.data && <Members key={editing.id} call={call} group={editing} people={people.data.people} onDone={() => (setEditing(undefined), reload(), people.reload())} />}
      {!adding && <Problem error={action.error} />}
      <Panel flush>
        <List label="Groups" rows={data?.groups} columns={columns} empty="No groups yet" getRowId={(g) => g.id} />
      </Panel>
    </>
  );
}
