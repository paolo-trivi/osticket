import { getTranslations, setRequestLocale } from "next-intl/server";

import { NewButton } from "@/components/adminsys/BackLink";
import SysNotice from "@/components/adminsys/SysNotice";
import MassBar from "@/components/admin/MassBar";
import DataTable, { PageHeader } from "@/components/common/DataTable";
import { Link } from "@/i18n/navigation";
import { coreConfig } from "@/server/config/config";
import { db } from "@/server/db";
import { listEmails } from "@/server/domain/adminsys/email";

import { dateFormatter } from "../_sys/server";
import { requireAdmin } from "../guard";
import { massEmailAction } from "./actions";

/** Account email (include/staff/emails.inc.php). */
export default async function EmailsPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<Record<string, string>> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const agent = await requireAdmin(locale);
  const t = await getTranslations("asys.emails");
  const c = await getTranslations("asys.common");
  const date = await dateFormatter(agent, locale);
  const sp = await searchParams;
  const cfg = await coreConfig();
  const rows = await listEmails(db());
  const def = cfg.int("default_email_id");
  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} subtitle={t("subtitle")} actions={<NewButton href="/admin/emails/new" label={t("new")} />} />
      <SysNotice sp={sp} />
      <form action={massEmailAction} className="space-y-4">
        <MassBar actions={[{ value: "delete", label: c("delete"), danger: true }]} />
        <DataTable
          empty={c("empty")}
          columns={[
            { key: "sel", label: "", className: "w-10" },
            { key: "email", label: t("email") },
            { key: "priority", label: t("priority") },
            { key: "dept", label: t("dept") },
            { key: "created", label: c("created") },
            { key: "updated", label: c("updated") },
          ]}
          rows={rows.map((r) => ({
            key: r.email_id,
            cells: {
              sel: <input type="checkbox" name="ids[]" value={r.email_id} disabled={r.email_id === def} className="h-4 w-4 accent-brand-500" aria-label={r.email} />,
              email: (
                <Link href={`/admin/emails/${r.email_id}`} className="font-medium text-brand-500 hover:text-brand-600">
                  {r.name ? `${r.name} <${r.email}>` : r.email}
                  {r.email_id === def && <span className="ms-2 text-theme-xs text-gray-500">({c("default")})</span>}
                </Link>
              ),
              priority: r.priority ?? "—",
              dept: r.dept ?? "—",
              created: date(r.created, "date"),
              updated: date(r.updated),
            },
          }))}
        />
      </form>
    </div>
  );
}
