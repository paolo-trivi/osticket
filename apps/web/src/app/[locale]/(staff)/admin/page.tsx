import { ArrowRight } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";

import ComponentCard from "@/components/common/ComponentCard";
import { PageHeader } from "@/components/common/DataTable";
import InfoRow from "@/components/common/InfoRow";
import Badge from "@/components/ui/badge/Badge";
import { Link } from "@/i18n/navigation";
import pkg from "../../../../../package.json";
import { adminSummary } from "@/server/domain/admin/dashboard";
import { knownSchema, VERIFIED_SCHEMAS } from "@/server/system/schema-compat";

import { requireAdmin } from "./guard";
import { adminMetadata } from "./metadata";

export const generateMetadata = adminMetadata("home");

const SECTIONS: { key: string; links: { key: string; href: string }[] }[] = [
  {
    key: "settings",
    links: [
      { key: "company", href: "/admin/settings/company" },
      { key: "system", href: "/admin/settings/system" },
      { key: "tickets", href: "/admin/settings/tickets" },
      { key: "tasks", href: "/admin/settings/tasks" },
      { key: "agentsSettings", href: "/admin/settings/agents" },
      { key: "usersSettings", href: "/admin/settings/users" },
      { key: "kb", href: "/admin/settings/kb" },
      { key: "theme", href: "/admin/theme" },
    ],
  },
  {
    key: "manage",
    links: [
      { key: "topics", href: "/admin/topics" },
      { key: "sla", href: "/admin/sla" },
      { key: "schedules", href: "/admin/schedules" },
    ],
  },
  {
    key: "staff",
    links: [
      { key: "agents", href: "/admin/agents" },
      { key: "teams", href: "/admin/teams" },
      { key: "roles", href: "/admin/roles" },
      { key: "departments", href: "/admin/departments" },
    ],
  },
];

/** Home dell'area admin: stato dell'help desk, versioni, conteggi e collegamenti alle sezioni. */
export default async function AdminHomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireAdmin(locale);
  const t = await getTranslations("admHome");
  const s = await adminSummary();
  const schemaVerified = VERIFIED_SCHEMAS.some((v) => v.signature === s.schema);
  const stats: { key: keyof typeof s.counts; href: string }[] = [
    { key: "openTickets", href: "/agent" },
    { key: "departments", href: "/admin/departments" },
    { key: "topics", href: "/admin/topics" },
    { key: "agents", href: "/admin/agents" },
    { key: "teams", href: "/admin/teams" },
    { key: "roles", href: "/admin/roles" },
    { key: "slas", href: "/admin/sla" },
    { key: "schedules", href: "/admin/schedules" },
  ];
  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} subtitle={s.helpdeskTitle} />
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {stats.map((x) => (
          <Link
            key={x.key}
            href={x.href}
            className="rounded-2xl border border-gray-200 bg-white p-5 transition hover:border-brand-300 dark:border-gray-800 dark:bg-white/3 dark:hover:border-brand-800"
          >
            <p className="text-sm text-gray-500 dark:text-gray-400">{t(`counts.${x.key}`)}</p>
            <p className="mt-2 text-title-sm font-semibold text-gray-800 dark:text-white/90">{s.counts[x.key]}</p>
          </Link>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <ComponentCard title={t("system")}>
          <dl className="space-y-1">
            <InfoRow
              label={t("status")}
              value={
                <Badge size="sm" color={s.online ? "success" : "error"}>
                  {s.online ? t("online") : t("offline")}
                </Badge>
              }
            />
            <InfoRow label={t("version")} value={`TailTicket ${pkg.version} · osTicket ${knownSchema(s.schema)?.series ?? "—"}`} />
            <InfoRow
              label={t("schema")}
              value={
                <span className="inline-flex flex-wrap items-center gap-2">
                  <code className="text-theme-xs">{s.schema}</code>
                  <Badge size="sm" color={schemaVerified ? "success" : "warning"}>
                    {schemaVerified ? t("schemaVerified") : t("schemaUnverified")}
                  </Badge>
                </span>
              }
            />
            <InfoRow label={t("database")} value={s.mysql} />
            <InfoRow label={t("runtime")} value={`Node.js ${s.node}`} />
            <InfoRow label={t("agentsSummary")} value={t("agentsLine", { active: s.counts.activeAgents, total: s.counts.agents, admins: s.counts.admins })} />
            <InfoRow label={t("users")} value={s.counts.users} />
          </dl>
        </ComponentCard>
        {SECTIONS.map((sec) => (
          <ComponentCard key={sec.key} title={t(`sections.${sec.key}`)}>
            <ul className="space-y-2">
              {sec.links.map((l) => (
                <li key={l.key}>
                  <Link href={l.href} className="group inline-flex items-center gap-1.5 text-sm font-medium text-brand-500 hover:text-brand-600">
                    {t(`links.${l.key}`)}
                    <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5 rtl:rotate-180" />
                  </Link>
                </li>
              ))}
            </ul>
          </ComponentCard>
        ))}
      </div>
    </div>
  );
}
