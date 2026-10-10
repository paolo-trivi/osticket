"use client";

import { useTranslations } from "next-intl";

import SuggestPicker from "../SuggestPicker";

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
  return (
    <SuggestPicker
      id={id}
      placeholder={placeholder}
      search={search}
      onPick={onPick}
      exclude={exclude}
      noResults={t("noResults")}
      render={(h) => (
        <>
          <span className="text-gray-800 dark:text-white/90">{h.name}</span>
          <span className="text-theme-xs text-gray-500 dark:text-gray-400">{h.email}</span>
        </>
      )}
    />
  );
}
