"use client";

import { useTranslations } from "next-intl";
import { useCallback, useState, type ReactNode } from "react";

import type { EditActionState } from "@/app/[locale]/(staff)/agent/(panel)/tickets/[id]/actions-edit";
import { Dropdown } from "@/components/ui/dropdown/Dropdown";
import { DropdownItem } from "@/components/ui/dropdown/DropdownItem";
import { useRouter } from "@/i18n/navigation";
import { ChevronDownIcon } from "@/icons";
import { cn } from "@/utils";

import CollaboratorsDialog from "./dialogs/CollaboratorsDialog";
import ConfirmDialog from "./dialogs/ConfirmDialog";
import DeleteDialog from "./dialogs/DeleteDialog";
import EditFieldDialog from "./dialogs/EditFieldDialog";
import EntryEditDialog from "./dialogs/EntryEditDialog";
import MergeDialog from "./dialogs/MergeDialog";
import OwnerDialog from "./dialogs/OwnerDialog";
import UpdateTicketDialog from "./dialogs/UpdateTicketDialog";
import type { ExtraKind, TicketExtraData } from "./types";

const itemClass =
  "block w-full rounded-lg px-3 py-2 text-start text-theme-sm text-gray-700 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-gray-300";
const buttonClass =
  "inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-theme-sm text-gray-700 hover:bg-gray-50 dark:border-gray-800 dark:text-gray-400 dark:hover:bg-white/5";

function MenuButton({ label, children }: { label: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <div className="relative">
      <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} className={cn("dropdown-toggle", buttonClass)}>
        {label}
        <ChevronDownIcon className={cn("size-4 transition-transform", open && "rotate-180")} />
      </button>
      <Dropdown isOpen={open} onClose={close} className="w-64 p-2">
        {children(close)}
      </Dropdown>
    </div>
  );
}

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
  const [notice, setNotice] = useState<string | null>(null);
  const close = useCallback(() => setKind(null), []);
  const { can } = data;

  const onSuccess = useCallback(
    (state: EditActionState) => {
      const k = kind;
      setKind(null);
      if (k === "delete" || state.gone) {
        router.push("/agent/tickets");
        return;
      }
      setNotice(k ? t(`done.${k}`, { email: state.email ?? data.ownerEmail }) : null);
      router.refresh();
    },
    [kind, router, t, data.ownerEmail],
  );
  const refresh = useCallback(() => router.refresh(), [router]);

  const item = (label: string, k: ExtraKind, closeMenu: () => void) => (
    <DropdownItem key={k} baseClassName={itemClass} onClick={() => setKind(k)} onItemClick={closeMenu}>
      {label}
    </DropdownItem>
  );
  const children = data.related.tickets.filter((x) => !x.parent);
  const isParent = data.related.tickets.some((x) => x.parent && x.id === data.ticketId);
  const mergeList = [
    { number: data.number, subject: "" },
    ...(isParent ? children.map((c) => ({ number: c.number, subject: c.subject })) : []),
  ];
  const hasMenu = can.edit || can.collaborators || can.merge || can.link || can.overdue || can.ban || can.delete || can.editEntries;

  return (
    <>
      {can.edit && (
        <button type="button" onClick={() => setKind("edit")} className={buttonClass}>
          {t("edit")}
        </button>
      )}
      {hasMenu && (
        <MenuButton label={t("manage")}>
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
        <div role="status" className="flex basis-full items-center justify-between gap-3 rounded-lg bg-success-50 px-4 py-2 text-theme-sm text-success-700 dark:bg-success-500/15 dark:text-success-400">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} className="text-theme-xs underline">
            {t("close")}
          </button>
        </div>
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
