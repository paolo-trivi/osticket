import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import en from "@/messages/admin/en.json";
import it_ from "@/messages/admin/it.json";
import { ConfigNamespace, CORE_DEFAULTS } from "@/server/config/config";
import { parsePhpForm, selectedIds } from "@/server/domain/admin/form-data";
import { ALL_PERMISSIONS, rebuildPermissions } from "@/server/domain/admin/role";
import { describeEntry, displaySortOrder, isFullDayEntry } from "@/server/domain/admin/schedule-entry-form";
import { usernameError } from "@/server/domain/admin/validator";
import { htmlchars, intval, isNumeric, truthy } from "@/server/php/values";

describe("parsePhpForm: FormData → $_POST", () => {
  it("liste, mappe e valori semplici come PHP", () => {
    const f = new FormData();
    f.append("$ACTION_ID_x", "");
    f.append("name", "Vendite");
    f.append("members[]", "2");
    f.append("members[]", "4");
    f.append("member_role[2]", "1");
    f.append("member_alerts[4]", "1");
    f.append("qsort[1]", "3");
    f.append("name", "Ultimo");
    expect(parsePhpForm(f)).toEqual({
      name: "Ultimo",
      members: ["2", "4"],
      member_role: { "2": "1" },
      member_alerts: { "4": "1" },
      qsort: { "1": "3" },
    });
    expect(selectedIds({ ids: ["3", "x", "0", "7"] })).toEqual([3, 7]);
  });
});

describe("semantica PHP", () => {
  it("truthiness, is_numeric, (int)", () => {
    expect([truthy("0"), truthy(""), truthy("a"), truthy([]), truthy(["0"])]).toEqual([false, false, true, false, true]);
    expect([isNumeric(" 12"), isNumeric("1e3"), isNumeric("12a"), isNumeric("")]).toEqual([true, true, false, false]);
    expect([intval("12abc"), intval("abc"), intval("-3.9")]).toEqual([12, 0, -3]);
  });

  it("Format::htmlchars senza doppia codifica e Validator::is_username", () => {
    expect(htmlchars(`a & b <c> "d" 'e' &amp; &#39;`)).toBe(`a &amp; b &lt;c&gt; &quot;d&quot; 'e' &amp; &#39;`);
    expect([usernameError("a"), usernameError("123"), usernameError("m.rossi"), usernameError("m rossi")]).toEqual(["too_short", "invalid_chars", "", "invalid_chars"]);
  });

  it("RolePermission: chiavi esistenti conservate, nuove in coda, vuoto = []", () => {
    expect(rebuildPermissions('{"x.custom":1,"ticket.edit":1}', ["ticket.close", "ticket.edit"])).toBe('{"x.custom":1,"ticket.edit":1,"ticket.close":1}');
    expect(rebuildPermissions(null, [])).toBe("[]");
  });
});

describe("default e testi dell'area admin", () => {
  it("OsticketConfig::$defaults: stesse chiavi del PHP, le opzioni email assenti dal DB sono attive", () => {
    const php = readFileSync(fileURLToPath(new URL("../../../../legacy/include/class.config.php", import.meta.url)), "utf8");
    const block = /class OsticketConfig[\s\S]*?var \$defaults = array\(([\s\S]*?)\);/.exec(php)?.[1] ?? "";
    const keys = [...block.matchAll(/'([a-z_]+)'\s*=>/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(20);
    expect(Object.keys(CORE_DEFAULTS).sort()).toEqual([...keys].sort());
    const cfg = new ConfigNamespace("core", new Map(), CORE_DEFAULTS);
    expect(["accept_unregistered_email", "add_email_collabs", "verify_email_addrs"].map((k) => cfg.bool(k))).toEqual([true, true, true]);
  });

  it("ogni permesso ha l'etichetta tradotta in it e en (chiave con _ al posto del punto)", () => {
    for (const p of ALL_PERMISSIONS) {
      const k = p.key.replace(/\./g, "_") as keyof typeof it_.admRoles.permLabels;
      expect(it_.admRoles.permLabels[k], p.key).toBeTruthy();
      expect(en.admRoles.permLabels[k], p.key).toBe(`${p.title} — ${p.desc}`);
    }
  });
});

describe("voci degli orari (ScheduleEntry)", () => {
  const base = {
    day: null,
    week: null,
    month: null,
    starts_on: "2019-01-01",
    starts_at: "08:00:00",
    ends_at: "17:00:00",
  };
  it("getDesc: giorno della voce settimanale, settimana/mese di mensili e annuali", () => {
    expect(describeEntry({ ...base, repeats: "weekly", day: 1 })).toEqual({
      key: "weekly",
      day: 1,
    });
    expect(describeEntry({ ...base, repeats: "weekdays" })).toEqual({
      key: "weekdays",
    });
    expect(describeEntry({ ...base, repeats: "monthly", day: 15 })).toEqual({
      key: "monthlyDay",
      day: 15,
    });
    expect(describeEntry({ ...base, repeats: "monthly", week: -1, day: 5 })).toEqual({ key: "monthlyWeek", week: -1, day: 5 });
    expect(describeEntry({ ...base, repeats: "yearly", day: 25, month: 12 })).toEqual({ key: "yearlyDate", day: 25, month: 12 });
    expect(
      describeEntry({
        ...base,
        repeats: "never",
        starts_on: "2019-01-01 00:00:00",
      }),
    ).toEqual({ key: "never", date: "2019-01-01" });
    expect([isFullDayEntry(base), isFullDayEntry({ starts_at: "00:00:00", ends_at: "23:59:59" })]).toEqual([false, true]);
  });

  it("ordine mostrato: `$entry->sort ?: ++$sort`", () => {
    expect(displaySortOrder([0, 0, 0])).toEqual([1, 2, 3]);
    expect(displaySortOrder([5, 0, 2, 0])).toEqual([5, 1, 2, 2]);
  });
});
