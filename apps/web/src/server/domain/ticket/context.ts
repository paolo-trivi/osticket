import "server-only";

import type { ConfigNamespace } from "../../config/config";
import type { DbOrTx } from "../../db";
import { PersonsName } from "../../format/persons-name";
import type { Agent } from "../staff/staff";
import type { Actor } from "./events";

/** Contesto di un'operazione di scrittura: transazione, config core, attore ($thisstaff/$thisclient). */
export interface WriteContext {
  tx: DbOrTx;
  cfg: ConfigNamespace;
  actor: Actor;
  /** agente corrente con ruoli e permessi (se l'attore è un agente) */
  agent: Agent | null;
  /** fuso del DB per confronti di date */
  dbZone: string;
  /** effetti da eseguire dopo il commit (email) */
  after: (() => Promise<void>)[];
}

/** Nome dell'agente come (string) Staff::getName(): formato core.agent_name_format. */
export function agentDisplayName(agent: Agent, cfg: ConfigNamespace): string {
  return new PersonsName({ first: agent.name.first, last: agent.name.last }, cfg.str("agent_name_format")).toString();
}

export function staffActor(agent: Agent, cfg: ConfigNamespace, ip: string): Actor {
  return { kind: "staff", id: agent.id, username: agent.username, name: agentDisplayName(agent, cfg), ip };
}
