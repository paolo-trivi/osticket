"use client";

import { useTranslations } from "next-intl";
import { useActionState, useEffect, useRef, useState, type ReactNode } from "react";

import {
  assignAction,
  claimAction,
  markAction,
  referAction,
  releaseAction,
  removeReferralsAction,
  statusAction,
  transferAction,
  type TicketActionState,
} from "@/app/[locale]/(staff)/agent/(panel)/tickets/[id]/actions-assign";
import Button from "@/components/ui/button/Button";
import { Modal } from "@/components/ui/modal";

import ActionDialog, { ErrorBox } from "./ActionDialog";
import { FieldCheck, FieldSelect, toOptions } from "./FormFields";
import type { ActionKind, TicketActionsData } from "./types";
import { submitKeepingValues } from "@/lib/submit-keeping-values";

interface Props {
  kind: ActionKind;
  data: TicketActionsData;
  onClose: () => void;
  onSuccess: (state: TicketActionState) => void;
}

const text = "text-theme-sm text-gray-600 dark:text-gray-400";

/** Modale dell'azione scelta nel menu (stessi form dei template PHP assign/transfer/refer/release/mark-as/ticket-status). */
export default function ActionDialogs({ kind, data, onClose, onSuccess }: Props) {
  const t = useTranslations("ticketActions");
  const common = { ticketId: data.ticketId, onClose, onSuccess };
  // Ticket::getAssigned(): agente/team separati da "/"; "te" se l'agente assegnato è l'utente
  const assigned = data.assignedStaff?.isMe ? t("you") : [data.assignedStaff?.name, data.assignedTeam?.name].filter(Boolean).join("/");
  const b = (chunks: ReactNode) => <strong className="font-semibold">{chunks}</strong>;
  const notice = data.isAssigned ? t.rich("currentlyAssigned", { who: assigned, b }) : undefined;

  if (typeof kind === "object") return <StatusDialog data={data} statusId={kind.status} onClose={onClose} onSuccess={onSuccess} />;

  switch (kind) {
    case "claim":
      // ajax claim: con un team assegnato mostra l'assegnazione attuale, altrimenti la conferma
      return (
        <ActionDialog
          {...common}
          title={t("claimTitle", { number: data.number })}
          notice={notice}
          action={claimAction}
          submitLabel={t("claimConfirm")}
          commentsPlaceholder={t("claimPlaceholder")}
        >
          {!data.isAssigned && <p className={text}>{t("claimWarn")}</p>}
        </ActionDialog>
      );
    case "assignAgent":
    case "assignTeam": {
      const agents = kind === "assignAgent";
      // getAssignmentForm: preselezione e casella "mantieni referral" solo con un assegnatario del tipo scelto
      const current = !data.isAssigned ? "" : agents ? (data.assignedStaff ? `s${data.assignedStaff.id}` : "") : data.assignedTeam ? `t${data.assignedTeam.id}` : "";
      const title = t(agents ? "assignAgentTitle" : "assignTeamTitle", {
        number: data.number,
        verb: data.isAssigned ? t("reassign") : t("assign"),
      });
      // nessun assegnatario possibile: niente form con una select vuota e "Assegna" inutilizzabile, solo la spiegazione
      if (!(agents ? data.agents : data.teams).length) return <EmptyDialog title={title} message={t(agents ? "noAgents" : "noTeams")} onClose={onClose} />;
      return (
        <ActionDialog {...common} title={title} notice={notice} action={assignAction} submitLabel={t("assign")} commentsPlaceholder={t("assignPlaceholder")}>
          <FieldSelect
            name="assignee"
            label={t("assignee")}
            placeholder={agents ? t("selectAgent") : t("selectTeam")}
            defaultValue={current}
            options={agents ? toOptions(data.agents, "s") : toOptions(data.teams, "t")}
          />
          {current && <FieldCheck name="refer" label={t("keepReferral", { who: assigned })} />}
        </ActionDialog>
      );
    }
    case "transfer":
      return (
        <ActionDialog {...common} title={t("transferTitle", { number: data.number })} action={transferAction} submitLabel={t("transfer")} commentsPlaceholder={t("transferPlaceholder")}>
          <FieldSelect name="dept" label={t("department")} defaultValue={String(data.deptId)} options={toOptions(data.depts)} />
          <FieldCheck name="refer" label={t("keepDeptReferral")} />
        </ActionDialog>
      );
    case "release":
      return (
        <ActionDialog {...common} title={t("releaseTitle", { number: data.number })} action={releaseAction} submitLabel={t("release")} commentsPlaceholder={t("releasePlaceholder")}>
          {data.assignedStaff && data.assignedTeam ? (
            // release.tmpl.php: con agente e team si sceglie cosa rilasciare (nessuna casella preselezionata)
            <div className="space-y-2">
              <p className={text}>{t("releaseWhich")}</p>
              <FieldCheck name="sid" label={`${t("agent")}: ${data.assignedStaff.name}`} />
              <FieldCheck name="tid" label={`${t("team")}: ${data.assignedTeam.name}`} />
            </div>
          ) : (
            <>
              <input type="hidden" name={data.assignedStaff ? "sid" : "tid"} value="1" />
              <p className={text}>{t.rich("releaseConfirm", { who: data.assignedStaff?.name ?? data.assignedTeam?.name ?? "", b })}</p>
            </>
          )}
        </ActionDialog>
      );
    case "refer":
      return <ReferDialog data={data} onClose={onClose} onSuccess={onSuccess} />;
    case "markAnswered":
    case "markUnanswered": {
      const answered = kind === "markAnswered";
      return (
        <ActionDialog {...common} title={t("confirmTitle")} action={markAction} submitLabel={t("ok")} commentsPlaceholder={t("markPlaceholder")}>
          <input type="hidden" name="answered" value={answered ? "1" : "0"} />
          <p className={text}>{t.rich(answered ? "markAnsweredConfirm" : "markUnansweredConfirm", { b })}</p>
        </ActionDialog>
      );
    }
  }
}

