"use client";

import { ArrowDown, ArrowUp, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { mergeAction, searchTicketsAction, unlinkAction, type EditActionState } from "@/app/[locale]/(staff)/agent/(panel)/tickets/[id]/actions-edit";
import SuggestPicker from "@/components/tickets/SuggestPicker";
import { useRouter } from "@/i18n/navigation";
import { tryAction } from "@/lib/try-action";
import type { TicketNumberHit } from "@/server/domain/ticket/merge";

import EditDialog from "../EditDialog";
import { Check, Field, Select } from "../inputs";
import type { RelatedItem } from "../types";
import { useClearableAction } from "../use-clearable-action";

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
const small = "rounded p-1.5 text-gray-600 hover:bg-gray-100 disabled:opacity-30 dark:text-gray-400 dark:hover:bg-white/5";

/**
 * Dialogo di merge/link (templates/merge-tickets.tmpl.php): ticket in ordine (il primo è il padre),
 * aggiunta per numero (number-lookup), partecipanti, stato dei figli e del padre, tipo di merge, elimina figli,
 * sposta i task. Lo scollegamento dei ticket già collegati usa un form a parte (dtids).
 */
export default function MergeDialog(p: MergeDialogProps) {
  const t = useTranslations("ticketEdit");
  const [list, setList] = useState(p.tickets.map((x) => ({ number: x.number, subject: x.subject })));
  // ticket già collegati tolti dall'elenco (dtids[]): salvando vengono scollegati
  const [unlinked, setUnlinked] = useState<{ id: number; number: string }[]>([]);
  const [addError, setAddError] = useState<string | null>(null);
  // opzioni fuori dal dialogo: restano se il dialogo si rimonta per azzerare l'errore
  const [opts, setOpts] = useState({
    participants: "all",
    childStatusId: String(p.defaultChildStatusId),
    parentStatusId: "",
    combine: p.mergeType === "separate" ? "0" : "1",
    deleteChild: false,
    moveTasks: false,
  });
  const set = (k: keyof typeof opts) => (v: string | boolean) => setOpts((o) => ({ ...o, [k]: v }));
  // l'errore dell'elenco ("Servono almeno due ticket") sparisce quando l'elenco cambia
  const merge = useClearableAction(mergeAction);
  const change = (fn: (l: typeof list) => typeof list) => {
    setList(fn);
    merge.clear();
  };
  const move = (i: number, d: number) =>
    change((l) => {
      const n = [...l];
      [n[i], n[i + d]] = [n[i + d], n[i]];
      return n;
    });
  const remove = (i: number) => {
    const linked = p.linked?.find((l) => l.number === list[i].number);
    if (linked) setUnlinked((u) => [...u, linked]);
    change((l) => l.filter((_, j) => j !== i));
  };
  const add = (hit: TicketNumberHit) => {
    // merge-tickets.tmpl.php: i ticket già uniti non si aggiungono a mano
    if (hit.mergeType !== "visual") return setAddError(t("mergedNoAdd"));
    if (list.some((x) => x.number === hit.number)) return setAddError(t("alreadyInList"));
    setAddError(null);
    setUnlinked((u) => u.filter((x) => x.number !== hit.number));
    change((l) => [...l, { number: hit.number, subject: hit.subject }]);
  };
  const isMerge = p.title === "merge";
  return (
    <EditDialog
      key={merge.key}
      ticketId={p.ticketId}
      title={t(isMerge ? "mergeTitle" : "linkTitle")}
      action={merge.action}
      submitLabel={t("saveChanges")}
      onClose={p.onClose}
      onSuccess={p.onSuccess}
      warning={
        unlinked.length > 0
          ? t("unlinkWarning", {
              numbers: unlinked.map((u) => `#${u.number}`).join(", "),
            })
          : undefined
      }
      wide
    >
      <input type="hidden" name="title" value={p.title} />
      {unlinked.map((u) => (
        <input key={u.id} type="hidden" name="dtids" value={u.id} />
      ))}
      <p className="text-theme-sm text-gray-600 dark:text-gray-400">{t(isMerge ? "mergeHelp" : "linkHelp")}</p>
      <ul className="space-y-2">
        {list.map((x, i) => (
          <li key={x.number} className={row}>
            <input type="hidden" name="tids" value={x.number} />
            <span className="font-medium text-gray-800 dark:text-white/90">#{x.number}</span>
            <span className="flex-1 truncate text-gray-600 dark:text-gray-400">{x.subject}</span>
            {i === 0 && <span className="rounded bg-brand-50 px-2 py-0.5 text-theme-xs text-brand-600 dark:bg-brand-500/15 dark:text-brand-400">{t("parent")}</span>}
            <button type="button" className={small} disabled={i === 0} onClick={() => move(i, -1)} aria-label={`${t("moveUp")} #${x.number}`}>
              <ArrowUp className="size-4" />
            </button>
            <button type="button" className={small} disabled={i === list.length - 1} onClick={() => move(i, 1)} aria-label={`${t("moveDown")} #${x.number}`}>
              <ArrowDown className="size-4" />
            </button>
            <button type="button" className={small} disabled={list.length < 2} onClick={() => remove(i)} aria-label={`${t("remove")} #${x.number}`}>
              <X className="size-4" />
            </button>
          </li>
        ))}
      </ul>
      <div className="space-y-1.5">
        <label htmlFor="merge-add" className="block text-theme-sm font-medium text-gray-700 dark:text-gray-400">
          {t("addTicket")}
        </label>
        <SuggestPicker
          id="merge-add"
          placeholder={t("ticketNumber")}
          search={searchTicketsAction}
          minLength={3}
          noResults={t("noTickets")}
          onPick={add}
          exclude={[p.ticketId]}
          render={(h) => (
            <span className={list.some((x) => x.number === h.number) ? "opacity-50" : undefined}>
              <span className="font-medium text-gray-800 dark:text-white/90">#{h.number}</span> <span className="text-gray-600 dark:text-gray-400">{h.subject}</span>
              {h.user && <span className="block text-theme-xs text-gray-500 dark:text-gray-400">{h.user}</span>}
            </span>
          )}
        />
        {addError && (
          <p role="alert" className="text-theme-xs text-error-600 dark:text-error-400">
            {addError}
          </p>
        )}
      </div>
      {isMerge && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t("participants")}>
            <Select
              name="participants"
              defaultValue={opts.participants}
              onChange={set("participants")}
              options={[
                { value: "user", label: t("participantsUser") },
                { value: "all", label: t("participantsAll") },
              ]}
            />
          </Field>
          <Field label={t("childStatus")} hint={t("childStatusHint")}>
            <Select
              name="childStatusId"
              defaultValue={opts.childStatusId}
              onChange={set("childStatusId")}
              options={p.closedStatuses.map((s) => ({
                value: String(s.id),
                label: s.name,
              }))}
            />
          </Field>
          <Field label={t("parentStatus")}>
            <Select
              name="parentStatusId"
              defaultValue={opts.parentStatusId}
              onChange={set("parentStatusId")}
              empty={t("select")}
              options={p.parentStatuses.map((s) => ({
                value: String(s.id),
                label: s.name,
              }))}
            />
          </Field>
          <fieldset className="space-y-2">
            <legend className="text-theme-sm font-medium text-gray-700 dark:text-gray-400">{t("mergeType")}</legend>
            <label className="flex items-center gap-2 text-theme-sm text-gray-700 dark:text-gray-400">
              <input type="radio" name="combine" value="1" defaultChecked={opts.combine === "1"} onChange={() => set("combine")("1")} className="accent-brand-500" /> {t("combine")}
            </label>
            <label className="flex items-center gap-2 text-theme-sm text-gray-700 dark:text-gray-400">
              <input type="radio" name="combine" value="0" defaultChecked={opts.combine === "0"} onChange={() => set("combine")("0")} className="accent-brand-500" /> {t("separate")}
            </label>
          </fieldset>
          <Check name="deleteChild" label={t("deleteChild")} defaultChecked={opts.deleteChild} onChange={set("deleteChild")} />
          <Check name="moveTasks" label={t("moveTasks")} defaultChecked={opts.moveTasks} onChange={set("moveTasks")} />
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
