import { getTranslations, setRequestLocale } from "next-intl/server";

import PhpLink from "@/components/adminsys/PhpLink";
import SysNotice from "@/components/adminsys/SysNotice";
import MassBar from "@/components/admin/MassBar";
import Callout from "@/components/common/Callout";
import DataTable, { PageHeader } from "@/components/common/DataTable";
import Badge from "@/components/ui/badge/Badge";
import { PluginInstance } from "@/lib/osticket/flags";
import { db } from "@/server/db";
import { listPlugins } from "@/server/domain/adminsys/plugin";

import { dateFormatter } from "../_sys/server";
import { requireAdmin } from "../guard";
import { massInstanceAction, massPluginAction } from "./actions";
import { adminMetadata } from "../metadata";

export const generateMetadata = adminMetadata("plugins");

/** Plugin installati (include/staff/plugins.inc.php). Installazione e configurazione restano al PHP. */
export default async function PluginsPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<Record<string, string>> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const agent = await requireAdmin(locale);
  const t = await getTranslations("asys.plugins");
  const c = await getTranslations("asys.common");
  const sp = await searchParams;
  const date = await dateFormatter(agent, locale);
  const plugins = await listPlugins(db());
  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      <SysNotice sp={sp} />
      <Callout tone="info">
        {t("phpNote")} <PhpLink path="/scp/plugins.php" label={t("openPhp")} />
      </Callout>
      <form action={massPluginAction} className="space-y-4">
        <MassBar
          actions={[
            { value: "enable", label: c("enable") },
            { value: "disable", label: c("disable") },
          ]}
        />
        <DataTable
          empty={t("none")}
          columns={[
            { key: "sel", label: "", className: "w-10" },
            { key: "name", label: t("name") },
            { key: "version", label: t("version") },
            { key: "status", label: t("status") },
            { key: "instances", label: t("instances") },
            { key: "installed", label: t("installed") },
          ]}
          rows={plugins.map((p) => ({
            key: p.id,
            cells: {
              sel: <input type="checkbox" name="ids[]" value={p.id} className="h-4 w-4 accent-brand-500" aria-label={p.name} />,
              name: (
                <span>
                  <span className="font-medium text-gray-800 dark:text-white/90">{p.name}</span>
                  <span className="block text-theme-xs text-gray-500">{p.install_path}</span>
                </span>
              ),
              version: p.version ?? "—",
              status: (
                <Badge size="sm" color={p.isactive ? "success" : "light"}>
                  {p.isactive ? c("active") : c("disabled")}
                </Badge>
              ),
              instances: p.instances.length,
              installed: date(p.installed, "date"),
            },
          }))}
        />
      </form>
      {plugins
        .filter((p) => p.instances.length)
        .map((p) => (
          <form key={p.id} action={massInstanceAction.bind(null, p.id)} className="space-y-3">
            <h3 className="text-base font-semibold text-gray-800 dark:text-white/90">{t("instancesOf", { name: p.name })}</h3>
            <MassBar
              actions={[
                { value: "enable", label: c("enable") },
                { value: "disable", label: c("disable") },
              ]}
            />
            <DataTable
              empty={c("empty")}
              columns={[
                { key: "sel", label: "", className: "w-10" },
                { key: "name", label: t("name") },
                { key: "status", label: t("status") },
                { key: "updated", label: c("updated") },
              ]}
              rows={p.instances.map((i) => ({
                key: i.id,
                cells: {
                  sel: <input type="checkbox" name="ids[]" value={i.id} className="h-4 w-4 accent-brand-500" aria-label={i.name} />,
                  name: i.name,
                  status: (
                    <Badge size="sm" color={i.flags & PluginInstance.ENABLED ? "success" : "light"}>
                      {i.flags & PluginInstance.ENABLED ? c("active") : c("disabled")}
                    </Badge>
                  ),
                  updated: date(i.updated),
                },
              }))}
            />
          </form>
        ))}
    </div>
  );
}
