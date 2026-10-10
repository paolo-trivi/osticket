import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Interfaccia senza emoji né caratteri usati come icone: le icone vengono tutte da Lucide (lucide-react).
 * Ammessi i simboli tipografici del testo (© nel copyright, → nei messaggi).
 */
const FORBIDDEN = /[\p{Extended_Pictographic}✕✗✓▲▼▸⇉❝⌘]/u;
const ALLOWED = new Set(["©", "®", "™"]);

function* sources(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* sources(p);
    else if (/\.(tsx?|json|css)$/.test(e.name)) yield p;
  }
}

describe("icone: un solo kit, niente emoji", () => {
  it("nessuna emoji o glifo-icona nei sorgenti dell'interfaccia", () => {
    const found: string[] = [];
    for (const file of sources(join(__dirname, "../../src"))) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          for (const ch of line) if (FORBIDDEN.test(ch) && !ALLOWED.has(ch)) found.push(`${file}:${i + 1} ${ch}`);
        });
    }
    expect(found).toEqual([]);
  });
});
