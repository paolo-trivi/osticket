import "server-only";

import { getTranslations } from "next-intl/server";

import FilterActionsEditor, { type ActionTypeDef } from "@/components/adminsys/FilterActionsEditor";
import { Hidden, RadioField, Section, SelectField, TextAreaField, TextField } from "@/components/adminsys/fields";
import Repeater from "@/components/adminsys/Repeater";
import { db } from "@/server/db";
import { phpJsonDecode } from "@/server/format/php-json";
import { deptOptions, emailOptions, priorityOptions, slaOptions, staffOptions, statusOptions, teamOptions, topicOptions } from "@/server/domain/admin/lookups";
import { TARGETS, type filterInfo } from "@/server/domain/adminsys/filter";
import { ACTION_FIELDS, ACTION_TYPES } from "@/server/domain/adminsys/filter-actions";
import { MATCH_TYPES, matchFieldList } from "@/server/domain/adminsys/filter-rules";

type Info = NonNullable<Awaited<ReturnType<typeof filterInfo>>>;

/** Form del filtro (include/staff/filter.inc.php): proprietà, regole, azioni, note. */
export async function FilterFields({ info }: { info: Info | null }) {
  const t = await getTranslations("asys.filters");
  const executor = db();
  const f = info?.filter;
  const [emails, depts, priorities, slas, teams, staff, topics, statuses, canned, matchFields] = await Promise.all([
    emailOptions(executor),
    deptOptions(executor),
    priorityOptions(executor),
    slaOptions(executor),
    teamOptions(executor),
    staffOptions(executor),
    topicOptions(executor),
    statusOptions(executor, ["open", "closed"]),
    executor.selectFrom("canned_response").select(["canned_id", "title", "isenabled"]).orderBy("title").execute(),
    matchFieldList(executor),
  ]);
  const unchanged = { value: "", label: t("unchanged") };
  const choices: Record<string, { value: string; label: string }[]> = {
    canned_id: [{ value: "", label: t("none") }, ...canned.map((c) => ({ value: String(c.canned_id), label: c.isenabled ? c.title : `${c.title} (${t("disabled")})` }))],
    dept_id: [unchanged, ...depts.filter((d) => d.active || String(phpJsonDecode<Record<string, unknown>>(info?.actions.find((a) => a.type === "dept")?.configuration, {}).dept_id) === d.value)],
    priority: [unchanged, ...priorities],
    sla_id: [unchanged, ...slas],
    team_id: [unchanged, ...teams],
    staff_id: [unchanged, ...staff],
    topic_id: [unchanged, ...topics],
    status_id: [unchanged, ...statuses],
    from: emails,
  };
  const types: ActionTypeDef[] = ACTION_TYPES.map((a) => ({
    type: a.type,
    label: t(`actions.${a.type}`),
    group: t(`actionGroups.${a.group}`),
    multi: a.multi,
    info: t.has(`actionInfo.${a.type}`) ? t(`actionInfo.${a.type}`) : undefined,
    fields: (ACTION_FIELDS[a.type] ?? []).map((fd) => ({ name: fd.name, kind: fd.kind, label: t(`actionFields.${fd.name}`), options: choices[fd.name] })),
  }));
  const existing = (info?.actions ?? []).map((a) => ({
    id: a.id,
    type: a.type,
    config: Object.fromEntries(Object.entries(phpJsonDecode<Record<string, unknown>>(a.configuration, {})).map(([k, v]) => [k, v === null || v === undefined || v === false ? "" : String(v)])),
  }));
  const groupLabel = (g: string) => t(`matchGroups.${g}`);
  const matchOptions = [
    { value: "", label: t("selectField") },
    ...["name", "email"].map((k) => ({ value: k, label: `${t("matchGroups.userInfo")} / ${t(`match.${k}`)}` })),
    ...["reply-to", "reply-to-name", "addressee"].map((k) => ({ value: k, label: `${t("matchGroups.emailMeta")} / ${t(`match.${k}`)}` })),
    { value: "topicId", label: `${t("matchGroups.topic")} / ${t("match.topicId")}` },
    ...matchFields.map((m) => ({ value: m.key, label: `${groupLabel(m.group)} / ${m.label}` })),
  ];
  const howOptions = [{ value: "", label: t("selectHow") }, ...MATCH_TYPES.map((h) => ({ value: h, label: t(`how.${h}`) }))];
  const target = f ? (f.target === "Email" && f.email_id ? String(f.email_id) : f.target) : "Any";
  return (
    <>
      <Hidden name="do" value={f ? "update" : "add"} />
      <Section title={t("sections.filter")}>
        <TextField name="name" label={t("name")} value={f?.name} required />
        <TextField name="execorder" label={t("order")} value={f?.execorder ?? ""} type="number" hint={t("orderHint")} />
        <RadioField
          name="isactive"
          label={t("status")}
          value={f ? String(f.isactive ? 1 : 0) : "1"}
          options={[
            { value: "1", label: t("active") },
            { value: "0", label: t("disabled") },
          ]}
        />
        <SelectField
          name="target"
          label={t("target")}
          value={target}
          options={[{ value: "", label: t("selectTarget") }, ...TARGETS.map((x) => ({ value: x, label: t(`targets.${x}`) })), ...emails.map((e) => ({ value: e.value, label: `${t("targets.Email")}: ${e.label}` }))]}
        />
        <label className="flex items-center gap-3 pt-2 text-sm text-gray-700 dark:text-gray-300">
          <input type="checkbox" name="stop_onmatch" value="1" defaultChecked={!!f?.stop_onmatch} className="h-4 w-4 accent-brand-500" />
          {t("stopOnMatch")}
        </label>
      </Section>
      <Section title={t("sections.rules")} desc={t("rulesDesc")} grid={false}>
        <div className="mb-4">
          <RadioField
            name="match_all_rules"
            label={t("matching")}
            value={f?.match_all_rules ? "1" : "0"}
            options={[
              { value: "1", label: t("matchAll") },
              { value: "0", label: t("matchAny") },
            ]}
          />
        </div>
        <Repeater
          columns={[
            { key: "w", label: t("field"), kind: "select", options: matchOptions },
            { key: "h", label: t("operator"), kind: "select", options: howOptions },
            { key: "v", label: t("value"), kind: "text" },
          ]}
          rows={[]}
          newNames={{ w: "rules[{i}][w]", h: "rules[{i}][h]", v: "rules[{i}][v]" }}
          initialNew={info?.rules.length ? info.rules.map((r) => ({ w: r.what, h: r.how, v: r.val })) : [{ w: "", h: "", v: "" }]}
          addLabel={t("addRule")}
          removeLabel={t("remove")}
        />
      </Section>
      <Section title={t("sections.actions")} desc={t("actionsDesc")} grid={false}>
        <FilterActionsEditor types={types} existing={existing} labels={{ add: t("addAction"), select: t("selectAction"), remove: t("remove"), empty: t("noActions"), unchanged: t("unchanged") }} />
      </Section>
      <Section title={t("sections.notes")} grid={false}>
        <TextAreaField name="notes" label={t("notes")} value={f?.notes} rows={3} />
      </Section>
    </>
  );
}
