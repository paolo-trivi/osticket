import "server-only";

import { sql } from "kysely";

import { hashPassword } from "../../auth/passwd";
import type { ConfigNamespace } from "../../config/config";
import { loadConfigNamespace } from "../../config/config";
import { NOW, table, type DbOrTx } from "../../db";
import { stripTags } from "../../format/html";
import { phpJsonDecode, phpJsonEncode } from "../../format/php-json";
import { sanitizeText } from "../../format/text";
import { randCode } from "../../mail/message-id";
import { loadStaffInfo, staffVar } from "../../mail/objects";
import { logSystem } from "../../system/syslog";
import { MISC_RAND_CHARS, checkPasswordPolicy, type PasswordError } from "../directory/accounts";
import { alertOrDefaultEmail, baseUrl, loadContentPage, sendContentMail } from "../directory/content-mail";
import { formatPhone, isValidEmail } from "../directory/forms";
import { isPhone } from "../staff/profile";
import { exists, idOf, type MassResult, type SaveResult } from "./common";
import { ACCESS_ALERTS, DeptFlag } from "./dept";
import { FILTER_REFS, filterActionsReferencing } from "./filters";
import { OrmRow, SQL_NOW, setFlag } from "./orm";
import { at, isset, list, phpLooseEquals, str, truthy, usernameError, type PhpVal, type PhpVars } from "./php";
import { ALL_PERMISSIONS, rebuildPermissions } from "./role";
import { MEMBER_ALERTS } from "./team";

/**
 * Agenti: scp/staff.php → Staff::update / Staff::create / Staff::delete / mass_process
 * (include/class.staff.php) e ajax.staff.php:setPassword (reset password via email o password
 * impostata dall'amministratore).
 *
 * Stranezze del PHP replicate:
 * - il form di modifica non ha il campo "isvisible": ogni salvataggio dall'admin imposta isvisible = 0;
 * - il controllo "unico amministratore attivo" confronta con l'id trovato dall'ultima ricerca per
 *   username/email ($uid), non con l'agente modificato.
 * Differenze: una password che non rispetta la politica genera un'eccezione non gestita nel PHP;
 * qui è un errore di validazione (nessuna scrittura).
 */
const STAFF_OPTS = { touchUpdated: true };

export interface StaffSaveOptions {
  /** id dell'amministratore che opera (thisstaff) */
  actorId: number;
  ip: string;
}

export interface StaffSaveResult extends SaveResult {
  /** invio dell'email di benvenuto/reset da eseguire dopo il commit */
  send?: () => Promise<void>;
}

/** Staff::lookup($id) come riga con dirty tracking. */
async function loadStaffRow(executor: DbOrTx, staffId: number): Promise<OrmRow | null> {
  return OrmRow.load(executor, "staff", "staff_id", { staff_id: staffId }, STAFF_OPTS);
}

/** Staff::updatePerms($vars): '' se nessun permesso, altrimenti JSON di RolePermission. */
function staffPermissions(row: OrmRow, perms: PhpVal): string {
  if (!truthy(perms)) return "";
  return rebuildPermissions(row.get("permissions") as string | null, perms);
}

/** Staff::setExtraAttr($attr, $value): JSON di `extra` con la chiave aggiornata (ordine conservato). */
function setExtraAttr(row: OrmRow, attr: string, value: unknown): void {
  const cur = phpJsonDecode<Record<string, unknown> | null>((row.get("extra") as string | null) ?? "", null);
  const extra: Record<string, unknown> = cur && typeof cur === "object" && !Array.isArray(cur) ? { ...cur } : {};
  extra[attr] = value;
  row.set("extra", phpJsonEncode(extra));
}

/** Staff::setPassword($new, null) con osTicketStaffAuthentication: hash, change_passwd 0, token annullati. */
async function setPassword(executor: DbOrTx, row: OrmRow, passwd: string): Promise<void> {
  row.set("passwd", hashPassword(passwd));
  row.set("change_passwd", 0);
  // cancelResetTokens(): eseguito subito (anche prima del salvataggio dell'agente)
  if (row.get("staff_id")) await executor.deleteFrom("config").where("namespace", "=", "pwreset").where("value", "=", str(row.get("staff_id") as PhpVal)).execute();
  row.set("passwdreset", SQL_NOW);
}

/**
 * Staff::setDepartmentId($dept_id, $eavesdrop): nuovo reparto primario, eventuale accesso esteso al
 * vecchio reparto (eavesdrop, avvisi attivi), rimozione dell'accesso esteso al nuovo reparto.
 */
