import "server-only";

import { promises as dns } from "node:dns";
import { isIP } from "node:net";

import { phpTrim } from "../../format/text";

/**
 * Equivalenti di include/class.validator.php usati dai form dinamici e dalle altre aree
 * (email, telefono, IP, numeri, formule). Unica fonte: non duplicare queste funzioni altrove.
 */

/** is_numeric() di PHP 8: spazi (solo " \t\n\r\v\f") ammessi prima e dopo il numero. */
export function phpIsNumeric(v: string): boolean {
  return /^[ \t\n\r\v\f]*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?[ \t\n\r\v\f]*$/.test(v);
}

/** Validator::is_formula */
export function isFormula(text: string): boolean {
  return /(^[^=+@-][\s\S]*$)|(^\+\d+$)/.test(text);
}

/** Validator::is_phone: tolti ( ) - . + e spazi, numerico di 7–16 caratteri. */
export function isPhone(phone: string): boolean {
  const stripped = phone.replace(/\(|\)|-|\.|\+|[  ]+/g, "");
  return phpIsNumeric(stripped) && stripped.length >= 7 && stripped.length <= 16;
}

/** Validator::is_ip: filter_var(trim($ip), FILTER_VALIDATE_IP) (IPv4 o IPv6, senza zona "%…"). */
export function isIp(ip: string): boolean {
  const v = phpTrim(ip);
  return !v.includes("%") && isIP(v) !== 0;
}

/* ---------------------------------------------------------------------------------------------
 * Mail_RFC822::parseAddressList (include/pear/Mail/RFC822.php) con i parametri di
 * Validator::is_email: dominio predefinito "localhost", gruppi annidati, validazione attiva.
 * Ogni condizione che nel PHP imposta $this->error rende la lista non valida: qui diventa
 * un'eccezione che interrompe l'analisi.
 * ------------------------------------------------------------------------------------------- */

class Rfc822Error extends Error {}

const DEFAULT_DOMAIN = "localhost";

/** str_replace($search, '', $subject) */
function strRemove(subject: string, search: string): string {
  return search === "" ? subject : subject.split(search).join("");
}

function hasUnclosedQuotes(value: string): boolean {
  const s = phpTrim(value);
  let inQuote = false;
  let slashes = 0;
  for (const ch of s) {
    if (ch === "\\") {
      slashes++;
      continue;
    }
    if (ch === '"' && slashes % 2 === 0) inQuote = !inQuote;
    slashes = 0;
  }
  return inQuote;
}

function hasUnclosedBracketsSub(value: string, num: number, char: string): number {
  const parts = value.split(char);
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].endsWith("\\") || hasUnclosedQuotes(parts[i])) num--;
    if (i + 1 < parts.length) parts[i + 1] = parts[i] + char + parts[i + 1];
  }
  return num;
}

function hasUnclosedBrackets(value: string, chars: string): boolean {
  const start = hasUnclosedBracketsSub(value, value.split(chars[0]).length - 1, chars[0]);
  const end = hasUnclosedBracketsSub(value, value.split(chars[1]).length - 1, chars[1]);
  // "Invalid address spec. Unmatched quote or bracket"
  if (start < end) throw new Rfc822Error();
  return start > end;
}

