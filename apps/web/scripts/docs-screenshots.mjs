#!/usr/bin/env node
// Screenshot della documentazione: rigenera i 18 file di docs/assets/screenshots (usati da docs/index.html e README.md)
// con l'interfaccia attuale e i dati demo di dev/seed.php. Desktop 1440×900, mobile 390×844, tema chiaro, solo viewport.
//
// Uso (da apps/web):
//   scripts/docs-demo.sh up            stack demo isolato (progetto tailticket-demo, http://localhost:28080), build col codice attuale
//   npm run docs:screenshots           tutti gli screenshot
//   npm run docs:screenshots -- agent-ticket portal-home     solo alcuni (nome del file senza .png)
// Variabili:
//   DOCS_URL              indirizzo della demo (default http://localhost:28080)
//   DOCS_ENV              .env dello stack demo (default ../tailticket-collaudo/demo/deploy/.env accanto al repo): da qui si leggono
//                         TAILTICKET_ADMIN_USER e TAILTICKET_ADMIN_PASSWORD, mai stampati
//   DOCS_ADMIN_USER, DOCS_ADMIN_PASSWORD     credenziali dell'admin (scavalcano DOCS_ENV)
//   DOCS_CLIENT_EMAIL     cliente del portale (default f.romano@ospedale.example, account creato da docs-demo.sh)
//   DOCS_CLIENT_PASSWORD  password del cliente (default: la password di sviluppo di dev/seed.php)
//   DOCS_TICKET           numero del ticket da mostrare (default: scelto tra i ticket aperti del cliente)
//   DOCS_OUT              cartella di uscita (default docs/assets/screenshots)
//   PW_CHROMIUM           eseguibile di Chromium (default: il Chromium di Playwright, npx playwright install chromium)
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const base = (process.env.DOCS_URL ?? "http://localhost:28080").replace(/\/+$/, "");
const out = resolve(process.env.DOCS_OUT ?? resolve(repo, "docs/assets/screenshots"));
const envFile = process.env.DOCS_ENV ?? resolve(repo, "../tailticket-collaudo/demo/deploy/.env");
const only = new Set(process.argv.slice(2).map((n) => n.replace(/\.png$/, "")));

// .env scritto da ./tailticket: KEY=valore, eventualmente tra apici singoli o doppi
function readEnv(file) {
  if (!existsSync(file)) return {};
  const env = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let v = m[2];
    if (/^'.*'$/.test(v)) v = v.slice(1, -1);
    else if (/^".*"$/.test(v)) v = v.slice(1, -1).replace(/\\([\\"$])/g, "$1");
    env[m[1]] = v;
  }
  return env;
}
const env = readEnv(envFile);
const devPassword = readFileSync(resolve(repo, "apps/web/dev/seed.php"), "utf8").match(/setPassword\('([^']+)'\)/)?.[1];
const admin = { user: process.env.DOCS_ADMIN_USER ?? env.TAILTICKET_ADMIN_USER ?? "ttadmin", password: process.env.DOCS_ADMIN_PASSWORD ?? env.TAILTICKET_ADMIN_PASSWORD };
const client = { email: process.env.DOCS_CLIENT_EMAIL ?? "f.romano@ospedale.example", password: process.env.DOCS_CLIENT_PASSWORD ?? devPassword };
if (!admin.password) throw new Error(`password dell'admin mancante: DOCS_ADMIN_PASSWORD oppure TAILTICKET_ADMIN_PASSWORD in ${envFile}`);
if (!client.password) throw new Error("password del cliente mancante: DOCS_CLIENT_PASSWORD");

const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 };
const MOBILE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true };
const want = (...names) => !only.size || names.some((n) => only.has(n));

mkdirSync(out, { recursive: true });
const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : { channel: "chromium" });
let failed = 0;

async function newPage(device) {
  const ctx = await browser.newContext({ ...device, locale: "it-IT", timezoneId: "Europe/Rome", colorScheme: "light", reducedMotion: "reduce" });
  const page = await ctx.newPage();
  page.setDefaultTimeout(60_000);
  page.on("pageerror", (e) => console.warn("  pageerror:", e.message.slice(0, 200)));
  return page;
}

// pagina caricata, font pronti, animazioni (grafici, transizioni) concluse
async function settle(page, ms = 600) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(ms);
}

async function open(page, path, ms) {
  await page.goto(base + path, { waitUntil: "load" });
  await settle(page, ms);
  if (new URL(page.url()).pathname.endsWith("/login") && !path.endsWith("/login")) throw new Error(`${path}: sessione scaduta (rimandato al login)`);
}

async function shot(page, name, path, { ms, prepare } = {}) {
  if (!want(name)) return;
  try {
    await open(page, path, ms);
    if (prepare) await prepare(page);
    await page.screenshot({ path: `${out}/${name}.png` });
    console.log("ok", name.padEnd(22), path);
  } catch (e) {
    failed++;
    console.error("ERRORE", name, e.message);
  }
}

async function agentLogin(page) {
  await open(page, "/agent/login");
  await page.fill("#username", admin.user);
  await page.fill("#password", admin.password);
  await page.click("button[type=submit]");
  await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 60_000 });
}

async function clientLogin(page) {
  await open(page, "/login");
  await page.fill("#login", client.email);
  await page.fill("#password", client.password);
  await page
    .locator("form", { has: page.locator("#login") })
    .locator("button[type=submit]")
    .click();
  await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 60_000 });
}

