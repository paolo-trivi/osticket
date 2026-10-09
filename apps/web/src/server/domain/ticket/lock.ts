import "server-only";

import { sql } from "kysely";

import type { ConfigNamespace } from "../../config/config";
import type { DbOrTx } from "../../db";
import { randCode } from "../../mail/message-id";
import { TicketRecord } from "./record";

/**
 * Lock dei ticket condivisi con il PHP (include/class.lock.php, Ticket::acquireLock/releaseLock,
 * ajax.tickets.php): righe in `lock`, collegate a ticket.lock_id. Modalità core.ticket_lock:
 * 0 disattivato, 1 alla visualizzazione, 2 all'attività (default); durata core.autolock_minutes.
 */
const LockMode = { DISABLED: 0, ON_VIEW: 1, ON_ACTIVITY: 2 } as const;

const LOCK_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ01234567890_=";

interface LockInfo {
  lock_id: number;
  staff_id: number;
  code: string | null;
  /** secondi rimanenti */
  time: number;
  expired: boolean;
}

export function lockEnabled(cfg: ConfigNamespace): boolean {
  return cfg.int("ticket_lock", LockMode.ON_ACTIVITY) !== LockMode.DISABLED && cfg.int("autolock_minutes") > 0;
}

async function lockRow(executor: DbOrTx, lockId: number): Promise<LockInfo | null> {
  if (!lockId) return null;
  const { rows } = await sql<{ lock_id: number; staff_id: number; code: string | null; time: number; expired: number }>`
    SELECT lock_id, staff_id, code, GREATEST(0, TIMESTAMPDIFF(SECOND, NOW(), expire)) AS time, (NOW() > expire) AS expired
    FROM ${sql.table("lock")} WHERE lock_id = ${lockId}`.execute(executor);
  const r = rows[0];
  return r ? { ...r, time: Number(r.time), expired: !!Number(r.expired) } : null;
}

/** Ticket::getLock: lock non scaduto del ticket. */
async function ticketLock(executor: DbOrTx, ticketId: number): Promise<LockInfo | null> {
  const t = await executor.selectFrom("ticket").select("lock_id").where("ticket_id", "=", ticketId).executeTakeFirst();
  const lock = await lockRow(executor, t?.lock_id ?? 0);
  return lock && !lock.expired ? lock : null;
}

async function renew(executor: DbOrTx, lockId: number, minutes: number): Promise<void> {
  await sql`UPDATE ${sql.table("lock")} SET expire = (NOW() + INTERVAL ${minutes} MINUTE) WHERE lock_id = ${lockId}`.execute(executor);
}

type AcquireResult = { ok: true; lock: LockInfo } | { ok: false; lockedBy?: number; retry: boolean };

/** ajax.tickets.php acquireLock + Ticket::acquireLock */
export async function acquireTicketLock(executor: DbOrTx, cfg: ConfigNamespace, ticketId: number, staffId: number): Promise<AcquireResult> {
  const minutes = cfg.int("autolock_minutes");
  if (!lockEnabled(cfg) || !staffId) return { ok: false, retry: false };
  const current = await ticketLock(executor, ticketId);
  if (current) {
    if (current.staff_id !== staffId) return { ok: false, lockedBy: current.staff_id, retry: false };
    await renew(executor, current.lock_id, minutes);
    return { ok: true, lock: (await lockRow(executor, current.lock_id))! };
  }
  const res = await sql`INSERT INTO ${sql.table("lock")} (created, staff_id, expire, code)
    VALUES (NOW(), ${staffId}, (NOW() + INTERVAL ${minutes} MINUTE), ${randCode(10, LOCK_CHARS)})`.execute(executor);
  const lockId = Number(res.insertId);
  const rec = await TicketRecord.load(executor, ticketId);
  if (rec) {
    rec.set("lock_id", lockId);
    await rec.save();
  }
  return { ok: true, lock: (await lockRow(executor, lockId))! };
}

/** ajax renewLock: rinnova il proprio lock o ne acquisisce uno nuovo se scaduto. */
export async function renewTicketLock(executor: DbOrTx, cfg: ConfigNamespace, ticketId: number, lockId: number, staffId: number): Promise<AcquireResult> {
  const t = await executor.selectFrom("ticket").select("lock_id").where("ticket_id", "=", ticketId).executeTakeFirst();
  const lock = await lockRow(executor, lockId);
  if (!lock || !t || t.lock_id !== lockId) return acquireTicketLock(executor, cfg, ticketId, staffId);
  if (!lock.staff_id || lock.expired) return acquireTicketLock(executor, cfg, ticketId, staffId);
  if (lock.staff_id !== staffId) return { ok: false, lockedBy: lock.staff_id, retry: false };
  await renew(executor, lockId, cfg.int("autolock_minutes"));
  return { ok: true, lock: (await lockRow(executor, lockId))! };
}

/** Ticket::releaseLock($staffId): elimina il lock e azzera ticket.lock_id (con updated = NOW()). */
export async function releaseTicketLock(executor: DbOrTx, ticketId: number, staffId?: number): Promise<boolean> {
  const lock = await ticketLock(executor, ticketId);
  if (!lock) return false;
  if (staffId && lock.staff_id !== staffId) return false;
  await sql`DELETE FROM ${sql.table("lock")} WHERE lock_id = ${lock.lock_id}`.execute(executor);
  const rec = await TicketRecord.load(executor, ticketId);
  if (rec) {
    rec.set("lock_id", 0);
    await rec.save();
  }
  return true;
}

/** Verifica del lock prima di risposta/nota (scp/tickets.php). */
export async function checkLockForPost(
  executor: DbOrTx,
  cfg: ConfigNamespace,
  ticketId: number,
  staffId: number,
  lockCode: string | undefined,
): Promise<null | "lock_required" | "locked_by_other" | "lock_expired"> {
  if (!lockEnabled(cfg)) return null;
  const lock = await ticketLock(executor, ticketId);
  if (!lock) return "lock_required";
  if (lock.staff_id !== staffId) return "locked_by_other";
  if (lock.code !== lockCode) return "lock_expired";
  return null;
}