async function setDepartmentId(executor: DbOrTx, row: OrmRow, deptId: PhpVal, eavesdrop: boolean, access: OrmRow[]): Promise<OrmRow[]> {
  const staffId = row.num("staff_id");
  const old = row.get("dept_id");
  if (eavesdrop) {
    const da = OrmRow.create("staff_dept_access", ["staff_id", "dept_id"]);
    da.set("dept_id", old);
    da.set("role_id", row.get("role_id"));
    setFlag(da, ACCESS_ALERTS, true);
    da.set("staff_id", staffId);
    access.push(da);
  }
  row.set("dept_id", str(deptId));
  const idx = access.findIndex((a) => phpLooseEquals(a.get("dept_id"), deptId as never));
  if (idx >= 0) {
    const [da] = access.splice(idx, 1);
    if (!da.isNew) await da.delete(executor);
  }
  await row.save(executor);
  return access;
}

async function loadAccess(executor: DbOrTx, staffId: number): Promise<OrmRow[]> {
  const rows = await executor.selectFrom("staff_dept_access").selectAll().where("staff_id", "=", staffId).execute();
  return rows.map((r) => OrmRow.from("staff_dept_access", ["staff_id", "dept_id"], r));
}

/** Staff::update($vars, $errors) — creazione se staffId è null (Staff::create()). */
export async function saveStaff(executor: DbOrTx, staffId: number | null, input: PhpVars, opts: StaffSaveOptions): Promise<StaffSaveResult> {
  const errors: Record<string, string> = {};
  const cfg = await loadConfigNamespace("core", executor);
  let staff: OrmRow;
  if (staffId) {
    const row = await loadStaffRow(executor, staffId);
    if (!row) return { ok: false, errors: { err: "not_found" } };
    staff = row;
  } else {
    staff = OrmRow.create("staff", "staff_id", STAFF_OPTS);
    staff.set("created", SQL_NOW);
  }
  const vars: PhpVars = { ...input, username: stripTags(str(input.username)), firstname: stripTags(str(input.firstname)), lastname: stripTags(str(input.lastname)) };
  const id = staffId;

  if (id && !phpLooseEquals(id, vars.id as never)) errors.err = "internal";
  if (!truthy(vars.firstname)) errors.firstname = "required";
  if (!truthy(vars.lastname)) errors.lastname = "required";
  let uid: number | null = null;
  const uerr = truthy(vars.username) ? usernameError(str(vars.username)) : "required";
  if (uerr) errors.username = uerr;
  else {
    uid = (await executor.selectFrom("staff").select("staff_id").where("username", "=", str(vars.username)).executeTakeFirst())?.staff_id ?? 0;
    if (uid && (!id || uid !== id)) errors.username = "in_use";
  }
  const email = str(vars.email);
  if (!email || !(await isValidEmail(email, cfg.bool("verify_email_addrs")))) errors.email = "invalid";
  else if (await executor.selectFrom("email").select("email_id").where("email", "=", email).executeTakeFirst()) errors.email = "system_email";
  else {
    uid = (await executor.selectFrom("staff").select("staff_id").where("email", "=", email).executeTakeFirst())?.staff_id ?? 0;
    if (uid && (!id || uid !== id)) errors.email = "in_use";
  }
  if (truthy(vars.phone) && !isPhone(str(vars.phone))) errors.phone = "invalid";
  if (truthy(vars.mobile) && !isPhone(str(vars.mobile))) errors.mobile = "invalid";
  if (!truthy(vars.dept_id)) errors.dept_id = "required";
  if (!truthy(vars.role_id)) errors.role_id = "required";
  const deptId = idOf(vars.dept_id);
  const dept = deptId ? await executor.selectFrom("department").select("flags").where("id", "=", deptId).executeTakeFirst() : undefined;
  if (dept && !((dept.flags ?? 0) & DeptFlag.ACTIVE)) errors.dept_id = "inactive";

  // Deve restare almeno un amministratore attivo
  if (vars.isadmin !== "1" || vars.islocked === "1") {
    const { rows } = await sql<{ cnt: number; sid: number | null }>`SELECT count(*) AS cnt, max(staff_id) AS sid FROM ${table("staff")} WHERE isadmin = 1 AND isactive = 1`.execute(executor);
    const r = rows[0];
    if (r && Number(r.cnt) === 1 && phpLooseEquals(r.sid, uid)) errors.isadmin = "last_admin";
  }

  // Password: politica controllata qui (nel PHP un'eccezione non gestita)
  const setPwd = !truthy(vars.welcome_email) && truthy(vars.passwd1);
  if (setPwd) {
    const pe: PasswordError | null = checkPasswordPolicy(str(vars.passwd1), null);
    if (pe) errors.passwd1 = pe;
  }

  staff.set("permissions", staffPermissions(staff, vars.perms));
  staff.set("isadmin", isset(vars, "isadmin") ? 1 : 0);
  staff.set("isactive", isset(vars, "islocked") ? 0 : 1);
  staff.set("isvisible", isset(vars, "isvisible") ? 1 : 0);
  staff.set("onvacation", isset(vars, "onvacation") ? 1 : 0);
  staff.set("assigned_only", isset(vars, "assigned_only") ? 1 : 0);
  staff.set("role_id", vars.role_id === undefined || vars.role_id === null ? null : str(vars.role_id));
  staff.set("username", str(vars.username));
  staff.set("firstname", str(vars.firstname));
  staff.set("lastname", str(vars.lastname));
  staff.set("email", email);
  staff.set("backend", vars.backend === undefined || vars.backend === null ? null : str(vars.backend));
  staff.set("phone", formatPhone(str(vars.phone)));
  staff.set("phone_ext", vars.phone_ext === undefined || vars.phone_ext === null ? null : str(vars.phone_ext));
  staff.set("mobile", formatPhone(str(vars.mobile)));
  staff.set("notes", sanitizeText(str(vars.notes)));
  if (setPwd && !errors.passwd1) {
    await setPassword(executor, staff, str(vars.passwd1));
    staff.set("change_passwd", truthy(vars.change_passwd) ? 1 : 0);
  }
  if (Object.keys(errors).length) return { ok: false, errors };

  await staff.save(executor);
  const newId = staff.num("staff_id");
  let access = id ? await loadAccess(executor, newId) : [];
  access = await setDepartmentId(executor, staff, vars.dept_id, false, access);

  // Accessi estesi: [dept_id, role_id, alerts]
  const wanted: [PhpVal, PhpVal, PhpVal][] = [];
  if (isset(vars, "dept_access")) for (const d of list(vars.dept_access)) wanted.push([d, at(vars.dept_access_role, str(d)), at(vars.dept_access_alerts, str(d))]);
  await updateAccess(executor, staff, access, wanted, errors);

  setExtraAttr(staff, "def_assn_role", isset(vars, "assign_use_pri_role"));
  await staff.save(executor);

  const teams: [PhpVal, PhpVal][] = [];
  if (isset(vars, "teams")) for (const t of list(vars.teams)) teams.push([t, at(vars.team_alerts, str(t))]);
  await updateTeams(executor, newId, teams, errors);

  let send: (() => Promise<void>) | undefined;
  if (truthy(vars.welcome_email)) send = await sendAgentResetEmail(executor, cfg, newId, "registration-staff", { log: false, ip: opts.ip });
  return { ok: true, id: newId, errors: {}, send };
}

