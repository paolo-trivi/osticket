import "server-only";

import { SLA } from "@/lib/osticket/flags";

import { loadConfigNamespace, type ConfigNamespace } from "../../config/config";
import { db, type DbOrTx } from "../../db";
import { detectDbTimezone } from "../../db/time";
import { PhpDateTime } from "./php-datetime";
import { addWorkingHours, loadBusinessHoursSchedule, phpRound, type ScheduleData, type ScheduleLoadOptions } from "./schedule";

/**
 * SLA di osTicket (include/class.sla.php) e calcolo della scadenza del ticket
 * (Ticket::getSLADueDate($recompute=true), include/class.ticket.php).
 */

interface SlaData {
  id: number;
  flags: number;
  /** ore (colonna INT: in DB non esistono periodi frazionari, ma il calcolo li supporta) */
  gracePeriod: number;
  scheduleId: number;
}

function slaIsActive(sla: Pick<SlaData, "flags">): boolean {
  return (sla.flags & SLA.ACTIVE) !== 0;
}

export async function loadSla(id: number, executor: DbOrTx = db()): Promise<SlaData | null> {
  if (!id) return null;
  const row = await executor
    .selectFrom("sla")
    .select(["id", "flags", "grace_period", "schedule_id"])
    .where("id", "=", id)
    .executeTakeFirst();
  return row ? { id: row.id, flags: row.flags, gracePeriod: Number(row.grace_period), scheduleId: row.schedule_id } : null;
}

/**
 * SLA::addGracePeriod($date, $schedule) con lo schedule già scelto (vedi resolveSlaSchedule).
 * Modifica `date` come il PHP e la restituisce: nel fuso dello schedule se le ore sono state
 * aggiunte secondo l'orario lavorativo, altrimenti nel fuso originale.
 * - grace period 0: la data resta invariata (addWorkingHours restituisce la data così com'è);
 * - schedule assente o senza voci: si aggiungono round(ore*3600) secondi di tempo trascorso.
 */
export function addGracePeriod(
  date: PhpDateTime,
  gracePeriod: number,
  schedule: ScheduleData | null,
  timeline?: string[],
): PhpDateTime {
  if (schedule && addWorkingHours(schedule, date, gracePeriod, timeline)) return date;
  // Nessuno schedule: si aggiungono le ore e basta
  date.addSeconds(phpRound(gracePeriod * 3600));
  return date;
}

/**
 * Precedenza di SLA::addGracePeriod: schedule richiesto (quello del reparto in getSLADueDate),
 * poi quello dello SLA, infine il predefinito di sistema (core.schedule_id). Ogni livello vale solo
 * se è uno schedule di tipo "orario lavorativo" esistente (BusinessHoursSchedule::lookup).
 * Gli schedule successivi sono caricati solo se servono, come nel PHP.
 */
export async function resolveSlaSchedule(
  ids: { requested?: number | null; sla?: number | null; default?: number | null },
  opts: ScheduleLoadOptions = {},
  executor: DbOrTx = db(),
): Promise<ScheduleData | null> {
  for (const id of [ids.requested, ids.sla, ids.default]) {
    if (!id) continue;
    const schedule = await loadBusinessHoursSchedule(id, opts, executor);
    if (schedule) return schedule;
  }
  return null;
}

/** $cfg->getDbTimezone(): core.db_timezone se presente, altrimenti il fuso rilevato del server DB. */
async function dbZoneFor(core: ConfigNamespace, executor: DbOrTx): Promise<string> {
  // Il PHP, se la chiave manca, la determina e la salva (DbTimezone::determine): qui non si scrive.
  return core.str("db_timezone") || (await detectDbTimezone(executor));
}

/** Department::getSchedule() del reparto del ticket (Ticket::getDept(): reparto o predefinito). */
async function deptScheduleId(deptId: number, core: ConfigNamespace, executor: DbOrTx): Promise<number | null> {
  const find = (id: number) =>
    id ? executor.selectFrom("department").select("schedule_id").where("id", "=", id).executeTakeFirst() : undefined;
  // Ticket::getDept(): $this->dept ?: $cfg->getDefaultDept()
  const dept = (await find(deptId)) ?? (await find(core.int("default_dept_id")));
  return dept ? dept.schedule_id : null;
}

interface SlaDueDateOptions {
  slaId: number;
  deptId: number;
  /** reopened ?: created del ticket, 'Y-m-d H:i:s' nel fuso del DB */
  start: string;
  /**
   * Fuso dell'agente/utente della richiesta ($thisstaff / $thisclient): il PHP lo usa per gli
   * schedule senza fuso ("floating") tramite $cfg->getTimezone(). Omesso = core.default_timezone
   * (es. cron, API, richieste senza utente).
   */
  userTimezone?: string | null;
  /** se fornito riceve il log del calcolo (BusinessHours::getTimeline) */
  timeline?: string[];
}

/**
 * Ticket::getSLADueDate(true): scadenza SLA nel formato del DB ('Y-m-d H:i:s' nel fuso del DB),
 * oppure null se lo SLA non esiste o non è attivo (il PHP restituisce null e est_duedate diventa NULL).
 */
export async function slaDueDate(opts: SlaDueDateOptions, executor: DbOrTx = db()): Promise<string | null> {
  const sla = await loadSla(opts.slaId, executor);
  if (!sla || !slaIsActive(sla)) return null;

  const core = await loadConfigNamespace("core", executor);
  const fallbackTimezone = opts.userTimezone || core.str("default_timezone") || "UTC";
  const schedule = await resolveSlaSchedule(
    {
      requested: await deptScheduleId(opts.deptId, core, executor),
      sla: sla.scheduleId,
      default: core.int("schedule_id"),
    },
    { fallbackTimezone },
    executor,
  );
  const dbZone = await dbZoneFor(core, executor);
  return computeSlaDueDate(opts.start, dbZone, sla.gracePeriod, schedule, opts.timeline);
}

/** Parte pura di getSLADueDate: data di partenza nel fuso DB → scadenza nel fuso DB. */
function computeSlaDueDate(
  start: string,
  dbZone: string,
  gracePeriod: number,
  schedule: ScheduleData | null,
  timeline?: string[],
): string {
  const dt = addGracePeriod(PhpDateTime.create(start, dbZone), gracePeriod, schedule, timeline);
  // L'ora va riportata nel fuso del DB
  dt.setTimezone(dbZone);
  return dt.format("Y-m-d H:i:s");
}
