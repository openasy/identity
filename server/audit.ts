// The audit log (ADR 0013): who signed in where, who was refused, and who changed what. Kept 400 days in the
// database for the Audit page, and written to the JSON log as it happens, for a SIEM.
import type { DatabaseSync } from "node:sqlite";
import { log } from "./log.ts";

const KEEP_DAYS = 400;

export interface AuditEvent {
  type: string;
  /** Who did it: a person's id, when known. */
  actor?: string;
  /** Whom or what it was done to. */
  target?: string;
  /** The application someone signed in to, or was refused. */
  application?: string;
  method?: string;
  ip?: string;
  detail?: string;
}

export interface AuditEntry extends AuditEvent {
  id: number;
  at: string;
  actorName: string | null;
  applicationName: string | null;
}

/** Sign-ins and refusals: failures among them show as warnings in the log. */
const WARN = new Set(["sign-in-failed", "session-ended", "app-sign-in-refused"]);

export function createAudit(db: DatabaseSync) {
  function record(e: AuditEvent) {
    const at = new Date().toISOString();
    db.prepare("INSERT INTO audit (at, type, actor, target, application, method, ip, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      at,
      e.type,
      e.actor ?? null,
      e.target ?? null,
      e.application ?? null,
      e.method ?? null,
      e.ip ?? null,
      e.detail ?? null,
    );
    log(WARN.has(e.type) ? "warn" : "info", "audit", { event: e });
  }

  /** The newest first; `type` narrows to one kind, `since` to events after a time. */
  function list({ limit = 200, type, since }: { limit?: number; type?: string; since?: string } = {}): AuditEntry[] {
    const rows = db
      .prepare(
        `SELECT a.*, u.name AS actor_name, p.name AS application_name FROM audit a
         LEFT JOIN auth_users u ON u.id = a.actor LEFT JOIN applications p ON p.id = a.application
         WHERE (? IS NULL OR a.type = ?) AND (? IS NULL OR a.at >= ?) ORDER BY a.id DESC LIMIT ?`,
      )
      .all(type ?? null, type ?? null, since ?? null, since ?? null, Math.min(Math.max(limit, 1), 1000)) as Array<Record<string, string | number | null>>;
    return rows.map((r) => ({
      id: r.id as number,
      at: r.at as string,
      type: r.type as string,
      actor: (r.actor as string | null) ?? undefined,
      actorName: r.actor_name as string | null,
      target: (r.target as string | null) ?? undefined,
      application: (r.application as string | null) ?? undefined,
      applicationName: r.application_name as string | null,
      method: (r.method as string | null) ?? undefined,
      ip: (r.ip as string | null) ?? undefined,
      detail: (r.detail as string | null) ?? undefined,
    }));
  }

  const count = (type: string, since: string) => (db.prepare("SELECT COUNT(*) AS n FROM audit WHERE type = ? AND at >= ?").get(type, since) as { n: number }).n;

  function purge() {
    db.prepare("DELETE FROM audit WHERE at < ?").run(new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString());
  }

  return { record, list, count, purge };
}

export type Audit = ReturnType<typeof createAudit>;
