"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { mergeAction, unlinkAction, type EditActionState } from "@/app/[locale]/(staff)/agent/(panel)/tickets/[id]/actions-edit";
import { useRouter } from "@/i18n/navigation";
import { tryAction } from "@/lib/try-action";

import EditDialog from "../EditDialog";
import { Check, Field, Select, TextInput } from "../inputs";
import type { RelatedItem } from "../types";

interface MergeDialogProps {
  ticketId: number;
  number: string;
  /** "merge" o "link" */
  title: "merge" | "link";
  /** ticket iniziali (il primo è il padre) */
  tickets: Pick<RelatedItem, "number" | "subject">[];
  /** ticket già collegati (scollegabili) */
  linked?: { id: number; number: string }[];
  closedStatuses: { id: number; name: string }[];
  defaultChildStatusId: number;
  parentStatuses: { id: number; name: string }[];
  /** tipo di merge attuale del ticket ("combine" | "separate" | "visual") */
  mergeType: string;
  onClose: () => void;
  onSuccess: (s: EditActionState) => void;
}

const row = "flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-theme-sm dark:border-gray-800";
const small = "rounded px-2 py-1 text-theme-xs text-gray-600 hover:bg-gray-100 disabled:opacity-30 dark:text-gray-400 dark:hover:bg-white/5";

/**
 * Dialogo di merge/link (templates/merge-tickets.tmpl.php): ticket in ordine (il primo è il padre),
 * aggiunta per numero, partecipanti, stato dei figli e del padre, tipo di merge, elimina figli,
 * sposta i task. Lo scollegamento dei ticket già collegati usa un form a parte (dtids).
 */
export default function MergeDialog(p: MergeDialogProps) {
  const t = useTranslations("ticketEdit");
  const [list, setList] = useState(p.tickets.map((x) => ({ number: x.number, subject: x.subject })));
  const [add, setAdd] = useState("");
  const move = (i: number, d: number) =>
    setList((l) => {
      const n = [...l];
      [n[i], n[i + d]] = [n[i + d], n[i]];
      return n;
    });
  const isMerge = p.title === "merge";
  return (
    <EditDialog ticketId={p.ticketId} title={t(isMerge ? "mergeTitle" : "linkTitle")} action={mergeAction} submitLabel={t("saveChanges")} onClose={p.onClose} onSuccess={p.onSuccess} wide>
      <input type="hidden" name="title" value={p.title} />
      <p className="text-theme-sm text-gray-600 dark:text-gray-400">{t(isMerge ? "mergeHelp" : "linkHelp")}</p>
      <ul className="space-y-2">
        {list.map((x, i) => (
          <li key={x.number} className={row}>
            <input type="hidden" name="tids" value={x.number} />
            <span className="font-medium text-gray-800 dark:text-white/90">#{x.number}</span>
            <span className="flex-1 truncate text-gray-600 dark:text-gray-400">{x.subject}</span>
            {i === 0 && <span className="rounded bg-brand-50 px-2 py-0.5 text-theme-xs text-brand-600 dark:bg-brand-500/15 dark:text-brand-400">{t("parent")}</span>}
            <button type="button" className={small} disabled={i === 0} onClick={() => move(i, -1)} aria-label={t("moveUp")}>
              ↑
            </button>
            <button type="button" className={small} disabled={i === list.length - 1} onClick={() => move(i, 1)} aria-label={t("moveDown")}>
              ↓
            </button>
            <button type="button" className={small} disabled={list.length < 2} onClick={() => setList((l) => l.filter((_, j) => j !== i))} aria-label={t("remove")}>
              ✕
            </button>
          </li>
        ))}
      </ul>
      <div className="flex items-end gap-2">
        <Field label={t("addTicket")}>
          <TextInput value={add} onChange={(e) => setAdd(e.target.value.trim())} placeholder={t("ticketNumber")} />
        </Field>
        <button
          type="button"
          disabled={!add || list.some((x) => x.number === add)}
          onClick={() => {
            setList((l) => [...l, { number: add, subject: "" }]);
            setAdd("");
          }}
          className="h-11 rounded-lg border border-gray-300 px-4 text-theme-sm text-gray-700 hover:bg-gray-50 disabled:opacity-40 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-white/5"
        >
          {t("add")}
        </button>
      </div>
      {isMerge && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t("participants")}>
            <Select name="participants" defaultValue="all" options={[{ value: "user", label: t("participantsUser") }, { value: "all", label: t("participantsAll") }]} />
          </Field>
          <Field label={t("childStatus")} hint={t("childStatusHint")}>
            <Select name="childStatusId" defaultValue={String(p.defaultChildStatusId)} options={p.closedStatuses.map((s) => ({ value: String(s.id), label: s.name }))} />
          </Field>
          <Field label={t("parentStatus")}>
            <Select name="parentStatusId" defaultValue="" empty={t("select")} options={p.parentStatuses.map((s) => ({ value: String(s.id), label: s.name }))} />
          </Field>
          <fieldset className="space-y-2">
            <legend className="text-theme-sm font-medium text-gray-700 dark:text-gray-400">{t("mergeType")}</legend>
            <label className="flex items-center gap-2 text-theme-sm text-gray-700 dark:text-gray-400">
              <input type="radio" name="combine" value="1" defaultChecked={p.mergeType !== "separate"} className="accent-brand-500" /> {t("combine")}
            </label>
            <label className="flex items-center gap-2 text-theme-sm text-gray-700 dark:text-gray-400">
              <input type="radio" name="combine" value="0" defaultChecked={p.mergeType === "separate"} className="accent-brand-500" /> {t("separate")}
            </label>
          </fieldset>
          <Check name="deleteChild" label={t("deleteChild")} />
          <Check name="moveTasks" label={t("moveTasks")} />
        </div>
      )}
      {p.linked && p.linked.length > 0 && <UnlinkList linked={p.linked} onDone={p.onClose} />}
    </EditDialog>
  );
}

/** Elenco dei ticket collegati con lo scollegamento (dtids[]): pulsanti con formAction dedicata. */
function UnlinkList({ linked, onDone }: { linked: { id: number; number: string }[]; onDone: () => void }) {
  const t = useTranslations("ticketEdit");
  const router = useRouter();
  // un errore di rete o del server resta nella finestra (la formAction gira in una transizione)
  const [failed, setFailed] = useState(false);
  return (
    <div className="space-y-2 border-t border-gray-100 pt-4 dark:border-gray-800">
      <p className="text-theme-sm font-medium text-gray-700 dark:text-gray-300">{t("linkedTickets")}</p>
      {failed && (
        <p role="alert" className="text-theme-xs text-error-600 dark:text-error-400">
          {t("errors.generic")}
        </p>
      )}
      <ul className="space-y-1">
        {linked.map((l) => (
          <li key={l.id} className="flex items-center justify-between text-theme-sm text-gray-700 dark:text-gray-300">
            <span>#{l.number}</span>
            <button
              type="submit"
              name="dtids"
              value={l.id}
              formAction={async (fd: FormData) => {
                setFailed(false);
                const res = await tryAction(() => unlinkAction({}, fd));
                if (!res.ok) return setFailed(true);
                onDone();
                router.refresh();
              }}
              formNoValidate
              className="text-theme-xs text-error-500 hover:underline"
            >
              {t("unlink")}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
