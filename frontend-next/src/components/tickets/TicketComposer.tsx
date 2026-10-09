"use client";

import { useActionState, useCallback, useEffect, useRef, useState } from "react";

import RichTextEditor, { type RichTextEditorHandle } from "@/components/editor/RichTextEditor";
import { useRouter } from "@/i18n/navigation";
import { cn } from "@/utils";

import {
  cannedTextAction,
  lockAction,
  postNoteAction,
  postReplyAction,
  releaseLockAction,
  type LockState,
  type PostState,
} from "@/app/[locale]/(staff)/agent/(panel)/tickets/[id]/actions";

export interface ComposerLabels {
  reply: string;
  note: string;
  send: string;
  sending: string;
  replyTo: string;
  replyAll: string;
  replyUser: string;
  replyNone: string;
  collaborators: string;
  signature: string;
  sigNone: string;
  sigMine: string;
  sigDept: string;
  statusAfter: string;
  statusUnchanged: string;
  canned: string;
  cannedPick: string;
  noteTitle: string;
  replyPlaceholder: string;
  notePlaceholder: string;
  posted: string;
  lockedBy: string;
  errors: Record<string, string>;
  editor: { bold: string; italic: string; underline: string; bullets: string; numbers: string; link: string; quote: string; linkPrompt: string };
}

interface Props {
  ticketId: number;
  canReply: boolean;
  lockMode: number;
  statuses: { id: number; name: string; state: string }[];
  currentStatusId: number;
  collaborators: { userId: number; name: string; email: string; active: boolean }[];
  canned: { id: number; title: string }[];
  hasMySignature: boolean;
  deptSignature: boolean;
  defaultSignature: string;
  labels: ComposerLabels;
}

const selectCls =
  "h-10 rounded-lg border border-gray-300 bg-transparent px-3 text-sm text-gray-800 focus:border-brand-300 focus:outline-hidden dark:border-gray-700 dark:bg-gray-900 dark:text-white/90";

