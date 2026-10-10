import "server-only";

import { getTranslations } from "next-intl/server";

import type { FormSection } from "@/lib/admin/form-schema";
import { Topic } from "@/lib/osticket/flags";
import { FormType } from "@/lib/osticket/object-types";
import { db } from "@/server/db";
import { deptOptions, formsWithFields, pageOptions, priorityOptions, sequenceOptions, slaOptions, staffOptions, statusOptions, teamOptions, topicOptions } from "@/server/domain/admin/lookups";
import { phpJsonDecode } from "@/server/format/php-json";

/** Sezioni del form help topic (include/staff/helptopic.inc.php). */
export async function topicSections(topicId: number | null): Promise<FormSection[] | null> {
  const t = await getTranslations("admTopics");
  const u = await getTranslations("admUi");
  const executor = db();
  const topic = topicId ? await executor.selectFrom("help_topic").selectAll().where("topic_id", "=", topicId).executeTakeFirst() : null;
  if (topicId && !topic) return null;
  const flags = topic?.flags ?? Topic.ACTIVE;
  const status = flags & Topic.ACTIVE ? "active" : flags & Topic.ARCHIVED ? "archived" : "disabled";
  const [topics, depts, statuses, priorities, slas, pages, staff, teams, sequences, forms] = await Promise.all([
    topicOptions(executor),
    deptOptions(executor),
    statusOptions(executor, ["open"]),
    priorityOptions(executor),
    slaOptions(executor),
    pageOptions(executor, "thank-you"),
    staffOptions(executor),
    teamOptions(executor),
    sequenceOptions(executor),
    formsWithFields(executor),
  ]);
  const attached = topicId ? await executor.selectFrom("help_topic_form").select(["form_id", "sort", "extra"]).where("topic_id", "=", topicId).orderBy("sort").execute() : [];
  const disabled = new Set<number>();
  for (const a of attached) for (const id of phpJsonDecode<{ disable?: number[] }>(a.extra, {}).disable ?? []) disabled.add(Number(id));
  const attachedIds = attached.map((a) => String(a.form_id));
  // form della pagina nuovo topic: "Ticket Details" (tipo T) predefinito
  const selectedForms = topicId ? attachedIds : forms.filter((f) => f.type === FormType.TICKET).map((f) => String(f.id));
  const orderedForms = [...forms].sort((a, b) => {
    const ia = selectedForms.indexOf(String(a.id));
    const ib = selectedForms.indexOf(String(b.id));
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
  });
  const assign = topic?.staff_id ? `s${topic.staff_id}` : topic?.team_id ? `t${topic.team_id}` : "";
  const def = (label: string) => [{ value: "0", label }];
  return [
    {
      title: t("sections.info"),
      fields: [
        { kind: "hidden", name: "do", value: topicId ? "update" : "create" },
        { kind: "hidden", name: "id", value: topicId ? String(topicId) : "" },
        { kind: "text", name: "topic", label: t("topic"), value: topic?.topic ?? "", required: true },
        {
          kind: "select",
          name: "topic_pid",
          label: t("parent"),
          value: String(topic?.topic_pid ?? 0),
          options: [{ value: "0", label: t("topLevel") }, ...topics.filter((x) => x.value !== String(topicId))],
        },
        { kind: "select", name: "status", label: t("status"), value: status, options: ["active", "disabled", "archived"].map((s) => ({ value: s, label: u(`status.${s}`) })) },
        {
          kind: "radio",
          name: "ispublic",
          label: t("type"),
          value: topic ? String(topic.ispublic) : "1",
          options: [
            { value: "1", label: t("public") },
            { value: "0", label: t("private") },
          ],
        },
        { kind: "textarea", name: "notes", label: t("notes"), value: topic?.notes ?? "", rows: 3, wide: true },
      ],
    },
    {
      title: t("sections.options"),
      fields: [
        { kind: "select", name: "dept_id", label: t("dept"), value: String(topic?.dept_id ?? 0), options: [...def(t("systemDefault")), ...depts.filter((d) => d.active)] },
        { kind: "select", name: "status_id", label: t("ticketStatus"), value: String(topic?.status_id ?? 0), options: [...def(t("systemDefault")), ...statuses] },
        { kind: "select", name: "priority_id", label: t("priority"), value: String(topic?.priority_id ?? 0), options: [...def(t("systemDefault")), ...priorities] },
        { kind: "select", name: "sla_id", label: t("sla"), value: String(topic?.sla_id ?? 0), options: [...def(t("deptDefault")), ...slas] },
        { kind: "select", name: "page_id", label: t("thankYouPage"), value: String(topic?.page_id ?? 0), options: [...def(t("systemDefault")), ...pages] },
        {
          kind: "select",
          name: "assign",
          label: t("autoAssign"),
          value: assign,
          options: [{ value: "", label: u("none") }, ...staff.map((s) => ({ value: `s${s.value}`, label: `${t("agent")}: ${s.label}` })), ...teams.map((x) => ({ value: `t${x.value}`, label: `${t("team")}: ${x.label}` }))],
        },
        { kind: "checkbox", name: "noautoresp", label: t("noAutoresp"), checked: !!topic?.noautoresp },
        {
          kind: "radio",
          name: "custom-numbers",
          label: t("numbering"),
          value: flags & Topic.CUSTOM_NUMBERS ? "1" : "0",
          options: [
            { value: "0", label: t("systemNumbering") },
            { value: "1", label: t("customNumbering") },
          ],
        },
        { kind: "text", name: "number_format", label: t("numberFormat"), value: topic?.number_format ?? "", placeholder: "######" },
        { kind: "select", name: "sequence_id", label: t("sequence"), value: String(topic?.sequence_id ?? 0), options: [...def(t("random")), ...sequences] },
      ],
    },
    {
      title: t("sections.forms"),
      desc: t("formsDesc"),
      fields: [
        { kind: "checkboxes", name: "forms[]", label: t("forms"), values: selectedForms, options: orderedForms.map((f) => ({ value: String(f.id), label: f.title })), wide: true },
        {
          kind: "checkboxes",
          name: "fields[]",
          label: t("fields"),
          wide: true,
          options: [],
          values: orderedForms.flatMap((f) => f.fields.map((x) => x.value)).filter((id) => !disabled.has(Number(id))),
          groups: orderedForms.map((f) => ({ title: f.title, options: f.fields })),
        },
      ],
    },
  ];
}
