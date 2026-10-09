"use client";

import { useTranslations } from "next-intl";

import { deleteTicketAction, type EditActionState } from "@/app/[locale]/(staff)/agent/(panel)/tickets/[id]/actions-edit";

import EditDialog from "../EditDialog";
import { Check, Editor } from "../inputs";
import type { TicketExtraData } from "../types";

/** "Elimina ticket" (ticket-status.tmpl.php con lo stato "deleted" → Ticket::delete). */
export default function DeleteDialog({ data, onClose, onSuccess }: { data: TicketExtraData; onClose: () => void; onSuccess: (s: EditActionState) => void }) {
  const t = useTranslations("ticketEdit");
  return (
    <EditDialog
      ticketId={data.ticketId}
      title={t("deleteTitle", { number: data.number })}
      action={deleteTicketAction}
      submitLabel={t("deleteConfirm")}
      onClose={onClose}
      onSuccess={onSuccess}
      warning={
        <>
          {t("deleteWarn")}
          <strong className="mt-1 block">{t("deleteExtra")}</strong>
        </>
      }
      danger
    >
      <input type="hidden" name="statusId" value={data.deletedStatusId ?? 0} />
      {data.hasChildren && <Check name="children" label={t("deleteChildren")} />}
      <Editor name="comments" placeholder={t("deletePlaceholder")} />
    </EditDialog>
  );
}
