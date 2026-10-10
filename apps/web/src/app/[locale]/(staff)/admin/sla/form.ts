import "server-only";

import { getTranslations } from "next-intl/server";

import type { FormSection } from "@/lib/admin/form-schema";
import { SLA } from "@/lib/osticket/flags";
import { db } from "@/server/db";
import { htmlDecode } from "@/server/format/html";
import { scheduleOptions } from "@/server/domain/admin/lookups";

/** Sezioni del form SLA (include/staff/slaplan.inc.php). */
export async function slaSections(slaId: number | null): Promise<FormSection[] | null> {
  const t = await getTranslations("admSla");
  const sla = slaId ? await db().selectFrom("sla").selectAll().where("id", "=", slaId).executeTakeFirst() : null;
  if (slaId && !sla) return null;
  const flags = sla?.flags ?? SLA.ACTIVE;
  const schedules = await scheduleOptions(db(), "bizhrs");
  return [
    {
      title: t("sections.plan"),
      fields: [
        { kind: "hidden", name: "do", value: slaId ? "update" : "add" },
        { kind: "hidden", name: "id", value: slaId ? String(slaId) : "" },
        // il PHP salva il nome con le entità HTML (Format::htmlchars): nel form si mostra decodificato
        { kind: "text", name: "name", label: t("name"), value: sla ? htmlDecode(sla.name) : "", required: true },
        { kind: "number", name: "grace_period", label: t("gracePeriod"), value: sla ? String(sla.grace_period) : "", required: true, hint: t("gracePeriodHint") },
        { kind: "select", name: "schedule_id", label: t("schedule"), value: String(sla?.schedule_id ?? 0), options: [{ value: "0", label: t("systemDefault") }, ...schedules] },
        {
          kind: "radio",
          name: "isactive",
          label: t("status"),
          value: flags & SLA.ACTIVE ? "1" : "0",
          options: [
            { value: "1", label: t("active") },
            { value: "0", label: t("disabled") },
          ],
        },
        { kind: "checkbox", name: "transient", label: t("transient"), checked: !!(flags & SLA.TRANSIENT), hint: t("transientHint") },
        { kind: "checkbox", name: "disable_overdue_alerts", label: t("noOverdueAlerts"), checked: !!(flags & SLA.NOALERTS) },
        { kind: "textarea", name: "notes", label: t("notes"), value: sla?.notes ?? "", rows: 3, wide: true },
      ],
    },
  ];
}
