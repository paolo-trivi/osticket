"use client";

import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";

import type { TicketActionState } from "@/app/[locale]/(staff)/agent/(panel)/tickets/[id]/actions-assign";
import ActionNotice from "@/components/common/ActionNotice";
import MenuButton from "@/components/common/MenuButton";
import { menuButtonClass, menuItemClass } from "@/components/common/menu-classes";
import { DropdownItem } from "@/components/ui/dropdown/DropdownItem";
import { useRouter } from "@/i18n/navigation";

import { useTicketNotice } from "../view/use-ticket-notice";

import ActionDialogs from "./ActionDialogs";
import type { ActionKind, TicketActionsData } from "./types";

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
  // un solo esito visibile nella testata: il nuovo sostituisce quelli delle altre barre
  const [notice, setNotice] = useTicketNotice<string>();
  const closeDialog = useCallback(() => setKind(null), []);

  const onSuccess = useCallback(
    (state: TicketActionState) => {
      const k = kind;
      setKind(null);
      if (k === null) return;
      const status = typeof k === "object" ? data.statuses.find((s) => s.id === k.status) : undefined;
      const done = k === "assignAgent" || k === "assignTeam" ? "assign" : k === "transfer" ? "transfer" : status && status.state !== "open" ? "status" : null;
      if (done) {
        // la lista mostra l'esito (TicketDoneNotice), come il messaggio di sessione del PHP
        router.push(`/agent/tickets?done=${done}&tid=${data.ticketId}`);
        return;
      }
      let text: string;
      if (status) text = t("done.status", { status: status.name });
      else if (state.removed !== undefined) text = t("done.removed", { count: state.removed });
      else text = t(`done.${k as Exclude<ActionKind, object>}`);
      setNotice(text);
      router.refresh();
    },
    [kind, data.statuses, data.ticketId, router, t, setNotice],
  );

  const item = (label: string, k: ActionKind, close: () => void) => (
    <DropdownItem key={typeof k === "object" ? `s${k.status}` : k} baseClassName={menuItemClass} onClick={() => setKind(k)} onItemClick={close}>
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
        <MenuButton width="w-60" label={data.isAssigned ? t("reassign") : t("assign")}>
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
        <button type="button" onClick={() => setKind("transfer")} className={menuButtonClass}>
          {t("transfer")}
        </button>
      )}
      {can.status && menuStatuses.length > 0 && (
        <MenuButton width="w-60" label={t("changeStatus")}>{(close) => menuStatuses.map((s) => item(s.name, { status: s.id }, close))}</MenuButton>
      )}
      {hasMore && (
        <MenuButton width="w-60" label={t("more")}>
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
        <ActionNotice closeLabel={t("close")} onClose={() => setNotice(null)}>
          {notice}
        </ActionNotice>
      )}
      {kind !== null && <ActionDialogs kind={kind} data={data} onClose={closeDialog} onSuccess={onSuccess} />}
    </>
  );
}
