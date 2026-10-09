import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

/**
 * Port di Crypto (include/class.crypto.php) per i segreti salvati dal PHP (password degli account email,
 * token OAuth2): formato `$<lib>$base64('$<cipher>$' + iv + ciphertext)` con AES-128-CBC e chiave
 * HMAC-SHA512(master . md5(subkey), iv)[0..16]. Librerie: 2 = OpenSSL, 3 = phpseclib (stesso schema).
 */
function keyHash(master: string, sub: string, iv: Buffer, len: number): Buffer {
  const data = master + createHash("md5").update(sub, "utf8").digest("hex");
  return createHmac("sha512", iv).update(data, "utf8").digest().subarray(0, len);
}

export function decrypt(ciphertext: string | null | undefined, master: string, sub = "encryption"): string | false {
  if (!master || !ciphertext || ciphertext[0] !== "$") return false;
  const m = /^\$(\d+)\$(.*)$/s.exec(ciphertext);
  if (!m || !["2", "3"].includes(m[1]) || !m[2]) return false;
  const b64 = m[2];
  const raw = Buffer.from(b64, "base64");
  // '$<cid>$' + iv(16) + ciphertext
  if (raw[0] !== 0x24) return false;
  const second = raw.indexOf(0x24, 1);
  if (second < 0) return false;
  const cid = raw.subarray(1, second).toString("latin1");
  if (cid !== "1") return false;
  const body = raw.subarray(second + 1);
  const iv = body.subarray(0, 16);
  const data = body.subarray(16);
  if (!data.length) return false;
  try {
    const d = createDecipheriv("aes-128-cbc", keyHash(master, sub, iv, 16), iv);
    return Buffer.concat([d.update(data), d.final()]).toString("utf8");
  } catch {
    return false;
  }
}

export function encrypt(input: string, master: string, sub = "encryption"): string | false {
  if (!input || !master) return false;
  const iv = randomBytes(16);
  const c = createCipheriv("aes-128-cbc", keyHash(master, sub, iv, 16), iv);
  const ct = Buffer.concat([c.update(input, "utf8"), c.final()]);
  return `$2$${Buffer.concat([Buffer.from("$1$", "latin1"), iv, ct]).toString("base64")}`;
}
