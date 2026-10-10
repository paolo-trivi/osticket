import { getTranslations } from "next-intl/server";

import { ReadOnlyNotice, WriteGate } from "@/components/common/WriteGate";
import TicketComposer, { type ComposerLabels } from "@/components/tickets/TicketComposer";
import type { TicketComposerData } from "@/server/domain/ticket/view";

/**
 * Composer della vista ticket (risposta / nota interna): dati dal loader, testi tradotti lato server.
 * In sola lettura un avviso prende il posto del form (e il lock del ticket non viene chiesto).
 */
export default async function TicketComposerSection({ composer }: { composer: TicketComposerData }) {
  const tc = await getTranslations("composer");
  const labels: ComposerLabels = {
    reply: tc("reply"),
    note: tc("note"),
    send: tc("send"),
    sending: tc("sending"),
    replyTo: tc("replyTo"),
    replyAll: tc("replyAll"),
    replyUser: tc("replyUser"),
    replyNone: tc("replyNone"),
    collaborators: tc("collaborators"),
    signature: tc("signature"),
    sigNone: tc("sigNone"),
    sigMine: tc("sigMine"),
    sigDept: tc("sigDept"),
    statusAfter: tc("statusAfter"),
    statusUnchanged: tc("statusUnchanged"),
    canned: tc("canned"),
    cannedPick: tc("cannedPick"),
    noteTitle: tc("noteTitle"),
    replyPlaceholder: tc("replyPlaceholder"),
    notePlaceholder: tc("notePlaceholder"),
    posted: tc("posted"),
    lockedBy: tc.raw("lockedBy") as string,
    errors: {
      session_expired: tc("errors.session_expired"),
      not_found: tc("errors.not_found"),
      denied: tc("errors.denied"),
      response_required: tc("errors.response_required"),
      note_required: tc("errors.note_required"),
      lock_required: tc("errors.lock_required"),
      locked_by_other: tc("errors.locked_by_other"),
      lock_expired: tc("errors.lock_expired"),
      banned: tc("errors.banned"),
      // postReply/postNote senza agente nel contesto (codice "forbidden" del dominio)
      forbidden: tc("errors.forbidden"),
      read_only: tc("errors.read_only"),
      generic: tc("errors.generic"),
    },
    editor: {
      bold: tc("editor.bold"),
      italic: tc("editor.italic"),
      underline: tc("editor.underline"),
      bullets: tc("editor.bullets"),
      numbers: tc("editor.numbers"),
      link: tc("editor.link"),
      quote: tc("editor.quote"),
      linkPrompt: tc("editor.linkPrompt"),
    },
  };
  return (
    <WriteGate fallback={<ReadOnlyNotice />}>
      <TicketComposer {...composer} labels={labels} />
    </WriteGate>
  );
}
