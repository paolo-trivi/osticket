"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import {
  massAssignAction,
  massAssigneesAction,
  massClaimAction,
  massDeleteAction,
  massMergeAction,
  massMergeCandidatesAction,
  massStatusAction,
  massTransferAction,
  type MassActionState,
} from "@/app/[locale]/(staff)/agent/(panel)/tickets/actions-mass";
import { Check, Editor, Field, Select } from "@/components/tickets/edit/inputs";
import Button from "@/components/ui/button/Button";
import { Dropdown } from "@/components/ui/dropdown/Dropdown";
import { DropdownItem } from "@/components/ui/dropdown/DropdownItem";
import { Modal } from "@/components/ui/modal";
import { useRouter } from "@/i18n/navigation";
import { ChevronDownIcon } from "@/icons";
import { withBase } from "@/lib/base-path";
import { cn } from "@/utils";

import MassDialog from "./MassDialog";
import type { MassData, MassKind } from "./types";

const itemClass =
  "block w-full rounded-lg px-3 py-2 text-start text-theme-sm text-gray-700 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-gray-300";
const buttonClass =
  "inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-theme-sm text-gray-700 hover:bg-gray-50 dark:border-gray-800 dark:text-gray-400 dark:hover:bg-white/5";

function MenuButton({ label, children }: { label: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <div className="relative">
      <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} className={cn("dropdown-toggle", buttonClass)}>
        {label}
        <ChevronDownIcon className={cn("size-4 transition-transform", open && "rotate-180")} />
      </button>
      <Dropdown isOpen={open} onClose={close} className="w-56 p-2">
        {children(close)}
      </Dropdown>
    </div>
  );
}

/** Ticket selezionati nella lista (caselle `data-mass-tid`). */
function selectedIds(): number[] {
  // la lista ha due viste (schede su mobile, tabella da md in su): stessi id, senza duplicati
  return [...new Set([...document.querySelectorAll<HTMLInputElement>("input[data-mass-tid]:checked")].map((i) => Number(i.value)))].filter(Boolean);
}

/**
 * Barra delle azioni di massa della lista (include/staff/templates/tickets-actions.tmpl.php): cambio
 * stato, presa in carico/assegnazione, merge, link, trasferimento, eliminazione; più l'export CSV
 * della coda (queue-tickets.tmpl.php → ajax.php/tickets/export/<id>).
 */
export default function TicketMassActions({ data }: { data: MassData }) {
  const t = useTranslations("ticketEdit.mass");
  const router = useRouter();
  const [kind, setKind] = useState<MassKind | null>(null);
  const [ids, setIds] = useState<number[]>([]);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const close = useCallback(() => setKind(null), []);
  const { can } = data;

  const open = (k: MassKind) => {
    const sel = selectedIds();
    if (k !== "export" && !sel.length) {
      setNotice({ ok: false, text: t("selectFirst") });
      return;
    }
    setIds(sel);
    setKind(k);
  };
  const onSuccess = useCallback(
    (s: MassActionState) => {
      setKind(null);
      setNotice({ ok: true, text: s.count === s.total ? t("doneAll", { count: s.count ?? 0 }) : t("donePartial", { count: s.count ?? 0, total: s.total ?? 0 }) });
      router.refresh();
    },
    [router, t],
  );
  const item = (label: string, k: MassKind, c: () => void) => (
    <DropdownItem key={typeof k === "object" ? `s${k.status}` : k} baseClassName={itemClass} onClick={() => open(k)} onItemClick={c}>
      {label}
    </DropdownItem>
  );

  return (
    <div className="flex flex-wrap items-center gap-2">
      {can.status && data.statuses.length > 0 && <MenuButton label={t("status")}>{(c) => data.statuses.map((s) => item(s.name, { status: s.id }, c))}</MenuButton>}
      {can.assign && (
        <MenuButton label={t("assign")}>
          {(c) => (
            <>
              {item(t("claim"), "claim", c)}
              {item(t("toAgent"), "assignAgents", c)}
              {item(t("toTeam"), "assignTeams", c)}
            </>
          )}
        </MenuButton>
      )}
      {can.merge && (
        <button type="button" className={buttonClass} onClick={() => open("merge")}>
          {t("merge")}
        </button>
      )}
      {can.link && (
        <button type="button" className={buttonClass} onClick={() => open("link")}>
          {t("link")}
        </button>
      )}
      {can.transfer && (
        <button type="button" className={buttonClass} onClick={() => open("transfer")}>
          {t("transfer")}
        </button>
      )}
      {can.delete && (
        <button type="button" className={cn(buttonClass, "text-error-600 dark:text-error-400")} onClick={() => open("delete")}>
          {t("delete")}
        </button>
      )}
      {can.export && (
        <button type="button" className={buttonClass} onClick={() => open("export")}>
          {t("export")}
        </button>
      )}
      {notice && (
        <div
          role="status"
          className={cn(
            "flex basis-full items-center justify-between gap-3 rounded-lg px-4 py-2 text-theme-sm",
            notice.ok ? "bg-success-50 text-success-700 dark:bg-success-500/15 dark:text-success-400" : "bg-warning-50 text-warning-700 dark:bg-warning-500/15 dark:text-orange-400",
          )}
        >
          <span>{notice.text}</span>
          <button type="button" onClick={() => setNotice(null)} className="text-theme-xs underline">
            {t("close")}
          </button>
        </div>
      )}
      {kind !== null && <MassDialogs kind={kind} ids={ids} data={data} onClose={close} onSuccess={onSuccess} />}
    </div>
  );
}

