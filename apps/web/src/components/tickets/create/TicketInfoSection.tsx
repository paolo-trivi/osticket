"use client";

import { useState } from "react";

import { useTranslations } from "next-intl";

import ComponentCard from "@/components/common/ComponentCard";
import FieldShell from "@/components/forms/dynamic/FieldShell";
import { errorInputCls, inputCls, selectCls } from "@/components/forms/dynamic/styles";
import { cn } from "@/utils";

import { first, type NewTicketOptions, type SubmittedValues } from "./types";

interface Props {
  options: NewTicketOptions;
  values?: SubmittedValues;
  errors: {
    topicId?: string;
    source?: string;
    duedate?: string;
    assignId?: string;
    deptId?: string;
  };
  onTopicChange: (topicId: number) => void;
}

const SOURCES = ["Phone", "Email", "Other"] as const;

/** Sorgente, help topic, reparto, SLA, scadenza e assegnazione (ticket-open.inc.php). */
export default function TicketInfoSection({ options, values, errors, onTopicChange }: Props) {
  const t = useTranslations("createTicket.info");
  const tc = useTranslations("createTicket");
  const [due, setDue] = useState(first(values, "duedate").slice(0, 16));
  return (
    <ComponentCard title={tc("sections.info")}>
      <div className="grid gap-5 md:grid-cols-2">
        <FieldShell htmlFor="source" label={t("source")} required errors={errors.source ? [errors.source] : undefined}>
          <select id="source" name="source" defaultValue={first(values, "source") || "Phone"} className={selectCls}>
            {SOURCES.map((s) => (
              <option key={s} value={s}>
                {t(`sources.${s}`)}
              </option>
            ))}
          </select>
        </FieldShell>
        <FieldShell htmlFor="topicId" label={t("topic")} required errors={errors.topicId ? [errors.topicId] : undefined}>
          <select
            id="topicId"
            name="topicId"
            required
            defaultValue={first(values, "topicId")}
            onChange={(e) => onTopicChange(Number(e.target.value) || 0)}
            className={cn(selectCls, errors.topicId && errorInputCls)}
          >
            <option value="">{t("topicPick")}</option>
            {options.topics.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </FieldShell>
        <FieldShell htmlFor="deptId" label={t("dept")} errors={errors.deptId ? [errors.deptId] : undefined}>
          <select id="deptId" name="deptId" defaultValue={first(values, "deptId")} className={selectCls}>
            <option value="">{t("deptFromTopic")}</option>
            {options.depts.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </FieldShell>
        <FieldShell htmlFor="slaId" label={t("sla")}>
          <select id="slaId" name="slaId" defaultValue={first(values, "slaId")} className={selectCls}>
            <option value="">{t("slaDefault")}</option>
            {options.slas.map((o) => (
              <option key={o.id} value={o.id}>
                {o.active === false ? `${o.name} ${t("slaDisabled")}` : o.name}
              </option>
            ))}
          </select>
        </FieldShell>
        <FieldShell htmlFor="duedate" label={t("duedate")} hint={t("duedateHint")} errors={errors.duedate ? [errors.duedate] : undefined}>
          <input id="duedate" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} className={cn(inputCls, errors.duedate && errorInputCls)} />
          {/* ora nel fuso dell'agente, convertita dal server come in "Modifica ticket" */}
          <input type="hidden" name="duedate" value={due} />
        </FieldShell>
        <FieldShell htmlFor="assignId" label={t("assign")} errors={errors.assignId ? [errors.assignId] : undefined}>
          <select id="assignId" name="assignId" defaultValue={first(values, "assignId")} className={selectCls}>
            <option value="">{t("assignNone")}</option>
            <optgroup label={t("agents")}>
              {options.agents.map((o) => (
                <option key={`s${o.id}`} value={`s${o.id}`}>
                  {o.name}
                </option>
              ))}
            </optgroup>
            {options.teams.length > 0 && (
              <optgroup label={t("teams")}>
                {options.teams.map((o) => (
                  <option key={`t${o.id}`} value={`t${o.id}`}>
                    {o.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </FieldShell>
      </div>
    </ComponentCard>
  );
}
