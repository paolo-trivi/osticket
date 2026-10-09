"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { searchUsersAction, updateTicketAction, type EditActionState } from "@/app/[locale]/(staff)/agent/(panel)/tickets/[id]/actions-edit";
import DynamicForm from "@/components/forms/dynamic/DynamicForm";
import UserPicker from "@/components/tickets/create/UserPicker";

import EditDialog from "../EditDialog";
import { Editor, Field, Select, TextInput } from "../inputs";
import type { TicketExtraData } from "../types";

/** Form "Modifica ticket" (include/staff/ticket-edit.inc.php → Ticket::update). */
export default function UpdateTicketDialog({ data, onClose, onSuccess }: { data: TicketExtraData; onClose: () => void; onSuccess: (s: EditActionState) => void }) {
  const t = useTranslations("ticketEdit");
  const e = data.edit;
  const [user, setUser] = useState({ id: e.userId, name: e.userName, email: e.userEmail });
  const [changing, setChanging] = useState(false);
  return (
    <EditDialog ticketId={data.ticketId} title={t("updateTitle", { number: data.number })} action={updateTicketAction} submitLabel={t("save")} onClose={onClose} onSuccess={onSuccess} wide>
      <section className="space-y-3">
        <h5 className="text-sm font-semibold text-gray-800 dark:text-white/90">{t("userInfo")}</h5>
        <input type="hidden" name="user_id" value={user.id} />
        <div className="flex flex-wrap items-center gap-3 text-sm text-gray-700 dark:text-gray-300">
          <span>
            {user.name} &lt;{user.email}&gt;
          </span>
          <button type="button" onClick={() => setChanging((v) => !v)} className="text-theme-sm text-brand-500 hover:underline">
            {t("changeUser")}
          </button>
        </div>
        {changing && (
          <UserPicker
            id="edit-user"
            placeholder={t("searchUser")}
            search={searchUsersAction}
            onPick={(u) => {
              setUser(u);
              setChanging(false);
            }}
          />
        )}
      </section>
      <section className="space-y-4">
        <h5 className="text-sm font-semibold text-gray-800 dark:text-white/90">{t("ticketInfo")}</h5>
        <p className="text-theme-xs text-gray-500 dark:text-gray-400">{t("duedateHint")}</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t("source")}>
            <Select name="source" defaultValue={e.source || "Phone"} options={e.sources.map((s) => ({ value: s, label: t.has(`sources.${s}`) ? t(`sources.${s}`) : s }))} required />
          </Field>
          <Field label={t("topic")}>
            <Select name="topicId" defaultValue={e.topicId ? String(e.topicId) : ""} empty={t("selectTopic")} options={e.topics.map((x) => ({ value: String(x.id), label: x.name }))} />
          </Field>
          <Field label={t("sla")}>
            <Select name="slaId" defaultValue={String(e.slaId || 0)} options={[{ value: "0", label: t("none") }, ...e.slas.map((x) => ({ value: String(x.id), label: x.name }))]} />
          </Field>
          <Field label={t("duedate")} hint={t("duedateTz")}>
            <TextInput type="datetime-local" name="duedate" defaultValue={e.duedate} disabled={e.isClosed && !e.duedate} />
          </Field>
        </div>
      </section>
      {e.forms.map((f) => (
        <DynamicForm key={f.id} form={f} values={e.values} showTitle />
      ))}
      <section className="space-y-2">
        <h5 className="text-sm font-semibold text-gray-800 dark:text-white/90">{t("internalNote")}</h5>
        <Editor name="note" placeholder={t("notePlaceholder")} />
      </section>
    </EditDialog>
  );
}