function MassDialogs({ kind, ids, data, onClose, onSuccess }: { kind: MassKind; ids: number[]; data: MassData; onClose: () => void; onSuccess: (s: MassActionState) => void }) {
  const t = useTranslations("ticketEdit.mass");
  const te = useTranslations("ticketEdit");
  const common = { ids, onClose, onSuccess };
  const n = ids.length;
  if (typeof kind === "object") {
    const status = data.statuses.find((s) => s.id === kind.status);
    const deleting = status?.state === "deleted";
    return (
      <MassDialog
        {...common}
        title={t("statusTitle", { count: n })}
        action={massStatusAction}
        submitLabel={deleting ? t("deleteConfirm") : t("apply")}
        danger={deleting}
        warning={deleting ? <>{t("deleteWarn", { count: n })} <strong>{te("deleteExtra")}</strong></> : undefined}
      >
        <input type="hidden" name="statusId" value={kind.status} />
        <p className="text-theme-sm text-gray-700 dark:text-gray-300">{t("statusTo", { status: status?.name ?? "" })}</p>
        <Editor name="comments" placeholder={deleting ? t("deletePlaceholder", { count: n }) : t("commentsPlaceholder")} />
      </MassDialog>
    );
  }
  switch (kind) {
    case "claim":
      return (
        <MassDialog {...common} title={t("claimTitle", { count: n })} action={massClaimAction} submitLabel={t("claimConfirm")} warning={t("claimWarn", { count: n })}>
          <Editor name="comments" placeholder={t("commentsPlaceholder")} />
        </MassDialog>
      );
    case "assignAgents":
    case "assignTeams":
      return <AssignDialog {...common} what={kind === "assignAgents" ? "agents" : "teams"} />;
    case "transfer":
      return (
        <MassDialog {...common} title={t("transferTitle", { count: n })} action={massTransferAction} submitLabel={t("transfer")}>
          <Field label={t("dept")}>
            <Select name="dept" defaultValue="" empty={t("selectDept")} required options={data.depts.map((d) => ({ value: String(d.id), label: d.name }))} />
          </Field>
          <Editor name="comments" placeholder={t("commentsPlaceholder")} />
        </MassDialog>
      );
    case "delete":
      return (
        <MassDialog
          {...common}
          title={t("deleteTitle", { count: n })}
          action={massDeleteAction}
          submitLabel={t("deleteConfirm")}
          danger
          warning={<>{t("deleteWarn", { count: n })} <strong>{te("deleteExtra")}</strong></>}
        >
          <Editor name="comments" placeholder={t("deletePlaceholder", { count: n })} />
        </MassDialog>
      );
    case "merge":
    case "link":
      return <MergeMassDialog {...common} title={kind} data={data} />;
    case "export":
      return <ExportDialog data={data} onClose={onClose} />;
  }
}

