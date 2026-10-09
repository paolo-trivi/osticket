import { installConfig } from "@/server/env";
import { decodeMessageId } from "@/server/mail/message-id";

import { maskAlertTime } from "./alert-time";

/**
 * Accesso a Mailpit (SMTP finto dell'ambiente di sviluppo) per confrontare le email inviate da PHP e TS.
 */
const API = process.env.MAILPIT_API ?? `http://127.0.0.1:${process.env.MAILPIT_HTTP_PORT ?? "8025"}/api/v1`;

export interface CapturedMail {
  headers: Record<string, string[]>;
  subject: string;
  from: string;
  to: string[];
  cc: string[];
  html: string;
  text: string;
  messageId: string;
}

export async function clearMailpit(): Promise<void> {
  await fetch(`${API}/messages`, { method: "DELETE" });
}

interface MailpitAddress {
  Name: string;
  Address: string;
}

const fmt = (a: MailpitAddress) => `${a.Name} <${a.Address}>`;

/** Messaggi catturati (dal più vecchio), attendendo fino a `expected` messaggi. */
export async function fetchMails(expected = 0, timeoutMs = 5000): Promise<CapturedMail[]> {
  const until = Date.now() + timeoutMs;
  let list: { ID: string }[] = [];
  for (;;) {
    const res = (await (await fetch(`${API}/messages?limit=50`)).json()) as { messages: { ID: string }[] };
    list = res.messages ?? [];
    if (list.length >= expected || Date.now() > until) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const out: CapturedMail[] = [];
  for (const m of list.reverse()) {
    const msg = (await (await fetch(`${API}/message/${m.ID}`)).json()) as {
      Subject: string;
      From: MailpitAddress;
      To: MailpitAddress[];
      Cc: MailpitAddress[] | null;
      HTML: string;
      Text: string;
      MessageID: string;
    };
    const headers = (await (await fetch(`${API}/message/${m.ID}/headers`)).json()) as Record<string, string[]>;
    out.push({
      headers,
      subject: msg.Subject,
      from: fmt(msg.From),
      to: (msg.To ?? []).map(fmt),
      cc: (msg.Cc ?? []).map(fmt),
      html: maskAlertTime(msg.HTML),
      text: maskAlertTime(msg.Text),
      messageId: msg.MessageID,
    });
  }
  return out;
}

/** Email normalizzata: Message-ID ridotto ai campi firmati, testo alternativo escluso (impaginazione diversa). */
export function normalizeMail(m: CapturedMail) {
  const { secretSalt } = installConfig();
  const mid = m.messageId.replace(/^<|>$/g, "");
  const d = decodeMessageId(mid, secretSalt);
  // header confrontati dopo la decodifica RFC 2047 (=?UTF-8?Q?...?=)
  const decodeWords = (v: string) =>
    v.replace(/=\?UTF-8\?([QB])\?([^?]*)\?=/gi, (_m, enc: string, txt: string) =>
      enc.toUpperCase() === "B"
        ? Buffer.from(txt, "base64").toString("utf8")
        : Buffer.from(txt.replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, (_x, h: string) => String.fromCharCode(parseInt(h, 16))), "latin1").toString("utf8"),
    );
  const pick = (k: string) => (m.headers[k] ?? []).map((v) => decodeWords(v).replaceAll(mid, "<MID>"));
  return {
    mid: { loopback: d.loopback, userId: d.userId, entryId: d.entryId, threadId: d.threadId, userClass: d.userClass, sig: mid.split("-").slice(3).join("-") },
    subject: m.subject,
    from: m.from,
    to: m.to,
    cc: m.cc,
    returnPath: pick("Return-Path"),
    xMailer: pick("X-Mailer"),
    inReplyTo: pick("In-Reply-To"),
    references: pick("References"),
    autoSubmitted: pick("Auto-Submitted"),
    suppress: pick("X-Auto-Response-Suppress"),
    html: m.html.replaceAll(mid, "<MID>").replace(/\r\n/g, "\n").trim(),
    textRefMid: m.text.includes(`Ref-Mid: ${mid}`),
  };
}


/** Esegue `run` e restituisce le email catturate, normalizzate (attende almeno `expected` messaggi). */
export async function mailsOf(run: () => Promise<unknown>, expected: number) {
  await clearMailpit();
  await run();
  return (await fetchMails(expected)).map(normalizeMail);
}
