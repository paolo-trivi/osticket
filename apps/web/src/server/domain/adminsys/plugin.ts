import "server-only";

import { sql } from "kysely";

import { PluginInstance } from "@/lib/osticket/flags";

import type { DbOrTx } from "../../db";
import type { MassResult } from "../admin/common";

/**
 * Plugin: scp/plugins.php. Next non esegue codice PHP, quindi installazione, disinstallazione,
 * configurazione e creazione/modifica delle istanze (che richiedono le classi del plugin) restano al
 * pannello PHP. Qui: elenco, abilitazione/disabilitazione dei plugin (QuerySet::update di isactive)
 * e delle istanze (flags | FLAG_ENABLED / flags & ~FLAG_ENABLED), eliminazione delle istanze.
 * PluginManager::clearCache() svuota solo una cache in memoria del PHP: nessuna scrittura.
 */

export async function listPlugins(executor: DbOrTx) {
  const plugins = await executor.selectFrom("plugin").selectAll().orderBy("name").execute();
  const out = [];
  for (const p of plugins) {
    const instances = await executor.selectFrom("plugin_instance").selectAll().where("plugin_id", "=", p.id).orderBy("name").execute();
    out.push({ ...p, instances });
  }
  return out;
}

export type PluginMassAction = "enable" | "disable";

/** scp/plugins.php do=mass_process (enable/disable) */
export async function massPlugins(executor: DbOrTx, action: PluginMassAction, ids: number[]): Promise<MassResult> {
  if (!ids.length) return { ok: false, num: 0, error: "select_one" };
  const r = await executor
    .updateTable("plugin")
    .set({ isactive: action === "enable" ? 1 : 0 })
    .where("id", "in", ids)
    .executeTakeFirst();
  return { ok: true, num: Number(r.numUpdatedRows) };
}

export type InstanceMassAction = "enable" | "disable";

/**
 * scp/plugins.php do=instances-actions (enable/disable). L'eliminazione di un'istanza chiama
 * PluginInstance::delete → getConfig()->purge() con la classe di configurazione del plugin (codice
 * PHP): resta al pannello PHP.
 */
export async function massPluginInstances(executor: DbOrTx, pluginId: number, action: InstanceMassAction, ids: number[]): Promise<MassResult> {
  if (!ids.length) return { ok: false, num: 0, error: "select_one" };
  const plugin = await executor.selectFrom("plugin").select("id").where("id", "=", pluginId).executeTakeFirst();
  if (!plugin) return { ok: false, num: 0, error: "unknown" };
  const base = () => executor.updateTable("plugin_instance").where("plugin_id", "=", pluginId).where("id", "in", ids);
  if (action === "enable") await base().set({ flags: sql`flags | ${PluginInstance.ENABLED}` }).execute();
  else await base().set({ flags: sql`flags & ${~PluginInstance.ENABLED}` }).execute();
  return { ok: true, num: ids.length };
}
