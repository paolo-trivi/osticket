"use client";

import { useState } from "react";

import { TextField } from "./FormControls";

/**
 * Data/ora locale del browser convertita in istante ISO (campo nascosto `name`), come il DatetimeField
 * del PHP che interpreta la data nel fuso dell'agente.
 */
export default function DueDateInput({ name, label, defaultIso, error }: { name: string; label: string; defaultIso?: string | null; error?: string }) {
  const toLocal = (iso?: string | null) => {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const [iso, setIso] = useState(defaultIso ?? "");
  return (
    <div onChange={(e) => {
      const v = (e.target as HTMLInputElement).value;
      setIso(v ? new Date(v).toISOString() : "");
    }}>
      <input type="hidden" name={name} value={iso} />
      <TextField name={`${name}:local`} type="datetime-local" label={label} defaultValue={toLocal(defaultIso)} error={error} />
    </div>
  );
}
