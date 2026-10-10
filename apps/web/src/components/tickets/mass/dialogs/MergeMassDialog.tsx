"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { massMergeAction, massMergeCandidatesAction } from "@/app/[locale]/(staff)/agent/(panel)/tickets/actions-mass";
import { Check, Field, Select } from "@/components/tickets/edit/inputs";

import MassDialog from "../MassDialog";
import type { MassData, MassDialogProps } from "../types";

interface MergeMassDialogProps extends MassDialogProps {
  title: "merge" | "link";
  data: MassData;
}

/** Unione o collegamento dei ticket selezionati: ordine (il primo è il padre) e opzioni dell'unione. */
export default function MergeMassDialog({ ids, title, data, onClose, onSuccess }: MergeMassDialogProps) {
  const t = useTranslations("ticketEdit");
  const tm = useTranslations("ticketEdit.mass");
  const [list, setList] = useState<{ id: number; number: string; subject: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void massMergeCandidatesAction(ids, title).then((r) => {
      if ("error" in r) setError(r.error);
      else setList(r.tickets);
    });
  }, [ids, title]);
  const move = (i: number, d: number) =>
    setList((l) => {
      if (!l) return l;
      const c = [...l];
      [c[i], c[i + d]] = [c[i + d], c[i]];
      return c;
    });
  const isMerge = title === "merge";
  return (
    <MassDialog ids={ids} onClose={onClose} onSuccess={onSuccess} title={t(isMerge ? "mergeTitle" : "linkTitle")} action={massMergeAction} submitLabel={t("saveChanges")} wide>
      <input type="hidden" name="title" value={title} />
      {error && <p className="text-theme-sm text-error-600 dark:text-error-400">{tm.has(`errors.${error}`) ? tm(`errors.${error}`) : t("errors.generic")}</p>}
      {list && (
        <ul className="space-y-2">
          {list.map((x, i) => (
            <li key={x.id} className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-theme-sm dark:border-gray-800">
              <input type="hidden" name="numbers" value={x.number} />
              <span className="font-medium text-gray-800 dark:text-white/90">#{x.number}</span>
              <span className="flex-1 truncate text-gray-600 dark:text-gray-400">{x.subject}</span>
              {i === 0 && <span className="rounded bg-brand-50 px-2 py-0.5 text-theme-xs text-brand-600 dark:bg-brand-500/15 dark:text-brand-400">{t("parent")}</span>}
              <button type="button" disabled={i === 0} onClick={() => move(i, -1)} aria-label={t("moveUp")} className="rounded px-2 py-1 text-theme-xs disabled:opacity-30">
                ↑
              </button>
              <button type="button" disabled={i === list.length - 1} onClick={() => move(i, 1)} aria-label={t("moveDown")} className="rounded px-2 py-1 text-theme-xs disabled:opacity-30">
                ↓
              </button>
            </li>
          ))}
        </ul>
      )}
      {isMerge && list && <MergeOptions data={data} />}
    </MassDialog>
  );
}

/** Opzioni dell'unione: partecipanti, stati di figli e padre, tipo di unione, eliminazione e task. */
function MergeOptions({ data }: { data: MassData }) {
  const t = useTranslations("ticketEdit");
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Field label={t("participants")}>
        <Select name="participants" defaultValue="all" options={[{ value: "user", label: t("participantsUser") }, { value: "all", label: t("participantsAll") }]} />
      </Field>
      <Field label={t("childStatus")}>
        <Select name="childStatusId" defaultValue={String(data.defaultChildStatusId)} options={data.closedStatuses.map((s) => ({ value: String(s.id), label: s.name }))} />
      </Field>
      <Field label={t("parentStatus")}>
        <Select name="parentStatusId" defaultValue="" empty={t("select")} options={data.parentStatuses.map((s) => ({ value: String(s.id), label: s.name }))} />
      </Field>
      <fieldset className="space-y-2">
        <legend className="text-theme-sm font-medium text-gray-700 dark:text-gray-400">{t("mergeType")}</legend>
        <label className="flex items-center gap-2 text-theme-sm text-gray-700 dark:text-gray-400">
          <input type="radio" name="combine" value="1" defaultChecked className="accent-brand-500" /> {t("combine")}
        </label>
        <label className="flex items-center gap-2 text-theme-sm text-gray-700 dark:text-gray-400">
          <input type="radio" name="combine" value="0" className="accent-brand-500" /> {t("separate")}
        </label>
      </fieldset>
      <Check name="deleteChild" label={t("deleteChild")} />
      <Check name="moveTasks" label={t("moveTasks")} />
    </div>
  );
}
