import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { modeAllows, readOnlyReasons } from "@/lib/write-mode";

function messages(area: string, locale: string): Record<string, unknown> {
  const file = area ? `../../src/messages/${area}/${locale}.json` : `../../src/messages/${locale}.json`;
  return JSON.parse(readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8"));
}
const at = (o: unknown, path: string) => path.split(".").reduce<unknown>((x, k) => (x as Record<string, unknown> | undefined)?.[k], o);

describe("modeAllows (ambiti scrivibili per modalità)", () => {
  it("readonly non scrive nulla, operational solo l'ambito operativo, full tutto", () => {
    expect(modeAllows("readonly", "operational")).toBe(false);
    expect(modeAllows("readonly", "admin")).toBe(false);
    expect(modeAllows("operational", "operational")).toBe(true);
    expect(modeAllows("operational", "admin")).toBe(false);
    expect(modeAllows("full", "operational")).toBe(true);
    expect(modeAllows("full", "admin")).toBe(true);
  });
});

describe("readOnlyReasons (motivi della sola lettura automatica)", () => {
  it("nessun motivo se la modalità effettiva è quella configurata", () => {
    expect(readOnlyReasons("readonly", "readonly", ["schema_unverified"])).toEqual([]);
    expect(readOnlyReasons("full", "full", [])).toEqual([]);
  });
  it("traduce i codici di effectiveWriteMode e del doctor, senza duplicati e nell'ordine di arrivo", () => {
    expect(readOnlyReasons("full", "readonly", ["schema_unverified", "doctor:timezone", "doctor:table_prefix", "doctor:secret_salt"])).toEqual([
      "schema",
      "timezone",
      "tablePrefix",
      "secretSalt",
    ]);
    expect(readOnlyReasons("operational", "readonly", ["schema_unreadable", "doctor_failed"])).toEqual(["schemaUnreadable", "doctorFailed"]);
  });
  it("controlli del doctor non previsti e codici sconosciuti cadono su motivi generici, mai grezzi", () => {
    expect(readOnlyReasons("full", "readonly", ["doctor:nuovo", "doctor:altro"])).toEqual(["critical"]);
    expect(readOnlyReasons("full", "readonly", ["boh", "constructor"])).toEqual(["other"]);
    expect(readOnlyReasons("full", "readonly", [])).toEqual(["other"]);
  });
});

describe("messaggi della sola lettura", () => {
  const keys = ["banner.readonly", "banner.admin", "banner.portal", "banner.legacy", "banner.reason", "hint", "hintAdmin", "notice", "noticeAdmin", "noticePortal", "boardDrag"];
  const reasons = ["schema", "schemaUnreadable", "tablePrefix", "secretSalt", "timezone", "critical", "doctorFailed", "other"];
  it.each(["it", "en"])("writeMode completo in %s", (locale) => {
    const m = messages("", locale);
    for (const k of [...keys, ...reasons.map((r) => `reasons.${r}`)]) expect(typeof at(m, `writeMode.${k}`), k).toBe("string");
  });

  // namespace d'errore in cui le action e i dialoghi traducono i codici (t.has(`errors.${code}`))
  const namespaces: [string, string][] = [
    ["", "auth.errors"],
    ["", "composer.errors"],
    ["actions", "ticketActions.errors"],
    ["admin", "admUi.errors"],
    ["adminsys", "asys.errors"],
    ["board", "board.errors"],
    ["create", "createTicket.errors"],
    ["create", "attachments.errors"],
    ["people", "peopleUi.errors"],
    ["people", "peopleAuth.errors"],
    ["portal", "portal.errors"],
    ["ticketedit", "ticketEdit.errors"],
    ["ticketedit", "ticketEdit.mass.errors"],
  ];
  it.each(["it", "en"])("errors.read_only tradotto in tutti i namespace (%s)", (locale) => {
    for (const [area, ns] of namespaces) expect(typeof at(messages(area, locale), `${ns}.read_only`), `${area}:${ns}`).toBe("string");
  });
});