/** Modale senza azione possibile: titolo, spiegazione e "Chiudi". */
function EmptyDialog({ title, message, onClose }: { title: string; message: string; onClose: () => void }) {
  const t = useTranslations("ticketActions");
  return (
    <Modal isOpen onClose={onClose} className="m-4 max-w-[600px] p-6 lg:p-8">
      <div className="space-y-5">
        <h4 className="pe-12 text-title-sm font-semibold text-gray-800 dark:text-white/90">{title}</h4>
        <p role="status" className="rounded-lg bg-warning-50 px-4 py-3 text-theme-sm text-warning-700 dark:bg-warning-500/15 dark:text-orange-400">
          {message}
        </p>
        <div className="flex justify-end">
          <Button size="sm" variant="outline" onClick={onClose}>
            {t("close")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Scheda "Referral" del modale refer.tmpl.php: elenco dei referral con rimozione (do=manage). */
function ReferralsManager({ data, onSuccess }: { data: TicketActionsData; onSuccess: (state: TicketActionState) => void }) {
  const t = useTranslations("ticketActions");
  const [state, formAction, pending] = useActionState<TicketActionState, FormData>(removeReferralsAction, {});
  const done = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (state.ok && done.current !== state.nonce) {
      done.current = state.nonce;
      onSuccess(state);
    }
  }, [state, onSuccess]);
  const label = { S: t("agent"), E: t("team"), D: t("department") };
  const submit = submitKeepingValues(formAction);
  return (
    <form onSubmit={submit} className="space-y-3 rounded-lg border border-gray-200 p-4 dark:border-gray-800">
      <input type="hidden" name="ticketId" value={data.ticketId} />
      <p className="text-theme-sm font-medium text-gray-700 dark:text-gray-400">{t("currentReferrals", { count: data.referrals.length })}</p>
      <ErrorBox state={state} />
      {data.referrals.length ? (
        <>
          <ul className="space-y-2">
            {data.referrals.map((r) => (
              <li key={r.id}>
                <FieldCheck
                  name="remove"
                  value={String(r.id)}
                  label={
                    <>
                      <span className="text-gray-400">{label[r.type]}:</span> {r.name}
                    </>
                  }
                />
              </li>
            ))}
          </ul>
          <div className="flex justify-end">
            <Button size="sm" variant="outline" type="submit" disabled={pending}>
              {pending ? t("working") : t("removeReferrals")}
            </Button>
          </div>
        </>
      ) : (
        <p className={text}>{t("noReferrals")}</p>
      )}
    </form>
  );
}

function ReferDialog({ data, onClose, onSuccess }: { data: TicketActionsData; onClose: () => void; onSuccess: (state: TicketActionState) => void }) {
  const t = useTranslations("ticketActions");
  const [target, setTarget] = useState("");
  return (
    <ActionDialog
      ticketId={data.ticketId}
      onClose={onClose}
      onSuccess={onSuccess}
      title={t("referTitle", { number: data.number })}
      aside={<ReferralsManager data={data} onSuccess={onSuccess} />}
      action={referAction}
      submitLabel={t("refer")}
      commentsPlaceholder={t("referPlaceholder")}
    >
      <FieldSelect
        name="target"
        label={t("referee")}
        placeholder={t("selectTarget")}
        onChange={setTarget}
        options={[
          { value: "agent", label: t("agent") },
          { value: "team", label: t("team") },
          { value: "dept", label: t("department") },
        ]}
      />
      {target === "agent" && (
        <FieldSelect key="agent" name="agent" label={t("agent")} placeholder={t(data.referral.agents.length ? "selectAgent" : "noneAvailable")} options={toOptions(data.referral.agents)} />
      )}
      {target === "team" && (
        <FieldSelect key="team" name="team" label={t("team")} placeholder={t(data.referral.teams.length ? "selectTeam" : "noneAvailable")} options={toOptions(data.referral.teams)} />
      )}
      {target === "dept" && (
        <FieldSelect key="dept" name="dept" label={t("department")} placeholder={t(data.referral.depts.length ? "selectDept" : "noneAvailable")} options={toOptions(data.referral.depts)} />
      )}
    </ActionDialog>
  );
}

function StatusDialog({ data, statusId, onClose, onSuccess }: { data: TicketActionsData; statusId: number; onClose: () => void; onSuccess: (state: TicketActionState) => void }) {
  const t = useTranslations("ticketActions");
  const chosen = data.statuses.find((s) => s.id === statusId);
  const state = chosen?.state ?? "open";
  const closing = state === "closed";
  // ticket-status.tmpl.php: select tra tutti gli stati con lo stesso "state" (attuale compreso), preselezionato quello scelto
  const sameState = data.statuses.filter((s) => s.state === state);
  const blocker = closing ? data.closeBlocker : null;
  const warning = blocker
    ? blocker.reason === "tasks"
      ? t("notCloseableTasks", { count: blocker.count })
      : t(blocker.reason === "topic" ? "notCloseableTopic" : "notCloseableFields")
    : undefined;
  const verb = t(closing ? "verbClose" : "verbReopen");
  return (
    <ActionDialog
      ticketId={data.ticketId}
      onClose={onClose}
      onSuccess={onSuccess}
      title={t("statusTitle", { verb, number: data.number })}
      warning={warning}
      action={statusAction}
      submitLabel={verb}
      commentsPlaceholder={t("statusPlaceholder")}
    >
      {sameState.length > 1 ? (
        <FieldSelect name="statusId" label={t("status")} defaultValue={String(statusId)} options={toOptions(sameState)} />
      ) : (
        <input type="hidden" name="statusId" value={statusId} />
      )}
      {data.hasChildren && <FieldCheck name="children" label={t("children")} />}
    </ActionDialog>
  );
}
