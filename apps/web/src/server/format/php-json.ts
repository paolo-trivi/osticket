/**
 * json_encode() di PHP con flag di default (usato da JsonDataEncoder::encode in osTicket):
 * - "/" diventa "\/";
 * - i caratteri non ASCII diventano sequenze \uXXXX (coppie surrogate per quelli fuori dal BMP).
 * Serve perché i JSON scritti dalla app siano identici byte per byte a quelli del PHP.
 */
export function phpJsonEncode(value: unknown): string {
  return JSON.stringify(value)
    .replace(/\//g, "\\/")
    .replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

/** JsonDataParser::decode: oggetto vuoto se il JSON non è valido. */
export function phpJsonDecode<T = Record<string, unknown>>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
