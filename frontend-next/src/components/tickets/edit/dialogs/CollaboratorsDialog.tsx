"use client";

import { useTranslations } from "next-intl";
import { useActionState, useEffect, useRef, useState } from "react";

import {
  addCollaboratorAction,
  searchUsersAction,
  updateCollaboratorsAction,
  type EditActionState,
} from "@/app/[locale]/(staff)/agent/(panel)/tickets/[id]/actions-edit";
import UserPicker from "@/components/tickets/create/UserPicker";
import Button from "@/components/ui/button/Button";
import { Modal } from "@/components/ui/modal";

import { EditErrorBox } from "../EditDialog";
import type { TicketExtraData } from "../types";

/** Esito positivo di un form: richiama `fn` una sola volta per invio. */
function useOnOk(state: EditActionState, fn: () => void) {
  const seen = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (state.ok && seen.current !== state.nonce) {
      seen.current = state.nonce;
      fn();
    }
  }, [state, fn]);
}

/**
 * Gestione dei collaboratori (templates/collaborators.tmpl.php): attivi (`cid[]`), da rimuovere
 * (`del[]`) e aggiunta di un utente esistente (add-collaborator).
 */
export default function CollaboratorsDialog({
  data,
  onClose,
  onSuccess,
  onAdded,
}: {
  data: TicketExtraData;
  onClose: () => void;
  onSuccess: (s: EditActionState) => void;
  onAdded: () => void;
}) {
  const t = useTranslations("ticketEdit");
  const [state, action, pending] = useActionState<EditActionState, FormData>(updateCollaboratorsAction, {});
  const [addState, addAction, adding] = useActionState<EditActionState, FormData>(addCollaboratorAction, {});
  const [picked, setPicked] = useState<{ id: number; name: string } | null>(null);
  useOnOk(state, () => onSuccess(state));
  useOnOk(addState, () => {
    setPicked(null);
    onAdded();
  });

  return (
    <Modal isOpen onClose={onClose} className="m-4 max-w-[640px] p-6 lg:p-8">
      <div className="max-h-[80vh] space-y-6 overflow-y-auto pe-1 custom-scrollbar">
        <h4 className="pe-12 text-title-sm font-semibold text-gray-800 dark:text-white/90">{t("collabTitle", { number: data.number })}</h4>
        <form action={action} className="space-y-4">
          <input type="hidden" name="ticketId" value={data.ticketId} />
          <EditErrorBox state={state} />
          {data.collaborators.length === 0 ? (
            <p className="text-theme-sm text-gray-500 dark:text-gray-400">{t("noCollaborators")}</p>
          ) : (
            <>
              <table className="w-full text-theme-sm">
                <thead>
                  <tr className="text-theme-xs text-gray-500 uppercase dark:text-gray-400">
                    <th className="py-2 text-start">{t("collaborator")}</th>
                    <th className="py-2 text-center">{t("active")}</th>
                    <th className="py-2 text-center">{t("remove")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                  {data.collaborators.map((c) => (
                    <tr key={c.id}>
                      <td className="py-2 text-gray-800 dark:text-white/90">
                        {c.name} <span className="text-gray-500 dark:text-gray-400">&lt;{c.email}&gt;</span>
                      </td>
                      <td className="py-2 text-center">
                        <input type="checkbox" name="cid" value={c.id} defaultChecked={c.active} aria-label={t("active")} className="size-4 accent-brand-500" />
                      </td>
                      <td className="py-2 text-center">
                        <input type="checkbox" name="del" value={c.id} aria-label={t("remove")} className="size-4 accent-error-500" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="flex justify-end">
                <Button size="sm" type="submit" disabled={pending}>
                  {pending ? t("working") : t("saveChanges")}
                </Button>
              </div>
            </>
          )}
        </form>
        <form action={addAction} className="space-y-3 border-t border-gray-100 pt-4 dark:border-gray-800">
          <input type="hidden" name="ticketId" value={data.ticketId} />
          <p className="text-theme-sm font-medium text-gray-700 dark:text-gray-300">{t("addCollaborator")}</p>
          <EditErrorBox state={addState} />
          <UserPicker
            id="collab-user"
            placeholder={t("searchUser")}
            search={searchUsersAction}
            onPick={(u) => setPicked(u)}
            exclude={[data.edit.userId, ...data.collaborators.map((c) => c.userId)]}
          />
          {picked && (
            <div className="flex items-center justify-between gap-3 text-theme-sm text-gray-800 dark:text-white/90">
              <span>{picked.name}</span>
              <input type="hidden" name="userId" value={picked.id} />
              <Button size="sm" type="submit" disabled={adding}>
                {adding ? t("working") : t("add")}
              </Button>
            </div>
          )}
        </form>
        <div className="flex justify-end">
          <Button size="sm" variant="outline" onClick={onClose}>
            {t("close")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
