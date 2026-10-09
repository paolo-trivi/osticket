"use client";

import { useTranslations } from "next-intl";

import ComponentCard from "@/components/common/ComponentCard";
import RichTextEditor from "@/components/editor/RichTextEditor";
import AttachmentInput from "@/components/forms/AttachmentInput";
import FieldShell from "@/components/forms/dynamic/FieldShell";
import { selectCls } from "@/components/forms/dynamic/styles";

import { first, type NewTicketOptions, type SubmittedValues } from "./types";

interface Props {
  options: NewTicketOptions;
  values?: SubmittedValues;
  uploadUrl: string;
}

/** Risposta iniziale con allegati, stato del ticket e firma; nota interna. */
export default function ResponseSection({ options, values, uploadUrl }: Props) {
  const t = useTranslations("createTicket");
  const te = useTranslations("composer");
  const editorLabels = {
    bold: te("editor.bold"),
    italic: te("editor.italic"),
    underline: te("editor.underline"),
    bullets: te("editor.bullets"),
    numbers: te("editor.numbers"),
    link: te("editor.link"),
    quote: te("editor.quote"),
    linkPrompt: te("editor.linkPrompt"),
  };
  return (
    <>
      <ComponentCard title={t("sections.response")}>
        <RichTextEditor name="response" placeholder={t("response.placeholder")} labels={editorLabels} minHeight={120} defaultValue={first(values, "response")} />
        {options.maxFileSize > 0 && (
          <FieldShell label={t("response.attachments")}>
            <AttachmentInput name="responseFiles" uploadUrl={uploadUrl} maxSize={options.maxFileSize} />
          </FieldShell>
        )}
        <div className="grid gap-5 md:grid-cols-2">
          <FieldShell htmlFor="statusId" label={t("response.status")}>
            <select id="statusId" name="statusId" defaultValue={first(values, "statusId")} className={selectCls}>
              <option value="">{t("response.statusDefault")}</option>
              {options.statuses.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </FieldShell>
          <FieldShell htmlFor="signature" label={t("response.signature")}>
            <select id="signature" name="signature" defaultValue={first(values, "signature") || "none"} className={selectCls}>
              <option value="none">{t("response.sigNone")}</option>
              {options.hasMySignature && <option value="mine">{t("response.sigMine")}</option>}
              <option value="dept">{t("response.sigDept")}</option>
            </select>
          </FieldShell>
        </div>
      </ComponentCard>
      <ComponentCard title={t("sections.note")}>
        <RichTextEditor name="note" placeholder={t("note.placeholder")} labels={editorLabels} minHeight={100} defaultValue={first(values, "note")} />
      </ComponentCard>
    </>
  );
}
