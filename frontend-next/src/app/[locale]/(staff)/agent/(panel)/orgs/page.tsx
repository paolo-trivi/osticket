import { getTranslations, setRequestLocale } from "next-intl/server";

import DataTable, { PageHeader, SearchBox } from "@/components/common/DataTable";
import LinkPager from "@/components/common/LinkPager";
import { Link } from "@/i18n/navigation";
import { listOrgs } from "@/server/domain/directory/directory";
import { pageSizeFor } from "@/server/domain/queue/context";
import { agentTimeZone, formatDbDate } from "@/server/format/datetime";

import { requireAgent } from "../../guard";

export async function generateMetadata() {
  return { title: (await getTranslations("directory"))("orgs") };
}

export default async function OrgsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ q?: string; p?: string; sort?: string; dir?: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const agent = await requireAgent(locale);
  const t = await getTranslations("directory");
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.p) || 1);
  const pageSize = await pageSizeFor(agent);
  const desc = sp.dir === "1";
  const { rows, total } = await listOrgs({ q: sp.q, sort: sp.sort, desc, page, pageSize });
  const tz = await agentTimeZone(agent);
  const href = (extra: Record<string, string | number>) => {
    const p = new URLSearchParams();
    if (sp.q) p.set("q", sp.q);
    for (const [k, v] of Object.entries({ sort: sp.sort ?? "", dir: sp.dir ?? "", ...extra })) if (v !== "") p.set(k, String(v));
    return `/agent/orgs?${p}`;
  };
  const sortCol = (key: string) => ({
    sortHref: href({ sort: key, dir: sp.sort === key && !desc ? 1 : 0, p: 1 }),
    sorted: sp.sort === key || (!sp.sort && key === "name") ? ((desc ? "desc" : "asc") as "asc" | "desc") : undefined,
  });
  return (
    <div className="space-y-5">
      <PageHeader title={t("orgs")} subtitle={t("orgsCount", { n: total })} actions={<SearchBox action="/agent/orgs" value={sp.q} placeholder={t("searchOrgs")} />} />
      <DataTable
        empty={t("empty")}
        columns={[
          { key: "name", label: t("name"), ...sortCol("name") },
          { key: "users", label: t("users"), ...sortCol("users") },
          { key: "created", label: t("created"), ...sortCol("created") },
          { key: "updated", label: t("updated"), ...sortCol("updated") },
        ]}
        rows={rows.map((o) => ({
          key: o.id,
          cells: {
            name: (
              <Link href={`/agent/orgs/${o.id}`} className="font-medium text-brand-600 hover:underline dark:text-brand-400">
                {o.name}
              </Link>
            ),
            users: o.users,
            created: formatDbDate(o.created, tz, locale, "date"),
            updated: formatDbDate(o.updated, tz, locale, "date"),
          },
        }))}
      />
      <LinkPager page={page} totalPages={Math.max(1, Math.ceil(total / pageSize))} href={(p) => href({ p })} labels={{ prev: t("prev"), next: t("next") }} />
    </div>
  );
}
