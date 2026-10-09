import { cn } from "@/utils";

/** HTML già sanitizzato lato server (kbDisplayHtml) con lo stile dei corpi dei messaggi. */
export default function HtmlContent({ html, className }: { html: string; className?: string }) {
  return (
    <div
      className={cn("thread-body min-w-0 overflow-x-auto break-words text-gray-700 dark:text-gray-300", className)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
