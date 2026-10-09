"use client";

import { useBranding } from "@/context/BrandingContext";
import { cn } from "@/utils";
import Image from "next/image";
import { withBase } from "@/lib/base-path";

/**
 * Marchio dell'helpdesk.
 * - Se in osTicket è stato caricato un logo (Admin > Impostazioni) e il tema lo consente, si usa quello
 *   (/api/branding/...).
 * - Altrimenti il logo TailTicket (SVG), con variante chiara/scura in base al tema.
 */
export default function BrandLogo({
  variant = "full",
  audience = "staff",
  height = 40,
  forceDark = false,
  className,
}: {
  variant?: "full" | "icon";
  audience?: "staff" | "client";
  height?: number;
  /** usa sempre la variante per sfondi scuri */
  forceDark?: boolean;
  className?: string;
}) {
  const branding = useBranding();
  const name = branding.displayName;

  if (variant === "icon") {
    return (
      <Image src={withBase("/images/logo/tailticket-mark.svg")} alt={name} width={height} height={height} priority unoptimized className={className} />
    );
  }

  const custom = audience === "staff" ? branding.hasStaffLogo : branding.hasClientLogo;
  if (custom) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- immagine servita dal DB osTicket, dimensioni ignote
      <img src={withBase(`/api/branding/${audience}-logo`)} alt={name} style={{ maxHeight: height, width: "auto" }} className={className} />
    );
  }

  // proporzioni del logo TailTicket (docs/brand/logo.svg: 233×64)
  const width = Math.round((height * 233) / 64);
  if (forceDark) {
    return <Image src={withBase("/images/logo/tailticket-logo-dark.svg")} alt={name} width={width} height={height} priority unoptimized className={className} />;
  }
  return (
    <>
      <Image src={withBase("/images/logo/tailticket-logo.svg")} alt={name} width={width} height={height} priority unoptimized className={cn("dark:hidden", className)} />
      <Image src={withBase("/images/logo/tailticket-logo-dark.svg")} alt={name} width={width} height={height} priority unoptimized className={cn("hidden dark:block", className)} />
    </>
  );
}
