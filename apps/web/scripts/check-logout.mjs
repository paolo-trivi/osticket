#!/usr/bin/env node
// Verifica E2E della revoca della sessione al logout (collaudo RC): login come agente, copia del cookie,
// logout dal menu utente, poi il vecchio cookie non deve più valere né sulle route /api né sulle pagine.
// Da lanciare contro una build di produzione (next build + next start): in produzione route handler e
// pagine sono bundle diversi e lo stato in memoria deve essere condiviso (src/server/auth/bounded-store.ts).
// Uso: node scripts/check-logout.mjs [utente]
// Variabili: APP_URL (default http://127.0.0.1:3000), PW_CHROMIUM (eseguibile Chromium), SHOT_PASSWORD.
import { chromium } from "@playwright/test";

const base = process.env.APP_URL ?? "http://127.0.0.1:3000";
const user = process.argv[2] ?? "devadmin";
const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
});
const ctx = await browser.newContext({ locale: "it-IT", viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto(`${base}/agent/login`, { waitUntil: "load", timeout: 120_000 });
await page.waitForTimeout(1500); // idratazione del form di login
await page.fill("#username", user);
await page.fill("#password", process.env.SHOT_PASSWORD ?? "Passw0rd!dev");
await page.click("button[type=submit]");
await page.waitForURL((url) => url.pathname.startsWith("/agent") && !url.pathname.startsWith("/agent/login"), { timeout: 120_000 });

const cookie = (await ctx.cookies()).find((c) => c.name === "ostn_staff");
if (!cookie) throw new Error("cookie ostn_staff assente dopo il login");
const header = { cookie: `ostn_staff=${cookie.value}` };
const targets = ["/api/agent/tickets/export?queue=1", "/api/agent/stats/export?group=dept", "/agent/tickets/1"];

async function probe(label) {
  const out = {};
  for (const path of targets) {
    const res = await fetch(base + path, { headers: header, redirect: "manual" });
    out[path] = res.status;
  }
  console.log(label, out);
  return out;
}

const before = await probe("prima del logout:");
// logout dal menu utente (server action del pannello)
await page.click("header .dropdown-toggle");
await page.getByRole("button", { name: /^(Esci|Sign out)$/ }).click();
await page.waitForURL(/\/agent\/login/, { timeout: 60_000 });
const after = await probe("dopo il logout (vecchio cookie):");
await browser.close();

const ok =
  targets.every((p) => before[p] === 200) &&
  [targets[0], targets[1]].every((p) => after[p] === 401 || after[p] === 403) &&
  // pagina: redirect al login
  after[targets[2]] >= 300 &&
  after[targets[2]] < 400;
console.log(ok ? "OK: sessione revocata ovunque" : "ERRORE: il vecchio cookie vale ancora");
process.exit(ok ? 0 : 1);
