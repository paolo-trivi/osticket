"use client";

import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useRef, useState } from "react";

import { Bold, Italic, LinkIcon, List, ListOrdered, TextQuote, Underline, type LucideIcon } from "lucide-react";

import { useTranslations } from "next-intl";

import { cn } from "@/utils";

/**
 * Editor HTML essenziale (contentEditable) per risposte e note: grassetto, corsivo, sottolineato,
 * elenchi, link, citazione. L'HTML prodotto viene sempre sanificato lato server (Format::safe_html).
 */
export interface RichTextEditorHandle {
  insertHtml: (html: string) => void;
  clear: () => void;
  focus: () => void;
}

interface Props {
  name: string;
  placeholder?: string;
  /** nome accessibile dell'area di testo quando manca il placeholder (es. etichetta visibile del campo) */
  label?: string;
  /** chiamata alla prima digitazione (acquisizione del lock "all'attività") */
  onActivity?: () => void;
  minHeight?: number;
  /** HTML iniziale (es. ripristino del testo dopo un errore di validazione) */
  defaultValue?: string;
  labels: {
    bold: string;
    italic: string;
    underline: string;
    bullets: string;
    numbers: string;
    link: string;
    quote: string;
    linkPrompt: string;
  };
}

const BUTTONS: {
  cmd: string;
  arg?: string;
  label: keyof Props["labels"];
  icon: LucideIcon;
}[] = [
  { cmd: "bold", label: "bold", icon: Bold },
  { cmd: "italic", label: "italic", icon: Italic },
  { cmd: "underline", label: "underline", icon: Underline },
  { cmd: "insertUnorderedList", label: "bullets", icon: List },
  { cmd: "insertOrderedList", label: "numbers", icon: ListOrdered },
  { cmd: "formatBlock", arg: "blockquote", label: "quote", icon: TextQuote },
  { cmd: "createLink", label: "link", icon: LinkIcon },
];

/** Indirizzi ammessi per i collegamenti (come prima con il prompt): web e email. */
const LINK_RE = /^(https?:\/\/\S+|mailto:\S+)$/i;

