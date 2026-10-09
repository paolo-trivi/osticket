import "server-only";

import { sql } from "kysely";

import { ConfigNamespace, loadConfigNamespace } from "../../config/config";
import { db, table, type DbOrTx } from "../../db";
import type { StaffTable } from "../../db/schema.gen";
import type { Selectable } from "kysely";

/** Permessi di ruolo (doc 09 §5.1) e globali dell'agente (§5.2). */
export const TicketPerm = {
  CREATE: "ticket.create",
  EDIT: "ticket.edit",
  ASSIGN: "ticket.assign",
  RELEASE: "ticket.release",
  TRANSFER: "ticket.transfer",
  REFER: "ticket.refer",
  MERGE: "ticket.merge",
  LINK: "ticket.link",
  REPLY: "ticket.reply",
  MARKANSWERED: "ticket.markanswered",
  CLOSE: "ticket.close",
  DELETE: "ticket.delete",
  THREAD_EDIT: "thread.edit",
} as const;

export const TaskPerm = {
  CREATE: "task.create",
  EDIT: "task.edit",
  ASSIGN: "task.assign",
  TRANSFER: "task.transfer",
  REPLY: "task.reply",
  CLOSE: "task.close",
  DELETE: "task.delete",
} as const;

export const GlobalPerm = {
  USER_CREATE: "user.create",
  USER_EDIT: "user.edit",
  USER_DELETE: "user.delete",
  USER_MANAGE: "user.manage",
  USER_DIR: "user.dir",
  ORG_CREATE: "org.create",
  ORG_EDIT: "org.edit",
  ORG_DELETE: "org.delete",
  FAQ_MANAGE: "faq.manage",
  BANLIST: "emails.banlist",
  SEARCH_ALL: "search.all",
  STATS_AGENTS: "stats.agents",
  VISIBILITY_AGENTS: "visibility.agents",
  VISIBILITY_DEPTS: "visibility.departments",
  CANNED_MANAGE: "canned.manage",
} as const;

/** RolePermission PHP: JSON {"perm": 1, ...}; has() = valore "truthy". */
export class PermissionSet {
  private readonly perms: Record<string, unknown>;

  constructor(json: string | null | undefined) {
    let parsed: unknown = {};
    try {
      parsed = json ? JSON.parse(json) : {};
    } catch {
      parsed = {};
    }
    this.perms = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  }

  has(perm: string): boolean {
    const v = this.perms[perm];
    return !(v === undefined || v === null || v === false || v === 0 || v === "" || v === "0");
  }

  keys(): string[] {
    return Object.keys(this.perms).filter((k) => this.has(k));
  }
}

export interface RoleInfo {
  id: number;
  name: string;
  perms: PermissionSet;
}

/** Ruolo implicito di Staff::getRole() quando l'agente non ha accesso al reparto. */
const CREATE_ONLY_ROLE: RoleInfo = {
  id: 0,
  name: "",
  perms: new PermissionSet(JSON.stringify({ [TicketPerm.CREATE]: 1 })),
};

type StaffRow = Selectable<StaffTable>;

export class Agent {
  constructor(
    readonly row: StaffRow,
    /** ruolo per reparto: primario + accessi estesi (Staff::getRoles) */
    private readonly rolesByDept: ReadonlyMap<number, RoleInfo>,
    readonly primaryRole: RoleInfo,
    /** reparti accessibili (Staff::getDepartments, inclusi sottoreparti e reparti gestiti) */
    readonly deptIds: readonly number[],
    readonly teamIds: readonly number[],
    readonly extendedAccess: ReadonlyArray<{ deptId: number; roleId: number; flags: number }>,
    /** preferenze e 2FA: config namespace "staff.<id>" con i default di Staff::getConfig() */
    readonly config: ConfigNamespace,
  ) {}

  get id(): number {
    return this.row.staff_id;
  }
  get username(): string {
    return this.row.username;
  }
  get email(): string {
    return this.row.email ?? "";
  }
  get deptId(): number {
    return this.row.dept_id;
  }
  get isActive(): boolean {
    return !!this.row.isactive;
  }
  get isAdmin(): boolean {
    return !!this.row.isadmin;
  }
  get onVacation(): boolean {
    return !!this.row.onvacation;
  }
  get isAvailable(): boolean {
    return this.isActive && !this.onVacation;
  }
  /** assigned_only: vede solo i ticket assegnati a sé o ai suoi team */
  get isAccessLimited(): boolean {
    return !!this.row.assigned_only;
  }
  get mustChangePassword(): boolean {
    return !!this.row.change_passwd;
  }

  get name(): { first: string; last: string; full: string } {
    const first = this.row.firstname ?? "";
    const last = this.row.lastname ?? "";
    return { first, last, full: `${first} ${last}`.trim() };
  }

  extra<T = unknown>(attr: string, fallback: T): T {
    try {
      const data = this.row.extra ? (JSON.parse(this.row.extra) as Record<string, unknown>) : {};
      return attr in data ? (data[attr] as T) : fallback;
    } catch {
      return fallback;
    }
  }

  /** Permesso globale (staff.permissions) — Staff::hasPerm($perm) */
  hasGlobalPerm(perm: string): boolean {
    return new PermissionSet(this.row.permissions).has(perm);
  }

