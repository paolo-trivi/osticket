import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";

import BackLink from "@/components/adminsys/BackLink";
import AdminForm from "@/components/admin/AdminForm";
import AdminNotice from "@/components/admin/AdminNotice";
import MassBar from "@/components/admin/MassBar";
import ComponentCard from "@/components/common/ComponentCard";
import DataTable, { PageHeader } from "@/components/common/DataTable";
import { Link } from "@/i18n/navigation";
import type { FormSection } from "@/lib/admin/form-schema";
import { Schedule } from "@/lib/osticket/flags";
import { idOrNotFound } from "@/lib/route-id";
import { db } from "@/server/db";
import { scheduleOptions, timezoneOptions } from "@/server/domain/admin/lookups";
import { describeEntry, displaySortOrder, FREQUENCIES, isFullDayEntry, type EntryDesc } from "@/server/domain/admin/schedule-entry-form";
import { phpJsonDecode } from "@/server/format/php-json";

import { dateFormatter } from "../../_sys/server";
import { requireAdmin } from "../../guard";
import { deleteEntriesAction, saveEntryAction, updateScheduleAction } from "../actions";
import { adminMetadata } from "../../metadata";

export const generateMetadata = adminMetadata("schedules");

/** Orario (include/staff/schedule.inc.php): dati, festività, ordine e gestione delle voci. */
export default async function SchedulePage({ params, searchParams }: { params: Promise<{ locale: string; id: string }>; searchParams: Promise<Record<string, string>> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const date = await dateFormatter(await requireAdmin(locale), locale);
  const t = await getTranslations("admSchedules");
  const u = await getTranslations("admUi");
  const sp = await searchParams;
  const scheduleId = idOrNotFound(id);
  const schedule = await db().selectFrom("schedule").selectAll().where("id", "=", scheduleId).executeTakeFirst();
  if (!schedule) notFound();
  const bizhrs = !!(schedule.flags & Schedule.BIZHRS);
  const entries = await db().selectFrom("schedule_entry").selectAll().where("schedule_id", "=", scheduleId).orderBy("sort").orderBy("id").execute();
  const cfg = await db().selectFrom("config").select("value").where("namespace", "=", `schedule.${scheduleId}`).where("key", "=", "configuration").executeTakeFirst();
  const holidays = (phpJsonDecode<{ holidays?: unknown[] }>(cfg?.value ?? "", {}).holidays ?? []).map(String);
  const holidaySchedules = bizhrs ? await scheduleOptions(db(), "hdays") : [];

  const scheduleSections: FormSection[] = [
    {
      title: t("sections.schedule"),
      fields: [
        { kind: "hidden", name: "do", value: "update" },
        { kind: "hidden", name: "type", value: bizhrs ? "bizhrs" : "hdays" },
        { kind: "text", name: "name", label: t("name"), value: schedule.name, required: true },
        { kind: "info", name: "type_info", label: t("type"), text: bizhrs ? t("bizhrs") : t("hdays") },
        { kind: "select", name: "timezone", label: t("timezone"), value: schedule.timezone ?? "", options: [{ value: "", label: t("floating") }, ...timezoneOptions()] },
        { kind: "textarea", name: "description", label: t("description"), value: schedule.description, rows: 3, wide: true },
        ...(bizhrs ? [{ kind: "checkboxes" as const, name: "holidays[]", label: t("holidays"), values: holidays, options: holidaySchedules, wide: true }] : []),
      ],
    },
    {
      title: t("sections.order"),
      desc: t("orderDesc"),
      fields: (() => {
        const order = displaySortOrder(entries.map((e) => e.sort));
        return entries.map((e, i) => ({
          kind: "number" as const,
          name: `sort-${e.id}`,
          label: e.name,
          value: String(order[i]),
        }));
      })(),
    },
  ];

  const editId = Number(sp.entry) || null;
  const edit = editId ? entries.find((e) => e.id === editId) : undefined;
  const isoDate = (v: string | null) => (v ? String(v).slice(0, 10) : "");
  const hhmm = (v: string | null) => (v ? String(v).slice(0, 5) : "");
  // ScheduleEntry::getDesc(): frequenza con giorno/settimana/mese e, se non è tutto il giorno, l'orario
  const word = (v: string) => (locale.startsWith("en") ? v : v.toLocaleLowerCase(locale));
  const dayName = (d: number) => (t.has(`days.${d}`) ? word(t(`days.${d}`)) : String(d));
  const weekName = (w: number) => (t.has(`weeks.${w}`) ? word(t(`weeks.${w}`)) : String(w));
  const monthName = (m: number) => (t.has(`months.${m}`) ? word(t(`months.${m}`)) : String(m));
  const descText = (d: EntryDesc): string => {
    switch (d.key) {
      case "never":
        return t("desc.never", {
          date: d.date
            ? new Intl.DateTimeFormat(locale, {
                dateStyle: "long",
                timeZone: "UTC",
              }).format(new Date(`${d.date}T00:00:00Z`))
            : "—",
        });
      case "daily":
        return t("freq.daily");
      case "weekdays":
        return t("weekdays");
      case "weekends":
        return t("weekends");
      case "weekly":
        return t("desc.weekly", { day: dayName(d.day) });
      case "monthlyDay":
        return t("desc.monthlyDay", { day: d.day });
      case "monthlyWeek":
        return t("desc.monthlyWeek", {
          week: weekName(d.week),
          day: dayName(d.day),
        });
      case "yearlyDate":
        return t("desc.yearlyDate", { day: d.day, month: monthName(d.month) });
      case "yearlyWeek":
        return t("desc.yearlyWeek", {
          week: weekName(d.week),
          day: dayName(d.day),
          month: monthName(d.month),
        });
    }
  };
  const days = [1, 2, 3, 4, 5, 6, 7].map((d) => ({
    value: String(d),
    label: t(`days.${d}`),
  }));
  const weeks = ["1", "2", "3", "4", "5", "-1"].map((w) => ({
    value: w,
    label: t(`weeks.${w}`),
  }));
  const allDay = edit ? edit.starts_at === "00:00:00" && edit.ends_at === "23:59:59" : !bizhrs;
  const weeklyDay = edit ? (edit.repeats === "weekdays" || edit.repeats === "weekends" ? edit.repeats : String(edit.day ?? "")) : "";
  const entrySections: FormSection[] = [
    {
      title: edit ? t("editEntry", { name: edit.name }) : t("addEntry"),
      desc: t("entryDesc"),
      fields: [
        { kind: "text", name: "name", label: t("name"), value: edit?.name ?? "", required: true },
        {
          kind: "select",
          name: "repeats",
          label: t("repeats"),
          value: edit ? (edit.repeats === "weekdays" || edit.repeats === "weekends" ? "weekly" : edit.repeats) : "never",
          options: FREQUENCIES.map((f) => ({ value: f, label: t(`freq.${f}`) })),
        },
        { kind: "date", name: "starts_on", label: t("startsOn"), value: isoDate(edit?.starts_on ?? null), required: true },
        { kind: "date", name: "stops_on", label: t("stopsOn"), value: isoDate(edit?.stops_on ?? null), hint: t("stopsOnHint") },
        { kind: "checkbox", name: "allday", value: "1", label: t("allDay"), checked: allDay, wide: true },
        { kind: "time", name: "starts_at", label: t("startsAt"), value: edit ? hhmm(edit.starts_at) : "08:00" },
        { kind: "time", name: "ends_at", label: t("endsAt"), value: edit ? hhmm(edit.ends_at) : "17:00" },
        {
          kind: "select",
          name: "weekly_day",
          label: t("weeklyDay"),
          value: weeklyDay,
          options: [{ value: "", label: u("choose") }, ...days, { value: "weekdays", label: t("weekdays") }, { value: "weekends", label: t("weekends") }],
          hint: t("onlyWeekly"),
        },
        {
          kind: "select",
          name: "monthly",
          label: t("monthly"),
          value: edit?.repeats === "monthly" ? String(edit.week ?? "day") : "day",
          options: [{ value: "day", label: t("dayOfMonth") }, ...weeks],
          hint: t("onlyMonthly"),
        },
        { kind: "select", name: "monthly_day", label: t("day"), value: edit?.repeats === "monthly" ? String(edit.day ?? "") : "", options: [{ value: "", label: u("choose") }, ...days] },
        {
          kind: "select",
          name: "yearly",
          label: t("yearly"),
          value: edit?.repeats === "yearly" ? (edit.week ? String(edit.week) : "date") : "date",
          options: [{ value: "date", label: t("dateEntered") }, ...weeks],
          hint: t("onlyYearly"),
        },
        { kind: "select", name: "yearly_day", label: t("day"), value: edit?.repeats === "yearly" && edit.week ? String(edit.day ?? "") : "", options: [{ value: "", label: u("choose") }, ...days] },
        {
          kind: "select",
          name: "yearly_month",
          label: t("month"),
          value: edit?.repeats === "yearly" && edit.week ? String(edit.month ?? "") : "",
          options: [{ value: "", label: u("choose") }, ...Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: t(`months.${i + 1}`) }))],
        },
      ],
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={schedule.name}
        subtitle={bizhrs ? t("bizhrs") : t("hdays")}
        actions={
          <span className="flex gap-4">
            <Link href={`/admin/schedules/new?clone=${scheduleId}`} className="text-sm font-medium text-brand-500 hover:text-brand-600">
              {t("clone")}
            </Link>
            <BackLink href="/admin/schedules" label={t("back")} />
          </span>
        }
      />
      {sp.created && <AdminNotice ok="created" n="1" />}
      {sp.entry_added && <AdminNotice ok="entry" n="1" />}
      <AdminNotice ok={sp.ok} n={sp.n} err={sp.err} />
      <AdminForm sections={scheduleSections.filter((s) => s.fields.length)} action={updateScheduleAction.bind(null, scheduleId)} />
      <ComponentCard title={t("entries")}>
        <form action={deleteEntriesAction.bind(null, scheduleId)} className="space-y-4">
          <MassBar actions={[{ value: "delete", label: u("delete"), danger: true }]} />
          <DataTable
            empty={u("empty")}
            columns={[
              { key: "sel", label: "", className: "w-10" },
              { key: "name", label: t("name") },
              { key: "repeats", label: t("repeats") },
              { key: "updated", label: t("updated") },
            ]}
            rows={entries.map((e) => ({
              key: e.id,
              cells: {
                sel: <input type="checkbox" name="ids[]" value={e.id} className="h-4 w-4 accent-brand-500" aria-label={e.name} />,
                name: (
                  <Link href={`/admin/schedules/${scheduleId}?entry=${e.id}`} className="font-medium text-brand-500 hover:text-brand-600">
                    {e.name}
                  </Link>
                ),
                repeats: isFullDayEntry(e) ? descText(describeEntry(e)) : `${descText(describeEntry(e))} (${hhmm(e.starts_at)}–${hhmm(e.ends_at)})`,
                updated: date(e.updated),
              },
            }))}
          />
        </form>
      </ComponentCard>
      <AdminForm
        key={editId ?? "new"}
        sections={entrySections}
        action={saveEntryAction.bind(null, scheduleId, edit ? edit.id : null)}
        submitLabel={edit ? u("save") : t("addEntry")}
      />
    </div>
  );
}
