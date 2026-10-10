"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { inputCls } from "@/components/forms/dynamic/styles";
import { cn } from "@/utils";

interface Props<T extends { id: number }> {
  id: string;
  placeholder: string;
  search: (q: string) => Promise<T[]>;
  onPick: (item: T) => void;
  /** id da non proporre (già scelti) */
  exclude?: number[];
  /** caratteri minimi prima della ricerca */
  minLength?: number;
  noResults: string;
  render: (item: T) => ReactNode;
}

/**
 * Campo di ricerca con suggerimenti (typeahead dei form PHP). Combobox ARIA: frecce per scorrere i
 * suggerimenti, Invio sceglie quello evidenziato (senza mai inviare il form che contiene il campo),
 * Esc chiude l'elenco.
 */
export default function SuggestPicker<T extends { id: number }>({ id, placeholder, search, onPick, exclude, minLength = 2, noResults, render }: Props<T>) {
  const listId = useId();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<T[] | null>(null);
  const [active, setActive] = useState(-1);
  const [closed, setClosed] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const term = q.trim();
    if (term.length < minLength) return;
    const n = ++seq.current;
    const timer = setTimeout(() => {
      void search(term).then((r) => {
        if (n !== seq.current) return;
        setHits(r);
        setActive(-1);
      });
    }, 250);
    return () => clearTimeout(timer);
  }, [q, search, minLength]);

  const visible = q.trim().length >= minLength ? (hits ?? []).filter((h) => !exclude?.includes(h.id)) : [];
  const open = q.trim().length >= minLength && !!hits && !closed;
  const current = open && active >= 0 && active < visible.length ? active : -1;
  const optId = (i: number) => `${listId}-${i}`;

  const pick = (h: T) => {
    onPick(h);
    setQ("");
    setHits(null);
    setActive(-1);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      // Invio non invia mai il form: sceglie il suggerimento evidenziato, altrimenti nulla
      e.preventDefault();
      if (current >= 0) pick(visible[current]);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!visible.length) return;
      e.preventDefault();
      setClosed(false);
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive(current < 0 ? (step > 0 ? 0 : visible.length - 1) : (current + step + visible.length) % visible.length);
      return;
    }
    if (e.key === "Escape" && open) {
      // chiude solo l'elenco, non la finestra modale che contiene il campo
      e.preventDefault();
      e.nativeEvent.stopPropagation();
      setClosed(true);
      setActive(-1);
    }
  };

  return (
    <div className="relative">
      <input
        id={id}
        type="search"
        role="combobox"
        aria-expanded={open && visible.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={current >= 0 ? optId(current) : undefined}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setClosed(false);
        }}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        autoComplete="off"
        className={inputCls}
      />
      {open && visible.length === 0 && (
        <p
          role="status"
          className="absolute z-9 mt-1 w-full rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm text-gray-500 shadow-theme-lg dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400"
        >
          {noResults}
        </p>
      )}
      <ul
        id={listId}
        role="listbox"
        aria-label={placeholder}
        hidden={!open || visible.length === 0}
        className="absolute z-9 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-gray-200 bg-white shadow-theme-lg dark:border-gray-800 dark:bg-gray-900"
      >
        {open &&
          visible.map((h, i) => (
            <li
              key={h.id}
              id={optId(i)}
              role="option"
              aria-selected={i === current}
              // mousedown: il campo resta a fuoco durante la scelta
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(h)}
              className={cn("flex w-full cursor-pointer flex-col px-4 py-2 text-start text-sm hover:bg-gray-50 dark:hover:bg-white/5", i === current && "bg-gray-100 dark:bg-white/10")}
            >
              {render(h)}
            </li>
          ))}
      </ul>
    </div>
  );
}
