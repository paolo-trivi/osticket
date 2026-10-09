import { createHash, timingSafeEqual } from "node:crypto";

import bcrypt from "bcryptjs";

/**
 * Hash password compatibili con osTicket (include/class.passwd.php → phpass PasswordHash(8, FALSE)):
 * - nuovi hash: bcrypt "$2a$08$..." (phpass genera il prefisso $2a$);
 * - verifica: bcrypt ($2a$/$2y$/$2b$), hash "portabili" phpass ($P$/$H$), e il fallback MD5
 *   di Staff/User::check_passwd (le installazioni molto vecchie avevano md5(password)).
 */
const WORK_FACTOR = 8;
const ITOA64 = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function hashPassword(password: string): string {
  const hash = bcrypt.hashSync(password, bcrypt.genSaltSync(WORK_FACTOR));
  // Stesso algoritmo: si usa il prefisso storico di phpass per avere hash identici nel formato.
  return hash.replace(/^\$2[aby]\$/, "$2a$");
}

function encode64(input: Buffer, count: number): string {
  let output = "";
  let i = 0;
  do {
    let value = input[i++];
    output += ITOA64[value & 0x3f];
    if (i < count) value |= input[i] << 8;
    output += ITOA64[(value >> 6) & 0x3f];
    if (i++ >= count) break;
    if (i < count) value |= input[i] << 16;
    output += ITOA64[(value >> 12) & 0x3f];
    if (i++ >= count) break;
    output += ITOA64[(value >> 18) & 0x3f];
  } while (i < count);
  return output;
}

/** crypt_private di phpass per gli hash "portabili" $P$ / $H$. */
function phpassPortable(password: string, setting: string): string | null {
  const countLog2 = ITOA64.indexOf(setting[3]);
  if (countLog2 < 7 || countLog2 > 30) return null;
  const salt = setting.slice(4, 12);
  if (salt.length !== 8) return null;
  let count = 1 << countLog2;
  const pw = Buffer.from(password, "utf8");
  let hash = createHash("md5").update(Buffer.concat([Buffer.from(salt, "binary"), pw])).digest();
  do {
    hash = createHash("md5").update(Buffer.concat([hash, pw])).digest();
  } while (--count);
  return setting.slice(0, 12) + encode64(hash, 16);
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Equivalente di Passwd::cmp (solo hash phpass/bcrypt). */
export function comparePassword(password: string, hash: string | null | undefined): boolean {
  if (!password || !hash) return false;
  if (/^\$2[abxy]\$\d\d\$/.test(hash)) {
    return bcrypt.compareSync(password, hash.replace(/^\$2[xy]\$/, "$2a$"));
  }
  if (hash.startsWith("$P$") || hash.startsWith("$H$")) {
    const computed = phpassPortable(password, hash);
    return computed !== null && safeEqual(computed, hash);
  }
  return false;
}

type PasswordCheck =
  | { ok: false }
  /** `rehash` valorizzato: l'hash era MD5 legacy e va sostituito (come fa check_passwd). */
  | { ok: true; rehash?: string };

/** Equivalente di Staff::check_passwd / UserAccount::checkPassword. */
export function checkPassword(password: string, hash: string | null | undefined): PasswordCheck {
  if (comparePassword(password, hash)) return { ok: true };
  if (!password || !hash) return { ok: false };
  const md5 = createHash("md5").update(password, "utf8").digest("hex");
  if (!safeEqual(md5, hash)) return { ok: false };
  return { ok: true, rehash: hashPassword(password) };
}
