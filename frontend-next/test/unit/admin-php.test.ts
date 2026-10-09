import { describe, expect, it } from "vitest";

import { parsePhpForm, selectedIds } from "@/server/domain/admin/form-data";
import { formatHtmlchars, intval, isNumeric, truthy, usernameError } from "@/server/domain/admin/php";
import { rebuildPermissions } from "@/server/domain/admin/role";

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
    expect(formatHtmlchars(`a & b <c> "d" 'e' &amp; &#39;`)).toBe(`a &amp; b &lt;c&gt; &quot;d&quot; 'e' &amp; &#39;`);
    expect([usernameError("a"), usernameError("123"), usernameError("m.rossi"), usernameError("m rossi")]).toEqual(["too_short", "invalid_chars", "", "invalid_chars"]);
  });

  it("RolePermission: chiavi esistenti conservate, nuove in coda, vuoto = []", () => {
    expect(rebuildPermissions('{"x.custom":1,"ticket.edit":1}', ["ticket.close", "ticket.edit"])).toBe('{"x.custom":1,"ticket.edit":1,"ticket.close":1}');
    expect(rebuildPermissions(null, [])).toBe("[]");
  });
});
