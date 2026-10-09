import "server-only";

import { connect as netConnect, type Socket } from "node:net";
import { hostname } from "node:os";
import { connect as tlsConnect } from "node:tls";

import nodemailer from "nodemailer";

/**
 * Prove di connessione degli account email, come osTicket\Mail\AccountSetting + Smtp/Imap/Pop3
 * (include/class.mail.php, Laminas Mail): servono solo a validare host, porta e credenziali
 * prima di salvare (MailBoxAccount::setInfo, SmtpAccount::setInfo, updateBasicAuthCredentials).
 * Il recupero delle email resta al cron PHP.
 */
export { connectionOf, type Connection } from "../../mail/connection";
import type { Connection } from "../../mail/connection";

/** AccountSetting::isValid: host, porta e protocollo obbligatori ("HOST Required", …). */
export function connectionErrors(c: Connection): string[] {
  const out: string[] = [];
  if (!c.host) out.push("HOST Required");
  if (!c.port) out.push("PORT Required");
  if (!c.protocol) out.push("PROTOCOL Required");
  return out;
}

export interface Credentials {
  type: "basic" | "none";
  username: string;
  password?: string;
}

const TIMEOUT = 15_000;

/** Smtp::connect (Laminas): EHLO, STARTTLS solo con tls, AUTH LOGIN con credenziali basic. */
export async function probeSmtp(c: Connection, cred: Credentials): Promise<void> {
  const transport = nodemailer.createTransport({
    host: c.host,
    port: c.port,
    secure: c.ssl === "ssl",
    requireTLS: c.ssl === "tls",
    ignoreTLS: c.ssl === null,
    name: hostname(),
    auth: cred.type === "basic" ? { user: cred.username, pass: cred.password ?? "" } : undefined,
    tls: { rejectUnauthorized: false },
    connectionTimeout: TIMEOUT,
    greetingTimeout: TIMEOUT,
  });
  try {
    await transport.verify();
  } finally {
    transport.close();
  }
}

/** Sessione testuale minima (IMAP/POP3) su socket, con STARTTLS opzionale. */
class LineSession {
  private buf = "";
  private waiters: (() => void)[] = [];
  private closed = false;
  constructor(private socket: Socket) {
    this.attach();
  }

  private attach() {
    this.socket.setEncoding("utf8");
    this.socket.on("data", (d: string) => {
      this.buf += d;
      this.waiters.splice(0).forEach((w) => w());
    });
    this.socket.on("close", () => {
      this.closed = true;
      this.waiters.splice(0).forEach((w) => w());
    });
    this.socket.on("error", () => undefined);
  }

  static open(c: Connection): Promise<LineSession> {
    return new Promise((resolve, reject) => {
      const onError = (e: Error) => reject(new Error(`cannot connect to host ${c.host}:${c.port}; ${e.message}`));
      const s =
        c.ssl === "ssl"
          ? tlsConnect({ host: c.host, port: c.port, rejectUnauthorized: false, timeout: TIMEOUT }, () => resolve(new LineSession(s)))
          : netConnect({ host: c.host, port: c.port, timeout: TIMEOUT }, () => resolve(new LineSession(s)));
      s.once("error", onError);
      s.once("timeout", () => {
        s.destroy();
        reject(new Error(`cannot connect to host ${c.host}:${c.port}; timeout`));
      });
    });
  }

  async line(): Promise<string> {
    const deadline = Date.now() + TIMEOUT;
    for (;;) {
      const i = this.buf.indexOf("\n");
      if (i >= 0) {
        const l = this.buf.slice(0, i).replace(/\r$/, "");
        this.buf = this.buf.slice(i + 1);
        return l;
      }
      if (this.closed || Date.now() > deadline) throw new Error("connection closed by server");
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, 1000);
      });
    }
  }

  send(s: string) {
    this.socket.write(`${s}\r\n`);
  }

  startTls(host: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const secured = tlsConnect({ socket: this.socket, servername: host, rejectUnauthorized: false }, () => {
        this.socket = secured;
        this.buf = "";
        this.attach();
        resolve();
      });
      secured.once("error", reject);
    });
  }

  close() {
    this.socket.destroy();
  }
}

const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Risposta taggata IMAP: righe non taggate raccolte, esito OK/NO/BAD. */
async function imapCmd(s: LineSession, tag: string, cmd: string): Promise<{ ok: boolean; lines: string[]; status: string }> {
  s.send(`${tag} ${cmd}`);
  const lines: string[] = [];
  for (;;) {
    const l = await s.line();
    if (l.startsWith(`${tag} `)) return { ok: /^\S+ OK/i.test(l), lines, status: l.slice(tag.length + 1) };
    lines.push(l);
  }
}

export interface MailboxProbe {
  /** cartelle esistenti richieste (hasFolder) */
  folders?: string[];
  /** cartella d'archivio da creare se manca (solo IMAP) */
  create?: string | null;
}

/**
 * Imap/Pop3 di osTicket (Laminas Storage): connessione, login e, per IMAP, verifica delle cartelle.
 * Restituisce le cartelle mancanti e quelle che non è stato possibile creare.
 */
export async function probeMailbox(c: Connection, cred: Credentials, opts: MailboxProbe = {}): Promise<{ missing: string[]; notCreated: string[] }> {
  if (!["IMAP", "POP", "POP3"].includes(c.protocol)) throw new Error(`Unknown Mail protocol: ${c.protocol}`);
  const s = await LineSession.open(c);
  try {
    const greeting = await s.line();
    if (c.protocol === "IMAP") {
      if (!/^\* (OK|PREAUTH)/i.test(greeting)) throw new Error("cannot read - connection closed?");
      if (c.ssl === "tls") {
        const r = await imapCmd(s, "TAG1", "STARTTLS");
        if (!r.ok) throw new Error("cannot enable TLS");
        await s.startTls(c.host);
      }
      const login = await imapCmd(s, "TAG2", `LOGIN ${quote(cred.username)} ${quote(cred.password ?? "")}`);
      if (!login.ok) throw new Error("cannot login, user or password wrong");
      const missing: string[] = [];
      const notCreated: string[] = [];
      let n = 3;
      const has = async (f: string) => (await imapCmd(s, `TAG${n++}`, `LIST "" ${quote(f)}`)).lines.some((l) => /^\* LIST/i.test(l));
      for (const f of opts.folders ?? []) if (!(await has(f))) missing.push(f);
      if (opts.create && !(await has(opts.create)) && !(await imapCmd(s, `TAG${n++}`, `CREATE ${quote(opts.create)}`)).ok) notCreated.push(opts.create);
      await imapCmd(s, `TAG${n++}`, "LOGOUT").catch(() => undefined);
      return { missing, notCreated };
    }
    if (!/^\+OK/i.test(greeting)) throw new Error("last request failed");
    if (c.ssl === "tls") {
      s.send("STLS");
      if (!/^\+OK/i.test(await s.line())) throw new Error("cannot enable TLS");
      await s.startTls(c.host);
    }
    s.send(`USER ${cred.username}`);
    if (!/^\+OK/i.test(await s.line())) throw new Error("last request failed");
    s.send(`PASS ${cred.password ?? ""}`);
    if (!/^\+OK/i.test(await s.line())) throw new Error("last request failed");
    s.send("QUIT");
    return { missing: [], notCreated: [] };
  } finally {
    s.close();
  }
}