/** Staff::updateAccess: righe staff_dept_access salvate una per una finché non ci sono errori. */
async function updateAccess(executor: DbOrTx, staff: OrmRow, access: OrmRow[], wanted: [PhpVal, PhpVal, PhpVal][], errors: Record<string, string>): Promise<boolean> {
  const staffId = staff.num("staff_id");
  const dropped = new Set(access.map((a) => a.num("dept_id")));
  const accErrors: Record<string, string> = {};
  const hasErr = () => Object.keys(errors).length > 0 || Object.keys(accErrors).length > 0;
  for (const [deptId, roleId, alerts] of wanted) {
    dropped.delete(idOf(deptId) ?? -1);
    if (!truthy(roleId) || !(await exists(executor, "role", roleId))) accErrors[str(deptId)] = "role";
    if (!truthy(deptId) || !(await exists(executor, "department", deptId))) accErrors[str(deptId)] = "dept";
    if (phpLooseEquals(deptId as never, staff.get("dept_id"))) accErrors[str(deptId)] = "primary";
    let da = access.find((a) => phpLooseEquals(a.get("dept_id"), deptId as never));
    if (!da) {
      da = OrmRow.create("staff_dept_access", ["staff_id", "dept_id"]);
      da.set("dept_id", str(deptId));
      da.set("role_id", str(roleId));
      da.set("staff_id", staffId);
      access.push(da);
    } else {
      da.set("role_id", str(roleId));
    }
    setFlag(da, ACCESS_ALERTS, truthy(alerts));
    if (!hasErr()) await da.save(executor);
  }
  if (Object.keys(accErrors).length) errors.dept_access = JSON.stringify(accErrors);
  if (!hasErr() && dropped.size) await executor.deleteFrom("staff_dept_access").where("staff_id", "=", staffId).where("dept_id", "in", [...dropped]).execute();
  return !hasErr();
}

