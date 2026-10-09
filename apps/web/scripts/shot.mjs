#!/usr/bin/env node
// Screenshot di sviluppo: login come agente e cattura di una o più pagine della app.
// Uso: node scripts/shot.mjs <utente> <url> <file.png> [<url> <file.png> ...]
// Variabili: APP_URL (default http://127.0.0.1:3000), PW_CHROMIUM (eseguibile Chromium), SHOT_PASSWORD.
import { chromium } from "@playwright/test";

const base = process.env.APP_URL ?? "http://127.0.0.1:3000";
const [user, ...pairs] = process.argv.slice(2);
const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
});
const ctx = await browser.newContext({ locale: "it-IT", viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message.slice(0, 300)));
await page.goto(`${base}/agent/login`, { waitUntil: "load", timeout: 120_000 });
await page.waitForTimeout(1500);
await page.fill("#username", user);
await page.fill("#password", process.env.SHOT_PASSWORD ?? "Passw0rd!dev");
await page.click("button[type=submit]");
await page.waitForURL(/\/agent(\?|$|\/)/, { timeout: 120_000 });
for (let i = 0; i < pairs.length; i += 2) {
  await page.goto(base + pairs[i], { waitUntil: "load", timeout: 120_000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: pairs[i + 1], fullPage: true });
  console.log("ok", pairs[i], await page.title());
}
await browser.close();
