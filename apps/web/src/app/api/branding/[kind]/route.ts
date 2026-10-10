import { NextResponse } from "next/server";

import { withBase } from "@/lib/base-path";
import { readStoredFile } from "@/server/domain/file/storage";
import { localRedirect } from "@/server/http/redirect";
import { loadTheme } from "@/server/theme/theme";

/**
 * Loghi caricati in osTicket (equivalente di logo.php e scp/logo.php):
 *   /api/branding/staff-logo, /api/branding/client-logo, /api/branding/backdrop
 * Se non configurati rimanda agli asset TailTicket predefiniti.
 */
const FALLBACK: Record<string, string> = {
  "staff-logo": "/images/logo/tailticket-logo.svg",
  "client-logo": "/images/logo/tailticket-logo.svg",
  backdrop: "/images/logo/tailticket-mark.svg",
};

export async function GET(request: Request, { params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params;
  if (!Object.hasOwn(FALLBACK, kind)) return new NextResponse(null, { status: 404 });

  const theme = await loadTheme();
  const fileId = kind === "staff-logo" ? theme.staffLogoId : kind === "client-logo" ? theme.clientLogoId : theme.backdropId;
  const file = fileId ? await readStoredFile(fileId) : null;
  if (!file || !file.type.startsWith("image/") || file.type.includes("svg")) {
    return localRedirect(withBase(FALLBACK[kind]));
  }
  return new NextResponse(new Uint8Array(file.data), {
    headers: {
      "Content-Type": file.type,
      "Cache-Control": "private, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
