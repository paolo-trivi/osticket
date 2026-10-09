"use client";

import { useTranslations } from "next-intl";

/** Etichette della barra dell'editor (namespace "composer" dei testi base) */
export function useEditorLabels() {
  const te = useTranslations("composer");
  return {
    bold: te("editor.bold"),
    italic: te("editor.italic"),
    underline: te("editor.underline"),
    bullets: te("editor.bullets"),
    numbers: te("editor.numbers"),
    link: te("editor.link"),
    quote: te("editor.quote"),
    linkPrompt: te("editor.linkPrompt"),
  };
}
