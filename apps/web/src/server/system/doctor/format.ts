import { isWritable, type DoctorCheck, type DoctorLevel, type DoctorReport } from "./types";

/**
 * Report del doctor come tabella di testo per il terminale (/api/doctor?format=text, stampata così com'è
 * dal CLI): solo ASCII, nessun colore, controlli in ordine di gravità, esito sull'ultima riga.
 */
const LEVEL_LABEL: Record<DoctorLevel, string> = {
  block: "BLOCCO",
  warn: "AVVISO",
  info: "INFO",
  ok: "OK",
};
const LEVEL_ORDER: readonly DoctorLevel[] = ["block", "warn", "info", "ok"];

const LEVEL_W = 8;
const TITLE_W = 34;
const DETAIL_W = 72;

/** Va a capo sulle parole entro `width` caratteri (le parole più lunghe restano intere). */
export function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (line && line.length + 1 + word.length > width) {
        out.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    out.push(line);
  }
  return out;
}

export function sortChecks(checks: readonly DoctorCheck[]): DoctorCheck[] {
  return [...checks].sort((a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level));
}

/** Ultima riga del report: l'esito che legge chi installa. */
export function verdictLine(report: Pick<DoctorReport, "summary">): string {
  return isWritable(report) ? "Scrittura consentita" : `Scrittura bloccata: ${report.summary.block} problemi`;
}

export function formatReportText(report: DoctorReport): string {
  const lines: string[] = ["TailTicket doctor - collegamento a osTicket", ""];
  const pad = (s: string, w: number) => s.padEnd(w);
  const indent = " ".repeat(LEVEL_W + TITLE_W);
  lines.push(`${pad("LIVELLO", LEVEL_W)}${pad("CONTROLLO", TITLE_W)}DETTAGLIO`);
  lines.push("-".repeat(LEVEL_W + TITLE_W + DETAIL_W));
  for (const c of sortChecks(report.checks)) {
    const titles = wrapText(c.title, TITLE_W - 2);
    const details = wrapText(c.detail, DETAIL_W);
    // il suggerimento conserva gli a capo; le istruzioni SQL (terminate da ";") restano su una riga
    // per poterle copiare. "> " ne segna l'inizio.
    const hints = c.hint
      ? c.hint
          .split("\n")
          .flatMap((l) => (l.trimEnd().endsWith(";") ? [l] : wrapText(l, DETAIL_W - 2)))
          .map((l, i) => `${i === 0 ? "> " : "  "}${l}`)
      : [];
    const rows = Math.max(titles.length, details.length);
    for (let i = 0; i < rows; i++) {
      const lvl = i === 0 ? LEVEL_LABEL[c.level] : "";
      lines.push(`${pad(lvl, LEVEL_W)}${pad(titles[i] ?? "", TITLE_W)}${details[i] ?? ""}`.trimEnd());
    }
    for (const h of hints) lines.push(`${indent}${h}`.trimEnd());
    lines.push("");
  }
  const s = report.summary;
  lines.push(`Riepilogo: ${s.ok} ok, ${s.warn} avvisi, ${s.block} blocchi`);
  lines.push(verdictLine(report));
  return `${lines.join("\n")}\n`;
}
