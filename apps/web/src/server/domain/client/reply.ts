import "server-only";

import type { ConfigNamespace } from "../../config/config";
import type { AttachInput } from "../file/upload";
import { postMessage, type PostMessageResult } from "../ticket/message";
import type { ReadOnlyResult } from "../../system/write-mode";
import { runWrite } from "../write";
import { clientDisplayName, type ClientIdentity } from "./identity";
import { deleteDraftsForNamespace } from "../drafts";
import { clientActor } from "./open";
import { editTicketAsClient, type ClientEditResult } from "./ticket-edit";
import { clientCanAccess } from "./tickets";

/**
 * tickets.php POST a=reply: controllo di accesso, Ticket::postMessage($vars, 'Web') con l'utente
 * corrente come autore, poi cancellazione delle bozze `ticket.client.<id ticket>` di chiunque.
 */
export async function postClientMessage(
  cfg: ConfigNamespace,
  client: ClientIdentity,
  ticketId: number,
  input: { message: string; files?: AttachInput[]; ip: string },
): Promise<PostMessageResult | { error: "access" } | ReadOnlyResult> {
  return runWrite({ actor: clientActor(cfg, client, input.ip) }, async (ctx) => {
    if (!(await clientCanAccess(client, ticketId, ctx.tx))) return { error: "access" as const };
    const res = await postMessage(ctx, {
      ticketId,
      userId: client.id,
      poster: clientDisplayName(client, cfg),
      message: input.message,
      files: input.files,
      origin: "Web",
    });
    if ("entryId" in res) await deleteDraftsForNamespace(ctx.tx, `ticket.client.${ticketId}`);
    return res;
  });
}

/** tickets.php POST a=edit (solo proprietario): campi del ticket modificabili dai clienti */
export async function editClientTicket(
  cfg: ConfigNamespace,
  client: ClientIdentity,
  ticketId: number,
  vars: Record<string, unknown>,
  ip: string,
): Promise<ClientEditResult | ReadOnlyResult> {
  const actor = clientActor(cfg, client, ip);
  return runWrite({ actor }, (ctx) => editTicketAsClient(ctx, client, ticketId, vars));
}
