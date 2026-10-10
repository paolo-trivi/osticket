import "server-only";

import { sql } from "kysely";

import { Dept, StaffDeptAccess, TeamMember } from "@/lib/osticket/flags";

import { loadConfigNamespace } from "../../config/config";
import { table, type DbOrTx } from "../../db";
import { stripTags } from "../../format/html";
import { phpJsonDecode, phpJsonEncode } from "../../format/php-json";
import { sanitizeText } from "../../format/text";
import { at, isset, list, phpLooseEquals, str, truthy, type PhpVal, type PhpVars } from "../../php/values";
import { checkPasswordPolicy, type PasswordError } from "../directory/accounts";
import { formatPhone } from "../forms/fields";
import { isPhone, isValidEmail } from "../forms/validator";
import { exists, idOf, type SaveResult } from "./common";
import { OrmRow, SQL_NOW, setFlag } from "./orm";
import { ALL_PERMISSIONS } from "./role";
import { sendAgentResetEmail, setPassword } from "./staff-password";
import { loadAccess, loadStaffRow, setDepartmentId, staffPermissions, STAFF_OPTS } from "./staff-row";
import { usernameError } from "./validator";

/**
 * Agenti: scp/staff.php → Staff::update / Staff::create (include/class.staff.php). Password e reset
 * sono in staff-password.ts, eliminazione e azioni di massa in staff-mass.ts.
 *
 * Stranezze del PHP replicate:
 * - il form (staff.inc.php) non ha il campo "isvisible" e Staff::update imposta 0: in creazione per
 *   l'ORM null == 0 non è una modifica e resta il default della colonna (1), in modifica si scrive 0.
 *   Il valore non è letto da nessuna pagina (né del PHP né di Next), quindi non c'è effetto visibile;
 * - il controllo "unico amministratore attivo" confronta con l'id trovato dall'ultima ricerca per
 *   username/email ($uid), non con l'agente modificato.
 * Differenze: una password che non rispetta la politica genera un'eccezione non gestita nel PHP;
 * qui è un errore di validazione (nessuna scrittura).
 */

interface StaffSaveOptions {
  /** id dell'amministratore che opera (thisstaff) */
  actorId: number;
  ip: string;
}

interface StaffSaveResult extends SaveResult {
  /** invio dell'email di benvenuto/reset da eseguire dopo il commit */
  send?: () => Promise<void>;
}

/** Staff::setExtraAttr($attr, $value): JSON di `extra` con la chiave aggiornata (ordine conservato). */
function setExtraAttr(row: OrmRow, attr: string, value: unknown): void {
  const cur = phpJsonDecode<Record<string, unknown> | null>((row.get("extra") as string | null) ?? "", null);
  const extra: Record<string, unknown> = cur && typeof cur === "object" && !Array.isArray(cur) ? { ...cur } : {};
  extra[attr] = value;
  row.set("extra", phpJsonEncode(extra));
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
  // il PHP ha un solo messaggio ("Valid email is required"): qui vuoto → obbligatorio, altrimenti non valido
  if (!email) errors.email = "required";
  else if (!(await isValidEmail(email, cfg.bool("verify_email_addrs")))) errors.email = "invalid";
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
  if (dept && !((dept.flags ?? 0) & Dept.ACTIVE)) errors.dept_id = "inactive";

  // Deve restare almeno un amministratore attivo
  if (vars.isadmin !== "1" || vars.islocked === "1") {
    const { rows } = await sql<{
      cnt: number;
      sid: number | null;
    }>`SELECT count(*) AS cnt, max(staff_id) AS sid FROM ${table("staff")} WHERE isadmin = 1 AND isactive = 1`.execute(executor);
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
    setFlag(da, StaffDeptAccess.ALERTS, truthy(alerts));
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
    setFlag(m, TeamMember.ALERTS, truthy(alerts));
    if (noErr()) await m.save(executor);
    dropped.delete(m.num("team_id"));
  }
  if (noErr() && dropped.size) await executor.deleteFrom("team_member").where("staff_id", "=", staffId).where("team_id", "in", [...dropped]).execute();
}

/** Permessi "primari" (globali dell'agente) mostrati nel form agente, nell'ordine del PHP. */
export const AGENT_PERMISSIONS = ALL_PERMISSIONS.filter((p) => p.primary);
