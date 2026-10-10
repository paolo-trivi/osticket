/**
 * fgetcsv($stream, $length, ",", "\"", "") di PHP 8 applicato a un testo intero: le righe che
 * restituirebbero le chiamate successive fino a EOF (port di php_fgetcsv, ext/standard/file.c, con
 * carattere di escape disattivato). Codice puro, testato in test/unit/php-csv.test.ts.
 *
 * Semantica replicata:
 * - un record termina al "\n" (un "\r" isolato non chiude la riga); dalla riga si toglie una sola
 *   terminazione finale ("\r\n", "\n" o "\r");
 * - riga vuota → [null];
 * - gli spazi iniziali di un campo si saltano solo se seguiti dalle virgolette;
 * - campo tra virgolette: "" vale ", può proseguire sulle righe successive (terminazioni incluse),
 *   il testo dopo la virgoletta di chiusura fino al delimitatore si accoda; senza chiusura il campo
 *   prende tutto fino alla fine del testo;
 * - campo senza virgolette: le virgolette interne sono letterali e si toglie una terminazione finale.
 * Non replicato: lo spezzamento delle righe più lunghe di $length (1000/4096 caratteri nel PHP).
 */

const DELIMITER = ",";
const ENCLOSURE = '"';
const isSpace = (c: string | undefined) => c === " " || c === "\t" || c === "\n" || c === "\v" || c === "\f" || c === "\r";

/** php_fgetcsv_lookup_trailing_spaces: lunghezza senza l'ultima terminazione ("\r\n", "\n" o "\r"). */
function trimLineEnd(s: string): string {
  if (s.endsWith("\r\n")) return s.slice(0, -2);
  if (s.endsWith("\n") || s.endsWith("\r")) return s.slice(0, -1);
  return s;
}

/** Tutte le righe di un testo CSV, come chiamate ripetute di fgetcsv fino a false. */
export function parseCsv(text: string): (string | null)[][] {
  const rows: (string | null)[][] = [];
  let pos = 0;
  /** php_stream_get_line: fino al "\n" incluso, null a fine testo */
  const nextLine = (): string | null => {
    if (pos >= text.length) return null;
    const nl = text.indexOf("\n", pos);
    const end = nl < 0 ? text.length : nl + 1;
    const line = text.slice(pos, end);
    pos = end;
    return line;
  };

  for (let buf = nextLine(); buf !== null; buf = nextLine()) {
    let limit = trimLineEnd(buf).length;
    let lineEnd = buf.slice(limit);
    const row: (string | null)[] = [];
    let b = 0;
    let first = true;
    let more = true;
    while (more) {
      if (b < limit) {
        // spazi iniziali saltati solo se seguiti dalle virgolette
        let t = b;
        while (t < buf.length && buf[t] !== DELIMITER && isSpace(buf[t])) t++;
        if (buf[t] === ENCLOSURE && t < limit) b = t;
      }
      if (first && b === limit) {
        row.push(null);
        break;
      }
      first = false;
      let field = "";
      if (b < limit && buf[b] === ENCLOSURE) {
        b++;
        let hunk = b;
        let afterQuote = false;
        for (;;) {
          if (b >= limit) {
            if (afterQuote) {
              // virgoletta di chiusura subito prima della fine riga
              field += buf.slice(hunk, b - 1);
              hunk = b;
              break;
            }
            field += buf.slice(hunk, b) + lineEnd;
            const next = nextLine();
            if (next === null) {
              // virgolette non chiuse: il campo prende tutto fino alla fine
              hunk = b;
              break;
            }
            buf = next;
            limit = trimLineEnd(buf).length;
            lineEnd = buf.slice(limit);
            b = 0;
            hunk = 0;
            continue;
          }
          if (afterQuote) {
            if (buf[b] !== ENCLOSURE) {
              // vera chiusura
              field += buf.slice(hunk, b - 1);
              hunk = b;
              break;
            }
            // "" → "
            field += buf.slice(hunk, b);
            b++;
            hunk = b;
            afterQuote = false;
            continue;
          }
          if (buf[b] === ENCLOSURE) afterQuote = true;
          b++;
        }
        // testo dopo la chiusura fino al delimitatore
        while (b < limit && buf[b] !== DELIMITER) b++;
        field += buf.slice(hunk, b);
        more = b < limit;
        if (more) b++;
      } else {
        const start = b;
        while (b < limit && buf[b] !== DELIMITER) b++;
        field = trimLineEnd(buf.slice(start, b));
        more = b < limit;
        if (more) b++;
      }
      row.push(field);
    }
    rows.push(row);
  }
  return rows;
}
