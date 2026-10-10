import { getTranslations } from "next-intl/server";

import Callout from "@/components/common/Callout";

/** Esiti ammessi nel parametro ?done= delle pagine people (creazione ed eliminazione). */
const DONE_CODES = ["task_created", "task_deleted", "user_created", "user_deleted", "org_created", "org_deleted"] as const;
type PeopleDoneCode = (typeof DONE_CODES)[number];

/** Percorso con l'esito in query string (?done=<codice>&n=<numero del task>), letto da PeopleDoneNotice. */
export function withDone(path: string, code: PeopleDoneCode, number?: string): string {
  const q = new URLSearchParams({ done: code });
  if (number) q.set("n", number);
  return `${path}${path.includes("?") ? "&" : "?"}${q}`;
}

/**
 * Esito dell'azione con cui si è arrivati alla pagina (messaggio di sessione del PHP dopo un redirect):
 * il codice viene dall'URL, quindi solo quelli noti; il numero del task solo se alfanumerico, i nomi
 * vengono dalla pagina (dati attuali), non dall'URL.
 */
export default async function PeopleDoneNotice({ done, n, name }: { done?: string; n?: string; name?: string }) {
  if (!done || !(DONE_CODES as readonly string[]).includes(done)) return null;
  const t = await getTranslations("peopleUi.done");
  const number = n && /^[\w-]{1,32}$/.test(n) ? n : "";
  return (
    <Callout tone="success" role="status">
      {t(done, { number, name: name ?? "" })}
    </Callout>
  );
}
