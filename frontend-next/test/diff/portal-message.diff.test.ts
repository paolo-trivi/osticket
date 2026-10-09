import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadConfigNamespace } from "@/server/config/config";
import { closeDb, db } from "@/server/db";
import { loadClientIdentity, type GuestAccess } from "@/server/domain/client/identity";
import { editClientTicket, postClientMessage } from "@/server/domain/client/reply";
import { uploadFile, uploadRules } from "@/server/domain/file/upload";

import { compareWorkingDatabases, execBoth, prepareSnapshot, resetWorkingDatabases, runPhp } from "./lib/harness";
import { mailsOf as rawMailsOf } from "./lib/mailpit";

/**
 * Portale clienti: messaggi (tickets.php a=reply → Ticket::postMessage) e modifica dei campi del
 * ticket da parte del proprietario (tickets.php a=edit). PHP: test/diff/php/ops/portal.php.
 */
const IP = "127.0.0.1";

beforeAll(prepareSnapshot);
beforeEach(resetWorkingDatabases);
afterAll(closeDb);

/** Token dei link `view.php?auth=` (hash della data di creazione: identico) e firme Message-ID */
async function mailsOf(run: () => Promise<unknown>, expected: number) {
  return rawMailsOf(run, expected);
}

const cfgSql = (key: string, value: string | number) =>
  `INSERT INTO {p}config (namespace, \`key\`, value, updated) VALUES ('core','${key}','${value}',NOW()) ON DUPLICATE KEY UPDATE value='${value}'`;
const collabSql = (ticketId: number, userId: number, flags = 3, id?: number) =>
  `INSERT INTO {p}thread_collaborator (${id ? "id, " : ""}flags, thread_id, user_id, role, created, updated) SELECT ${id ? `${id}, ` : ""}${flags}, id, ${userId}, 'M', NOW(), NOW() FROM {p}thread WHERE object_type='T' AND object_id=${ticketId}`;

async function tsMessage(client: number, ticket: number, message: string, opts: { guest?: GuestAccess; files?: { id: number; name: string }[] } = {}) {
  const cfg = await loadConfigNamespace("core");
  const c = await loadClientIdentity(client, opts.guest ?? null);
  return postClientMessage(cfg, c!, ticket, { message, files: opts.files, ip: IP });
}
const phpMessage = (client: number, ticket: number, message: string, extra: Record<string, unknown> = {}) =>
  runPhp<{ ok: boolean; id: number; error?: string }>({ op: "portal.message", args: { client, ticket, message, ...extra }, ip: IP });

