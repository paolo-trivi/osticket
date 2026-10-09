import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadConfigNamespace } from "@/server/config/config";
import { closeDb, db } from "@/server/db";
import { detectDbTimezone } from "@/server/db/time";
import { FormattedDate } from "@/server/mail/objects";

import { execBoth, prepareSnapshot, resetWorkingDatabases, runPhp } from "./lib/harness";

// Date nei template email (%{ticket.create_date}, %{…​.short|long|time|full}): stesso testo del PHP.
beforeAll(prepareSnapshot);
beforeEach(resetWorkingDatabases);
afterAll(closeDb);

const DATE = "2026-03-07 15:04:05";

async function both() {
  const php = await runPhp<Record<string, string>>({ op: "core.formatdate", args: { date: DATE } });
  const cfg = await loadConfigNamespace("core", db(), {});
  const d = new FormattedDate(DATE, cfg, await detectDbTimezone(db()));
  const ts: Record<string, string> = { asVar: d.asVar() };
  for (const k of ["short", "long", "time", "full"]) ts[k] = String(d.getVar(k));
  return { php, ts };
}

describe("FormattedDate", () => {
  it("formati ICU della lingua di sistema (date_formats non custom)", async () => {
    const { php, ts } = await both();
    expect(ts).toEqual(php);
  });

  it("pattern personalizzati (date_formats = custom)", async () => {
    await execBoth(
      "DELETE FROM {p}config WHERE namespace='core' AND `key`='date_formats'",
      "INSERT INTO {p}config (namespace, `key`, value, updated) VALUES ('core', 'date_formats', 'custom', NOW())",
    );
    const { php, ts } = await both();
    expect(ts).toEqual(php);
  });
});
