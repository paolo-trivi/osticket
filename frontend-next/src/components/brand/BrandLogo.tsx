"use client";

import { useBranding } from "@/context/BrandingContext";
import { cn } from "@/utils";
import Image from "next/image";
import { withBase } from "@/lib/base-path";

/**
 * Marchio dell'helpdesk.
 * - Se in osTicket è stato caricato un logo (Admin > Impostazioni), si usa quello (/api/branding/...).
 * - Altrimenti gli asset originali osTicket (scp/images/ost-logo.png, images/favicon.png),
 *   con variante chiara/scura in base al tema.
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
      <Image src={withBase("/images/logo/osticket-icon.png")} alt={name} width={height} height={height} priority className={cn("rounded-lg", className)} />
    );
  }

  const custom = audience === "staff" ? branding.hasStaffLogo : branding.hasClientLogo;
  if (custom) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- immagine servita dal DB osTicket, dimensioni ignote
      <img src={withBase(`/api/branding/${audience}-logo`)} alt={name} style={{ maxHeight: height, width: "auto" }} className={className} />
    );
  }

  const width = Math.round((height * 395) / 132);
  if (forceDark) {
    return <Image src={withBase("/images/logo/osticket-logo-dark.png")} alt={name} width={width} height={height} priority className={className} />;
  }
  return (
    <>
      <Image src={withBase("/images/logo/osticket-logo.png")} alt={name} width={width} height={height} priority className={cn("dark:hidden", className)} />
      <Image src={withBase("/images/logo/osticket-logo-dark.png")} alt={name} width={width} height={height} priority className={cn("hidden dark:block", className)} />
    </>
  );
}
