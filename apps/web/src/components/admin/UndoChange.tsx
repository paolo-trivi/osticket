"use client";

import { Undo2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { undoChangeAction } from "@/app/[locale]/(staff)/admin/changes/actions";
import { Link, usePathname, useRouter } from "@/i18n/navigation";
import { MAX_CHANGE_ROWS, type ChangeRef, type UndoState } from "@/lib/changes";
import { tryAction } from "@/lib/try-action";

const BTN =
  "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium ring-1 ring-current/40 ring-inset hover:bg-white/60 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-white/5";

/**
 * "Annulla modifica" sotto l'esito di un salvataggio admin (AdminForm, SysForm, AdminNotice, SysNotice,
 * tema, Modifiche recenti). Modifica non annullabile: il motivo. Dopo l'annullamento:
 *  - `inline`: `onUndone` (il form si ricarica con i valori ripristinati e mostra l'esito, useUndoReload);
 *  - altrimenti si torna alla pagina (o, con `leave`, a quella superiore: l'elemento creato non esiste
 *    più) con ?ok=undone, mostrato dal banner d'esito della pagina.
 * `disabled`: annullamento non consentito dalla modalità (motivo nel tooltip).
 */
export default function UndoChange({
  change,
  inline = false,
  leave = false,
  disabled,
  onUndone,
}: {
  change: ChangeRef;
  inline?: boolean;
  leave?: boolean;
  disabled?: string;
  onUndone?: () => void;
}) {
  const t = useTranslations("admChanges");
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<UndoState | null>(null);

  if (!change.undoable) {
    return (
      <p className="mt-2 text-theme-xs">
        {t("notUndoable", { reason: t(`reasons.${change.reason ?? "capture_failed"}`, { max: MAX_CHANGE_ROWS }) })}{" "}
        <Link href="/admin/changes" className="underline">
          {t("recentLink")}
        </Link>
      </p>
    );
  }
  // inline: l'esito "Modifica annullata" lo mostra il form al posto di "Modifiche salvate" (useUndoReload)
  if (state?.status === "done") return null;

  const undo = () =>
    startTransition(async () => {
      const res = await tryAction(() => undoChangeAction(change.id));
      const next: UndoState = res.ok ? res.value : { status: "error", error: "failed" };
      setState(next);
      if (next.status !== "done") return;
      if (inline) onUndone?.();
      else router.replace(`${leave ? pathname.replace(/\/[^/]+$/, "") || "/admin" : pathname}?ok=undone`);
    });

  return (
    <div className="mt-3 space-y-2">
      <button type="button" onClick={undo} disabled={pending || !!disabled} title={disabled} className={BTN}>
        <Undo2 className="size-4" aria-hidden />
        {pending ? t("undoing") : t("undo")}
      </button>
      {state?.status === "error" && (
        <div role="alert" className="text-theme-xs">
          <p>{t(`errors.${state.error}`)}</p>
          {!!state.conflicts?.length && <p className="mt-1">{t("conflictRows", { rows: state.conflicts.join("; ") })}</p>}
        </div>
      )}
    </div>
  );
}
