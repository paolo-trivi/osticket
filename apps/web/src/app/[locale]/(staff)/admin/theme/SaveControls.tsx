"use client";

import Alert from "@/components/ui/alert/Alert";
import Button from "@/components/ui/button/Button";
import { useTranslations } from "next-intl";

import type { SaveThemeState } from "./actions";

interface SaveControlsProps {
  state: SaveThemeState;
  dirty: boolean;
  pending: boolean;
  /** il colore primario è valido */
  canSave: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onReset: () => void;
}

/** Esito del salvataggio, salva / annulla modifiche e ripristino del tema predefinito. */
export default function SaveControls({ state, dirty, pending, canSave, onSave, onDiscard, onReset }: SaveControlsProps) {
  const t = useTranslations("admin.theme");
  return (
    <div className="space-y-3">
      {state.status === "saved" && <Alert variant="success" title={t("saved")} message="" />}
      {state.status === "error" && <Alert variant="error" title={t("error")} message={state.message ?? ""} />}
      <div className="flex gap-3">
        <Button onClick={onSave} disabled={!dirty || pending || !canSave} className="flex-1">
          {pending ? t("saving") : t("save")}
        </Button>
        <Button variant="outline" onClick={onDiscard} disabled={!dirty || pending}>
          {t("discard")}
        </Button>
      </div>
      <button
        type="button"
        onClick={onReset}
        className="text-theme-xs text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-white"
      >
        {t("resetDefaults")}
      </button>
    </div>
  );
}
