import { NextResponse } from "next/server";

import { readStoredFile } from "@/server/domain/file/storage";
import { loadTheme } from "@/server/theme/theme";

/**
 * Loghi caricati in osTicket (equivalente di logo.php e scp/logo.php):
 *   /api/branding/staff-logo, /api/branding/client-logo, /api/branding/backdrop
 * Se non configurati rimanda agli asset osTicket predefiniti.
 */
const FALLBACK: Record<string, string> = {
  "staff-logo": "/images/logo/osticket-logo.png",
  "client-logo": "/images/logo/osticket-logo.png",
  backdrop: "/images/logo/osticket-icon.png",
};

export async function GET(request: Request, { params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params;
  if (!(kind in FALLBACK)) return new NextResponse(null, { status: 404 });

  const theme = await loadTheme();
  const fileId = kind === "staff-logo" ? theme.staffLogoId : kind === "client-logo" ? theme.clientLogoId : theme.backdropId;
  const file = fileId ? await readStoredFile(fileId) : null;
  if (!file || !file.type.startsWith("image/") || file.type.includes("svg")) {
    return NextResponse.redirect(new URL(FALLBACK[kind], request.url));
  }
  return new NextResponse(new Uint8Array(file.data), {
    headers: {
      "Content-Type": file.type,
      "Cache-Control": "private, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
