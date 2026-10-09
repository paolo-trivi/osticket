"use client";

import { useRef, useState } from "react";

import { useTranslations } from "next-intl";

import { withBase } from "@/lib/base-path";
import { cn } from "@/utils";

export interface UploadedFile {
  id: number;
  name: string;
  size: number;
  /** token firmato da inviare con il form */
  token: string;
}

interface Props {
  /** nome dei campi nascosti con i token (uno per file) */
  name: string;
  /** endpoint di upload (es. "/api/agent/upload"); passa da withBase() */
  uploadUrl: string;
  /** dimensione massima in byte (controllo anche lato server) */
  maxSize?: number;
  /** estensioni/tipi ammessi per il selettore (attributo accept) */
  accept?: string;
  disabled?: boolean;
  className?: string;
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Selettore di allegati riusabile (ticket nuovi, risposte, note, portale): ogni file viene caricato
 * subito sull'endpoint (come il widget AJAX di osTicket) e il form invia solo i token restituiti.
 */
export default function AttachmentInput({ name, uploadUrl, maxSize, accept, disabled, className }: Props) {
  const t = useTranslations("attachments");
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [busy, setBusy] = useState(0);
  const [errors, setErrors] = useState<string[]>([]);

  const upload = async (list: FileList | null) => {
    if (!list?.length) return;
    const errs: string[] = [];
    for (const file of Array.from(list)) {
      if (maxSize && file.size > maxSize) {
        errs.push(t("errors.size", { name: file.name }));
        continue;
      }
      setBusy((n) => n + 1);
      try {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch(withBase(uploadUrl), { method: "POST", body: fd });
        const json = (await res.json().catch(() => ({ error: "invalid" }))) as Partial<UploadedFile> & { error?: string };
        if (!res.ok || json.error || !json.token) {
          const code = json.error ?? "invalid";
          errs.push(t.has(`errors.${code}`) ? t(`errors.${code}`, { name: file.name }) : t("errors.invalid", { name: file.name }));
        } else {
          const uploaded = { id: json.id!, name: json.name ?? file.name, size: json.size ?? file.size, token: json.token };
          setFiles((prev) => (prev.some((p) => p.id === uploaded.id) ? prev : [...prev, uploaded]));
        }
      } catch {
        errs.push(t("errors.network", { name: file.name }));
      } finally {
        setBusy((n) => n - 1);
      }
    }
    setErrors(errs);
    if (input.current) input.current.value = "";
  };

  return (
    <div className={cn("space-y-2", className)}>
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (!disabled) void upload(e.dataTransfer.files);
        }}
        className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-gray-300 px-4 py-3 text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400"
      >
        <button
          type="button"
          disabled={disabled}
          onClick={() => input.current?.click()}
          className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-white/5"
        >
          {t("choose")}
        </button>
        <span>{busy ? t("uploading") : t("dropHint")}</span>
        <input ref={input} type="file" multiple accept={accept} className="hidden" onChange={(e) => void upload(e.target.files)} />
      </div>
      {files.length > 0 && (
        <ul className="space-y-1">
          {files.map((f) => (
            <li key={f.id} className="flex items-center gap-3 text-sm text-gray-700 dark:text-gray-300">
              <input type="hidden" name={name} value={f.token} />
              <span className="truncate">{f.name}</span>
              <span className="text-theme-xs text-gray-400">{formatSize(f.size)}</span>
              <button
                type="button"
                onClick={() => setFiles((prev) => prev.filter((p) => p.id !== f.id))}
                className="ms-auto text-theme-xs text-error-600 hover:underline dark:text-error-400"
              >
                {t("remove")}
              </button>
            </li>
          ))}
        </ul>
      )}
      {errors.map((e) => (
        <p key={e} role="alert" className="text-theme-xs text-error-600 dark:text-error-400">
          {e}
        </p>
      ))}
    </div>
  );
}
