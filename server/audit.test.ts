import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAudit } from "./audit.ts";
import { openDb } from "./db.ts";

describe("the audit log per hour", () => {
  it("counts each type in the hour it happened, oldest hour first, and leaves out what is older", () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), "identity-")), "identity.db"));
    const audit = createAudit(db);
    const now = Date.parse("2026-10-24T15:40:00.000Z");
    const at = (iso: string, type: string, application?: string) =>
      db.prepare("INSERT INTO audit (at, type, application) VALUES (?, ?, ?)").run(iso, type, application ?? null);
    at("2026-10-24T15:05:00.000Z", "app-sign-in", "a1");
    at("2026-10-24T15:30:00.000Z", "app-sign-in", "a1");
    at("2026-10-24T13:59:59.000Z", "app-sign-in-refused", "a2");
    at("2026-10-23T16:00:00.000Z", "sign-in-failed");
    // Older than the first of the 24 hours, and a type nobody asked for.
    at("2026-10-23T15:59:59.000Z", "app-sign-in", "a1");
    at("2026-10-24T15:10:00.000Z", "sign-out");

    const h = audit.hourly(["app-sign-in", "app-sign-in-refused", "sign-in-failed"], 24, now);
    expect(h.hours[0]).toBe("2026-10-23T16:00:00.000Z");
    expect(h.hours.at(-1)).toBe("2026-10-24T15:00:00.000Z");
    expect(h.series["app-sign-in"]!.at(-1)).toBe(2);
    expect(h.series["app-sign-in"]!.reduce((a, b) => a + b, 0)).toBe(2);
    expect(h.series["app-sign-in-refused"]![21]).toBe(1);
    expect(h.series["sign-in-failed"]![0]).toBe(1);

    expect(audit.byApplication("2026-10-23T16:00:00.000Z")).toEqual([{ id: "a1", name: null, signIns: 2 }]);
    db.close();
  });
});