describe("messaggio dal portale (Ticket::postMessage 'Web')", () => {
  it("proprietario su ticket aperto: voce M, lastmessage, isanswered, avvisi agli agenti", async () => {
    await execBoth("INSERT INTO {p}draft (staff_id, namespace, body, created) VALUES (0, 'ticket.client.12', 'bozza', NOW())");
    const msg = "<p>Il problema si ripresenta anche oggi.</p>";
    let php: unknown;
    const phpMails = await mailsOf(async () => (php = await phpMessage(3, 12, msg)), 1);
    let ts: unknown;
    const tsMails = await mailsOf(async () => (ts = await tsMessage(3, 12, msg)), 1);
    expect(php).toMatchObject({ ok: true });
    expect(ts).toMatchObject({ ticketId: 12 });
    expect(await compareWorkingDatabases()).toEqual([]);
    expect(tsMails).toEqual(phpMails);
  });

  it("auto-risposta message.autoresp e avvisi a responsabile del reparto", async () => {
    await execBoth(cfgSql("message_autoresponder", 1), cfgSql("message_alert_dept_manager", 1), "UPDATE {p}department SET manager_id=4 WHERE id=1");
    const msg = "<p>Allego altri dettagli.</p><p>Grazie</p>";
    const phpMails = await mailsOf(() => phpMessage(3, 12, msg), 3);
    const tsMails = await mailsOf(() => tsMessage(3, 12, msg), 3);
    expect(await compareWorkingDatabases()).toEqual([]);
    expect(tsMails).toEqual(phpMails);
  });

  it("ticket chiuso riapribile: riapertura con evento reopened e riassegnazione", async () => {
    const msg = "<p>Il guasto non è risolto, riapro.</p>";
    const phpMails = await mailsOf(() => phpMessage(4, 2, msg), 1);
    const tsMails = await mailsOf(() => tsMessage(4, 2, msg), 1);
    expect(await compareWorkingDatabases({ ignore: ["ticket.est_duedate"] })).toEqual([]);
    expect(tsMails).toEqual(phpMails);
  });

  it("ticket chiuso con stato non riapribile: nessuna riapertura", async () => {
    await execBoth(`UPDATE {p}ticket_status SET properties='{"allowreopen":false,"description":"x"}' WHERE id=3`);
    const msg = "<p>Ancora io.</p>";
    await phpMessage(4, 2, msg);
    await tsMessage(4, 2, msg);
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("collaboratori: notifica ticket.activity.notice (proprietario autore → 'Collaborator')", async () => {
    await execBoth(collabSql(9, 6), collabSql(9, 7));
    const msg = "<p>Aggiorno anche i colleghi.</p>";
    const phpMails = await mailsOf(() => phpMessage(3, 9, msg), 1);
    const tsMails = await mailsOf(() => tsMessage(3, 9, msg), 1);
    expect(await compareWorkingDatabases()).toEqual([]);
    expect(tsMails).toEqual(phpMails);
  });

  it("messaggio di un collaboratore: destinatari, flag COLLABORATOR, notifica al proprietario", async () => {
    await execBoth(collabSql(9, 6), collabSql(9, 7), cfgSql("message_autoresponder", 1));
    const msg = "<p>Confermo, anche nel mio reparto.</p>";
    const phpMails = await mailsOf(() => phpMessage(6, 9, msg), 2);
    const tsMails = await mailsOf(() => tsMessage(6, 9, msg), 2);
    expect(await compareWorkingDatabases()).toEqual([]);
    expect(tsMails).toEqual(phpMails);
  });

  it("membro dell'organizzazione (condivisione con i contatti primari): diventa collaboratore", async () => {
    await execBoth("UPDATE {p}user SET status=1 WHERE id=7");
    const msg = "<p>Intervengo per il collega.</p>";
    const phpMails = await mailsOf(() => phpMessage(7, 24, msg), 1);
    const tsMails = await mailsOf(() => tsMessage(7, 24, msg), 1);
    expect(await compareWorkingDatabases()).toEqual([]);
    expect(tsMails).toEqual(phpMails);
  });

  it("ospite da link (TicketOwner) con allegato", async () => {
    const php = await runPhp<{ ok: boolean; id: number }>({ op: "create.upload", args: { name: "foto.png", type: "image/png", data: PNG.toString("base64") } });
    const tsUp = await uploadFile(db(), { name: "foto.png", type: "image/png", data: PNG }, uploadRules({}, await loadConfigNamespace("core")));
    expect(tsUp.ok && tsUp.file.id).toBe(php.id);
    const files = [{ id: php.id, name: "foto del guasto.png" }];
    const msg = "<p>Ecco la foto.</p>";
    const phpMails = await mailsOf(() => phpMessage(3, 9, msg, { guestTicket: 9, files }), 1);
    const tsMails = await mailsOf(() => tsMessage(3, 9, msg, { guest: { ticketId: 9, collabId: 0 }, files }), 1);
    expect(await compareWorkingDatabases({ ignore: ["file.key"] })).toEqual([]);
    expect(tsMails).toEqual(phpMails);
  });

  it("testo semplice (enable_richtext disattivato): doppia pulizia del corpo come il PHP", async () => {
    await execBoth(cfgSql("enable_richtext", 0));
    const msg = "Riga 1 & <b>due</b>\n\n\nRiga 3";
    await phpMessage(3, 12, msg);
    await tsMessage(3, 12, msg);
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("accesso negato a un ticket di altri", async () => {
    const php = await phpMessage(3, 2, "<p>x</p>");
    expect(php).toMatchObject({ ok: false, error: "access" });
    expect(await tsMessage(3, 2, "<p>x</p>")).toEqual({ error: "access" });
    expect(await compareWorkingDatabases()).toEqual([]);
  });
});

describe("modifica dei campi dal portale (tickets.php a=edit)", () => {
  it("oggetto modificato dal proprietario: risposta, cdata ed evento edited", async () => {
    const vars = { subject: "Badge non funzionante (piano 2)" };
    const php = await runPhp<{ ok: boolean; changes: number }>({ op: "portal.edit", args: { client: 3, ticket: 12, vars }, ip: IP });
    const cfg = await loadConfigNamespace("core");
    const ts = await editClientTicket(cfg, (await loadClientIdentity(3))!, 12, vars, IP);
    // getChanges include anche la priorità (non visibile ai clienti, assente dal POST → null)
    expect(php).toMatchObject({ ok: true, changes: 2 });
    expect(ts).toEqual({ ok: true, changes: 2 });
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("oggetto vuoto (obbligatorio) e utente non proprietario", async () => {
    const php = await runPhp<{ ok: boolean }>({ op: "portal.edit", args: { client: 3, ticket: 12, vars: { subject: "" } }, ip: IP });
    const cfg = await loadConfigNamespace("core");
    const ts = await editClientTicket(cfg, (await loadClientIdentity(3))!, 12, { subject: "" }, IP);
    expect(php.ok).toBe(false);
    expect(ts).toMatchObject({ error: "invalid" });
    const php2 = await runPhp<{ ok: boolean }>({ op: "portal.edit", args: { client: 4, ticket: 12, vars: { subject: "x" } }, ip: IP });
    expect(php2.ok).toBe(false);
    expect(await editClientTicket(cfg, (await loadClientIdentity(4))!, 12, { subject: "x" }, IP)).toEqual({ error: "access" });
    expect(await compareWorkingDatabases()).toEqual([]);
  });
});

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c6360000002000100e221bc330000000049454e44ae426082",
  "hex",
);
