"use client";

import { useEffect, useRef, useState } from "react";

import { useTranslations } from "next-intl";

import { inputCls } from "@/components/forms/dynamic/styles";

export interface PickedUser {
  id: number;
  name: string;
  email: string;
}

interface Props {
  id: string;
  placeholder: string;
  search: (q: string) => Promise<PickedUser[]>;
  onPick: (u: PickedUser) => void;
  exclude?: number[];
}

/** Ricerca utenti con suggerimenti (nome o email), come il typeahead del form di apertura PHP. */
export default function UserPicker({ id, placeholder, search, onPick, exclude }: Props) {
  const t = useTranslations("createTicket.user");
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<PickedUser[] | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return;
    const n = ++seq.current;
    const timer = setTimeout(() => {
      void search(term).then((r) => {
        if (n === seq.current) setHits(r);
      });
    }, 250);
    return () => clearTimeout(timer);
  }, [q, search]);

  const visible = q.trim().length >= 2 ? (hits ?? []).filter((h) => !exclude?.includes(h.id)) : [];
  return (
    <div className="relative">
      <input id={id} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} autoComplete="off" className={inputCls} />
      {q.trim().length >= 2 && hits && (
        <ul className="absolute z-9 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-gray-200 bg-white shadow-theme-lg dark:border-gray-800 dark:bg-gray-900">
          {visible.length === 0 && <li className="px-4 py-2 text-sm text-gray-500 dark:text-gray-400">{t("noResults")}</li>}
          {visible.map((h) => (
            <li key={h.id}>
              <button
                type="button"
                onClick={() => {
                  onPick(h);
                  setQ("");
                  setHits(null);
                }}
                className="flex w-full flex-col px-4 py-2 text-start text-sm hover:bg-gray-50 dark:hover:bg-white/5"
              >
                <span className="text-gray-800 dark:text-white/90">{h.name}</span>
                <span className="text-theme-xs text-gray-500 dark:text-gray-400">{h.email}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
