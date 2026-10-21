import { Badge, Button, Checkbox, PageHeader, Panel, TextField, type Column } from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { Plus, Trash2, Users } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { Group, Person } from "./api.ts";
import { List, Problem, useAction, useData, type Call } from "./shared.tsx";

/** Choosing a group's members by hand; groups that follow a provider take theirs from it. */
function Members({ call, group, people, onDone }: { call: Call; group: Group; people: Person[]; onDone: () => void }) {
  const [chosen, setChosen] = useState(() => people.filter((p) => p.groups.includes(group.name)).map((p) => p.id));
  const action = useAction();
  const save = () => action.run(() => call(`/api/v1/groups/${group.id}/members`, { method: "PUT", body: JSON.stringify({ userIds: chosen }) }).then(onDone));
  return (
    <Panel title={`Members of ${group.name}`} description="They can sign in to the applications this group may use, and the group goes to those applications in the groups claim.">
      <div className="flex flex-col gap-1.5">
        {people.map((p) => (
          <Checkbox key={p.id} label={p.name} description={p.email} checked={chosen.includes(p.id)} onChange={(e) => setChosen(e.target.checked ? [...chosen, p.id] : chosen.filter((id) => id !== p.id))} />
        ))}
        <Problem error={action.error} title="Not saved" />
        <span className="mt-2 flex gap-2">
          <Button variant="primary" loading={action.busy} onClick={() => void save()}>
            Save members
          </Button>
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </span>
      </div>
    </Panel>
  );
}

export function GroupsPage({ call }: { call: Call }) {
  const { can } = useAuth();
  const { data, reload } = useData<{ groups: Group[] }>(call, "/api/v1/groups", 30_000);
  const people = useData<{ people: Person[] }>(call, "/api/v1/people", 0);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [syncedFrom, setSyncedFrom] = useState("");
  const [editing, setEditing] = useState<Group>();
  const action = useAction();

  const add = async (e: FormEvent) => {
    e.preventDefault();
    await action.run(async () => {
      await call("/api/v1/groups", { method: "POST", body: JSON.stringify({ name, description, syncedFrom: syncedFrom.trim() || null }) });
      setName("");
      setDescription("");
      setSyncedFrom("");
      reload();
    });
  };

  const columns: Column<Group>[] = [
    { id: "name", header: "Group", cell: (g) => g.name, sortValue: (g) => g.name },
    { id: "description", header: "Description", cell: (g) => g.description || <span className="text-fg-muted">none</span> },
    { id: "members", header: "Members", width: "100px", align: "right", cell: (g) => g.members, sortValue: (g) => g.members },
    { id: "source", header: "Members from", width: "220px", cell: (g) => (g.syncedFrom ? <Badge tone="info">{g.syncedFrom}</Badge> : "Chosen here") },
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
      <PageHeader title="Groups" description="Groups decide who may sign in to which application, and applications receive them to give people roles." />
      {can("editor") && (
        <Panel title="Add a group">
          <form onSubmit={add} className="flex flex-wrap items-end gap-2">
            <TextField label="Name" placeholder="Engineering" value={name} onChange={(e) => setName(e.target.value)} />
            <TextField label="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
            <TextField
              label="Members from a provider"
              mono
              placeholder="keycloak:ops-admins"
              hint="Optional: <provider id>:<group there>. Members then follow that group at each sign-in."
              value={syncedFrom}
              onChange={(e) => setSyncedFrom(e.target.value)}
            />
            <Button type="submit" variant="primary" icon={<Plus />} loading={action.busy} disabled={!name.trim()}>
              Add group
            </Button>
          </form>
        </Panel>
      )}
      {editing && people.data && <Members key={editing.id} call={call} group={editing} people={people.data.people} onDone={() => (setEditing(undefined), reload(), people.reload())} />}
      <Problem error={action.error} />
      <Panel flush>
        <List label="Groups" rows={data?.groups} columns={columns} empty="No groups yet" getRowId={(g) => g.id} />
      </Panel>
    </>
  );
}
