import { getTranslations, setRequestLocale } from "next-intl/server";

import SysNotice from "@/components/adminsys/SysNotice";
import MassBar from "@/components/admin/MassBar";
import Callout from "@/components/common/Callout";
import DataTable, { PageHeader } from "@/components/common/DataTable";
import Badge from "@/components/ui/badge/Badge";
import { CustomQueue } from "@/lib/osticket/flags";
import { coreConfig } from "@/server/config/config";
import { db } from "@/server/db";
import { listQueues } from "@/server/domain/adminsys/queue";

import { dateFormatter } from "../_sys/server";
import { requireAdmin } from "../guard";
import { massQueueAction } from "./actions";

/** Code dei ticket (scp/queues.php, elenco di settings.php?t=tickets#queues). */
export default async function QueuesPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<Record<string, string>> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const agent = await requireAdmin(locale);
  const t = await getTranslations("asys.queues");
  const c = await getTranslations("asys.common");
  const sp = await searchParams;
  const date = await dateFormatter(agent, locale);
  const cfg = await coreConfig();
  // OsticketConfig::getDefaultTicketQueueId(): 1 se la chiave manca
  const def = cfg.has("default_ticket_queue") ? cfg.int("default_ticket_queue") : 1;
  const queues = (await listQueues(db())).filter((q) => q.flags & CustomQueue.QUEUE && !q.staff_id);
  const byId = new Map(queues.map((q) => [q.id, q]));
  const fullName = (id: number, seen = new Set<number>()): string => {
    const q = byId.get(id);
    if (!q) return "";
    return q.parent_id && byId.has(q.parent_id) && !seen.has(q.parent_id) ? `${fullName(q.parent_id, new Set([...seen, id]))} / ${q.title}` : (q.title ?? "");
  };
  const phpUrl = process.env.OST_PHP_URL;
  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      <SysNotice sp={sp} />
      <Callout tone="info">
        {t("phpNote")}{" "}
        {phpUrl && (
          <a href={`${phpUrl.replace(/\/$/, "")}/scp/settings.php?t=tickets#queues`} className="font-medium underline" target="_blank" rel="noreferrer">
            {t("openPhp")}
          </a>
        )}
      </Callout>
      <form action={massQueueAction} className="space-y-4">
        <MassBar
          actions={[
            { value: "enable", label: c("enable") },
            { value: "disable", label: c("disable") },
            { value: "delete", label: c("delete"), danger: true },
          ]}
        />
        <DataTable
          empty={c("empty")}
          columns={[
            { key: "sel", label: "", className: "w-10" },
            { key: "title", label: t("name") },
            { key: "status", label: t("status") },
            { key: "columns", label: t("columns") },
            { key: "updated", label: c("updated") },
          ]}
          rows={queues
            .map((q) => ({ q, name: fullName(q.id) }))
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(({ q, name }) => ({
              key: q.id,
              cells: {
                sel: <input type="checkbox" name="ids[]" value={q.id} className="h-4 w-4 accent-brand-500" aria-label={name} />,
                title: (
                  <span className="font-medium text-gray-800 dark:text-white/90">
                    {name}
                    {q.id === def && <span className="ms-2 text-theme-xs text-gray-500">({c("default")})</span>}
                  </span>
                ),
                status: (
                  <Badge size="sm" color={q.flags & CustomQueue.DISABLED ? "light" : "success"}>
                    {q.flags & CustomQueue.DISABLED ? c("disabled") : c("active")}
                  </Badge>
                ),
                columns: q.flags & CustomQueue.INHERIT_COLUMNS ? t("inherited") : q.columns,
                updated: date(q.updated),
              },
            }))}
        />
      </form>
    </div>
  );
}
