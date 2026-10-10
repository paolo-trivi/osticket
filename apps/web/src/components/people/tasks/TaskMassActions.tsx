"use client";

import { useTranslations } from "next-intl";
import { useCallback, useState, type ReactNode } from "react";

import { taskMassAction } from "@/app/[locale]/(staff)/agent/(panel)/tasks/actions";
import ActionNotice from "@/components/common/ActionNotice";
import { useReadOnlyHint } from "@/components/common/WriteGate";
import Button from "@/components/ui/button/Button";
import { checkedIds, useCheckedCount } from "@/lib/checked-ids";

import { SelectField } from "../FormControls";
import PeopleDialog from "../PeopleDialog";
import type { Choice, PeopleAction, PeopleActionState } from "../types";
import { useActionNotice } from "../useActionNotice";

const TASK_SELECTOR = 'input[data-task-select="1"]';

type Op = "claim" | "assign" | "transfer" | "close" | "reopen" | "delete";

/**
 * Azioni di massa della lista task (ajax.tasks.php:massProcess). La lista resta una tabella server:
 * le caselle hanno form="task-mass" e vengono inviate con il form del dialogo.
 */
export default function TaskMassActions({ can, agents, teams, depts }: { can: Record<Op, boolean>; agents: Choice[]; teams: Choice[]; depts: Choice[] }) {
  const t = useTranslations("peopleTasks");
  const tu = useTranslations("peopleUi");
  const [op, setOp] = useState<Op | null>(null);
  const [ids, setIds] = useState<number[]>([]);
  const close = useCallback(() => setOp(null), []);
  const selected = useCheckedCount(TASK_SELECTOR);
  const readOnly = useReadOnlyHint();
  // ajax.tasks.php:massProcess: "Successfully <azione> N selected tasks" o "N of M selected tasks <azione>"
  const { notice, clear, withNotice } = useActionNotice();
  const doneText = (s: PeopleActionState) => {
    const n = s.count ?? 0;
    return n < ids.length ? tu("done.mass_partial", { n, total: ids.length }) : tu("done.mass_done", { n });
  };
  const ops = (Object.keys(can) as Op[]).filter((k) => can[k]);
  if (!ops.length) return null;

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
          <Button
            key={k}
            size="sm"
            variant="outline"
            disabled={!selected || !!readOnly}
            title={readOnly}
            onClick={() => {
              setIds(checkedIds(TASK_SELECTOR));
              setOp(k);
            }}>
            {t(`actions.${k === "assign" ? "assign" : k}`)}
          </Button>
        ))}
        {notice && (
          <ActionNotice closeLabel={tu("dismiss")} onClose={clear}>
            {notice}
          </ActionNotice>
        )}
      </div>
      {op && (
        <MassDialog
          op={op}
          ids={ids}
          action={withNotice(taskMassAction, doneText)}
          onClose={close}
          title={t(`mass.${op}`)}
          submit={t(`actions.${op}`)}
          withComments={op === "close" || op === "reopen" || op === "delete"}
          commentsLabel={t("commentsOptional")}
          countLabel={(n) => (n ? t("nSelected", { n }) : t("noneSelected"))}
        >
          {body}
        </MassDialog>
      )}
    </>
  );
}

function MassDialog({
  op,
  ids,
  action,
  onClose,
  title,
  submit,
  withComments,
  commentsLabel,
  countLabel,
  children,
}: {
  op: Op;
  ids: number[];
  action: PeopleAction;
  onClose: () => void;
  title: string;
  submit: string;
  withComments: boolean;
  commentsLabel: string;
  countLabel: (n: number) => string;
  children: ReactNode;
}) {
  return (
    <PeopleDialog
      title={title}
      action={action}
      submitLabel={submit}
      onClose={onClose}
      hidden={{ do: op }}
      danger={op === "delete"}
      notice={countLabel(ids.length)}
      commentsPlaceholder={withComments ? commentsLabel : undefined}
    >
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
