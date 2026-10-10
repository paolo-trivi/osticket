"use server";

import type { AdminFormState } from "@/lib/admin/form-schema";
import { adminFormResult, massRedirect } from "@/server/actions/result";
import { parsePhpForm, selectedIds } from "@/server/domain/admin/form-data";
import { str, truthy } from "@/server/php/values";
import { addSchedule, deleteScheduleEntries, deleteSchedules, saveScheduleEntry, updateSchedule } from "@/server/domain/admin/schedule";

import { adminWrite, requireAdminAction } from "../_shared/server";

/** ajax.schedule.php add / clone */
export async function addScheduleAction(_prev: AdminFormState, form: FormData): Promise<AdminFormState> {
  const { locale } = await requireAdminAction();
  const vars = parsePhpForm(form);
  const clone = Number(str(vars.clone)) || null;
  const r = await adminWrite((tx) => addSchedule(tx, vars, clone));
  return adminFormResult(r, { locale, created: (id) => `/admin/schedules/${id}?created=1` });
}

/** scp/schedules.php do=update */
export async function updateScheduleAction(scheduleId: number, _prev: AdminFormState, form: FormData): Promise<AdminFormState> {
  const { locale } = await requireAdminAction();
  const r = await adminWrite((tx) => updateSchedule(tx, scheduleId, parsePhpForm(form)));
  return adminFormResult(r, { locale });
}

/** ajax.schedule.php addEntry / updateEntry */
export async function saveEntryAction(scheduleId: number, entryId: number | null, _prev: AdminFormState, form: FormData): Promise<AdminFormState> {
  const { agent, locale } = await requireAdminAction();
  const v = parsePhpForm(form);
  const input = {
    name: str(v.name),
    starts_on: str(v.starts_on),
    allday: truthy(v.allday),
    starts_at: str(v.starts_at),
    ends_at: str(v.ends_at),
    repeats: str(v.repeats),
    stops_on: str(v.stops_on) || undefined,
    weekly_day: str(v.weekly_day),
    monthly: str(v.monthly) || undefined,
    monthly_day: str(v.monthly_day),
    yearly: str(v.yearly),
    yearly_day: str(v.yearly_day),
    yearly_month: str(v.yearly_month),
  };
  const r = await adminWrite((tx) => saveScheduleEntry(tx, scheduleId, entryId, input, { actorId: agent.id }));
  return adminFormResult(r, { locale, created: entryId ? undefined : () => `/admin/schedules/${scheduleId}?entry_added=1` });
}

/** ajax.schedule.php deleteEntries */
export async function deleteEntriesAction(scheduleId: number, form: FormData): Promise<void> {
  const { locale } = await requireAdminAction();
  const ids = selectedIds(parsePhpForm(form));
  const num = await adminWrite((tx) => deleteScheduleEntries(tx, scheduleId, ids));
  if (typeof num !== "number") massRedirect(`/admin/schedules/${scheduleId}`, locale, num, "delete");
  massRedirect(`/admin/schedules/${scheduleId}`, locale, { ok: num > 0, num, error: num ? undefined : "select" }, "delete");
}

/** scp/schedules.php do=mass_process a=delete */
export async function massSchedulesAction(form: FormData): Promise<void> {
  const { locale } = await requireAdminAction();
  const vars = parsePhpForm(form);
  if (str(vars.a) !== "delete") massRedirect("/admin/schedules", locale, { ok: false, num: 0, error: "unknown" }, str(vars.a));
  const ids = selectedIds(vars);
  if (!ids.length) massRedirect("/admin/schedules", locale, { ok: false, num: 0, error: "select" }, "delete");
  const r = await adminWrite((tx) => deleteSchedules(tx, ids));
  massRedirect("/admin/schedules", locale, r, "delete");
}
