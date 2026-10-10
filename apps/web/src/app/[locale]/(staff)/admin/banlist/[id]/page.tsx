import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";

import BackLink from "@/components/adminsys/BackLink";
import { Hidden, RadioField, Section, TextAreaField, TextField } from "@/components/adminsys/fields";
import SysForm from "@/components/adminsys/SysForm";
import { PageHeader } from "@/components/common/DataTable";
import { idOrNotFound } from "@/lib/route-id";
import { db } from "@/server/db";
import { banlistFilterId } from "@/server/domain/adminsys/banlist";

import { requireAdmin } from "../../guard";
import { updateBanAction } from "../actions";
import { adminMetadata } from "../../metadata";

export const generateMetadata = adminMetadata("banlist");

export default async function EditBanPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  await requireAdmin(locale);
  const t = await getTranslations("asys.banlist");
  const c = await getTranslations("asys.common");
  const ruleId = idOrNotFound(id);
  const filterId = await banlistFilterId(db());
  const rule =
    filterId
      ? await db().selectFrom("filter_rule").selectAll().where("id", "=", ruleId).where("filter_id", "=", filterId).executeTakeFirst()
      : null;
  if (!rule) notFound();
  return (
    <div className="space-y-6">
      <PageHeader title={rule.val} subtitle={t("edit")} actions={<BackLink href="/admin/banlist" label={c("back")} />} />
      <SysForm action={updateBanAction.bind(null, ruleId)} labels={{ val: t("email") }}>
        <Section title={t("edit")}>
          <Hidden name="do" value="update" />
          <TextField name="val" label={t("email")} value={rule.val} type="email" required />
          <RadioField
            name="isactive"
            label={t("status")}
            value={rule.isactive ? "1" : "0"}
            options={[
              { value: "1", label: c("active") },
              { value: "0", label: c("disabled") },
            ]}
          />
          <TextAreaField name="notes" label={t("notes")} value={rule.notes} rows={3} />
        </Section>
      </SysForm>
    </div>
  );
}
