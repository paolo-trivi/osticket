"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import {
  assignAction,
  claimAction,
  markAction,
  referAction,
  releaseAction,
  statusAction,
  transferAction,
} from "@/app/[locale]/(staff)/agent/(panel)/tickets/[id]/actions-assign";

import ActionDialog from "./ActionDialog";
import { FieldCheck, FieldSelect, toOptions } from "./FormFields";
import type { ActionKind, TicketActionsData } from "./types";

interface Props {
  kind: ActionKind;
  data: TicketActionsData;
  onClose: () => void;
}

/** Modale dell'azione scelta nel menu (stessi form dei template PHP assign/transfer/refer/release/mark-as/ticket-status). */
export default function ActionDialogs({ kind, data, onClose }: Props) {
  const t = useTranslations("ticketActions");
  const common = { ticketId: data.ticketId, onClose };
  const assigned = data.assignedStaff?.isMe ? t("you") : [data.assignedStaff?.name, data.assignedTeam?.name].filter(Boolean).join(" / ");
  const notice = data.isAssigned ? t("currentlyAssigned", { who: assigned }) : undefined;

  if (typeof kind === "object") return <StatusDialog data={data} statusId={kind.status} onClose={onClose} />;

  switch (kind) {
    case "claim":
      return (
        <ActionDialog {...common} title={t("claimTitle", { number: data.number })} action={claimAction} submitLabel={t("claimConfirm")} commentsPlaceholder={t("claimPlaceholder")}>
          <p className="text-theme-sm text-gray-600 dark:text-gray-400">{t("claimWarn")}</p>
        </ActionDialog>
      );
    case "assignAgent":
    case "assignTeam": {
      const agents = kind === "assignAgent";
      const current = agents ? (data.assignedStaff && data.isAssigned ? `s${data.assignedStaff.id}` : "") : data.assignedTeam && data.isAssigned ? `t${data.assignedTeam.id}` : "";
      const hasCurrent = data.isAssigned && (data.assignedStaff || data.assignedTeam);
      return (
        <ActionDialog
          {...common}
          title={t(agents ? "assignAgentTitle" : "assignTeamTitle", { number: data.number, verb: data.isAssigned ? t("reassign") : t("assign") })}
          notice={notice}
          action={assignAction}
          submitLabel={t("assign")}
          commentsPlaceholder={t("assignPlaceholder")}
        >
          <FieldSelect
            name="assignee"
            label={t("assignee")}
            placeholder={agents ? t("selectAgent") : t("selectTeam")}
            defaultValue={current}
            options={agents ? toOptions(data.agents, "s") : toOptions(data.teams, "t")}
          />
          {hasCurrent && <FieldCheck name="refer" label={t("keepReferral", { who: assigned })} />}
        </ActionDialog>
      );
    }
    case "transfer":
      return (
        <ActionDialog
          {...common}
          title={t("transferTitle", { number: data.number })}
          action={transferAction}
          submitLabel={t("transfer")}
          commentsPlaceholder={t("transferPlaceholder")}
        >
          <FieldSelect name="dept" label={t("department")} defaultValue={String(data.deptId)} options={toOptions(data.depts)} />
          <FieldCheck name="refer" label={t("keepDeptReferral")} />
        </ActionDialog>
      );
    case "release":
      return (
        <ActionDialog {...common} title={t("releaseTitle", { number: data.number })} action={releaseAction} submitLabel={t("release")} commentsPlaceholder={t("releasePlaceholder")}>
          <p className="text-theme-sm text-gray-600 dark:text-gray-400">{t("releaseWhich")}</p>
          <div className="space-y-2">
            {data.assignedStaff && <FieldCheck name="sid" label={data.assignedStaff.isMe ? t("you") : data.assignedStaff.name} defaultChecked />}
            {data.assignedTeam && <FieldCheck name="tid" label={data.assignedTeam.name} defaultChecked={!data.assignedStaff} />}
          </div>
        </ActionDialog>
      );
    case "refer":
      return <ReferDialog data={data} onClose={onClose} />;
    case "markAnswered":
    case "markUnanswered": {
      const answered = kind === "markAnswered";
      return (
        <ActionDialog
          {...common}
          title={t("confirmTitle")}
          action={markAction}
          submitLabel={t(answered ? "markAnswered" : "markUnanswered")}
          commentsPlaceholder={t("markPlaceholder")}
        >
          <input type="hidden" name="answered" value={answered ? "1" : "0"} />
          <p className="text-theme-sm text-gray-600 dark:text-gray-400">{t(answered ? "markAnsweredConfirm" : "markUnansweredConfirm")}</p>
        </ActionDialog>
      );
    }
  }
}

function ReferDialog({ data, onClose }: { data: TicketActionsData; onClose: () => void }) {
  const t = useTranslations("ticketActions");
  const [target, setTarget] = useState("");
  const icon = { S: t("agent"), E: t("team"), D: t("department") };
  return (
    <ActionDialog ticketId={data.ticketId} onClose={onClose} title={t("referTitle", { number: data.number })} action={referAction} submitLabel={t("refer")} commentsPlaceholder={t("referPlaceholder")}>
      {data.referrals.length > 0 && (
        <div className="space-y-1">
          <p className="text-theme-sm font-medium text-gray-700 dark:text-gray-400">{t("currentReferrals")}</p>
          <ul className="space-y-1 text-theme-sm text-gray-600 dark:text-gray-400">
            {data.referrals.map((r) => (
              <li key={r.id}>
                <span className="text-gray-400">{icon[r.type]}:</span> {r.name}
              </li>
            ))}
          </ul>
        </div>
      )}
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
      {target === "agent" && <FieldSelect key="agent" name="agent" placeholder={t("selectAgent")} options={toOptions(data.referral.agents)} />}
      {target === "team" && <FieldSelect key="team" name="team" placeholder={t("selectTeam")} options={toOptions(data.referral.teams)} />}
      {target === "dept" && <FieldSelect key="dept" name="dept" placeholder={t("selectDept")} options={toOptions(data.referral.depts)} />}
    </ActionDialog>
  );
}

function StatusDialog({ data, statusId, onClose }: { data: TicketActionsData; statusId: number; onClose: () => void }) {
  const t = useTranslations("ticketActions");
  const chosen = data.statuses.find((s) => s.id === statusId);
  const state = chosen?.state ?? "open";
  // ticket-status.tmpl.php: select tra gli stati con lo stesso "state", preselezionato quello scelto
  const sameState = data.statuses.filter((s) => s.state === state);
  return (
    <ActionDialog
      ticketId={data.ticketId}
      onClose={onClose}
      title={t("statusTitle", { verb: t(state === "closed" ? "verbClose" : "verbReopen"), number: data.number })}
      action={statusAction}
      submitLabel={t(state === "closed" ? "verbClose" : "verbReopen")}
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