const escapeHtml = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const RichTextEditor = forwardRef<RichTextEditorHandle, Props>(function RichTextEditor({ name, placeholder, label, onActivity, minHeight = 160, labels, defaultValue }, ref) {
  const editor = useRef<HTMLDivElement>(null);
  const [html, setHtml] = useState(defaultValue ?? "");
  const touched = useRef(false);
  const tc = useTranslations("common");
  const tl = useTranslations("composer.editor");
  // Riquadro del collegamento: selezione salvata all'apertura (il focus passa al campo URL)
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("https://");
  const savedRange = useRef<Range | null>(null);
  const linkButton = useRef<HTMLButtonElement>(null);
  const linkInput = useRef<HTMLInputElement>(null);
  const linkId = useId();

  const sync = useCallback(() => {
    setHtml(editor.current?.innerHTML ?? "");
    if (!touched.current) {
      touched.current = true;
      onActivity?.();
    }
  }, [onActivity]);

  useImperativeHandle(ref, () => ({
    insertHtml(fragment: string) {
      editor.current?.focus();
      document.execCommand("insertHTML", false, fragment);
      sync();
    },
    clear() {
      if (editor.current) editor.current.innerHTML = "";
      setHtml("");
      touched.current = false;
    },
    focus() {
      editor.current?.focus();
    },
  }));

  useEffect(() => {
    document.execCommand("defaultParagraphSeparator", false, "p");
  }, []);

  // Contenuto iniziale impostato una sola volta al montaggio (l'editor non è controllato)
  useEffect(() => {
    if (defaultValue && editor.current && !editor.current.innerHTML) editor.current.innerHTML = defaultValue;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (linkOpen) linkInput.current?.select();
  }, [linkOpen]);

  /** Ripristina nell'editor la selezione salvata all'apertura del riquadro. */
  const restoreSelection = () => {
    editor.current?.focus();
    const sel = window.getSelection();
    if (sel && savedRange.current) {
      sel.removeAllRanges();
      sel.addRange(savedRange.current);
    }
  };

  const openLink = () => {
    const sel = window.getSelection();
    const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
    savedRange.current = range && editor.current?.contains(range.commonAncestorContainer) ? range.cloneRange() : null;
    setLinkUrl("https://");
    setLinkOpen(true);
  };

  const closeLink = (refocus: "editor" | "button") => {
    setLinkOpen(false);
    if (refocus === "editor") restoreSelection();
    else linkButton.current?.focus();
  };

  const url = linkUrl.trim();
  const urlValid = LINK_RE.test(url);
  // segnalato solo dopo che l'utente ha scritto qualcosa oltre al prefisso proposto
  const linkInvalid = url !== "" && url !== "https://" && !urlValid;

  const applyLink = () => {
    if (!urlValid) return;
    setLinkOpen(false);
    restoreSelection();
    const range = savedRange.current;
    // senza testo selezionato il collegamento si inserisce con l'indirizzo come testo
    if (!range || range.collapsed) document.execCommand("insertHTML", false, `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`);
    else document.execCommand("createLink", false, url);
    savedRange.current = null;
    sync();
  };

  const exec = (cmd: string, arg?: string) => {
    if (cmd === "createLink") {
      if (linkOpen) closeLink("editor");
      else openLink();
      return;
    }
    editor.current?.focus();
    document.execCommand(cmd, false, arg);
    sync();
  };

  const empty = !html.replace(/<[^>]*>|&nbsp;|\s/g, "");
  // Il testo digitato senza blocco va in un paragrafo, come produce l'editor di osTicket
  const value = empty || /^\s*<(p|div|ul|ol|blockquote|h[1-6]|table|pre)\b/i.test(html) ? html : `<p>${html}</p>`;

  return (
    <div className="relative rounded-lg border border-gray-300 focus-within:border-brand-300 focus-within:ring-3 focus-within:ring-brand-500/10 dark:border-gray-700">
      <div className="flex flex-wrap gap-1 border-b border-gray-200 px-2 py-1.5 dark:border-gray-800">
        {BUTTONS.map((b) => (
          <button
            key={b.cmd + (b.arg ?? "")}
            ref={b.cmd === "createLink" ? linkButton : undefined}
            type="button"
            title={labels[b.label]}
            aria-label={labels[b.label]}
            {...(b.cmd === "createLink"
              ? {
                  "aria-haspopup": "dialog" as const,
                  "aria-expanded": linkOpen,
                  "aria-controls": linkId,
                }
              : {})}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => exec(b.cmd, b.arg)}
            className="inline-flex size-8 items-center justify-center rounded text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/5"
          >
            <b.icon className="size-4" />
          </button>
        ))}
      </div>
      {linkOpen && (
        // Riquadro non modale sotto la barra: niente <form> annidato (l'editor sta già in un form),
        // Invio applica, Esc annulla; uscendo con il focus si chiude senza modifiche
        <div
          id={linkId}
          role="dialog"
          aria-label={labels.link}
          className="absolute start-2 top-11 z-20 w-80 max-w-[calc(100%-1rem)] rounded-lg border border-gray-200 bg-white p-3 shadow-theme-lg dark:border-gray-700 dark:bg-gray-900"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              closeLink("button");
            }
          }}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setLinkOpen(false);
          }}
        >
          <label htmlFor={`${linkId}-url`} className="mb-1.5 block text-theme-xs font-medium text-gray-700 dark:text-gray-400">
            {labels.linkPrompt}
          </label>
          <input
            ref={linkInput}
            id={`${linkId}-url`}
            type="text"
            inputMode="url"
            autoComplete="off"
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                applyLink();
              }
            }}
            aria-invalid={linkInvalid}
            aria-describedby={`${linkId}-hint`}
            className="h-9 w-full rounded-lg border border-gray-300 bg-transparent px-3 text-sm text-gray-800 focus:border-brand-300 focus:ring-3 focus:ring-brand-500/10 focus:outline-hidden dark:border-gray-700 dark:text-white/90"
          />
          <p id={`${linkId}-hint`} className={cn("mt-1 text-theme-xs", linkInvalid ? "text-error-500" : "text-gray-500 dark:text-gray-400")}>
            {tl("linkInvalid")}
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => closeLink("editor")}
              className="h-8 rounded-lg border border-gray-300 px-3 text-theme-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-white/5"
            >
              {tc("cancel")}
            </button>
            <button
              type="button"
              onClick={applyLink}
              disabled={!urlValid}
              className="h-8 rounded-lg bg-brand-500 px-3 text-theme-xs font-medium text-white hover:bg-brand-600 disabled:opacity-50"
            >
              {tl("linkApply")}
            </button>
          </div>
        </div>
      )}
      <div className="relative">
        {empty && placeholder && <div className="pointer-events-none absolute top-3 left-4 text-sm text-gray-400">{placeholder}</div>}
        <div
          ref={editor}
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label={label ?? placeholder}
          onInput={sync}
          className="thread-body max-w-none px-4 py-3 text-sm text-gray-800 outline-none dark:text-white/90"
          style={{ minHeight }}
        />
      </div>
      <input type="hidden" name={name} value={value} />
    </div>
  );
});

export default RichTextEditor;
