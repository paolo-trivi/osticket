"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { Field, Select } from "@/components/tickets/edit/inputs";
import Button from "@/components/ui/button/Button";
import { Modal } from "@/components/ui/modal";
import { withBase } from "@/lib/base-path";
import { cn } from "@/utils";

import type { MassData } from "../types";

/** Dialogo di export (templates/queue-export.tmpl.php): campi, separatore, download del CSV. */
export default function ExportMassDialog({ data, onClose }: { data: MassData; onClose: () => void }) {
  const t = useTranslations("ticketEdit.mass");
  const te = useTranslations("ticketEdit");
  const [fields, setFields] = useState(data.exportFields.map((f) => f.path));
  const [delimiter, setDelimiter] = useState(",");
  const params = new URLSearchParams({ queue: String(data.queueId), delimiter });
  if (data.sort) params.set("sort", data.sort);
  if (data.dir) params.set("dir", data.dir);
  for (const f of fields) params.append("fields", f);
  const href = withBase(`/api/agent/tickets/export?${params.toString()}`);
  const toggle = (path: string, on: boolean) =>
    setFields((l) => (on ? data.exportFields.map((x) => x.path).filter((p) => l.includes(p) || p === path) : l.filter((p) => p !== path)));
  return (
    <Modal isOpen onClose={onClose} className="m-4 max-w-[760px] p-6 lg:p-8">
      <div className="max-h-[80vh] space-y-5 overflow-y-auto pe-1 custom-scrollbar">
        <h4 className="pe-12 text-title-sm font-semibold text-gray-800 dark:text-white/90">{t("exportTitle", { queue: data.queueName })}</h4>
        <p className="text-theme-sm text-gray-600 dark:text-gray-400">{t("exportHelp")}</p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {data.exportFields.map((f) => (
            <label key={f.path} className="flex items-center gap-2 text-theme-sm text-gray-700 dark:text-gray-400">
              <input type="checkbox" checked={fields.includes(f.path)} onChange={(e) => toggle(f.path, e.target.checked)} className="size-4 accent-brand-500" />
              {f.label}
            </label>
          ))}
        </div>
        <Field label={t("delimiter")}>
          <Select
            value={delimiter}
            onChange={setDelimiter}
            options={[
              { value: ",", label: t("delimiters.comma") },
              { value: ";", label: t("delimiters.semicolon") },
              { value: "\t", label: t("delimiters.tab") },
              { value: "|", label: t("delimiters.pipe") },
            ]}
          />
        </Field>
        <div className="flex items-center justify-end gap-3">
          <Button size="sm" variant="outline" onClick={onClose}>
            {te("cancel")}
          </Button>
          <a
            href={fields.length ? href : undefined}
            aria-disabled={!fields.length}
            onClick={() => setTimeout(onClose, 300)}
            className={cn("inline-flex rounded-lg bg-brand-500 px-4 py-3 text-sm font-medium text-white hover:bg-brand-600", !fields.length && "pointer-events-none opacity-50")}
          >
            {t("download")}
          </a>
        </div>
      </div>
    </Modal>
  );
}
