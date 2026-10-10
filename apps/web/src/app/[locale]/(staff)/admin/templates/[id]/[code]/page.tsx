import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";

import BackLink from "@/components/adminsys/BackLink";
import { Hidden, Section, TextAreaField, TextField } from "@/components/adminsys/fields";
import SysForm from "@/components/adminsys/SysForm";
import SysNotice from "@/components/adminsys/SysNotice";
import Callout from "@/components/common/Callout";
import { PageHeader } from "@/components/common/DataTable";
import { Link } from "@/i18n/navigation";
import { idOrNotFound } from "@/lib/route-id";
import { db } from "@/server/db";
import { initialTemplate, loadGroup, TEMPLATE_NAMES } from "@/server/domain/adminsys/template";

import { requireAdmin } from "../../../guard";
import { saveTemplateAction } from "../../actions";
import { adminMetadata } from "../../../metadata";

export const generateMetadata = adminMetadata("templates");

/** Modifica (updatetpl) o definizione (implement) di un messaggio del set (include/staff/tpl.inc.php). */
export default async function TemplateMessagePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; id: string; code: string }>;
  searchParams: Promise<Record<string, string>>;
}) {
  const { locale, id, code: rawCode } = await params;
  setRequestLocale(locale);
  await requireAdmin(locale);
  // nell'URL i punti del codice diventano trattini (i percorsi con un punto non passano dal middleware i18n)
  const code = decodeURIComponent(rawCode).replace(/-/g, ".");
  const tplId = idOrNotFound(id);
  const group = await loadGroup(db(), tplId);
  if (!group || !TEMPLATE_NAMES[code]) notFound();
  const t = await getTranslations("asys.templates");
  const sp = await searchParams;
  const msg = await db().selectFrom("email_template").selectAll().where("tpl_id", "=", tplId).where("code_name", "=", code).executeTakeFirst();
  const initial = !msg || sp.default ? initialTemplate(code, group.lang) : null;
  const subject = initial?.subject ?? msg?.subject ?? "";
  const body = initial?.body ?? msg?.body ?? "";
  const vars = [...new Set([...`${subject} ${body}`.matchAll(/%\{([^}]*)\}/g)].map((m) => m[1]))];
  const unknown = vars.filter((v) => !TEMPLATE_NAMES[code].context.some((ctx) => v === ctx || v.startsWith(`${ctx}.`)) && !["company", "url"].some((g) => v === g || v.startsWith(`${g}.`)));
  return (
    <div className="space-y-6">
      <PageHeader title={t(`names.${code.replace(/\./g, "_")}`)} subtitle={`${group.name} — ${code}`} actions={<BackLink href={`/admin/templates/${tplId}`} label={t("backToSet")} />} />
      <SysNotice sp={sp} />
      {!msg && <Callout tone="info">{t("implementNote")}</Callout>}
      {sp.default && msg && <Callout tone="warning">{t("defaultLoaded")}</Callout>}
      {unknown.length > 0 && (
        <Callout tone="warning">
          {t("invalidVars")} <code>{unknown.map((v) => `%{${v}}`).join(", ")}</code>
        </Callout>
      )}
      <SysForm
        key={sp.default ? "default" : "current"}
        action={saveTemplateAction.bind(null, tplId, code, msg?.id ?? null)}
        labels={{ subject: t("subject"), body: t("body"), tpl_id: t("set"), code_name: t("message") }}
        extraButtons={
          msg && !sp.default ? (
            <Link href={`/admin/templates/${tplId}/${code.replace(/\./g, "-")}?default=1`} className="rounded-lg px-4 py-2.5 text-sm font-medium text-gray-700 ring-1 ring-gray-300 ring-inset hover:bg-gray-50 dark:text-gray-300 dark:ring-gray-700 dark:hover:bg-white/5">
              {t("loadDefault")}
            </Link>
          ) : undefined
        }
      >
        <Section title={t("subjectAndBody")} desc={t("variablesHint", { contexts: TEMPLATE_NAMES[code].context.join(", ") })}>
          <Hidden name="do" value={msg ? "updatetpl" : "implement"} />
          <TextField name="subject" label={t("subject")} value={subject} wide />
          <TextAreaField name="body" label={t("body")} value={body} rows={18} mono hint={t("bodyHint")} />
        </Section>
      </SysForm>
    </div>
  );
}
