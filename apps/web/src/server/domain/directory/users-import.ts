import "server-only";

import { sql } from "kysely";

import { str, truthy } from "../../php/values";
import { parseCsv } from "../../php/csv";
import { GlobalPerm } from "../staff/staff";
import { lookupUserByEmail, userFromVars } from "../ticket/create-user";
import type { WriteContext } from "../ticket/context";
import { defaultFormOf, toDatabase } from "../forms/answers";
import { currentDates } from "../forms/entry";
import { parseFieldValue, type FieldDef } from "../forms/fields";
import { isEmail } from "../forms/validator";
import { updateUserInfo, type DirError } from "./users";

/**
 * Importazione CSV degli utenti (User::importFromPost / importCsv, include/class.import.php
 * CsvImporter e CsvImportIterator) con le stesse righe del PHP; il testo è letto come fgetcsv
 * (src/server/php/csv.ts).
 */

class ImportFailure extends Error {}

/**
 * User::importFromPost / importCsv (scp/users.php do=import-users, ajax.*:importUsers, scp/orgs.php):
 * intestazione "name, email" aggiunta al testo incollato, mappatura dei campi per nome o etichetta,
 * User::fromVars($data, true, true) per riga (utenti esistenti aggiornati con updateInfo). Tutto o niente.
 * Restituisce il numero di utenti importati o il messaggio d'errore (come il PHP).
 */
export async function importUsers(
  ctx: WriteContext,
  pasted: string,
  extra: { orgId?: number } = {},
  opts: { checkPerm?: boolean; file?: boolean } = {},
): Promise<{ ok: true; count: number } | { ok: false; error: DirError; detail?: string }> {
  const { agent } = ctx;
  if (opts.checkPerm !== false && (!agent || !agent.hasGlobalPerm(GlobalPerm.USER_CREATE))) return { ok: false, error: "forbidden" };
  // importFromPost: sprintf('name, email%s %s', PHP_EOL, $stream); un file caricato ha già l'intestazione
  const stream = opts.file ? pasted : `name, email\n ${pasted}`;
  // db_autocommit(false) … db_rollback(): savepoint dentro la transazione dell'operazione
  await sql`SAVEPOINT people_import`.execute(ctx.tx);
  try {
    const count = await doImport(ctx, stream, extra);
    await sql`RELEASE SAVEPOINT people_import`.execute(ctx.tx);
    return { ok: true, count };
  } catch (e) {
    if (e instanceof ImportFailure) {
      await sql`ROLLBACK TO SAVEPOINT people_import`.execute(ctx.tx);
      return { ok: false, error: "import", detail: e.message };
    }
    throw e;
  }
}

async function doImport(ctx: WriteContext, stream: string, extra: { orgId?: number }): Promise<number> {
  const { tx } = ctx;
  const form = await defaultFormOf(tx, "U");
  if (!form) throw new ImportFailure("Unable to parse submitted csv");
  const rows = parseCsv(stream);
  const named = form.fields.filter((f) => f.name);
  if (!rows.length) throw new ImportFailure("Whoops. Perhaps you meant to send some CSV records");
  const first = rows[0];
  let headers: FieldDef[] = [];
  let hasHeader = true;
  for (const cell of first) {
    const raw = cell ?? "";
    const h = raw.trim().toLowerCase();
    const f = form.fields.find((x) => [x.name.toLowerCase(), x.label.toLowerCase()].includes(h));
    if (f) {
      if (!f.name) throw new ImportFailure(`${raw.trim()}: Field must have \`variable\` set to be imported`);
      headers.push(f);
      continue;
    }
    hasHeader = false;
    if (first.length === named.length) {
      headers = [...named];
      break;
    }
    throw new ImportFailure(`${raw.trim()}: Unable to map header to the object field`);
  }
  const data = hasHeader ? rows.slice(1) : rows;
  let imported = 0;
  // CsvImportIterator::$current: vale true finché non è stata letta una riga di dati
  let rec: Record<string, unknown> | null = null;
  for (const csv of data) {
    // Riga vuota (fgetcsv → [null], $csv[0] == null): il `continue` dentro do { } while (false) esce
    // dal ciclo senza leggere altro, quindi l'iteratore ripropone il record precedente (stranezza
    // replicata); prima di ogni record $data = true e la validazione di nome ed email fallisce.
    if (!(csv.length === 1 && (csv[0] === null || csv[0] === ""))) {
      if (csv.length !== headers.length) throw new ImportFailure(`Bad data. Expected: ${headers.map((h) => h.label).join(", ")}`);
      const next: Record<string, unknown> = {};
      if (extra.orgId !== undefined) next.org_id = extra.orgId;
      // CsvImportIterator: $f->parse(trim($csv[$i])) (senza widget), poi to_database
      headers.forEach((f, i) => {
        next[f.name] = toDatabase(f, parseFieldValue(f, (csv[i] ?? "").trim()));
      });
      rec = next;
    }
    if (!rec) throw new ImportFailure("Both `name` and `email` fields are required");
    const email = str(rec.email as string | null);
    if (!isEmail(email) || !truthy(rec.name as string | null)) throw new ImportFailure("Both `name` and `email` fields are required");
    const existing = await lookupUserByEmail(tx, email);
    if (existing) {
      // fromVars($vars, true, $update=true) → updateInfo($vars, $errors, true): errori ignorati
      await updateUserInfo(ctx, existing.id, rec);
    } else {
      const u = await userFromVars(tx, ctx.cfg, rec, { dates: await currentDates(ctx) });
      if (!u) throw new ImportFailure(`Unable to import user: ${JSON.stringify(rec)}`);
    }
    imported++;
  }
  return imported;
}
