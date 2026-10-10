"use client";

import { useTranslations } from "next-intl";
import { useRef, useState } from "react";

import { useReadOnlyHint } from "@/components/common/WriteGate";
import { Modal } from "@/components/ui/modal";
import { useCheckedCount } from "@/lib/checked-ids";

const IDS = 'input[name="ids[]"]';

const BTN = "rounded-lg px-3 py-2 text-sm font-medium ring-1 ring-inset disabled:cursor-not-allowed disabled:opacity-50";
const NEUTRAL = `${BTN} text-gray-700 ring-gray-300 hover:bg-gray-50 dark:text-gray-300 dark:ring-gray-700 dark:hover:bg-white/5 disabled:hover:bg-transparent`;
const DANGER = `${BTN} text-error-600 ring-error-300 hover:bg-error-50 dark:text-error-400 dark:ring-error-500/40 dark:hover:bg-error-500/10 disabled:hover:bg-transparent`;

/**
 * Pulsanti delle azioni di massa (mass_process di scp/*.php) dentro il <form> della lista: ogni
 * pulsante invia `a=<azione>` con gli `ids[]` selezionati. Senza selezione i pulsanti sono
 * disattivati; le azioni pericolose chiedono conferma in una finestra modale.
 */
export default function MassBar({ actions }: { actions: { value: string; label: string; danger?: boolean }[] }) {
  const t = useTranslations("admUi");
  const count = useCheckedCount(IDS);
  // amministrazione non scrivibile: tutte le azioni disattivate, il motivo nel tooltip
  const readOnly = useReadOnlyHint("admin");
  const [pending, setPending] = useState<{
    button: HTMLButtonElement;
    label: string;
  } | null>(null);
  const close = () => setPending(null);
  const confirm = () => {
    const button = pending?.button;
    setPending(null);
    // requestSubmit con il pulsante come submitter: arriva anche `a=<azione>`
    button?.form?.requestSubmit(button);
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="me-2 flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
        <SelectAll label={t("selectAll")} />
        {t("selectAll")}
      </label>
      <span className="me-2 text-sm text-gray-500 dark:text-gray-400" aria-live="polite">
        {t("selectedCount", { n: count })}
      </span>
      {actions.map((a) => (
        <button
          key={a.value}
          type="submit"
          name="a"
          value={a.value}
          // "sort" (ordinamento degli argomenti) non richiede una selezione
          disabled={!!readOnly || (count === 0 && a.value !== "sort")}
          title={readOnly}
          onClick={(e) => {
            if (!a.danger) return;
            e.preventDefault();
            setPending({ button: e.currentTarget, label: a.label });
          }}
          className={a.danger ? DANGER : NEUTRAL}
        >
          {a.label}
        </button>
      ))}
      <Modal isOpen={!!pending} onClose={close} className="m-4 max-w-[480px] p-6 lg:p-8">
        <div className="space-y-5">
          <h4 className="pe-12 text-title-sm font-semibold text-gray-800 dark:text-white/90">{t("confirmTitle")}</h4>
          <p className="text-theme-sm text-gray-700 dark:text-gray-300">{t("confirmAction", { action: pending?.label ?? "", n: count })}</p>
          <div className="flex justify-end gap-3">
            <button type="button" onClick={close} className={NEUTRAL}>
              {t("cancel")}
            </button>
            <button type="button" onClick={confirm} className={DANGER}>
              {pending?.label}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

/**
 * Casella "seleziona tutto" per gli ids[] del form (le righe disattivate restano escluse). Impostare
 * .checked non emette eventi: ogni riga cambiata emette "change", così il conteggio si aggiorna.
 */
function SelectAll({ label }: { label: string }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={label}
      className="h-4 w-4 accent-brand-500"
      onChange={(e) => {
        const on = e.currentTarget.checked;
        ref.current?.form?.querySelectorAll<HTMLInputElement>(IDS).forEach((c) => {
          if (c.disabled || c.checked === on) return;
          c.checked = on;
          c.dispatchEvent(new Event("change", { bubbles: true }));
        });
      }}
    />
  );
}
