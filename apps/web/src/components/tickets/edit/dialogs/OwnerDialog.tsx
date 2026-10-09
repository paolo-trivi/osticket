"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { changeOwnerAction, searchUsersAction, type EditActionState } from "@/app/[locale]/(staff)/agent/(panel)/tickets/[id]/actions-edit";
import UserPicker, { type PickedUser } from "@/components/tickets/create/UserPicker";

import EditDialog from "../EditDialog";
import type { TicketExtraData } from "../types";

/** "Cambia proprietario" (ajax change-user → do=changeuser → Ticket::changeOwner). */
export default function OwnerDialog({ data, onClose, onSuccess }: { data: TicketExtraData; onClose: () => void; onSuccess: (s: EditActionState) => void }) {
  const t = useTranslations("ticketEdit");
  const [user, setUser] = useState<PickedUser | null>(null);
  return (
    <EditDialog ticketId={data.ticketId} title={t("ownerTitle", { number: data.number })} action={changeOwnerAction} submitLabel={t("changeOwner")} onClose={onClose} onSuccess={onSuccess}>
      <p className="text-theme-sm text-gray-600 dark:text-gray-400">{t("currentOwner", { name: data.edit.userName, email: data.edit.userEmail })}</p>
      <UserPicker id="owner-user" placeholder={t("searchUser")} search={searchUsersAction} onPick={setUser} exclude={[data.edit.userId]} />
      {user && (
        <p className="text-theme-sm text-gray-800 dark:text-white/90">
          {t("newOwner", { name: user.name, email: user.email })}
          <input type="hidden" name="userId" value={user.id} />
        </p>
      )}
    </EditDialog>
  );
}
