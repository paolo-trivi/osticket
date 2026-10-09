import { DownloadIcon } from "@/icons";

interface AttachmentItem {
  id: number;
  name: string;
  size: number;
  href: string;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Allegati scaricabili (link alla route protetta /api/agent/file/<chiave>). */
export default function AttachmentList({ items, downloadLabel }: { items: readonly AttachmentItem[]; downloadLabel: (name: string) => string }) {
  return (
    <ul className="space-y-2">
      {items.map((a) => (
        <li key={a.id}>
          <a
            href={a.href}
            download={a.name}
            aria-label={downloadLabel(a.name)}
            className="flex items-center gap-3 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 hover:border-brand-300 hover:bg-gray-50 dark:border-gray-800 dark:text-gray-300 dark:hover:border-brand-500/40 dark:hover:bg-white/3"
          >
            <DownloadIcon className="size-5 shrink-0 text-gray-400 dark:text-gray-500" />
            <span className="min-w-0 flex-1 truncate">{a.name}</span>
            <span className="shrink-0 text-theme-xs text-gray-400 dark:text-gray-500">{humanSize(a.size)}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}
