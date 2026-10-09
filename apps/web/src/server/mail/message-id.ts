import { createHash, createHmac, randomInt } from "node:crypto";

/**
 * Message-ID firmati come osTicket\Mail\Mailer::getMessageId / decodeMessageId (include/class.mailer.php):
 * il fetcher email del PHP riconosce le risposte ai messaggi inviati da Next e le riaggancia al thread.
 */
export type RecipientClass = "S" | "U" | "C" | "M" | "?";

const RAND_CHARS = "abcdefghiklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_=";

/** Mailer::getSystemMessageIdCode */
function systemMessageIdCode(secretSalt: string): string {
  const md5 = createHash("md5").update(`mail${secretSalt}`, "utf8").digest("base64");
  return md5.replace(/\+/g, "=").slice(0, 6);
}

export function randCode(len: number, chars = RAND_CHARS): string {
  let out = "";
  for (let i = 0; i < len; i++) out += chars[randomInt(chars.length)];
  return out;
}

export function buildMessageId(opts: {
  secretSalt: string;
  /** indirizzo dell'email di sistema mittente (firma del Message-ID) */
  fromAddress: string | null;
  recipientUserId: number;
  entryId: number;
  threadId: number;
  utype: RecipientClass;
  rand?: string;
}): string {
  const rand = opts.rand ?? randCode(5);
  const sysid = systemMessageIdCode(opts.secretSalt);
  const sig = opts.fromAddress ?? "@osTicketMailer";
  const head = Buffer.alloc(13);
  head.writeUInt32LE(opts.recipientUserId >>> 0, 0);
  head.writeUInt32LE(opts.entryId >>> 0, 4);
  head.writeUInt32LE(opts.threadId >>> 0, 8);
  head.write(opts.utype || "?", 12, "latin1");
  const hmac = createHmac("sha1", opts.secretSalt)
    .update(Buffer.concat([head, Buffer.from(rand + sysid, "latin1")]))
    .digest();
  const tag = Buffer.concat([head, hmac.subarray(hmac.length - 5)]).toString("base64").replace(/=/g, "");
  return `B${sysid}-${rand}-${tag}-${sig}`;
}

interface DecodedMessageId {
  loopback: boolean;
  version: string | false;
  code?: string;
  id?: string;
  userId?: number;
  entryId?: number;
  threadId?: number;
  userClass?: string;
}

/** Mailer::decodeMessageId (versione B). */
export function decodeMessageId(mid: string, secretSalt: string): DecodedMessageId {
  const clean = mid.replace(/^<|>$/g, "").trim();
  const m = /^B(.{6})-(.{5})-([^-]+)-/.exec(clean);
  if (!m) return { loopback: false, version: false };
  const [, sysid, rand, tagB64] = m;
  const raw = Buffer.from(tagB64, "base64");
  if (raw.length < 18) return { loopback: false, version: "B" };
  const head = raw.subarray(0, 13);
  const sig = raw.subarray(13, 18);
  const hmac = createHmac("sha1", secretSalt)
    .update(Buffer.concat([head, Buffer.from(rand + sysid, "latin1")]))
    .digest();
  const ok = hmac.subarray(hmac.length - 5).equals(sig) && sysid === systemMessageIdCode(secretSalt);
  return {
    loopback: ok,
    version: "B",
    code: sysid,
    id: rand,
    userId: head.readUInt32LE(0),
    entryId: head.readUInt32LE(4),
    threadId: head.readUInt32LE(8),
    userClass: head.subarray(12, 13).toString("latin1"),
  };
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz012345";

/** Base32::encode di osTicket (alfabeto minuscolo a-z0-5, senza padding). */
function base32Encode(buf: Buffer): string {
  let bits = "";
  for (const b of buf) bits += b.toString(2).padStart(8, "0");
  const rem = bits.length % 5;
  if (rem) bits += "0".repeat(5 - rem);
  let out = "";
  for (let i = 0; i < bits.length; i += 5) out += BASE32[Number.parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

export function base32Decode(str: string): Buffer {
  let bits = "";
  for (const ch of str.toLowerCase()) {
    const i = BASE32.indexOf(ch);
    if (i < 0) continue;
    bits += i.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/**
 * Ticket::getAuthToken($user, $algo=1): token del link di accesso senza login per proprietario ('o')
 * o collaboratore ('c'). `createDate` è ticket.created così com'è nel DB.
 */
export function ticketAuthToken(opts: {
  isOwner: boolean;
  /** user_id per il proprietario, id del collaboratore per i collaboratori */
  contactId: number;
  ticketId: number;
  createDate: string;
  secretSalt: string;
  algo?: number;
}): string {
  const packed = Buffer.alloc(8);
  packed.writeUInt32LE(opts.contactId >>> 0, 0);
  packed.writeUInt32LE(opts.ticketId >>> 0, 4);
  const md5 = createHash("md5")
    .update(`${opts.contactId}${opts.createDate}${opts.ticketId}${opts.secretSalt}`, "utf8")
    .digest("base64");
  return `${opts.isOwner ? "o" : "c"}${opts.algo ?? 1}x${base32Encode(packed)}${md5.slice(8)}`;
}
