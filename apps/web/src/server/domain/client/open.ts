import "server-only";

import type { ConfigNamespace } from "../../config/config";
import { deleteDraftsForNamespace } from "../drafts";
import { createTicket, type CreateResult, type CreateTicketVars } from "../ticket/create";
import type { Actor } from "../ticket/events";
import { runWrite } from "../write";
import type { ClientIdentity } from "./identity";

/**
 * Apertura di un ticket dal portale (open.php → Ticket::create($vars, $errors, 'Web')).
 */

/** $thisclient come attore delle scritture (eventi, fuso dell'utente) */
export function clientActor(cfg: ConfigNamespace, client: ClientIdentity, ip: string): Actor {
  return {
    kind: "user",
    id: client.id,
    // ThreadEvents::log: getFullName() (nome grezzo) se l'utente ha un account, altrimenti l'indirizzo
    name: client.name,
    email: client.email,
    hasAccount: !!client.account,
    ip,
  };
}

type PortalOpenError = "login_required" | "captcha_unsupported";

/**
 * Regole di open.php: con "solo clienti registrati" (clients_only) servono un utente autenticato e
 * non ospite; con registrazione disattivata il portale rimanda alla verifica dello stato.
 * Il captcha per gli ospiti (enable_captcha, immagine GD del PHP) non è replicato: con il captcha
 * attivo gli ospiti non possono aprire ticket da Next (regola più stretta) e usano il portale PHP.
 */
export function portalOpenAllowed(cfg: ConfigNamespace, client: ClientIdentity | null): true | PortalOpenError {
  if (cfg.bool("clients_only") && (!client || client.guest)) return "login_required";
  if (!client && cfg.bool("enable_captcha")) return "captcha_unsupported";
  return true;
}

/**
 * Apertura dal portale: cancellazione delle bozze della sessione (`ticket.client.<ultimi 12 caratteri
 * della sessione>`, anche se la creazione fallisce) e Ticket::create con origine Web, reparto ed email
 * azzerati, utente corrente come proprietario. `vars` = campi dei form (per nome) e `message`,
 * `files` = allegati già verificati.
 */
export async function openPortalTicket(
  cfg: ConfigNamespace,
  client: ClientIdentity | null,
  vars: CreateTicketVars,
  opts: { ip: string; sessionKey: string },
): Promise<CreateResult | { ok: false; denied: PortalOpenError }> {
  const allowed = portalOpenAllowed(cfg, client);
  if (allowed !== true) return { ok: false, denied: allowed };
  const actor = client ? clientActor(cfg, client, opts.ip) : null;
  const input: CreateTicketVars = { ...vars, ip: opts.ip, deptId: 0, emailId: 0 };
  if (client) input.uid = client.id;
  else delete input.uid;
  return runWrite({ actor }, async (ctx) => {
    await deleteDraftsForNamespace(ctx.tx, `ticket.client.${opts.sessionKey.slice(-12)}`);
    return createTicket(ctx, input, "web");
  });
}

