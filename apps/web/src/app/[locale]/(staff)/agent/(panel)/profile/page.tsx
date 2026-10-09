import { getTranslations, setRequestLocale } from "next-intl/server";
import { sql } from "kysely";

import ComponentCard from "@/components/common/ComponentCard";
import { PageHeader } from "@/components/common/DataTable";
import InfoRow from "@/components/common/InfoRow";
import ProfileForm from "@/components/people/profile/ProfileForm";
import { PasswordCard, TwoFactorCard } from "@/components/people/profile/SecurityCards";
import Badge from "@/components/ui/badge/Badge";
import { staff2faConfig } from "@/server/auth/mfa";
import { sessionResetToken } from "@/server/auth/staff-recovery";
import { coreConfig } from "@/server/config/config";
import { db, table } from "@/server/db";
import { GlobalPerm } from "@/server/domain/staff/staff";
import { agentTimeZone, formatDbDate } from "@/server/format/datetime";

import { requireAgent } from "../../guard";

export async function generateMetadata() {
  return { title: (await getTranslations("profile"))("title") };
}

const LANGUAGES = [
  { id: "en_US", name: "English (US)" },
  { id: "it", name: "Italiano" },
];
const LOCALES = [
  { id: "en_US", name: "English (United States)" },
  { id: "en_GB", name: "English (United Kingdom)" },
  { id: "it_IT", name: "Italiano (Italia)" },
];

export default async function ProfilePage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ pwchange?: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const agent = await requireAgent(locale);
  const t = await getTranslations("profile");
  const tp = await getTranslations("peopleProfile");
  const sp = await searchParams;
  const tz = await agentTimeZone(agent);
  const cfg = await coreConfig();
  const dept = await db().selectFrom("department").select("name").where("id", "=", agent.deptId).executeTakeFirst();
  const globalPerms = Object.values(GlobalPerm).filter((p) => agent.hasGlobalPerm(p));
  // Code proposte come coda predefinita: pubbliche o personali (CustomQueue::queues)
  const { rows: queues } = await sql<{ id: number; title: string; parent: string | null }>`
    SELECT Q.id, Q.title, P.title AS parent FROM ${table("queue")} Q LEFT JOIN ${table("queue")} P ON (P.id = Q.parent_id)
    WHERE (Q.flags & 1) != 0 OR Q.staff_id = ${agent.id} ORDER BY Q.sort, Q.id`.execute(db());
  const twofa = staff2faConfig(agent.config);
  const resetToken = await sessionResetToken();
  const forced = !!sp.pwchange || agent.mustChangePassword;
  const r = agent.row;

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} subtitle={agent.email} />
      {agent.onVacation && <div className="rounded-xl border border-warning-300 bg-warning-50 p-4 text-sm text-warning-700 dark:border-warning-500/30 dark:bg-warning-500/10 dark:text-warning-400">{tp("welcomeBack", { name: agent.name.first })}</div>}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <ProfileForm
            data={{
              firstname: r.firstname ?? "",
              lastname: r.lastname ?? "",
              email: agent.email,
              phone: r.phone ?? "",
              phone_ext: r.phone_ext ?? "",
              mobile: r.mobile ?? "",
              signature: r.signature ?? "",
              timezone: r.timezone ?? "",
              locale: r.locale ?? "",
              lang: r.lang ?? "",
              max_page_size: r.max_page_size ?? 0,
              auto_refresh_rate: r.auto_refresh_rate ?? 0,
              default_signature_type: r.default_signature_type ?? "none",
              default_paper_size: r.default_paper_size ?? "none",
              onvacation: agent.onVacation,
              datetime_format: agent.config.str("datetime_format"),
              default_from_name: agent.config.str("default_from_name"),
              default_2fa: agent.config.str("default_2fa"),
              twofaVerified: !!twofa.verified,
              twofaRequired: cfg.bool("require_agent_2fa"),
              thread_view_order: agent.config.str("thread_view_order"),
              default_ticket_queue_id: agent.config.int("default_ticket_queue_id"),
              reply_redirect: agent.config.str("reply_redirect") || "Ticket",
              img_att_view: agent.config.str("img_att_view") || "download",
              editor_spacing: agent.config.str("editor_spacing") || "double",
              hideStaffName: cfg.bool("hide_staff_name"),
              systemPageSize: cfg.int("max_page_size"),
              queues: queues.map((q) => ({ id: q.id, name: q.parent ? `${q.parent} / ${q.title}` : q.title })),
              timezones: Intl.supportedValuesOf("timeZone"),
              languages: LANGUAGES,
              locales: LOCALES,
            }}
          />
        </div>
        <div className="space-y-6">
          <PasswordCard withToken={!!resetToken} forced={forced} />
          <TwoFactorCard email={twofa.config?.email ?? agent.email} verified={!!twofa.verified} />
          <ComponentCard title={t("account")}>
            <dl>
              <InfoRow label={t("username")} value={agent.username} />
              <InfoRow label={t("department")} value={dept?.name} />
              <InfoRow label={t("role")} value={agent.primaryRole.name} />
              <InfoRow label={t("lastLogin")} value={formatDbDate(r.lastlogin, tz, locale)} />
            </dl>
          </ComponentCard>
          <ComponentCard title={t("permissions")}>
            <div className="flex flex-wrap gap-2">
              {globalPerms.map((p) => (
                <Badge key={p} size="sm" color="info">{p}</Badge>
              ))}
              {agent.primaryRole.perms.keys().map((p) => (
                <Badge key={p} size="sm" color="success">{p}</Badge>
              ))}
            </div>
          </ComponentCard>
        </div>
      </div>
    </div>
  );
}