function validateAtom(atom: string): boolean {
  if (!/^[\x00-\x7E]+$/.test(atom)) return false;
  if (/[\][()<>@,;:". ]/.test(atom)) return false;
  return !/[\x00-\x1F]/.test(atom);
}

function validateQuotedString(qstring: string): boolean {
  return !/[\r\\"]/.test(qstring.slice(1, -1).replace(/\\./g, ""));
}

function validateDliteral(dliteral: string): boolean {
  return !/(.)[\][\r\\]/.test(dliteral);
}

function validateSubdomain(subdomain: string): boolean {
  const m = /^\[(.*)\]$/.exec(subdomain);
  return m ? validateDliteral(m[1]) : validateAtom(subdomain);
}

class Rfc822Parser {
  /** $this->index: ultima parte consumata da _splitCheck */
  private index = 0;

  /** _splitCheck: riunisce le parti finché virgolette e parentesi non sono chiuse. */
  private splitCheck(parts: string[], char: string): string {
    let s = parts[0];
    for (let i = 0; i < parts.length; i++) {
      if (hasUnclosedQuotes(s) || hasUnclosedBrackets(s, "<>") || hasUnclosedBrackets(s, "[]") || hasUnclosedBrackets(s, "()") || s.endsWith("\\")) {
        // "Invalid address spec. Unclosed bracket or quotes"
        if (i + 1 >= parts.length) throw new Rfc822Error();
        s = s + char + parts[i + 1];
      } else {
        this.index = i;
        break;
      }
    }
    return s;
  }

  /** Suddivisione ripetuta di `value` con _splitCheck (parole, sottodomini, frasi). */
  private splitAll(parts: string[], char: string): string[] {
    const out: string[] = [];
    let rest = parts;
    while (rest.length > 0) {
      out.push(this.splitCheck(rest, char));
      rest = rest.slice(this.index + 1);
    }
    return out;
  }

  private isGroup(address: string): boolean {
    const s = this.splitCheck(address.split(","), ",");
    const parts = s.split(":");
    return parts.length > 1 && this.splitCheck(parts, ":") !== s;
  }

  /** parseAddressList: ciclo di _splitAddresses (continua finché il resto è "vero" per PHP). */
  splitAddresses(input: string): { address: string; group: boolean }[] {
    const out: { address: string; group: boolean }[] = [];
    let address = input;
    do {
      const group = this.isGroup(address);
      const splitChar = group ? ";" : ",";
      const s = this.splitCheck(address.split(splitChar), splitChar);
      if (group) {
        if (!s.includes(":")) throw new Rfc822Error();
        const g = this.splitCheck(s.split(":"), ":");
        if (g === "" || g === "0") throw new Rfc822Error();
      }
      out.push({ address: phpTrim(s), group });
      address = phpTrim(address.slice(s.length + 1));
      if (group && address.startsWith(",")) address = phpTrim(address.slice(1));
    } while (address !== "" && address !== "0");
    return out;
  }

  private validatePhrase(phrase: string): boolean {
    const parts = phrase.split(/[ \t]+/).filter((p) => p !== "");
    for (const part of this.splitAll(parts, " ")) {
      if (part.startsWith('"')) {
        if (!validateQuotedString(part)) return false;
      } else if (!validateAtom(part)) return false;
    }
    return true;
  }

  private validateDomain(domain: string): boolean {
    for (const sub of this.splitAll(domain.split("."), ".")) if (!validateSubdomain(phpTrim(sub))) return false;
    return true;
  }

  private validateLocalPart(localPart: string): boolean {
    for (const word of this.splitAll(localPart.split("."), ".")) {
      if (word === "") return false;
      // strpos($word, ' ') "vero" solo se lo spazio non è il primo carattere
      if (word.indexOf(" ") > 0 && word[0] !== '"') return false;
      if (!this.validatePhrase(phpTrim(word))) return false;
    }
    return true;
  }

  private validateAddrSpec(spec: string): { mailbox: string; host: string } | null {
    const addrSpec = phpTrim(spec);
    let localPart: string;
    let domain: string;
    if (addrSpec.includes("@")) {
      localPart = this.splitCheck(addrSpec.split("@"), "@");
      domain = addrSpec.slice(localPart.length + 1);
    } else {
      localPart = addrSpec;
      domain = DEFAULT_DOMAIN;
    }
    if (!this.validateLocalPart(localPart) || !this.validateDomain(domain)) return null;
    return { mailbox: localPart, host: domain };
  }

  private validateRouteAddr(routeAddr: string): { mailbox: string; host: string } | null {
    const route = routeAddr.includes(":") ? this.splitCheck(routeAddr.split(":"), ":") : routeAddr;
    if (route === routeAddr) return this.validateAddrSpec(routeAddr);
    for (const d of phpTrim(route).split(",")) if (!this.validateDomain(strRemove(phpTrim(d), "@"))) return null;
    return this.validateAddrSpec(routeAddr.slice(route.length + 1));
  }

  /** validateMailbox: commenti tolti, poi "frase <route-addr>" oppure addr-spec. */
  validateMailbox(input: string): { mailbox: string; host: string } | null {
    let mailbox = input;
    const comments: string[] = [];
    let rest = mailbox;
    while (phpTrim(rest).length > 0) {
      const before = this.splitCheck(rest.split("("), "(");
      if (before === rest) break;
      const comment = this.splitCheck(strRemove(rest, before).slice(1).split(")"), ")");
      comments.push(comment);
      const pos = Math.max(rest.indexOf(`(${comment}`), 0);
      rest = rest.slice(pos + comment.length + 2);
    }
    for (const c of comments) mailbox = strRemove(mailbox, `(${c})`);
    mailbox = phpTrim(mailbox);

    if (mailbox.endsWith(">") && !mailbox.startsWith("<")) {
      const name = this.splitCheck(mailbox.split("<"), "<");
      const routeAddr = phpTrim(mailbox.slice(name.length + 1, -1));
      if (!this.validatePhrase(phpTrim(name))) return null;
      return this.validateRouteAddr(routeAddr);
    }
    const addrSpec = mailbox.startsWith("<") && mailbox.endsWith(">") ? mailbox.slice(1, -1) : mailbox;
    return this.validateAddrSpec(addrSpec);
  }
}

/**
 * Indirizzo singolo come lo accetta Validator::is_email($email, $list=false): un solo elemento,
 * non un gruppo, mailbox "vera" per PHP (non "" né "0") e host diverso da "localhost"
 * (confronto esatto, come il PHP). Restituisce mailbox e host oppure null.
 */
function parseSingleAddress(email: string): { mailbox: string; host: string } | null {
  const unfolded = String(email ?? "")
    .replace(/\r?\n/g, "\r\n")
    .replace(/\r\n(\t| )+/g, " ");
  try {
    const parser = new Rfc822Parser();
    const list = parser.splitAddresses(unfolded);
    if (list.length !== 1 || list[0].group) return null;
    const m = parser.validateMailbox(list[0].address);
    if (!m || m.mailbox === "" || m.mailbox === "0" || m.host === DEFAULT_DOMAIN) return null;
    return m;
  } catch (e) {
    if (e instanceof Rfc822Error) return null;
    throw e;
  }
}

/** Validator::is_email($email) senza verifica DNS. */
export function isEmail(email: string): boolean {
  return parseSingleAddress(email) !== null;
}

/**
 * Validator::is_email($email, false, $verify) / is_valid_email (con config verify_email_addrs):
 * l'host deve avere un record MX o, in mancanza, almeno un record A/AAAA (dns_get_record).
 */
export async function isValidEmail(email: string, verify: boolean): Promise<boolean> {
  const m = parseSingleAddress(email);
  if (!m) return false;
  if (!verify) return true;
  try {
    if ((await dns.resolveMx(`${m.host}.`)).length) return true;
  } catch {
    /* nessun MX: si prova A/AAAA */
  }
  let n = 0;
  for (const fn of [dns.resolve4, dns.resolve6]) {
    try {
      n += (await fn(`${m.host}.`)).length;
    } catch {
      /* nessun record */
    }
  }
  return n > 0;
}
