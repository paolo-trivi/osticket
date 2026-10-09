/**
 * Esportazione CSV di una scheda della dashboard (pulsante "Export" di scp/dashboard.php):
 * BOM UTF-8, separatore ";" se la lingua usa la virgola come separatore decimale (altrimenti ","),
 * ore con una cifra decimale nel formato della lingua, cella vuota se non ci sono campioni.
 * In più rispetto a osTicket: le celle di testo che iniziano con = + - @ tab o CR sono prefissate
 * con un apice, così il foglio di calcolo non le valuta come formule (CSV/formula injection).
 * Modulo puro (testato in test/unit/stats-csv.test.ts).
 */
import type { TabularRow } from "./report";

export interface StatsCsvLabels {
  /** intestazione della prima colonna (Reparto / Argomento / Agente) */
  first: string;
  opened: string;
  assigned: string;
  overdue: string;
  closed: string;
  reopened: string;
  deleted: string;
  serviceTime: string;
  responseTime: string;
}

/** Come scp/dashboard.php: ";" quando il separatore decimale della lingua è la virgola. */
export function csvDelimiter(locale: string): "," | ";" {
  const sep = new Intl.NumberFormat(locale).formatToParts(1.5).find((p) => p.type === "decimal")?.value;
  return sep === "," ? ";" : ",";
}

/** Neutralizza le formule: un apice iniziale fa trattare la cella come testo. */
export function safeText(v: string): string {
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

/** Virgolette (raddoppiate all'interno) se il campo contiene separatore, virgolette, a capo o spazi ai bordi. */
export function csvCell(v: string, delimiter: string): string {
  return v.includes(delimiter) || /["\r\n]/.test(v) || /^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function statsCsv(rows: readonly TabularRow[], labels: StatsCsvLabels, locale: string): string {
  const delimiter = csvDelimiter(locale);
  const hours = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false });
  const fmt = (h: number | null) => (h === null ? "" : hours.format(h));
  const lines: string[][] = [
    [
      labels.first,
      labels.opened,
      labels.assigned,
      labels.overdue,
      labels.closed,
      labels.reopened,
      labels.deleted,
      labels.serviceTime,
      labels.responseTime,
    ].map(safeText),
    ...rows.map((r) => [
      safeText(r.label ?? ""),
      String(r.opened),
      String(r.assigned),
      String(r.overdue),
      String(r.closed),
      String(r.reopened),
      String(r.deleted),
      fmt(r.serviceTime),
      fmt(r.responseTime),
    ]),
  ];
  return "﻿" + lines.map((l) => l.map((v) => csvCell(v, delimiter)).join(delimiter)).join("\r\n") + "\r\n";
}

/** Nome del file: stats-<scheda>-<primo giorno>-<ultimo giorno>.csv (giorni nel fuso dell'agente). */
export function statsCsvFilename(group: string, startDay: string, lastDay: string): string {
  const ymd = (d: string) => d.replace(/[^0-9]/g, "");
  return `stats-${group}-${ymd(startDay)}-${ymd(lastDay)}.csv`;
}