/** Staff::updateTeams: iscrizioni ai team (avvisi), rimozione dei team non più elencati. */
async function updateTeams(executor: DbOrTx, staffId: number, membership: [PhpVal, PhpVal][], errors: Record<string, string>): Promise<void> {
  const rows = (await executor.selectFrom("team_member").selectAll().where("staff_id", "=", staffId).execute()).map((r) => OrmRow.from("team_member", ["team_id", "staff_id"], r));
  const dropped = new Set(rows.map((r) => r.num("team_id")));
  const noErr = () => Object.keys(errors).length === 0;
  for (const [teamId, alerts] of membership) {
    let m = rows.find((r) => phpLooseEquals(r.get("team_id"), teamId as never));
    if (!m) {
      m = OrmRow.create("team_member", ["team_id", "staff_id"]);
      m.set("team_id", str(teamId));
      m.set("staff_id", staffId);
      rows.push(m);
    }
    setFlag(m, MEMBER_ALERTS, truthy(alerts));
    if (noErr()) await m.save(executor);
    dropped.delete(m.num("team_id"));
  }
  if (noErr() && dropped.size) await executor.deleteFrom("team_member").where("staff_id", "=", staffId).where("team_id", "in", [...dropped]).execute();
}

/**
 * Staff::sendResetEmail($template, $log): pagina di contenuto (registration-staff per il benvenuto,
 * pwreset-staff per il reset), token in config "pwreset", syslog "Agent Password Reset" se $log.
 * Restituisce l'invio da eseguire dopo il commit.
 */
export async function sendAgentResetEmail(
  executor: DbOrTx,
  cfg: ConfigNamespace,
  staffId: number,
  template: "registration-staff" | "pwreset-staff",
  opts: { log: boolean; ip: string },
): Promise<(() => Promise<void>) | undefined> {
  const page = await loadContentPage(executor, template);
  if (!page) return undefined;
  const token = randCode(48, MISC_RAND_CHARS);
  const info = await loadStaffInfo(executor, staffId);
  const email = await alertOrDefaultEmail(executor, cfg);
  if (!info || !email) return undefined;
  const v = staffVar(info, cfg);
  const link = `${baseUrl(cfg)}/scp/pwreset.php?token=${token}`;
  if (opts.log)
    // $_POST['userid'] non esiste nelle richieste dell'admin: Requested-User-Id vuoto
    await logSystem(
      "Warning",
      "Agent Password Reset",
      sanitizeText(`Password reset was attempted for agent: ${v.asVar(null as never)}<br><br>
                Requested-User-Id: <br>
                Source-Ip: ${opts.ip}<br>
                Email-Sent-To: ${info.email ?? ""}<br>
                Email-Sent-Via: ${email.email}`),
      opts.ip,
      { executor },
    );
  await executor.insertInto("config").values({ namespace: "pwreset", key: token, value: String(staffId), updated: NOW }).execute();
  return sendContentMail(executor, cfg, {
    email,
    page,
    vars: { token, staff: v, recipient: v, reset_link: link, link },
    to: { name: "", address: info.email ?? "" },
  });
}

/**
 * ajax.staff.php:setPassword per un agente esistente (PasswordResetForm): email di reset
 * (Staff::sendResetEmail con syslog) oppure nuova password con eventuale cambio obbligatorio.
 */
