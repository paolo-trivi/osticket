"use client";

import { useTranslations } from "next-intl";
import { useCallback, useState, type ReactNode } from "react";

import { taskMassAction } from "@/app/[locale]/(staff)/agent/(panel)/tasks/actions";
import Button from "@/components/ui/button/Button";

import { SelectField } from "../FormControls";
import PeopleDialog from "../PeopleDialog";
import type { Choice } from "../types";

type Op = "claim" | "assign" | "transfer" | "close" | "reopen" | "delete";

/**
 * Azioni di massa della lista task (ajax.tasks.php:massProcess). La lista resta una tabella server:
 * le caselle hanno form="task-mass" e vengono inviate con il form del dialogo.
 */
export default function TaskMassActions({ can, agents, teams, depts }: { can: Record<Op, boolean>; agents: Choice[]; teams: Choice[]; depts: Choice[] }) {
  const t = useTranslations("peopleTasks");
  const [op, setOp] = useState<Op | null>(null);
  const [ids, setIds] = useState<number[]>([]);
  const close = useCallback(() => setOp(null), []);
  const ops = (Object.keys(can) as Op[]).filter((k) => can[k]);
  if (!ops.length) return null;

  /** Copia nel dialogo gli id selezionati nella tabella. */
  const selected = (): number[] =>
    Array.from(document.querySelectorAll<HTMLInputElement>('input[data-task-select="1"]:checked')).map((i) => Number(i.value));

  let body: ReactNode = null;
  if (op === "assign")
    body = (
      <SelectField
        name="assignee"
        label={t("assignee")}
        placeholder={t("selectAgent")}
        options={[...agents.map((a) => ({ id: `s${a.id}`, name: a.name })), ...teams.map((a) => ({ id: `t${a.id}`, name: `${t("team")}: ${a.name}` }))]}
      />
    );
  if (op === "transfer") body = <SelectField name="dept" label={t("department")} placeholder={t("selectDept")} options={depts} />;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-theme-sm text-gray-500 dark:text-gray-400">{t("selected")}</span>
        {ops.map((k) => (
          <Button key={k} size="sm" variant="outline" onClick={() => {
              setIds(selected());
              setOp(k);
            }}>
            {t(`actions.${k === "assign" ? "assign" : k}`)}
          </Button>
        ))}
      </div>
      {op && (
        <MassDialog op={op} ids={ids} onClose={close} title={t(`mass.${op}`)} submit={t(`actions.${op}`)} withComments={op === "close" || op === "reopen" || op === "delete"} commentsLabel={t("commentsOptional")} countLabel={(n) => (n ? t("nSelected", { n }) : t("noneSelected"))}>
          {body}
        </MassDialog>
      )}
    </>
  );
}

function MassDialog({ op, ids, onClose, title, submit, withComments, commentsLabel, countLabel, children }: { op: Op; ids: number[]; onClose: () => void; title: string; submit: string; withComments: boolean; commentsLabel: string; countLabel: (n: number) => string; children: ReactNode }) {
  return (
    <PeopleDialog title={title} action={taskMassAction} submitLabel={submit} onClose={onClose} hidden={{ do: op }} danger={op === "delete"} notice={countLabel(ids.length)} commentsPlaceholder={withComments ? commentsLabel : undefined}>
      {ids.map((id) => (
        <input key={id} type="hidden" name="tids" value={id} />
      ))}
      {children}
    </PeopleDialog>
  );
}

/** Casella di selezione di una riga della lista. */
export function TaskSelect({ id }: { id: number }) {
  return <input type="checkbox" data-task-select="1" value={id} className="size-4 rounded border-gray-300 text-brand-500 dark:border-gray-700 dark:bg-gray-900" aria-label={`#${id}`} />;
}
