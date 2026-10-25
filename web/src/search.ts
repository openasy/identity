// What the search window (Cmd+K) finds in Identity: people by name or email, groups and applications by name. They
// are read whole and filtered here: a directory is small.
import type { SearchFn, SearchResult } from "@openasy/ui";
import { AppWindow, UserRound, Users } from "lucide-react";
import type { Application, Group, Person } from "./api.ts";
import type { T } from "./i18n.ts";

type Call = <R>(path: string, init?: RequestInit) => Promise<R>;

export function search(call: Call, t: T): SearchFn {
  return async (q, signal) => {
    const [people, groups, applications] = await Promise.all([
      call<{ people: Person[] }>("/api/v1/people", { signal }),
      call<{ groups: Group[] }>("/api/v1/groups", { signal }),
      call<{ applications: Application[] }>("/api/v1/applications", { signal }),
    ]);
    const has = (...texts: string[]) => texts.some((x) => x.toLowerCase().includes(q));
    return [
      ...people.people
        .filter((p) => has(p.name, p.email))
        .slice(0, 6)
        .map((p): SearchResult => ({ id: `person:${p.id}`, label: p.name, detail: p.email, kind: t("search.person"), icon: UserRound, href: "/people" })),
      ...groups.groups
        .filter((g) => has(g.name, g.description))
        .slice(0, 6)
        .map((g): SearchResult => ({
          id: `group:${g.id}`,
          label: g.name,
          detail: t("search.groupDetail", { members: g.members }),
          kind: t("search.group"),
          icon: Users,
          href: "/groups",
        })),
      ...applications.applications
        .filter((a) => has(a.name))
        .slice(0, 6)
        .map((a): SearchResult => ({
          id: `application:${a.id}`,
          label: a.name,
          detail: a.protocol === "saml" ? "SAML" : "OpenID Connect",
          kind: t("search.application"),
          icon: AppWindow,
          href: "/applications",
        })),
    ];
  };
}
