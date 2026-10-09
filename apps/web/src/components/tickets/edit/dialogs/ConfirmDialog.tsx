"use client";

import { useTranslations } from "next-intl";

import { banAction, overdueAction, type EditActionState } from "@/app/[locale]/(staff)/agent/(panel)/tickets/[id]/actions-edit";

import EditDialog from "../EditDialog";
import type { TicketExtraData } from "../types";

/** Conferme del menu "Altro" (confirm-action di ticket-view.inc.php): scaduto, ban, unban. */
export default function ConfirmDialog({
  kind,
  data,
  onClose,
  onSuccess,
}: {
  kind: "overdue" | "ban" | "unban";
  data: TicketExtraData;
  onClose: () => void;
  onSuccess: (s: EditActionState) => void;
}) {
  const t = useTranslations("ticketEdit");
  const action = kind === "overdue" ? overdueAction : banAction;
  return (
    <EditDialog ticketId={data.ticketId} title={t("confirmTitle")} action={action} submitLabel={t("confirmYes")} onClose={onClose} onSuccess={onSuccess}>
      {kind !== "overdue" && <input type="hidden" name="ban" value={kind === "ban" ? "1" : "0"} />}
      <p className="text-theme-sm text-gray-700 dark:text-gray-300">
        {kind === "overdue" ? t("overdueConfirm") : t(kind === "ban" ? "banConfirm" : "unbanConfirm", { email: data.ownerEmail })}
      </p>
    </EditDialog>
  );
}
