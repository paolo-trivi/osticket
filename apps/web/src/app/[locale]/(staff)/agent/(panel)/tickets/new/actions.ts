"use server";

import { getLocale } from "next-intl/server";

import { redirect } from "@/i18n/navigation";
import type { DynamicFormView } from "@/lib/forms/dynamic-field";
import { formIds, formNum, formStr, formStrs } from "@/server/actions/form-data";
import { currentAgent } from "@/server/auth/staff-auth";
import { clientIp } from "@/server/auth/session";
import { coreConfig } from "@/server/config/config";
import { db } from "@/server/db";
import { verifyUploadTokens } from "@/server/domain/file/upload";
import { loadFormDef, loadTopicForms } from "@/server/domain/forms/load";
import { TicketPerm } from "@/server/domain/staff/staff";
import { openTicket, type CreateErrors } from "@/server/domain/ticket/create";
import { formDataToVars, searchUsers, topicFormsView, usersByIds, type UserHit } from "@/server/domain/ticket/create-ui";
import { runWrite } from "@/server/domain/write";

export interface OpenTicketState {
  /** codice dell'errore generale (o testo originale del PHP se non riconosciuto) */
  error?: string;
  /** errori per campo del form di apertura (user, email, name, topicId, source, duedate, assignId) */
  errors?: Partial<Record<Exclude<keyof CreateErrors, "fields" | "err" | "errno">, string>>;
  /** errori dei campi dei form dinamici: id campo → codici */
  fieldErrors?: Record<number, string[]>;
  /** valori inviati (per ripristinare il form) */
  values?: Record<string, string[]>;
  /** richiedente e collaboratori scelti (ripristino) */
  user?: UserHit | null;
  ccs?: UserHit[];
  nonce?: number;
}

/** Messaggi del PHP → codici tradotti dalla UI */
const ERR_CODES: [RegExp, string][] = [
  [/^Missing or invalid data/, "invalid"],
  [/authorized users only/, "rejected"],
  [/permission to create a ticket in/, "deptDenied"],
  [/permission to create tickets/, "denied"],
  [/maximum open tickets/, "limit"],
];

function errorCode(err: string | undefined): string | undefined {
  if (!err) return undefined;
  for (const [re, code] of ERR_CODES) if (re.test(err)) return code;
  return err;
}

function submittedValues(fd: FormData): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of fd.entries()) {
    if (typeof v !== "string" || k.startsWith("$ACTION") || k === "files" || k === "responseFiles") continue;
    (out[k] ??= []).push(v);
  }
  return out;
}

/**
 * Apertura di un ticket da agente (scp/tickets.php?a=open → Ticket::open): permessi ricontrollati,
 * POST convertito nelle $vars di osTicket, allegati verificati tramite i token di upload.
 */
export async function openTicketAction(_prev: OpenTicketState, fd: FormData): Promise<OpenTicketState> {
  const agent = await currentAgent();
  if (!agent) return { error: "session_expired", nonce: Date.now() };
  const values = submittedValues(fd);
  if (!agent.hasPermInAnyRole(TicketPerm.CREATE)) return { error: "denied", values, nonce: Date.now() };

  const cfg = await coreConfig();
  const topicId = formNum(fd, "topicId") || 0;
  const uid = formNum(fd, "uid") || 0;
  const [ticketDef, userDef, topicForms] = await Promise.all([
    loadFormDef(db(), cfg, { type: "T" }, "staff"),
    uid ? Promise.resolve(null) : loadFormDef(db(), cfg, { type: "U" }, "staff"),
    topicId ? loadTopicForms(db(), cfg, topicId, "staff") : Promise.resolve([]),
  ]);
  const vars: Record<string, unknown> = formDataToVars(fd, [ticketDef, userDef, ...topicForms.filter((f) => f.type !== "T")]);
  if (uid) vars.uid = uid;
  for (const k of ["source", "topicId", "deptId", "slaId", "duedate", "assignId", "statusId", "reply-to", "response", "signature", "note"]) {
    if (fd.has(k) && formStr(fd, k) !== "") vars[k] = formStr(fd, k);
  }
  const ccs = formIds(fd, "ccs");
  if (ccs.length) vars.ccs = ccs;
  const owner = `S${agent.id}`;
  vars.files = verifyUploadTokens(formStrs(fd, "files"), owner);
  vars.responseFiles = verifyUploadTokens(formStrs(fd, "responseFiles"), owner);

  const res = await runWrite({ agent, ip: await clientIp() }, (ctx) => openTicket(ctx, vars));
  if (res.ok) {
    const locale = await getLocale();
    redirect({ href: `/agent/tickets/${res.ticketId}`, locale });
  }
  if (res.ok) return {};
  const { err, fields, errno: _errno, ...rest } = res.errors;
  void _errno;
  const picked = await usersByIds(db(), [uid, ...ccs].filter(Boolean));
  return {
    error: errorCode(err) ?? (Object.keys(rest).length || fields ? undefined : "generic"),
    errors: rest,
    fieldErrors: fields,
    values,
    user: picked.find((u) => u.id === uid) ?? null,
    ccs: ccs.map((id) => picked.find((u) => u.id === id)).filter((u): u is UserHit => !!u),
    nonce: Date.now(),
  };
}

/** Ricerca utenti per la scelta del richiedente e dei collaboratori */
export async function searchUsersAction(q: string): Promise<UserHit[]> {
  const agent = await currentAgent();
  if (!agent) return [];
  return searchUsers(db(), q);
}

/** Form aggiuntivi dell'help topic scelto (ajax.php/form/help-topic/<id>) */
export async function topicFormsAction(topicId: number): Promise<{ forms: DynamicFormView[]; disabled: number[] }> {
  const agent = await currentAgent();
  if (!agent || !topicId) return { forms: [], disabled: [] };
  return topicFormsView(db(), await coreConfig(), topicId, "staff");
}
