import "server-only";

import type { DbOrTx } from "../../db";
import { loadSystemEmail, sendMail } from "../../mail/mailer";
import type { SaveResult } from "../admin/common";
import { str, truthy, type PhpVars } from "../admin/php";
import type { Errors } from "../admin/validator";
import { isValidEmail } from "../forms/validator";
import { deleteDraftsForNamespace } from "../drafts";
import { sanitizeHtml } from "./sanitize";

/**
 * Diagnostica email: scp/emailtest.php → Email::send($to, $subj, Format::sanitize($body), null,
 * ['reply-tag' => false]) con l'email di sistema scelta, poi Draft::deleteForNamespace('email.diag').
 * Il destinatario è una stringa: Message-ID con classe "?" e nessun thread.
 */
export async function sendTestEmail(executor: DbOrTx, vars: PhpVars): Promise<SaveResult & { messageId?: string }> {
  const errors: Errors = {};
  const email = truthy(vars.email_id) ? await loadSystemEmail(Number(vars.email_id) || 0, executor) : null;
  if (!email) errors.email_id = "select_from";
  const verify = await executor.selectFrom("config").select("value").where("namespace", "=", "core").where("key", "=", "verify_email_addrs").executeTakeFirst();
  if (!truthy(vars.email) || !(await isValidEmail(str(vars.email), truthy(verify?.value ?? "")))) errors.email = "valid_recipient_required";
  if (!truthy(vars.subj)) errors.subj = "subject_required";
  if (!truthy(vars.body)) errors.body = "message_required";
  if (Object.keys(errors).length || !email) return { ok: false, errors };
  const id = await sendMail(
    {
      email,
      to: [{ name: "", address: str(vars.email) }],
      subject: str(vars.subj),
      body: sanitizeHtml(str(vars.body)),
      recipient: { userId: 0, utype: "?" },
    },
    executor,
  );
  if (!id) return { ok: false, errors: { err: "send_failed" } };
  await deleteDraftsForNamespace(executor, "email.diag");
  return { ok: true, errors: {}, messageId: id };
}
