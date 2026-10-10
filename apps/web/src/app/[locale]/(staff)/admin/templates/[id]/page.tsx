import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";

import BackLink from "@/components/adminsys/BackLink";
import SysForm from "@/components/adminsys/SysForm";
import SysNotice from "@/components/adminsys/SysNotice";
import DataTable, { PageHeader } from "@/components/common/DataTable";
import Badge from "@/components/ui/badge/Badge";
import { Link } from "@/i18n/navigation";
import { idOrNotFound } from "@/lib/route-id";
import { db } from "@/server/db";
import { groupTemplates, loadGroup, TEMPLATE_GROUPS, TEMPLATE_NAMES } from "@/server/domain/adminsys/template";

import { dateFormatter } from "../../_sys/server";
import { requireAdmin } from "../../guard";
import { updateTemplateGroupAction } from "../actions";
import { TemplateGroupFields } from "../fields";
import { adminMetadata } from "../../metadata";

export const generateMetadata = adminMetadata("templates");

/** Set di template: proprietà e messaggi (include/staff/template.inc.php). */
export default async function TemplateSetPage({ params, searchParams }: { params: Promise<{ locale: string; id: string }>; searchParams: Promise<Record<string, string>> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const agent = await requireAdmin(locale);
  const tplId = idOrNotFound(id);
  const group = await loadGroup(db(), tplId);
  if (!group) notFound();
  const t = await getTranslations("asys.templates");
  const c = await getTranslations("asys.common");
  const sp = await searchParams;
  const date = await dateFormatter(agent, locale);
  const impl = new Map((await groupTemplates(db(), tplId)).map((m) => [m.code_name, m]));
  const codes = Object.entries(TEMPLATE_NAMES).sort((a, b) => (a[1].group + a[0]).localeCompare(b[1].group + b[0]));
  return (
    <div className="space-y-6">
      <PageHeader title={group.name} subtitle={t("editSet")} actions={<BackLink href="/admin/templates" label={c("back")} />} />
      <SysNotice sp={sp} />
      <SysForm action={updateTemplateGroupAction.bind(null, tplId)} labels={{ name: t("name"), isactive: t("status") }}>
        <TemplateGroupFields group={group} sets={[]} />
      </SysForm>
      {TEMPLATE_GROUPS.filter((g) => codes.some(([, v]) => v.group === g)).map((g) => (
        <div key={g} className="space-y-2">
          <h3 className="text-base font-semibold text-gray-800 dark:text-white/90">{t(`groups.${g.replace(/\./g, "_")}`)}</h3>
          <DataTable
            empty={c("empty")}
            columns={[
              { key: "name", label: t("message") },
              { key: "subject", label: t("subject") },
              { key: "updated", label: c("updated") },
            ]}
            rows={codes
              .filter(([, v]) => v.group === g)
              .map(([code]) => {
                const m = impl.get(code);
                return {
                  key: code,
                  cells: {
                    name: (
                      <Link href={`/admin/templates/${tplId}/${code.replace(/\./g, "-")}`} className="font-medium text-brand-500 hover:text-brand-600">
                        {t(`names.${code.replace(/\./g, "_")}`)}
                        {!m && (
                          <Badge size="sm" color="warning">
                            {t("notDefined")}
                          </Badge>
                        )}
                      </Link>
                    ),
                    subject: m?.subject ?? "—",
                    updated: m ? date(m.updated) : "—",
                  },
                };
              })}
          />
        </div>
      ))}
    </div>
  );
}
