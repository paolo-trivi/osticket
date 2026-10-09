import "server-only";

import type { ConfigNamespace } from "../../config/config";
import { NOW, type DbOrTx } from "../../db";
import { detectDbTimezone } from "../../db/time";
import { stripTags } from "../../format/html";
import { sendMail, type MailContact } from "../../mail/mailer";
import { randCode } from "../../mail/message-id";
import { buildTicketVars, companyVar, loadUserContact, ticketLink, userPersonsName } from "../../mail/objects";
import { VarBag, VariableReplacer } from "../../mail/variables";
import { MISC_RAND_CHARS } from "../directory/accounts";
import { baseUrl, defaultEmail, loadContentPage, sendContentMail, userTemplateVar } from "../directory/content-mail";

/**
 * Email del portale basate sulle pagine di contenuto (Page::lookupByType): link di accesso al ticket
 * (Ticket::sendAccessLink), conferma della registrazione e reset password (UserAccount::sendUnlockEmail).
 */

/**
 * Ticket::sendAccessLink($user): pagina "access-link" dall'email predefinita al proprietario o al
 * collaboratore (ClientSession). Il link contiene sempre il token (getTicketLink con authtoken).
 * Destinatario ClientSession: classe '?' e utente 0 nel Message-ID (non è un TicketOwner/EmailContact).
 */
export async function sendAccessLinkMail(executor: DbOrTx, cfg: ConfigNamespace, ticketId: number, userId: number, collabId: number): Promise<boolean> {
  const email = await defaultEmail(executor, cfg);
  const page = await loadContentPage(executor, "access-link" as Parameters<typeof loadContentPage>[1]);
  if (!email || !page) return false;
  const tv = await buildTicketVars(executor, ticketId, cfg, await detectDbTimezone(executor));
  const contact = await loadUserContact(executor, userId);
  if (!tv || !contact) return false;
  const name = userPersonsName(contact, cfg);
  // TicketOwner::getTicketLink() con token; un Collaborator non ha getTicketLink: si risolve con
  // Collaborator::getVar('ticket_link'), che usa il token solo se il ticket non ha collaboratori
  const link = collabId ? `${baseUrl(cfg)}/tickets.php?id=${ticketId}` : ticketLink(cfg, tv.info, { isOwner: true, id: userId }, true);
  const recipient = new VarBag({ name, email: contact.email, id: contact.id, ticket_link: link }, () => name.toString());
  const r = new VariableReplacer().assign({
    ticket: tv.ticket,
    user: recipient,
    recipient,
    "recipient.ticket_link": link,
    url: baseUrl(cfg),
    company: await companyVar(executor),
  });
  const subject = stripTags(r.replaceVars(page.name));
  const body = r.replaceVars(page.body);
  const to: MailContact = { name: name.toString(), address: contact.email };
  // Mailer::send: il proprietario va in To, un Collaborator in Cc
  await sendMail({ email, to: collabId ? [] : [to], cc: collabId ? [to] : [], subject, body, recipient: { userId: 0, utype: "?" } }, executor);
  return true;
}

/**
 * UserAccount::sendUnlockEmail($template): token casuale di 48 caratteri in config "pwreset"
 * (valore "c<user_id>") e pagina di contenuto inviata dall'email predefinita. L'invio è restituito
 * per eseguirlo dopo il commit.
 */
export async function prepareUnlockMail(
  executor: DbOrTx,
  cfg: ConfigNamespace,
  userId: number,
  template: "pwreset-client" | "registration-client",
): Promise<(() => Promise<void>) | null> {
  const token = randCode(48, MISC_RAND_CHARS);
  const email = await defaultEmail(executor, cfg);
  const page = await loadContentPage(executor, template);
  if (!email || !page) return null;
  const user = await userTemplateVar(executor, userId, cfg);
  if (!user) return null;
  const link = `${baseUrl(cfg)}/pwreset.php?token=${token}`;
  const vars = { token, user: user.v, recipient: user.v, link, reset_link: link };
  await executor.insertInto("config").values({ namespace: "pwreset", key: token, value: `c${userId}`, updated: NOW }).execute();
  return sendContentMail(executor, cfg, { email, page, vars, to: { name: user.name, address: user.email } });
}
