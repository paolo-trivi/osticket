"use client";

import { useTranslations } from "next-intl";

import { massStatusAction } from "@/app/[locale]/(staff)/agent/(panel)/tickets/actions-mass";
import { Editor } from "@/components/tickets/edit/inputs";

import MassDialog from "../MassDialog";
import type { MassData, MassDialogProps } from "../types";

interface StatusMassDialogProps extends MassDialogProps {
  statusId: number;
  statuses: MassData["statuses"];
}

/** Cambio stato di massa; lo stato "eliminato" chiede conferma come l'eliminazione. */
export default function StatusMassDialog({ statusId, statuses, ...common }: StatusMassDialogProps) {
  const t = useTranslations("ticketEdit.mass");
  const te = useTranslations("ticketEdit");
  const n = common.ids.length;
  const status = statuses.find((s) => s.id === statusId);
  const deleting = status?.state === "deleted";
  return (
    <MassDialog
      {...common}
      title={t("statusTitle", { count: n })}
      action={massStatusAction}
      submitLabel={deleting ? t("deleteConfirm") : t("apply")}
      danger={deleting}
      warning={deleting ? <>{t("deleteWarn", { count: n })} <strong>{te("deleteExtra")}</strong></> : undefined}
    >
      <input type="hidden" name="statusId" value={statusId} />
      <p className="text-theme-sm text-gray-700 dark:text-gray-300">{t("statusTo", { status: status?.name ?? "" })}</p>
      <Editor name="comments" placeholder={deleting ? t("deletePlaceholder", { count: n }) : t("commentsPlaceholder")} />
    </MassDialog>
  );
}