function AssignDialog({ ids, what, onClose, onSuccess }: { ids: number[]; what: "agents" | "teams"; onClose: () => void; onSuccess: (s: MassActionState) => void }) {
  const t = useTranslations("ticketEdit.mass");
  const [options, setOptions] = useState<{ value: string; label: string }[] | null>(null);
  useEffect(() => {
    void massAssigneesAction(ids, what).then(setOptions);
  }, [ids, what]);
  return (
    <MassDialog ids={ids} onClose={onClose} onSuccess={onSuccess} title={t("assignTitle", { count: ids.length })} action={massAssignAction} submitLabel={t("assign")}>
      {options === null ? (
        <p className="text-theme-sm text-gray-500">{t("loading")}</p>
      ) : options.length === 0 ? (
        <p className="text-theme-sm text-warning-600">{t(what === "agents" ? "noAgents" : "noTeams")}</p>
      ) : (
        <Field label={t(what === "agents" ? "agent" : "team")}>
          <Select name="assignee" defaultValue="" empty={t(what === "agents" ? "selectAgent" : "selectTeam")} required options={options} />
        </Field>
      )}
      <Editor name="comments" placeholder={t("commentsPlaceholder")} />
    </MassDialog>
  );
}

function MergeMassDialog({ ids, title, data, onClose, onSuccess }: { ids: number[]; title: "merge" | "link"; data: MassData; onClose: () => void; onSuccess: (s: MassActionState) => void }) {
  const t = useTranslations("ticketEdit");
  const tm = useTranslations("ticketEdit.mass");
  const [list, setList] = useState<{ id: number; number: string; subject: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void massMergeCandidatesAction(ids, title).then((r) => {
      if ("error" in r) setError(r.error);
      else setList(r.tickets);
    });
  }, [ids, title]);
  const move = (i: number, d: number) =>
    setList((l) => {
      if (!l) return l;
      const c = [...l];
      [c[i], c[i + d]] = [c[i + d], c[i]];
      return c;
    });
  const isMerge = title === "merge";
  return (
    <MassDialog ids={ids} onClose={onClose} onSuccess={onSuccess} title={t(isMerge ? "mergeTitle" : "linkTitle")} action={massMergeAction} submitLabel={t("saveChanges")} wide>
      <input type="hidden" name="title" value={title} />
      {error && <p className="text-theme-sm text-error-600 dark:text-error-400">{tm.has(`errors.${error}`) ? tm(`errors.${error}`) : t("errors.generic")}</p>}
      {list && (
        <ul className="space-y-2">
          {list.map((x, i) => (
            <li key={x.id} className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-theme-sm dark:border-gray-800">
              <input type="hidden" name="numbers" value={x.number} />
              <span className="font-medium text-gray-800 dark:text-white/90">#{x.number}</span>
              <span className="flex-1 truncate text-gray-600 dark:text-gray-400">{x.subject}</span>
              {i === 0 && <span className="rounded bg-brand-50 px-2 py-0.5 text-theme-xs text-brand-600 dark:bg-brand-500/15 dark:text-brand-400">{t("parent")}</span>}
              <button type="button" disabled={i === 0} onClick={() => move(i, -1)} aria-label={t("moveUp")} className="rounded px-2 py-1 text-theme-xs disabled:opacity-30">
                ↑
              </button>
              <button type="button" disabled={i === list.length - 1} onClick={() => move(i, 1)} aria-label={t("moveDown")} className="rounded px-2 py-1 text-theme-xs disabled:opacity-30">
                ↓
              </button>
            </li>
          ))}
        </ul>
      )}
      {isMerge && list && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t("participants")}>
            <Select name="participants" defaultValue="all" options={[{ value: "user", label: t("participantsUser") }, { value: "all", label: t("participantsAll") }]} />
          </Field>
          <Field label={t("childStatus")}>
            <Select name="childStatusId" defaultValue={String(data.defaultChildStatusId)} options={data.closedStatuses.map((s) => ({ value: String(s.id), label: s.name }))} />
          </Field>
          <Field label={t("parentStatus")}>
            <Select name="parentStatusId" defaultValue="" empty={t("select")} options={data.parentStatuses.map((s) => ({ value: String(s.id), label: s.name }))} />
          </Field>
          <fieldset className="space-y-2">
            <legend className="text-theme-sm font-medium text-gray-700 dark:text-gray-400">{t("mergeType")}</legend>
            <label className="flex items-center gap-2 text-theme-sm text-gray-700 dark:text-gray-400">
              <input type="radio" name="combine" value="1" defaultChecked className="accent-brand-500" /> {t("combine")}
            </label>
            <label className="flex items-center gap-2 text-theme-sm text-gray-700 dark:text-gray-400">
              <input type="radio" name="combine" value="0" className="accent-brand-500" /> {t("separate")}
            </label>
          </fieldset>
          <Check name="deleteChild" label={t("deleteChild")} />
          <Check name="moveTasks" label={t("moveTasks")} />
        </div>
      )}
    </MassDialog>
  );
}