export async function setAgentPassword(
  executor: DbOrTx,
  staffId: number,
  vars: { welcome_email?: boolean; passwd1?: string; passwd2?: string; change_passwd?: boolean },
  ip: string,
): Promise<{ ok: boolean; errors: Record<string, string>; send?: () => Promise<void> }> {
  const staff = await loadStaffRow(executor, staffId);
  if (!staff) return { ok: false, errors: { err: "not_found" } };
  const errors: Record<string, string> = {};
  if (!vars.welcome_email) {
    if (!vars.passwd1) errors.passwd1 = "required";
    else {
      const pe = checkPasswordPolicy(vars.passwd1, null);
      if (pe) errors.passwd1 = pe;
    }
    if (!vars.passwd2) errors.passwd2 = "required";
    else if (!errors.passwd1 && vars.passwd1 !== vars.passwd2) errors.passwd1 = "mismatch";
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  const cfg = await loadConfigNamespace("core", executor);
  let send: (() => Promise<void>) | undefined;
  if (vars.welcome_email) {
    send = await sendAgentResetEmail(executor, cfg, staffId, "pwreset-staff", { log: true, ip });
  } else {
    await setPassword(executor, staff, vars.passwd1!);
    if (vars.change_passwd) staff.set("change_passwd", 1);
  }
  await staff.save(executor);
  return { ok: true, errors: {}, send };
}

/**
 * Staff::delete(): non se stessi; ticket non più assegnati, voci del thread con il nome dell'agente
 * come poster, iscrizioni ai team e accessi estesi eliminati. I task assegnati restano (come nel PHP).
 */
export async function deleteStaff(executor: DbOrTx, staffId: number, actorId: number): Promise<{ ok: boolean; error?: string }> {
  if (staffId === actorId) return { ok: false, error: "self" };
  const s = await executor.selectFrom("staff").select(["staff_id", "firstname", "lastname"]).where("staff_id", "=", staffId).executeTakeFirst();
  if (!s) return { ok: false };
  if (await filterActionsReferencing(executor, FILTER_REFS.staff, staffId)) return { ok: false, error: "filter" };
  await executor.deleteFrom("staff").where("staff_id", "=", staffId).execute();
  await executor.updateTable("ticket").set({ staff_id: 0 }).where("staff_id", "=", staffId).execute();
  await executor
    .updateTable("thread_entry")
    .set({ staff_id: 0, poster: `${s.firstname ?? ""} ${s.lastname ?? ""}` })
    .where("staff_id", "=", staffId)
    .execute();
  await executor.deleteFrom("team_member").where("staff_id", "=", staffId).execute();
  await executor.deleteFrom("staff_dept_access").where("staff_id", "=", staffId).execute();
  return { ok: true };
}

export type StaffMassAction = "enable" | "disable" | "delete" | "permissions" | "department";

/** scp/staff.php mass_process. `post`: perms[] per "permissions"; dept_id, role_id, eavesdrop per "department". */
export async function massStaff(executor: DbOrTx, action: StaffMassAction, ids: number[], actorId: number, post: PhpVars = {}): Promise<MassResult> {
  if (!ids.length) return { ok: false, num: 0, error: "select" };
  if ((action === "disable" || action === "delete") && ids.includes(actorId)) return { ok: false, num: 0, error: "self" };
  let num = 0;
  switch (action) {
    case "enable":
    case "disable": {
      const res = await executor.updateTable("staff").set({ isactive: action === "enable" ? 1 : 0 }).where("staff_id", "in", ids).executeTakeFirst();
      num = Number(res.numUpdatedRows);
      return { ok: num > 0, num };
    }
    case "delete": {
      const rows = await executor.selectFrom("staff").select("staff_id").where("staff_id", "in", ids).execute();
      for (const r of rows) {
        if (r.staff_id === actorId) continue;
        const d = await deleteStaff(executor, r.staff_id, actorId);
        if (d.error === "filter") return { ok: num > 0, num, error: "filter" };
        num++;
      }
      return { ok: num > 0, num };
    }
    case "permissions": {
      const rows = await executor.selectFrom("staff").selectAll().where("staff_id", "in", ids).execute();
      for (const r of rows) {
        const s = OrmRow.from("staff", "staff_id", r, STAFF_OPTS);
        // updatePerms senza permessi: permissions = '' e nessun "successo" (return senza valore)
        s.set("permissions", staffPermissions(s, post.perms));
        if (!truthy(post.perms)) continue;
        await s.save(executor);
        num++;
      }
      return { ok: num > 0, num };
    }
    case "department": {
      if (!truthy(post.dept_id) || !truthy(post.role_id) || !(await exists(executor, "department", post.dept_id)) || !(await exists(executor, "role", post.role_id)))
        return { ok: false, num: 0, error: "internal" };
      const rows = await executor.selectFrom("staff").selectAll().where("staff_id", "in", ids).execute();
      for (const r of rows) {
        const s = OrmRow.from("staff", "staff_id", r, STAFF_OPTS);
        let access = await loadAccess(executor, s.num("staff_id"));
        access = await setDepartmentId(executor, s, String(idOf(post.dept_id)), truthy(post.eavesdrop), access);
        s.set("role_id", idOf(post.role_id));
        await s.save(executor);
        for (const a of access) await a.save(executor);
        num++;
      }
      return { ok: num > 0, num };
    }
  }
}

/** Permessi "primari" (globali dell'agente) mostrati nel form agente, nell'ordine del PHP. */
export const AGENT_PERMISSIONS = ALL_PERMISSIONS.filter((p) => p.primary);

