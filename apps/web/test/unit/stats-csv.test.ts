import { describe, expect, it } from "vitest";

import { csvCell, csvDelimiter, safeText, statsCsv, statsCsvFilename, type StatsCsvLabels } from "@/server/domain/stats/csv";
import type { TabularRow } from "@/server/domain/stats/report";

const labels: StatsCsvLabels = {
  first: "Reparto",
  opened: "Aperti",
  assigned: "Assegnati",
  overdue: "Scaduti",
  closed: "Chiusi",
  reopened: "Riaperti",
  deleted: "Eliminati",
  serviceTime: "Tempo di servizio (h)",
  responseTime: "Tempo di risposta (h)",
};

const row = (label: string, extra: Partial<TabularRow> = {}): TabularRow => ({
  key: 1,
  label,
  opened: 3,
  assigned: 2,
  overdue: 0,
  closed: 1,
  reopened: 0,
  deleted: 0,
  serviceTime: 12.25,
  responseTime: null,
  ...extra,
});

describe("CSV della dashboard", () => {
  it("usa ';' con le lingue a virgola decimale e ',' con le altre", () => {
    expect(csvDelimiter("it")).toBe(";");
    expect(csvDelimiter("en")).toBe(",");
  });

  it("BOM UTF-8, CRLF, decimali nella lingua e cella vuota senza campioni", () => {
    const it_ = statsCsv([row("Supporto")], labels, "it");
    expect(it_.startsWith("﻿")).toBe(true);
    const lines = it_.slice(1).split("\r\n");
    expect(lines[0]).toBe("Reparto;Aperti;Assegnati;Scaduti;Chiusi;Riaperti;Eliminati;Tempo di servizio (h);Tempo di risposta (h)");
    expect(lines[1]).toBe("Supporto;3;2;0;1;0;0;12,3;");
    expect(lines[2]).toBe("");
    const en = statsCsv([row("Support", { serviceTime: 1234.5 })], { ...labels, first: "Department" }, "en");
    expect(en.slice(1).split("\r\n")[1]).toBe("Support,3,2,0,1,0,0,1234.5,");
  });

  it("mette tra virgolette separatore, virgolette, a capo e spazi ai bordi", () => {
    expect(csvCell('Rossi; "Mario"', ";")).toBe('"Rossi; ""Mario"""');
    expect(csvCell("a,b", ",")).toBe('"a,b"');
    expect(csvCell("a,b", ";")).toBe("a,b");
    expect(csvCell("riga\nnuova", ",")).toBe('"riga\nnuova"');
    expect(csvCell(" spazio", ",")).toBe('" spazio"');
    expect(csvCell("normale", ",")).toBe("normale");
  });

  it("neutralizza le formule (= + - @ tab CR) con un apice iniziale", () => {
    for (const v of ["=1+1", "+39 333", "-2", "@SUM(A1)", "\tcmd", "\rcmd"]) expect(safeText(v)).toBe(`'${v}`);
    expect(safeText("Mario Rossi")).toBe("Mario Rossi");
    expect(safeText("a=b")).toBe("a=b");
    const csv = statsCsv([row('=HYPERLINK("http://x";"y")'), row("@Vendite"), row("-Interni")], labels, "it");
    const lines = csv.slice(1).split("\r\n");
    expect(lines[1].startsWith(`"'=HYPERLINK(""http://x"";""y"")";`)).toBe(true);
    expect(lines[2].startsWith("'@Vendite;")).toBe(true);
    expect(lines[3].startsWith("'-Interni;")).toBe(true);
  });

  it("nome del file con scheda e periodo", () => {
    expect(statsCsvFilename("dept", "2026-09-09", "2026-10-09")).toBe("stats-dept-20260909-20261009.csv");
  });
});