/** Dialogo di export (templates/queue-export.tmpl.php): campi, separatore, download del CSV. */
function ExportDialog({ data, onClose }: { data: MassData; onClose: () => void }) {
  const t = useTranslations("ticketEdit.mass");
  const te = useTranslations("ticketEdit");
  const [fields, setFields] = useState(data.exportFields.map((f) => f.path));
  const [delimiter, setDelimiter] = useState(",");
  const params = new URLSearchParams({ queue: String(data.queueId), delimiter });
  if (data.sort) params.set("sort", data.sort);
  if (data.dir) params.set("dir", data.dir);
  for (const f of fields) params.append("fields", f);
  const href = withBase(`/api/agent/tickets/export?${params.toString()}`);
  const toggle = (path: string, on: boolean) =>
    setFields((l) => (on ? data.exportFields.map((x) => x.path).filter((p) => l.includes(p) || p === path) : l.filter((p) => p !== path)));
  return (
    <Modal isOpen onClose={onClose} className="m-4 max-w-[760px] p-6 lg:p-8">
      <div className="max-h-[80vh] space-y-5 overflow-y-auto pe-1 custom-scrollbar">
        <h4 className="pe-12 text-title-sm font-semibold text-gray-800 dark:text-white/90">{t("exportTitle", { queue: data.queueName })}</h4>
        <p className="text-theme-sm text-gray-600 dark:text-gray-400">{t("exportHelp")}</p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {data.exportFields.map((f) => (
            <label key={f.path} className="flex items-center gap-2 text-theme-sm text-gray-700 dark:text-gray-400">
              <input type="checkbox" checked={fields.includes(f.path)} onChange={(e) => toggle(f.path, e.target.checked)} className="size-4 accent-brand-500" />
              {f.label}
            </label>
          ))}
        </div>
        <Field label={t("delimiter")}>
          <Select
            value={delimiter}
            onChange={setDelimiter}
            options={[
              { value: ",", label: t("delimiters.comma") },
              { value: ";", label: t("delimiters.semicolon") },
              { value: "\t", label: t("delimiters.tab") },
              { value: "|", label: t("delimiters.pipe") },
            ]}
          />
        </Field>
        <div className="flex items-center justify-end gap-3">
          <Button size="sm" variant="outline" onClick={onClose}>
            {te("cancel")}
          </Button>
          <a
            href={fields.length ? href : undefined}
            aria-disabled={!fields.length}
            onClick={() => setTimeout(onClose, 300)}
            className={cn("inline-flex rounded-lg bg-brand-500 px-4 py-3 text-sm font-medium text-white hover:bg-brand-600", !fields.length && "pointer-events-none opacity-50")}
          >
            {t("download")}
          </a>
        </div>
      </div>
    </Modal>
  );
}
