"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";

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
  /** chiamata alla prima digitazione (acquisizione del lock "all'attività") */
  onActivity?: () => void;
  minHeight?: number;
  /** HTML iniziale (es. ripristino del testo dopo un errore di validazione) */
  defaultValue?: string;
  labels: { bold: string; italic: string; underline: string; bullets: string; numbers: string; link: string; quote: string; linkPrompt: string };
}

const BUTTONS: { cmd: string; arg?: string; label: keyof Props["labels"]; icon: string }[] = [
  { cmd: "bold", label: "bold", icon: "B" },
  { cmd: "italic", label: "italic", icon: "I" },
  { cmd: "underline", label: "underline", icon: "U" },
  { cmd: "insertUnorderedList", label: "bullets", icon: "•" },
  { cmd: "insertOrderedList", label: "numbers", icon: "1." },
  { cmd: "formatBlock", arg: "blockquote", label: "quote", icon: "❝" },
  { cmd: "createLink", label: "link", icon: "🔗" },
];

const RichTextEditor = forwardRef<RichTextEditorHandle, Props>(function RichTextEditor(
  { name, placeholder, onActivity, minHeight = 160, labels, defaultValue },
  ref,
) {
  const editor = useRef<HTMLDivElement>(null);
  const [html, setHtml] = useState(defaultValue ?? "");
  const touched = useRef(false);

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

  const exec = (cmd: string, arg?: string) => {
    editor.current?.focus();
    if (cmd === "createLink") {
      const url = window.prompt(labels.linkPrompt, "https://");
      if (!url || !/^(https?:|mailto:)/i.test(url)) return;
      document.execCommand(cmd, false, url);
    } else {
      document.execCommand(cmd, false, arg);
    }
    sync();
  };

  const empty = !html.replace(/<[^>]*>|&nbsp;|\s/g, "");
  // Il testo digitato senza blocco va in un paragrafo, come produce l'editor di osTicket
  const value = empty || /^\s*<(p|div|ul|ol|blockquote|h[1-6]|table|pre)\b/i.test(html) ? html : `<p>${html}</p>`;

  return (
    <div className="rounded-lg border border-gray-300 focus-within:border-brand-300 focus-within:ring-3 focus-within:ring-brand-500/10 dark:border-gray-700">
      <div className="flex flex-wrap gap-1 border-b border-gray-200 px-2 py-1.5 dark:border-gray-800">
        {BUTTONS.map((b) => (
          <button
            key={b.cmd + (b.arg ?? "")}
            type="button"
            title={labels[b.label]}
            aria-label={labels[b.label]}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => exec(b.cmd, b.arg)}
            className={cn(
              "min-w-8 rounded px-2 py-1 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/5",
              b.cmd === "bold" && "font-bold",
              b.cmd === "italic" && "italic",
              b.cmd === "underline" && "underline",
            )}
          >
            {b.icon}
          </button>
        ))}
      </div>
      <div className="relative">
        {empty && placeholder && (
          <div className="pointer-events-none absolute top-3 left-4 text-sm text-gray-400">{placeholder}</div>
        )}
        <div
          ref={editor}
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label={placeholder}
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
