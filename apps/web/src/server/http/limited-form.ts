import "server-only";

/**
 * Lettura di un corpo multipart con limite di dimensione, PRIMA di caricarlo tutto in memoria
 * (request.formData() legge l'intero corpo): Content-Length dichiarato oltre il limite → rifiuto
 * immediato; senza Content-Length (chunked) il corpo si legge a pezzi e la lettura si interrompe appena
 * supera il limite. Il limite è la dimensione massima del file (max_file_size di osTicket) più un
 * margine per l'imbustamento multipart.
 */
const MULTIPART_OVERHEAD = 64 * 1024;

type LimitedForm = { ok: true; form: FormData } | { ok: false; error: "size" | "invalid" };

export async function readLimitedFormData(request: Request, maxFileSize: number): Promise<LimitedForm> {
  const limit = maxFileSize + MULTIPART_OVERHEAD;
  const declared = Number(request.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > limit) return { ok: false, error: "size" };
  if (!request.body) return { ok: false, error: "invalid" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, error: "size" };
    }
    chunks.push(value);
  }
  try {
    const body = Buffer.concat(chunks);
    const form = await new Response(body, { headers: { "content-type": request.headers.get("content-type") ?? "" } }).formData();
    return { ok: true, form };
  } catch {
    return { ok: false, error: "invalid" };
  }
}
