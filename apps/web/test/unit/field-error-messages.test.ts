import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { routing } from "@/i18n/routing";
import { FIELD_ERROR_CODES } from "@/server/domain/forms/fields";

/**
 * Ogni form che mostra gli errori dei campi dinamici (validateField) traduce tutti i codici, in tutte
 * le lingue: azienda (admUi.errors), directory utenti/organizzazioni e task (peopleUi.fieldErrors),
 * portale (portal.fieldErrors e dynamicForms.errors), modifica del ticket (ticketEdit.fieldErrors).
 */
const NAMESPACES: [area: string, path: string][] = [
  ["admin", "admUi.errors"],
  ["people", "peopleUi.fieldErrors"],
  ["portal", "portal.fieldErrors"],
  ["create", "dynamicForms.errors"],
  ["ticketedit", "ticketEdit.fieldErrors"],
];

function messages(area: string, locale: string): Record<string, unknown> {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`../../src/messages/${area}/${locale}.json`, import.meta.url)), "utf8"));
}

describe("traduzioni dei codici d'errore dei campi", () => {
  for (const [area, path] of NAMESPACES) {
    for (const locale of routing.locales) {
      it(`${path} (${locale})`, () => {
        const node = path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], messages(area, locale)) as Record<string, unknown>;
        expect(FIELD_ERROR_CODES.filter((c) => typeof node?.[c] !== "string")).toEqual([]);
      });
    }
  }
});