/** Risposta / nota interna con gestione del lock come ticket-view.inc.php + osticket.js. */
export default function TicketComposer(props: Props) {
  const { ticketId, labels, lockMode } = props;
  const [tab, setTab] = useState<"reply" | "note">(props.canReply ? "reply" : "note");
  const [lock, setLock] = useState<LockState>({ id: 0 });
  const lockRef = useRef<LockState>({ id: 0 });
  const router = useRouter();
  const replyEditor = useRef<RichTextEditorHandle>(null);
  const noteEditor = useRef<RichTextEditorHandle>(null);

  // Dopo l'invio il server rilascia il lock: si azzera anche lo stato locale
  const withLockReset = (fn: (prev: PostState, fd: FormData) => Promise<PostState>) => async (prev: PostState, fd: FormData) => {
    const r = await fn(prev, fd);
    if (r.ok) {
      lockRef.current = { id: 0 };
      setLock({ id: 0 });
    }
    return r;
  };
  const [replyState, replyAction, replyPending] = useActionState<PostState, FormData>(withLockReset(postReplyAction), {});
  const [noteState, noteAction, notePending] = useActionState<PostState, FormData>(withLockReset(postNoteAction), {});

  const acquire = useCallback(async () => {
    if (!lockMode) return;
    const res = await lockAction(ticketId, lockRef.current.id || undefined);
    lockRef.current = res;
    setLock(res);
  }, [lockMode, ticketId]);

  // Modalità "alla visualizzazione": lock subito; rinnovo prima della scadenza; rilascio all'uscita
  useEffect(() => {
    if (lockMode === 1) void acquire();
    return () => {
      if (lockRef.current.id) void releaseLockAction(ticketId);
    };
  }, [acquire, lockMode, ticketId]);

  useEffect(() => {
    if (!lock.id || !lock.time) return;
    const t = setTimeout(() => void acquire(), Math.max(10, lock.time - 30) * 1000);
    return () => clearTimeout(t);
  }, [lock, acquire]);

  const state = tab === "reply" ? replyState : noteState;
  useEffect(() => {
    if (!state.ok) return;
    (tab === "reply" ? replyEditor : noteEditor).current?.clear();
    if (state.closed) router.push("/agent/tickets");
    else router.refresh();
  }, [state.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const insertCanned = async (id: string) => {
    if (!id) return;
    const html = await cannedTextAction(ticketId, Number(id));
    if (html) replyEditor.current?.insertHtml(html);
  };

  const statusSelect = (
    <label className="flex flex-col gap-1 text-theme-sm text-gray-600 dark:text-gray-400">
      {labels.statusAfter}
      <select name="statusId" defaultValue="" className={selectCls}>
        <option value="">{labels.statusUnchanged}</option>
        {props.statuses
          .filter((s) => s.id !== props.currentStatusId)
          .map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
      </select>
    </label>
  );

  const errorText = state.error ? (labels.errors[state.error] ?? state.error) : null;

  return (
    <div className="rounded-2xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-white/3">
      <div className="flex border-b border-gray-200 dark:border-gray-800">
        {props.canReply && (
          <TabButton active={tab === "reply"} onClick={() => setTab("reply")}>
            {labels.reply}
          </TabButton>
        )}
        <TabButton active={tab === "note"} onClick={() => setTab("note")}>
          {labels.note}
        </TabButton>
      </div>

      {lock.lockedBy && (
        <p className="mx-5 mt-4 rounded-lg bg-warning-50 px-4 py-2 text-theme-sm text-warning-700 dark:bg-warning-500/15 dark:text-warning-400">
          {labels.lockedBy.replace("{name}", lock.lockedBy)}
        </p>
      )}
      {errorText && (
        <p role="alert" className="mx-5 mt-4 rounded-lg bg-error-50 px-4 py-2 text-theme-sm text-error-700 dark:bg-error-500/15 dark:text-error-400">
          {errorText}
        </p>
      )}
      {state.ok && !state.closed && (
        <p role="status" className="mx-5 mt-4 rounded-lg bg-success-50 px-4 py-2 text-theme-sm text-success-700 dark:bg-success-500/15 dark:text-success-400">
          {labels.posted}
        </p>
      )}

      <form action={replyAction} className={cn("space-y-4 p-5", tab !== "reply" && "hidden")}>
        <input type="hidden" name="ticketId" value={ticketId} />
        <input type="hidden" name="lockCode" value={lock.code ?? ""} />
        <div className="flex flex-wrap gap-4">
          <label className="flex flex-col gap-1 text-theme-sm text-gray-600 dark:text-gray-400">
            {labels.replyTo}
            <select name="replyTo" defaultValue="all" className={selectCls}>
              <option value="all">{labels.replyAll}</option>
              <option value="user">{labels.replyUser}</option>
              <option value="none">{labels.replyNone}</option>
            </select>
          </label>
          {props.canned.length > 0 && (
            <label className="flex flex-col gap-1 text-theme-sm text-gray-600 dark:text-gray-400">
              {labels.canned}
              <select defaultValue="" onChange={(e) => void insertCanned(e.target.value)} className={selectCls}>
                <option value="">{labels.cannedPick}</option>
                {props.canned.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {props.collaborators.length > 0 && (
          <fieldset className="text-theme-sm text-gray-600 dark:text-gray-400">
            <legend className="mb-1">{labels.collaborators}</legend>
            <div className="flex flex-wrap gap-3">
              {props.collaborators.map((c) => (
                <label key={c.userId} className="flex items-center gap-2">
                  <input type="checkbox" name="ccs" value={c.userId} defaultChecked={c.active} className="size-4 accent-brand-500" />
                  {c.name} <span className="text-gray-400">&lt;{c.email}&gt;</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <RichTextEditor ref={replyEditor} name="response" placeholder={labels.replyPlaceholder} onActivity={lockMode === 2 ? acquire : undefined} labels={labels.editor} />
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex flex-col gap-1 text-theme-sm text-gray-600 dark:text-gray-400">
            {labels.signature}
            <select name="signature" defaultValue={props.defaultSignature} className={selectCls}>
              <option value="none">{labels.sigNone}</option>
              {props.hasMySignature && <option value="mine">{labels.sigMine}</option>}
              {props.deptSignature && <option value="dept">{labels.sigDept}</option>}
            </select>
          </label>
          {statusSelect}
          <button
            type="submit"
            disabled={replyPending}
            className="ms-auto h-10 rounded-lg bg-brand-500 px-5 text-sm font-medium text-white shadow-theme-xs hover:bg-brand-600 disabled:opacity-60"
          >
            {replyPending ? labels.sending : labels.send}
          </button>
        </div>
      </form>

      <form action={noteAction} className={cn("space-y-4 p-5", tab !== "note" && "hidden")}>
        <input type="hidden" name="ticketId" value={ticketId} />
        <input type="hidden" name="lockCode" value={lock.code ?? ""} />
        <input
          name="title"
          placeholder={labels.noteTitle}
          className="h-10 w-full rounded-lg border border-gray-300 bg-transparent px-3 text-sm text-gray-800 focus:border-brand-300 focus:outline-hidden dark:border-gray-700 dark:text-white/90"
        />
        <RichTextEditor ref={noteEditor} name="note" placeholder={labels.notePlaceholder} onActivity={lockMode === 2 ? acquire : undefined} labels={labels.editor} />
        <div className="flex flex-wrap items-end gap-4">
          {statusSelect}
          <button
            type="submit"
            disabled={notePending}
            className="ms-auto h-10 rounded-lg bg-warning-500 px-5 text-sm font-medium text-white shadow-theme-xs hover:bg-warning-600 disabled:opacity-60"
          >
            {notePending ? labels.sending : labels.send}
          </button>
        </div>
      </form>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "px-5 py-3 text-sm font-medium",
        active ? "border-b-2 border-brand-500 text-brand-600 dark:text-brand-400" : "text-gray-500 hover:text-gray-700 dark:text-gray-400",
      )}
    >
      {children}
    </button>
  );
}
