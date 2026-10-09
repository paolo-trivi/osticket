// Unisce docs/contract/*.md (contratti di scrittura per area) nel doc 17 della knowledge base,
// tra i marcatori BEGIN/END. Uso: node scripts/merge-contracts.mjs  (oppure npm run docs:contracts)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = path.resolve(appDir, "../..");
const doc = path.join(repoDir, "docs/reverse-engineering/17-contratto-scrittura.md");
const dir = path.join(appDir, "docs/contract");
const order = ["core", "actions", "ticketedit", "create", "people", "portal", "admin", "adminsys"];
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3));
const names = [...order.filter((n) => files.includes(n)), ...files.filter((n) => !order.includes(n)).sort()];

const parts = names.map((name, i) => {
  const src = fs.readFileSync(path.join(dir, `${name}.md`), "utf8").trim().split("\n");
  const title = src[0].replace(/^#\s+/, "").replace(/^Contratto di scrittura\s+[—-]\s+/i, "");
  // le intestazioni del file scendono di due livelli (## → ####) sotto "### 3.n"
  const body = src.slice(1).map((l) => (/^#{1,4}\s/.test(l) ? "##" + l : l)).join("\n").trim();
  return `### 3.${i + 1} ${title}\n\nFonte: \`apps/web/docs/contract/${name}.md\`.\n\n${body}`;
});

const B = "<!-- BEGIN contratti per area (generato da apps/web/docs/contract/*.md) -->";
const E = "<!-- END contratti per area -->";
const block = `${B}\n## 3. Contratti per area (TailTicket)\n\nSezione generata dai file \`apps/web/docs/contract/*.md\` con \`npm run docs:contracts\`: ogni area documenta le righe scritte e le differenze volute rispetto al PHP. Ogni operazione è coperta da scenari in \`apps/web/test/diff/\`.\n\n${parts.join("\n\n")}\n${E}`;

let text = fs.readFileSync(doc, "utf8");
const start = text.indexOf("<!-- BEGIN contratti per area");
const end = text.indexOf(E);
// sostituzione per indici: i contratti contengono sequenze "$…" che String.replace interpreterebbe
text = start >= 0 && end > start ? text.slice(0, start) + block + text.slice(end + E.length) : `${text.trimEnd()}\n\n${block}\n`;
fs.writeFileSync(doc, text);
console.log(`doc 17 aggiornato: ${names.join(", ")}`);
