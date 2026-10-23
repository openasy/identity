import { Badge, Button, Checkbox, Dialog, PageHeader, Panel, SelectField, TextField, type Column } from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { Plus, Trash2, Users } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { Group, Person } from "./api.ts";
import { List, Problem, useAction, useData, type Call } from "./shared.tsx";
import { useT, type T } from "./i18n.ts";

const MFA_OPTIONS = (t: T) => [
  { value: "optional", label: t("mfaOptions.optional") },
  { value: "required", label: t("mfaOptions.required") },
  { value: "passkey", label: t("mfaOptions.passkeyOnly") },
];

/** Choosing a group's members by hand; groups that follow a provider take theirs from it. */
function Members({ call, group, people, onDone }: { call: Call; group: Group; people: Person[]; onDone: () => void }) {
  const t = useT();
  const [chosen, setChosen] = useState(() => people.filter((p) => p.groups.includes(group.name)).map((p) => p.id));
  const action = useAction();
  const save = () => action.run(() => call(`/api/v1/groups/${group.id}/members`, { method: "PUT", body: JSON.stringify({ userIds: chosen }) }).then(onDone));
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onDone()}
      title={t("members.membersOf", { name: group.name })}
      description={t("members.theyCanSignInTo")}
      footer={
        <>
          <Button onClick={onDone}>{t("members.cancel")}</Button>
          <Button variant="primary" loading={action.busy} onClick={() => void save()}>
            {t("members.saveMembers")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-1.5">
        {people.map((p) => (
          <Checkbox
            key={p.id}
            label={p.name}
            description={p.email}
            checked={chosen.includes(p.id)}
            onChange={(e) => setChosen(e.target.checked ? [...chosen, p.id] : chosen.filter((id) => id !== p.id))}
          />
        ))}
      </div>
      <Problem error={action.error} title={t("members.notSaved")} />
    </Dialog>
  );
}

export function GroupsPage({ call }: { call: Call }) {
  const t = useT();
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
    { id: "name", header: t("groupsPage.group"), cell: (g) => g.name, sortValue: (g) => g.name },
    { id: "description", header: t("groupsPage.description"), cell: (g) => g.description || <span className="text-fg-muted">none</span> },
    { id: "members", header: t("groupsPage.members"), width: "100px", align: "right", cell: (g) => g.members, sortValue: (g) => g.members },
    {
      id: "source",
      header: t("groupsPage.membersFrom"),
      width: "200px",
      cell: (g) => (g.syncedFrom ? <Badge tone="info">{g.syncedFrom}</Badge> : "Chosen here"),
    },
    {
      id: "mfa",
      header: t("groupsPage.secondFactor"),
      width: "160px",
      cell: (g) =>
        can("editor") ? (
          <SelectField
            aria-label={t("groupsPage.secondFactorFor", { name: g.name })}
            value={g.mfa}
            options={MFA_OPTIONS(t)}
            onChange={(e) =>
              void action.run(() => call(`/api/v1/groups/${g.id}`, { method: "PATCH", body: JSON.stringify({ mfa: e.target.value }) }).then(reload))
            }
          />
        ) : (
          MFA_OPTIONS(t).find((o) => o.value === g.mfa)!.label
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
                    {t("groupsPage.members")}
                  </Button>
                )}
                <Button
                  size="xs"
                  variant="ghost"
                  icon={<Trash2 />}
                  onClick={() =>
                    confirm(t("groupsPage.removeItsMembersLoseThe", { name: g.name })) &&
                    void action.run(() => call(`/api/v1/groups/${g.id}`, { method: "DELETE" }).then(reload))
                  }
                >
                  {t("groupsPage.remove")}
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
        title={t("groupsPage.groups")}
        description={t("groupsPage.groupsDecideWhoMaySign")}
        actions={
          can("editor") && (
            <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>
              {t("groupsPage.addGroup")}
            </Button>
          )
        }
      />
      <Dialog
        open={adding}
        onOpenChange={(open) => !open && close()}
        title={t("groupsPage.addAGroup")}
        description={t("groupsPage.thenChooseItsMembersAnd")}
        onSubmit={add}
        footer={
          <>
            <Button type="button" onClick={close}>
              {t("groupsPage.cancel")}
            </Button>
            <Button type="submit" variant="primary" loading={action.busy} disabled={!name.trim()}>
              {t("groupsPage.addGroup")}
            </Button>
          </>
        }
      >
        <Problem error={action.error} title={t("groupsPage.notAdded")} />
        <TextField label={t("groupsPage.name")} placeholder={t("groupsPage.engineering")} value={name} onChange={(e) => setName(e.target.value)} />
        <TextField label={t("groupsPage.description")} value={description} onChange={(e) => setDescription(e.target.value)} />
        <SelectField label={t("groupsPage.secondFactor")} value={mfa} options={MFA_OPTIONS(t)} onChange={(e) => setMfa(e.target.value as Group["mfa"])} />
        <TextField
          label={t("groupsPage.membersFromAProvider")}
          mono
          placeholder="keycloak:ops-admins"
          hint={t("groupsPage.optionalProviderIdGroupThere")}
          value={syncedFrom}
          onChange={(e) => setSyncedFrom(e.target.value)}
        />
      </Dialog>
      {editing && people.data && (
        <Members key={editing.id} call={call} group={editing} people={people.data.people} onDone={() => (setEditing(undefined), reload(), people.reload())} />
      )}
      {!adding && <Problem error={action.error} />}
      <Panel flush>
        <List label={t("groupsPage.groups")} rows={data?.groups} columns={columns} empty={t("groupsPage.noGroupsYet")} getRowId={(g) => g.id} />
      </Panel>
    </>
  );
}
