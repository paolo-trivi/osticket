import { getTranslations, setRequestLocale } from "next-intl/server";

import { RadioField, Section, TextAreaField, TextField } from "@/components/adminsys/fields";
import SysForm from "@/components/adminsys/SysForm";
import SysNotice from "@/components/adminsys/SysNotice";
import MassBar from "@/components/admin/MassBar";
import Callout from "@/components/common/Callout";
import DataTable, { PageHeader } from "@/components/common/DataTable";
import Badge from "@/components/ui/badge/Badge";
import { Link } from "@/i18n/navigation";
import { db } from "@/server/db";
import { listBanRules } from "@/server/domain/adminsys/banlist";

import { dateFormatter } from "../_sys/server";
import { requireAdmin } from "../guard";
import { addBanAction, massBanAction } from "./actions";

/** Ban list (include/staff/banlist.inc.php + banrule.inc.php per l'aggiunta). */
export default async function BanlistPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<Record<string, string>> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const agent = await requireAdmin(locale);
  const t = await getTranslations("asys.banlist");
  const c = await getTranslations("asys.common");
  const sp = await searchParams;
  const date = await dateFormatter(agent, locale);
  const { filterId, isactive, rules } = await listBanRules(db(), sp.q);
  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      <SysNotice sp={sp} />
      {!filterId && <Callout tone="warning">{t("noFilter")}</Callout>}
      {filterId && !isactive && <Callout tone="warning">{t("disabledFilter")}</Callout>}
      <SysForm action={addBanAction} submitLabel={t("add")} savedMessage={t("added")} labels={{ val: t("email") }} resetOnSave>
        <Section title={t("addTitle")}>
          <TextField name="val" label={t("email")} type="email" required />
          <RadioField
            name="isactive"
            label={t("status")}
            value="1"
            options={[
              { value: "1", label: c("active") },
              { value: "0", label: c("disabled") },
            ]}
          />
          <TextAreaField name="notes" label={t("notes")} rows={2} />
          <input type="hidden" name="do" value="add" />
        </Section>
      </SysForm>
      <form method="get" className="flex gap-2">
        <input name="q" defaultValue={sp.q ?? ""} placeholder={t("search")} className="h-10 w-64 rounded-lg border border-gray-300 bg-transparent px-3 text-sm dark:border-gray-700 dark:text-white/90" />
        <button type="submit" className="rounded-lg px-3 text-sm font-medium text-gray-700 ring-1 ring-gray-300 ring-inset dark:text-gray-300 dark:ring-gray-700">
          {c("search")}
        </button>
      </form>
      <form action={massBanAction} className="space-y-4">
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
            { key: "val", label: t("email") },
            { key: "status", label: t("status") },
            { key: "created", label: c("created") },
            { key: "updated", label: c("updated") },
          ]}
          rows={rules.map((r) => ({
            key: r.id,
            cells: {
              sel: <input type="checkbox" name="ids[]" value={r.id} className="h-4 w-4 accent-brand-500" aria-label={r.val} />,
              val: (
                <Link href={`/admin/banlist/${r.id}`} className="font-medium text-brand-500 hover:text-brand-600">
                  {r.val}
                </Link>
              ),
              status: (
                <Badge size="sm" color={r.isactive ? "success" : "light"}>
                  {r.isactive ? c("active") : c("disabled")}
                </Badge>
              ),
              created: date(r.created),
              updated: date(r.updated),
            },
          }))}
        />
      </form>
    </div>
  );
}