  /** Permesso presente in almeno un ruolo — Staff::hasPerm($perm, false) */
  hasPermInAnyRole(perm: string): boolean {
    if (this.primaryRole.perms.has(perm)) return true;
    for (const role of this.rolesByDept.values()) if (role.perms.has(perm)) return true;
    return false;
  }

  /** Staff::getRole($dept, $assigned) */
  roleFor(deptId: number, assigned = false): RoleInfo {
    const role = this.rolesByDept.get(deptId);
    if (role) return role;
    if (assigned && this.extra("def_assn_role", true)) return this.primaryRole;
    return CREATE_ONLY_ROLE;
  }

  /** Staff::canAccessDept */
  canAccessDept(deptId: number): boolean {
    return !this.isAccessLimited && this.deptIds.includes(deptId);
  }

  isTeamMember(teamId: number): boolean {
    return !!teamId && this.teamIds.includes(teamId);
  }

  /** Staff::canManageTickets (menu/azioni di massa) */
  canManageTickets(): boolean {
    return (
      this.hasPermInAnyRole(TicketPerm.DELETE) ||
      this.hasPermInAnyRole(TicketPerm.TRANSFER) ||
      this.hasPermInAnyRole(TicketPerm.ASSIGN) ||
      this.hasPermInAnyRole(TicketPerm.CLOSE)
    );
  }
}

async function loadRoles(ids: number[], executor: DbOrTx): Promise<Map<number, RoleInfo>> {
  const unique = [...new Set(ids.filter((id) => id > 0))];
  if (!unique.length) return new Map();
  const rows = await executor
    .selectFrom("role")
    .select(["id", "name", "permissions"])
    .where("id", "in", unique)
    .execute();
  return new Map(rows.map((r) => [r.id, { id: r.id, name: r.name ?? "", perms: new PermissionSet(r.permissions) }]));
}

/** Reparti accessibili: stessa query di Staff::getDepartments() (include/class.staff.php). */
async function loadDeptIds(staffId: number, executor: DbOrTx): Promise<number[]> {
  const { rows } = await sql<{ id: number }>`
    SELECT DISTINCT d.id FROM ${table("staff")} s
    LEFT JOIN ${table("staff_dept_access")} g ON (s.staff_id = g.staff_id)
    INNER JOIN ${table("department")} d ON (
      LOCATE(CONCAT('/', s.dept_id, '/'), d.path)
      OR d.manager_id = s.staff_id
      OR LOCATE(CONCAT('/', g.dept_id, '/'), d.path))
    WHERE s.staff_id = ${staffId}`.execute(executor);
  return rows.map((r) => Number(r.id));
}

export async function loadAgent(staffId: number, executor: DbOrTx = db()): Promise<Agent | null> {
  const row = await executor.selectFrom("staff").selectAll().where("staff_id", "=", staffId).executeTakeFirst();
  if (!row) return null;

  const [access, teams, deptIds, config] = await Promise.all([
    executor
      .selectFrom("staff_dept_access")
      .select(["dept_id", "role_id", "flags"])
      .where("staff_id", "=", staffId)
      .execute(),
    executor.selectFrom("team_member").select("team_id").where("staff_id", "=", staffId).execute(),
    loadDeptIds(staffId, executor),
    loadConfigNamespace(`staff.${staffId}`, executor, STAFF_CONFIG_DEFAULTS),
  ]);

  const roles = await loadRoles([row.role_id, ...access.map((a) => a.role_id)], executor);
  const primaryRole = roles.get(row.role_id) ?? { id: row.role_id, name: "", perms: new PermissionSet(null) };
  const rolesByDept = new Map<number, RoleInfo>([[row.dept_id, primaryRole]]);
  for (const a of access) {
    const role = roles.get(a.role_id);
    if (role) rolesByDept.set(a.dept_id, role);
  }

  return new Agent(
    row,
    rolesByDept,
    primaryRole,
    deptIds,
    teams.map((t) => t.team_id),
    access.map((a) => ({ deptId: a.dept_id, roleId: a.role_id, flags: a.flags })),
    config,
  );
}

/** Default di Staff::getConfig() (include/class.staff.php). */
const STAFF_CONFIG_DEFAULTS = {
  default_from_name: "",
  datetime_format: "",
  thread_view_order: "",
  default_ticket_queue_id: 0,
  reply_redirect: "Ticket",
  img_att_view: "download",
  editor_spacing: "double",
} as const;

/**
 * Staff::lookup($var) per il login: email se valida, altrimenti username
 * (Validator::is_username: almeno 2 caratteri, non numerico, solo lettere/cifre/._-).
 */
export async function findStaffIdForLogin(login: string, executor: DbOrTx = db()): Promise<number | null> {
  const value = login.trim();
  if (!value) return null;
  let q = executor.selectFrom("staff").select("staff_id");
  if (value.includes("@")) {
    q = q.where("email", "=", value);
  } else if (value.length >= 2 && !/^\d+(\.\d+)?$/.test(value) && /^[\p{L}\d._-]+$/u.test(value)) {
    q = q.where("username", "=", value);
  } else {
    return null;
  }
  const row = await q.executeTakeFirst();
  return row?.staff_id ?? null;
}
