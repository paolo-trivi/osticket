"use client";

import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";

import type { EditActionState } from "@/app/[locale]/(staff)/agent/(panel)/tickets/[id]/actions-edit";
import ActionNotice from "@/components/common/ActionNotice";
import MenuButton from "@/components/common/MenuButton";
import { menuButtonClass, menuItemClass } from "@/components/common/menu-classes";
import { DropdownItem } from "@/components/ui/dropdown/DropdownItem";
import { useRouter } from "@/i18n/navigation";

import { useTicketNotice } from "../view/use-ticket-notice";

import CollaboratorsDialog from "./dialogs/CollaboratorsDialog";
import ConfirmDialog from "./dialogs/ConfirmDialog";
import DeleteDialog from "./dialogs/DeleteDialog";
import EditFieldDialog from "./dialogs/EditFieldDialog";
import EntryEditDialog from "./dialogs/EntryEditDialog";
import MergeDialog from "./dialogs/MergeDialog";
import OwnerDialog from "./dialogs/OwnerDialog";
import UpdateTicketDialog from "./dialogs/UpdateTicketDialog";
import type { ExtraKind, TicketExtraData } from "./types";

/**
 * Pulsanti dell'area "ticketedit" nella vista ticket: "Modifica" e menu "Gestisci" (cambia
 * proprietario, modifica campo, collaboratori, merge, link, segna scaduto, ban/unban email, modifica
 * voce del thread, elimina). Dopo un'azione la vista viene ricaricata; dopo l'eliminazione si torna
 * alla lista.
 */
export default function TicketExtraMenu({ data }: { data: TicketExtraData }) {
  const t = useTranslations("ticketEdit");
  const router = useRouter();
  const [kind, setKind] = useState<ExtraKind | null>(null);
  // un solo esito visibile nella testata: il nuovo sostituisce quelli delle altre barre
  const [notice, setNotice] = useTicketNotice<string>();
  const close = useCallback(() => setKind(null), []);
  const { can } = data;

  const onSuccess = useCallback(
    (state: EditActionState) => {
      const k = kind;
      setKind(null);
      if (k === "delete" || state.gone) {
        // il ticket non esiste più: la lista mostra l'esito con il numero (TicketDoneNotice)
        router.push(`/agent/tickets?done=delete&number=${encodeURIComponent(data.number)}`);
        return;
      }
      setNotice(k ? t(`done.${k}`, { email: state.email ?? data.ownerEmail }) : null);
      router.refresh();
    },
    [kind, router, t, data.ownerEmail, data.number, setNotice],
  );
  const refresh = useCallback(() => router.refresh(), [router]);

  const item = (label: string, k: ExtraKind, closeMenu: () => void) => (
    <DropdownItem key={k} baseClassName={menuItemClass} onClick={() => setKind(k)} onItemClick={closeMenu}>
      {label}
    </DropdownItem>
  );
  const children = data.related.tickets.filter((x) => !x.parent);
  const isParent = data.related.tickets.some((x) => x.parent && x.id === data.ticketId);
  const mergeList = [{ number: data.number, subject: data.subject }, ...(isParent ? children.map((c) => ({ number: c.number, subject: c.subject })) : [])];
  const hasMenu = can.edit || can.collaborators || can.merge || can.link || can.overdue || can.ban || can.delete || can.editEntries;

  return (
    <>
      {can.edit && (
        <button type="button" onClick={() => setKind("edit")} className={menuButtonClass}>
          {t("edit")}
        </button>
      )}
      {hasMenu && (
        <MenuButton label={t("manage")} width="w-64">
          {(c) => (
            <>
              {can.edit && item(t("editField"), "field", c)}
              {can.edit && item(t("changeOwner"), "owner", c)}
              {can.collaborators && item(t("manageCollaborators"), "collaborators", c)}
              {can.merge && item(t("mergeTickets"), "merge", c)}
              {can.link && item(t("linkTickets"), "link", c)}
              {can.overdue && item(t("markOverdue"), "overdue", c)}
              {can.ban && (data.banned ? item(t("unbanEmail", { email: data.ownerEmail }), "unban", c) : item(t("banEmail", { email: data.ownerEmail }), "ban", c))}
              {can.editEntries && item(t("editEntry"), "entry", c)}
              {can.delete && item(t("deleteTicket"), "delete", c)}
            </>
          )}
        </MenuButton>
      )}
      {notice && (
        <ActionNotice closeLabel={t("close")} onClose={() => setNotice(null)}>
          {notice}
        </ActionNotice>
      )}
      {kind === "edit" && <UpdateTicketDialog data={data} onClose={close} onSuccess={onSuccess} />}
      {kind === "field" && <EditFieldDialog data={data} onClose={close} onSuccess={onSuccess} />}
      {kind === "owner" && <OwnerDialog data={data} onClose={close} onSuccess={onSuccess} />}
      {kind === "collaborators" && <CollaboratorsDialog data={data} onClose={close} onSuccess={onSuccess} onAdded={refresh} />}
      {(kind === "merge" || kind === "link") && (
        <MergeDialog
          ticketId={data.ticketId}
          number={data.number}
          title={kind}
          tickets={mergeList}
          linked={kind === "link" && isParent ? children.map((x) => ({ id: x.id, number: x.number })) : undefined}
          closedStatuses={data.closedStatuses}
          defaultChildStatusId={data.defaultChildStatusId}
          parentStatuses={data.parentStatuses}
          mergeType={data.related.mergeType}
          onClose={close}
          onSuccess={onSuccess}
        />
      )}
      {(kind === "overdue" || kind === "ban" || kind === "unban") && <ConfirmDialog kind={kind} data={data} onClose={close} onSuccess={onSuccess} />}
      {kind === "entry" && <EntryEditDialog data={data} onClose={close} onSuccess={onSuccess} />}
      {kind === "delete" && <DeleteDialog data={data} onClose={close} onSuccess={onSuccess} />}
    </>
  );
}
