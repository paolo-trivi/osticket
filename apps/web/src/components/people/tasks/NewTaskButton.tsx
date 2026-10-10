"use client";

import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";

import { taskCreateAction } from "@/app/[locale]/(staff)/agent/(panel)/tasks/actions";
import RichTextEditor from "@/components/editor/RichTextEditor";
import Button from "@/components/ui/button/Button";

import DueDateInput from "../DueDateInput";
import { DynamicField, FieldError, SelectField, TextField } from "../FormControls";
import PeopleDialog from "../PeopleDialog";
import type { Choice, DynField } from "../types";

/** Campi del form del task resi a parte (titolo e descrizione). */
const CORE_FIELDS = ["title", "description"];

/**
 * Nuovo task (ajax.tasks.php:add, da ticket ajax.tickets.php:addTask): titolo, descrizione, altri campi
 * del form del task (inviati con il prefisso `f:`), reparto, assegnatario, scadenza.
 */
export default function NewTaskButton({
  ticketId,
  ticketNumber,
  depts,
  agents,
  teams,
  fields,
  defaultDept,
  canAssign,
}: {
  ticketId?: number;
  ticketNumber?: string;
  depts: Choice[];
  agents: Choice[];
  teams: Choice[];
  fields: DynField[];
  defaultDept?: number;
  canAssign: boolean;
}) {
  const t = useTranslations("peopleTasks");
  const tc = useTranslations("composer");
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        {ticketId ? t("newForTicket", { number: ticketNumber ?? "" }) : t("new")}
      </Button>
      {open && (
        <PeopleDialog title={ticketId ? t("newForTicket", { number: ticketNumber ?? "" }) : t("new")} action={taskCreateAction} submitLabel={t("create")} onClose={close} hidden={ticketId ? { ticketId } : {}} wide>
          {(s) => (
            <div className="space-y-4">
              <TextField name="title" label={t("titleField")} required maxLength={50} error={s.fields?.title} />
              <div className="space-y-1.5">
                <span className="text-theme-sm font-medium text-gray-700 dark:text-gray-400">{t("description")}</span>
                <RichTextEditor
                  name="description"
                  minHeight={120}
                  labels={{
                    bold: tc("editor.bold"),
                    italic: tc("editor.italic"),
                    underline: tc("editor.underline"),
                    bullets: tc("editor.bullets"),
                    numbers: tc("editor.numbers"),
                    link: tc("editor.link"),
                    quote: tc("editor.quote"),
                    linkPrompt: tc("editor.linkPrompt"),
                  }}
                />
                <FieldError code={s.fields?.description} />
              </div>
              {fields
                .filter((f) => !CORE_FIELDS.includes(f.name))
                .map((f) => {
                  const key = f.name || String(f.id);
                  return <DynamicField key={f.id} field={{ ...f, name: `f:${key}` }} error={s.fields?.[key]} />;
                })}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <SelectField name="dept" label={t("department")} placeholder={t("selectDept")} options={depts} defaultValue={defaultDept ?? ""} required error={s.fields?.dept} />
                {canAssign && (
                  <SelectField
                    name="assignee"
                    label={t("assignee")}
                    placeholder={t("unassigned")}
                    options={[...agents.map((a) => ({ id: `s${a.id}`, name: a.name })), ...teams.map((a) => ({ id: `t${a.id}`, name: `${t("team")}: ${a.name}` }))]}
                    error={s.error === "unknown_assignee" || s.error === "unavailable" || s.error === "team_disabled" || s.error === "team_empty" ? "invalid" : undefined}
                  />
                )}
              </div>
              <DueDateInput name="due" label={t("dueDate")} error={s.error === "due_past" ? "due_past" : s.error === "invalid_date" ? "invalid_date" : undefined} />
            </div>
          )}
        </PeopleDialog>
      )}
    </>
  );
}