// la barra dell'editor della risposta, con un tratto dell'area di testo, è visibile senza scorrere?
const toolbarVisible = (page) =>
  page.evaluate(() => {
    const ed = document.querySelector("[contenteditable=true]");
    if (!ed) return false;
    const r = ed.getBoundingClientRect();
    return r.top > 0 && r.top + 60 <= window.innerHeight;
  });

// Ticket da mostrare (agente e portale): quello indicato in DOCS_TICKET, altrimenti il ticket del cliente con più messaggi
// la cui risposta (barra dell'editor) resta visibile nella prima schermata
async function pickTicket(page) {
  await open(page, `/agent/tickets?q=${encodeURIComponent(client.email)}`);
  const rows = await page.$$eval("table tbody tr", (trs) =>
    trs.map((tr) => {
      const a = [...tr.querySelectorAll("a[href*='/agent/tickets/']")].find((x) => /^\d+$/.test(x.textContent.trim())) ?? tr.querySelector("a[href*='/agent/tickets/']");
      const nums = [...tr.querySelectorAll("a, span")].map((x) => x.textContent.trim()).filter((t) => /^\d{1,2}$/.test(t));
      return { href: a?.getAttribute("href"), number: (tr.innerText.match(/\b\d{6}\b/) ?? [])[0], count: Number(nums.at(-1) ?? 1) };
    }),
  );
  const candidates = rows.filter((r) => r.href && r.number);
  if (process.env.DOCS_TICKET) {
    const t = candidates.find((r) => r.number === process.env.DOCS_TICKET);
    if (!t) throw new Error(`ticket ${process.env.DOCS_TICKET} non trovato tra quelli di ${client.email}`);
    return t;
  }
  candidates.sort((a, b) => b.count - a.count);
  for (const t of candidates) {
    await open(page, t.href);
    if (await toolbarVisible(page)) return t;
  }
  if (!candidates.length) throw new Error(`nessun ticket di ${client.email}: dati demo mancanti (scripts/docs-demo.sh up)`);
  return candidates[0];
}

// --- Accesso (anonimo) ------------------------------------------------------------------------------
{
  const page = await newPage(DESKTOP);
  await shot(page, "login", "/agent/login");
  await shot(page, "portal-home", "/");
  await page.context().close();
}
{
  const page = await newPage(MOBILE);
  await shot(page, "login-mobile", "/agent/login");
  await page.context().close();
}

// --- Pannello agenti e amministrazione (admin) ----------------------------------------------------------
let ticket;
if (
  want(
    "agent-dashboard",
    "agent-tickets",
    "agent-ticket",
    "agent-new-ticket",
    "admin-dashboard",
    "admin-settings",
    "admin-theme",
    "agent-tickets-mobile",
    "agent-ticket-mobile",
    "portal-ticket",
    "portal-ticket-mobile",
  )
) {
  const page = await newPage(DESKTOP);
  await agentLogin(page);
  ticket = await pickTicket(page);
  console.log(`ticket mostrato: #${ticket.number}`);
  await shot(page, "agent-dashboard", "/agent", { ms: 2000 });
  await shot(page, "agent-tickets", "/agent/tickets");
  await shot(page, "agent-ticket", ticket.href);
  await shot(page, "agent-new-ticket", "/agent/tickets/new");
  await shot(page, "admin-dashboard", "/admin");
  await shot(page, "admin-settings", "/admin/settings/tickets");
  await shot(page, "admin-theme", "/admin/theme");

  // stessa sessione su un contesto mobile: i cookie di accesso passano dal contesto desktop
  const mobile = await newPage(MOBILE);
  await mobile.context().addCookies(await page.context().cookies());
  await shot(mobile, "agent-tickets-mobile", "/agent/tickets");
  await shot(mobile, "agent-ticket-mobile", ticket.href);
  await mobile.context().close();
  await page.context().close();
}

// --- Portale clienti (cliente con account) ------------------------------------------------------------------
if (want("portal-open", "portal-tickets", "portal-ticket", "portal-home-mobile", "portal-open-mobile", "portal-ticket-mobile")) {
  const page = await newPage(DESKTOP);
  await clientLogin(page);
  await open(page, "/tickets");
  const href =
    ticket &&
    (await page
      .locator("table a", { hasText: ticket.number })
      .first()
      .getAttribute("href")
      .catch(() => null));
  if (ticket && !href) console.warn(`  #${ticket.number} non è nella lista del portale: portal-ticket usa il primo ticket`);
  const portalTicket = href ?? (await page.locator("table tbody a").first().getAttribute("href"));
  await shot(page, "portal-open", "/open");
  await shot(page, "portal-tickets", "/tickets");
  await shot(page, "portal-ticket", portalTicket);

  const mobile = await newPage(MOBILE);
  await mobile.context().addCookies(await page.context().cookies());
  await shot(mobile, "portal-home-mobile", "/");
  await shot(mobile, "portal-open-mobile", "/open");
  await shot(mobile, "portal-ticket-mobile", portalTicket);
  await mobile.context().close();
  await page.context().close();
}

await browser.close();
if (failed) {
  console.error(`${failed} screenshot non riusciti`);
  process.exit(1);
}
