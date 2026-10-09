import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, db } from "@/server/db";
import type { PhpVars } from "@/server/php/values";
import { updateSettings } from "@/server/domain/admin/settings";

import { compareWorkingDatabases, prepareSnapshot, resetWorkingDatabases, runPhp } from "./lib/harness";

/**
 * Impostazioni (scp/settings.php → OsticketConfig::updateSettings): stesse righe `config` (insert
 * delle chiavi mancanti, update solo dei valori cambiati con updated=NOW) per ogni pagina.
 */
const IP = "127.0.0.1";

beforeAll(prepareSnapshot);
beforeEach(resetWorkingDatabases);
afterAll(closeDb);

async function both(vars: PhpVars, ip = IP): Promise<{ php: { ok: boolean; errors: Record<string, string> }; ts: { ok: boolean; errors: Record<string, string> } }> {
  const php = await runPhp<{ ok: boolean; errors: Record<string, string> }>({ op: "admin.settings", args: { agent: 1, vars }, ip });
  const ts = await db()
    .transaction()
    .execute((tx) => updateSettings(tx, vars, { ip }));
  return { php, ts };
}

const SYSTEM: PhpVars = {
  t: "system",
  isonline: "1",
  helpdesk_url: "http://localhost:8080/",
  helpdesk_title: "Helpdesk DEV",
  default_dept_id: "1",
  force_https: "",
  max_page_size: "25",
  log_level: "2",
  log_graceperiod: "12",
  time_format: "hh:mm a",
  date_format: "MM/dd/y",
  datetime_format: "MM/dd/y h:mm a",
  daydatetime_format: "EEE, MMM d y h:mm a",
  date_formats: "",
  default_timezone: "Europe/Rome",
  schedule_id: "1",
  default_locale: "",
  system_language: "en_US",
  add_secondary_language: "",
  max_file_size: "1048576",
  autolock_minutes: "3",
  enable_avatars: "on",
  enable_richtext: "on",
  allow_iframes: "",
  embedded_domain_whitelist: "youtube.com, dailymotion.com, vimeo.com, player.vimeo.com, web.microsoftstream.com",
  acl: "",
  acl_backend: "0",
  default_storage_bk: "D",
};

const TICKETS: PhpVars = {
  t: "tickets",
  ticket_number_format: "######",
  ticket_sequence_id: "0",
  queue_bucket_counts: "on",
  default_priority_id: "2",
  default_help_topic: "0",
  default_ticket_status_id: "1",
  default_sla_id: "1",
  max_open_tickets: "0",
  auto_claim_tickets: "on",
  auto_refer_closed: "on",
  collaborator_ticket_visibility: "on",
  show_related_tickets: "on",
  ticket_lock: "2",
  default_ticket_queue: "1",
  ticket_autoresponder: "on",
  ticket_notice_active: "on",
  ticket_alert_active: "1",
  ticket_alert_admin: "on",
  ticket_alert_dept_manager: "on",
  message_alert_active: "1",
  message_alert_laststaff: "on",
  message_alert_assigned: "on",
  note_alert_active: "0",
  transfer_alert_active: "0",
  overdue_alert_active: "1",
  overdue_alert_assigned: "on",
  assigned_alert_active: "1",
  assigned_alert_staff: "on",
  send_sys_errors: "on",
  send_sql_errors: "on",
  send_login_errors: "on",
  qsort: { "1": "2", "5": "1", "8": "4" },
};

const TASKS: PhpVars = {
  t: "tasks",
  task_number_format: "T-####",
  task_sequence_id: "2",
  default_task_priority_id: "2",
  task_alert_active: "1",
  task_alert_admin: "on",
  task_activity_alert_active: "0",
  task_assignment_alert_active: "1",
  task_assignment_alert_staff: "on",
  task_transfer_alert_active: "0",
  task_overdue_alert_active: "1",
  task_overdue_alert_assigned: "on",
};

const AGENTS: PhpVars = {
  t: "agents",
  agent_passwd_policy: "",
  staff_max_logins: "4",
  staff_login_timeout: "2",
  staff_session_timeout: "30",
  allow_pw_reset: "on",
  pw_reset_window: "30",
  agent_name_format: "full",
  agent_avatar: "gravatar.mm",
};

const USERS: PhpVars = {
  t: "users",
  client_passwd_policy: "",
  client_max_logins: "4",
  client_login_timeout: "2",
  client_session_timeout: "30",
  client_registration: "public",
  client_verify_email: "on",
  allow_auth_tokens: "on",
  client_name_format: "original",
  client_avatar: "gravatar.mm",
};

const PAGES: PhpVars = {
  t: "pages",
  landing_page_id: "1",
  offline_page_id: "3",
  "thank-you_page_id": "2",
  name: "Ospedale Responsabile",
  website: "https://ospedale.example",
  phone: "0874 409470",
  address: "Via Roma 1\nCampobasso",
  "selected-logo": "0",
  "selected-logo-scp": "0",
  "selected-backdrop": "0",
};

