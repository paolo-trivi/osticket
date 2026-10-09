"use client";

import { useTranslations } from "next-intl";
import { useActionState, useEffect } from "react";

import { profileUpdateAction } from "@/app/[locale]/(staff)/agent/(panel)/profile/actions";
import ComponentCard from "@/components/common/ComponentCard";
import Button from "@/components/ui/button/Button";
import { useRouter } from "@/i18n/navigation";

import { CheckField, FormAlert, SelectField, TextAreaField, TextField } from "../FormControls";
import type { Choice, PeopleActionState } from "../types";

export interface ProfileFormData {
  firstname: string;
  lastname: string;
  email: string;
  phone: string;
  phone_ext: string;
  mobile: string;
  signature: string;
  timezone: string;
  locale: string;
  lang: string;
  max_page_size: number;
  auto_refresh_rate: number;
  default_signature_type: string;
  default_paper_size: string;
  onvacation: boolean;
  datetime_format: string;
  default_from_name: string;
  default_2fa: string;
  twofaVerified: boolean;
  twofaRequired: boolean;
  thread_view_order: string;
  default_ticket_queue_id: number;
  reply_redirect: string;
  img_att_view: string;
  editor_spacing: string;
  hideStaffName: boolean;
  systemPageSize: number;
  queues: Choice[];
  timezones: string[];
  languages: Choice[];
  locales: Choice[];
}

/** Form del profilo (include/staff/profile.inc.php): account, preferenze, localizzazione, firma. */
export default function ProfileForm({ data }: { data: ProfileFormData }) {
  const t = useTranslations("peopleProfile");
  const tu = useTranslations("peopleUi");
  const router = useRouter();
  const [state, action, pending] = useActionState<PeopleActionState, FormData>(profileUpdateAction, {});
  useEffect(() => {
    if (state.ok) router.refresh();
  }, [state, router]);
  const f = state.fields ?? {};
  const pageSizes = Array.from({ length: 10 }, (_, i) => (i + 1) * 5).map((n) => ({ id: n, name: t("records", { n }) }));
  const refresh: Choice[] = [];
  for (let i = 1, y = 1; i <= 30; i += y) {
    refresh.push({ id: i, name: t("everyMinutes", { n: i }) });
    if (i > 9) y = 2;
  }
  const error = state.error ? (tu.has(`errors.${state.error}`) ? tu(`errors.${state.error}`) : tu("errors.generic")) : "";

  return (
    <form action={action} className="space-y-6">
      {error && <FormAlert kind="error">{error}</FormAlert>}
      {state.ok && <FormAlert kind="success">{t("saved")}</FormAlert>}
      <ComponentCard title={t("account")}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField name="firstname" label={t("firstname")} defaultValue={data.firstname} required maxLength={64} error={f.firstname} />
          <TextField name="lastname" label={t("lastname")} defaultValue={data.lastname} required maxLength={64} error={f.lastname} />
          <TextField name="email" type="email" label={t("email")} defaultValue={data.email} required maxLength={64} error={f.email} />
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <TextField name="phone" type="tel" label={t("phone")} defaultValue={data.phone} error={f.phone} />
            </div>
            <TextField name="phone_ext" label={t("ext")} defaultValue={data.phone_ext} />
          </div>
          <TextField name="mobile" type="tel" label={t("mobile")} defaultValue={data.mobile} error={f.mobile} />
          <SelectField
            name="default_2fa"
            label={t("default2fa")}
            defaultValue={data.twofaVerified ? data.default_2fa : ""}
            options={[...(data.twofaRequired ? [] : [{ id: "", name: t("disabled2fa") }]), ...(data.twofaVerified ? [{ id: "2fa-email", name: t("email2fa") }] : [])]}
          />
        </div>
        <div className="mt-4">
          <CheckField name="onvacation" label={t("onVacation")} defaultChecked={data.onvacation} />
        </div>
      </ComponentCard>

      <ComponentCard title={t("preferences")}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <SelectField name="max_page_size" label={t("pageSize")} defaultValue={data.max_page_size || data.systemPageSize} options={[{ id: 0, name: t("systemDefault") }, ...pageSizes]} />
          <SelectField name="auto_refresh_rate" label={t("refreshRate")} defaultValue={data.auto_refresh_rate} options={[{ id: 0, name: t("disabled") }, ...refresh]} />
          <SelectField
            name="default_from_name"
            label={t("fromName")}
            defaultValue={data.default_from_name}
            options={[
              { id: "email", name: t("fromEmail") },
              { id: "dept", name: t("fromDept") },
              ...(data.hideStaffName ? [] : [{ id: "mine", name: t("fromMine") }]),
              { id: "", name: t("systemDefault") },
            ]}
          />
          <SelectField name="default_ticket_queue_id" label={t("defaultQueue")} defaultValue={data.default_ticket_queue_id} options={[{ id: 0, name: t("systemDefault") }, ...data.queues]} />
          <SelectField
            name="thread_view_order"
            label={t("threadOrder")}
            defaultValue={data.thread_view_order}
            options={[
              { id: "desc", name: t("descending") },
              { id: "asc", name: t("ascending") },
              { id: "", name: t("systemDefault") },
            ]}
          />
          <SelectField
            name="default_signature_type"
            label={t("defaultSignature")}
            defaultValue={data.default_signature_type}
            error={f.default_signature_type}
            options={[
              { id: "none", name: t("none") },
              { id: "mine", name: t("mySignature") },
              { id: "dept", name: t("deptSignature") },
            ]}
          />
          <SelectField name="default_paper_size" label={t("paperSize")} defaultValue={data.default_paper_size} options={[{ id: "none", name: t("none") }, ...["Letter", "Legal", "A4", "A3"].map((p) => ({ id: p, name: p }))]} />
          <SelectField
            name="reply_redirect"
            label={t("replyRedirect")}
            defaultValue={data.reply_redirect}
            options={[
              { id: "Queue", name: t("queue") },
              { id: "Ticket", name: t("ticket") },
            ]}
          />
          <SelectField
            name="img_att_view"
            label={t("imageView")}
            defaultValue={data.img_att_view}
            options={[
              { id: "download", name: t("download") },
              { id: "inline", name: t("inline") },
            ]}
          />
          <SelectField
            name="editor_spacing"
            label={t("editorSpacing")}
            defaultValue={data.editor_spacing}
            options={[
              { id: "double", name: t("double") },
              { id: "single", name: t("single") },
            ]}
          />
        </div>
      </ComponentCard>

      <ComponentCard title={t("localization")}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <SelectField name="timezone" label={t("timezone")} defaultValue={data.timezone} placeholder={t("systemDefault")} options={data.timezones.map((z) => ({ id: z, name: z }))} />
          <SelectField
            name="datetime_format"
            label={t("timeFormat")}
            defaultValue={data.datetime_format}
            options={[
              { id: "relative", name: t("relative") },
              { id: "", name: t("systemDefault") },
            ]}
          />
          <SelectField name="lang" label={t("language")} defaultValue={data.lang} placeholder={t("browserLanguage")} options={data.languages} />
          <SelectField name="locale" label={t("locale")} defaultValue={data.locale} placeholder={t("languageLocale")} options={data.locales} />
        </div>
      </ComponentCard>

      <ComponentCard title={t("signature")}>
        <TextAreaField name="signature" defaultValue={data.signature} rows={4} hint={t("signatureHint")} />
      </ComponentCard>

      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? tu("working") : t("save")}
        </Button>
      </div>
    </form>
  );
}
