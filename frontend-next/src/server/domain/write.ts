import "server-only";

import { loadConfigNamespace } from "../config/config";
import { db } from "../db";
import { detectDbTimezone } from "../db/time";
import type { Agent } from "./staff/staff";
import { staffActor, type WriteContext } from "./ticket/context";
import type { Actor } from "./ticket/events";

/**
 * Esegue un'operazione di scrittura in una transazione con il contesto dell'attore; le email e gli altri
 * effetti esterni registrati in `ctx.after` partono solo dopo il commit.
 */
export async function runWrite<T>(who: { agent: Agent; ip: string } | { actor: Actor }, fn: (ctx: WriteContext) => Promise<T>): Promise<T> {
  const cfg = await loadConfigNamespace("core");
  const dbZone = await detectDbTimezone(db());
  const after: (() => Promise<void>)[] = [];
  const result = await db()
    .transaction()
    .execute(async (tx) => {
      const ctx: WriteContext = {
        tx,
        cfg,
        actor: "agent" in who ? staffActor(who.agent, cfg, who.ip) : who.actor,
        agent: "agent" in who ? who.agent : null,
        dbZone,
        after,
      };
      return fn(ctx);
    });
  for (const job of after) {
    try {
      await job();
    } catch (err) {
      console.error("[runWrite] effetto post-commit fallito", err);
    }
  }
  return result;
}
