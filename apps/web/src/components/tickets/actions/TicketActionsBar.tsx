"use client";

import { useTranslations } from "next-intl";
import { useCallback, useState, type ReactNode } from "react";

import type { TicketActionState } from "@/app/[locale]/(staff)/agent/(panel)/tickets/[id]/actions-assign";
import { Dropdown } from "@/components/ui/dropdown/Dropdown";
import { DropdownItem } from "@/components/ui/dropdown/DropdownItem";
import { useRouter } from "@/i18n/navigation";
import { ChevronDownIcon } from "@/icons";
import { cn } from "@/utils";

import ActionDialogs from "./ActionDialogs";
import type { ActionKind, ActionNotice, TicketActionsData } from "./types";

const itemClass =
  "block w-full rounded-lg px-3 py-2 text-start text-theme-sm text-gray-700 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-gray-300";

const buttonClass =
  "inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-theme-sm text-gray-700 hover:bg-gray-50 dark:border-gray-800 dark:text-gray-400 dark:hover:bg-white/5";

/** Pulsante con menu a discesa (stile TailAdmin). */
function MenuButton({ label, children }: { label: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <div className="relative">
      <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} className={cn("dropdown-toggle", buttonClass)}>
        {label}
        <ChevronDownIcon className={cn("size-4 transition-transform", open && "rotate-180")} />
      </button>
      <Dropdown isOpen={open} onClose={close} className="w-60 p-2">
        {children(close)}
      </Dropdown>
    </div>
  );
}

/**
 * Barra azioni della vista ticket: assegna, trasferisci, stato, altro. Dopo un'azione riuscita segue i
 * data-redirect di ticket-view.inc.php/status-options.tmpl.php: assegnazione, trasferimento e chiusura
 * tornano alla lista dei ticket; presa in carico, rilascio, segna risposto, referral e riapertura
 * ricaricano la vista e mostrano l'esito.
 */
export default function TicketActionsBar({ data }: { data: TicketActionsData }) {
  const t = useTranslations("ticketActions");
  const router = useRouter();
  const [kind, setKind] = useState<ActionKind | null>(null);
  const [notice, setNotice] = useState<ActionNotice | null>(null);
  const closeDialog = useCallback(() => setKind(null), []);

  const onSuccess = useCallback(
    (state: TicketActionState) => {
      const k = kind;
      setKind(null);
      if (k === null) return;
      const status = typeof k === "object" ? data.statuses.find((s) => s.id === k.status) : undefined;
      if (k === "assignAgent" || k === "assignTeam" || k === "transfer" || (status && status.state !== "open")) {
        router.push("/agent/tickets");
        return;
      }
      let text: string;
      if (status) text = t("done.status", { status: status.name });
      else if (state.removed !== undefined) text = t("done.removed", { count: state.removed });
      else text = t(`done.${k as Exclude<ActionKind, object>}`);
      setNotice({ kind: "success", text });
      router.refresh();
    },
    [kind, data.statuses, router, t],
  );

  const item = (label: string, k: ActionKind, close: () => void) => (
    <DropdownItem key={typeof k === "object" ? `s${k.status}` : k} baseClassName={itemClass} onClick={() => setKind(k)} onItemClick={close}>
      {label}
    </DropdownItem>
  );
  const { can } = data;
  const hasMore = can.release || can.mark || can.refer;
  // status-options.tmpl.php: stati diversi dall'attuale
  const menuStatuses = data.statuses.filter((s) => s.id !== data.currentStatusId);

  return (
    <>
      {can.assign && (
        <MenuButton label={data.isAssigned ? t("reassign") : t("assign")}>
          {(close) => (
            <>
              {can.claim && item(t("claim"), "claim", close)}
              {item(t("toAgent"), "assignAgent", close)}
              {item(t("toTeam"), "assignTeam", close)}
            </>
          )}
        </MenuButton>
      )}
      {can.transfer && (
        <button type="button" onClick={() => setKind("transfer")} className={buttonClass}>
          {t("transfer")}
        </button>
      )}
      {can.status && menuStatuses.length > 0 && (
        <MenuButton label={t("changeStatus")}>{(close) => menuStatuses.map((s) => item(s.name, { status: s.id }, close))}</MenuButton>
      )}
      {hasMore && (
        <MenuButton label={t("more")}>
          {(close) => (
            <>
              {can.release && item(t("releaseMenu"), "release", close)}
              {can.mark && (data.isAnswered ? item(t("markUnanswered"), "markUnanswered", close) : item(t("markAnswered"), "markAnswered", close))}
              {can.refer && item(t("manageReferrals"), "refer", close)}
            </>
          )}
        </MenuButton>
      )}
      {notice && (
        <div
          role="status"
          className="flex basis-full items-center justify-between gap-3 rounded-lg bg-success-50 px-4 py-2 text-theme-sm text-success-700 dark:bg-success-500/15 dark:text-success-400"
        >
          <span>{notice.text}</span>
          <button type="button" aria-label={t("close")} onClick={() => setNotice(null)} className="text-theme-xs underline">
            {t("close")}
          </button>
        </div>
      )}
      {kind !== null && <ActionDialogs kind={kind} data={data} onClose={closeDialog} onSuccess={onSuccess} />}
    </>
  );
}