describe("impostazioni: PHP vs TypeScript", () => {
  it("sistema: modifica, chiavi mancanti inserite e secondo salvataggio senza modifiche", async () => {
    const vars = { ...SYSTEM, helpdesk_title: "Helpdesk <b>Next</b> & co", force_https: "on", files_req_auth: "on", enable_richtext: undefined, log_level: "3" };
    const r = await both(vars);
    expect(r.php).toEqual({ ok: true, errors: [] as never });
    expect(r.ts).toEqual({ ok: true, errors: {} });
    const again = await both(vars);
    expect(again.ts.ok).toBe(again.php.ok);
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("sistema: errori di validazione (titolo mancante, ACL che esclude l'admin, backend sconosciuto)", async () => {
    const bad = { ...SYSTEM, helpdesk_title: "", acl: "10.0.0.1, 10.0.0.2", acl_backend: "1", default_storage_bk: "X" };
    const r = await both(bad);
    expect(r.php.ok).toBe(false);
    expect(r.ts.ok).toBe(false);
    expect(Object.keys(r.ts.errors).sort()).toEqual(Object.keys(r.php.errors).sort());
    const noIp = await both({ ...SYSTEM, acl: "", acl_backend: "3" });
    expect(Object.keys(noIp.ts.errors)).toEqual(Object.keys(noIp.php.errors));
    // ACL valida che include l'IP corrente
    const okAcl = await both({ ...SYSTEM, acl: "127.0.0.1, 10.1.1.1", acl_backend: "1" });
    expect(okAcl.ts.ok).toBe(true);
    expect(okAcl.php.ok).toBe(true);
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("ticket: opzioni, autorisposte, avvisi e ordinamento delle code", async () => {
    const r = await both(TICKETS);
    expect(r.php.ok).toBe(true);
    expect(r.ts.ok).toBe(true);
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("ticket: errori (formato numero, destinatari avvisi) e validazione tardiva che salva comunque autorisposte e avvisi", async () => {
    const r1 = await both({ ...TICKETS, ticket_number_format: "AB", note_alert_active: "1" });
    expect(r1.ts.ok).toBe(false);
    expect(Object.keys(r1.ts.errors).sort()).toEqual(Object.keys(r1.php.errors).sort());
    const r2 = await both({ ...TICKETS, max_open_tickets: "tanti", message_autoresponder: "on", ticket_alert_dept_members: "on" });
    expect(r2.ts.ok).toBe(false);
    expect(Object.keys(r2.ts.errors).sort()).toEqual(Object.keys(r2.php.errors).sort());
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("task: impostazioni e destinatari mancanti", async () => {
    const r = await both(TASKS);
    expect(r.ts.ok).toBe(true);
    expect(r.php.ok).toBe(true);
    const bad = await both({ ...TASKS, task_number_format: "", task_activity_alert_active: "1" });
    expect(Object.keys(bad.ts.errors).sort()).toEqual(Object.keys(bad.php.errors).sort());
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("agenti e utenti: impostazioni, avatar non valido, finestra di reset non valida", async () => {
    expect((await both({ ...AGENTS, staff_ip_binding: "on", hide_staff_name: "on", require_agent_2fa: "on" })).ts.ok).toBe(true);
    const bad = await both({ ...AGENTS, agent_avatar: "robot.x", pw_reset_window: "0" });
    expect(Object.keys(bad.ts.errors).sort()).toEqual(Object.keys(bad.php.errors).sort());
    expect((await both({ ...USERS, clients_only: "on", client_registration: "closed" })).ts.ok).toBe(true);
    const badU = await both({ ...USERS, client_session_timeout: "", client_avatar: "" });
    expect(Object.keys(badU.ts.errors).sort()).toEqual(Object.keys(badU.php.errors).sort());
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("knowledge base", async () => {
    expect((await both({ t: "kb", enable_kb: "on", restrict_kb: "on" })).ts.ok).toBe(true);
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("azienda (pages): form azienda, pagine e loghi selezionati; nome mancante", async () => {
    const r = await both(PAGES);
    expect(r.php.ok).toBe(true);
    expect(r.ts.ok).toBe(true);
    const bad = await both({ ...PAGES, name: "", landing_page_id: "" });
    expect(bad.php.ok).toBe(false);
    expect(bad.ts.ok).toBe(false);
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("azienda (pages): risalvataggio senza loghi, false == '' non riscrive le chiavi (confronto debole)", async () => {
    expect((await both(PAGES)).ts.ok).toBe(true);
    const again = await both(PAGES);
    expect(again.php.ok).toBe(true);
    expect(again.ts.ok).toBe(true);
    expect(await compareWorkingDatabases()).toEqual([]);
  });
});
