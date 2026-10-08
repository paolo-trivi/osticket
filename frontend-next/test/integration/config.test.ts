import { afterAll, describe, expect, it } from "vitest";

import { loadConfigNamespace } from "@/server/config/config";
import { closeDb, db } from "@/server/db";
import { detectDbTimezone, fromDb, toDb } from "@/server/db/time";

afterAll(closeDb);

describe("config + fuso DB (DB osTicket di sviluppo)", () => {
  it("legge la configurazione core scritta dall'installer PHP", async () => {
    const cfg = await loadConfigNamespace("core");
    expect(cfg.str("helpdesk_title")).toBe("Helpdesk DEV");
    expect(cfg.int("default_dept_id")).toBeGreaterThan(0);
    // default PHP quando la chiave manca nel DB
    expect(cfg.raw("default_storage_bk")).toBeDefined();
  });

  it("determina il fuso del DB e fa round-trip dei datetime", async () => {
    const zone = await detectDbTimezone(db());
    expect(zone).toBeTruthy();
    const row = await db().selectFrom("ticket").select("created").executeTakeFirstOrThrow();
    const dt = fromDb(row.created);
    expect(dt).not.toBeNull();
    expect(toDb(dt!)).toBe(row.created);
    expect(fromDb("0000-00-00 00:00:00")).toBeNull();
  });
});
