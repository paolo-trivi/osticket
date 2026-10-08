import { cn } from "@/utils";
import Image from "next/image";

/**
 * Marchio osTicket (asset originali del progetto: scp/images/ost-logo.png e images/favicon.png).
 * `full`: logo con scritta, variante chiara/scura in base al tema; `icon`: solo il canguro.
 */
export default function BrandLogo({
  variant = "full",
  height = 40,
  forceDark = false,
  className,
}: {
  variant?: "full" | "icon";
  height?: number;
  /** usa sempre la variante per sfondi scuri */
  forceDark?: boolean;
  className?: string;
}) {
  if (variant === "icon") {
    return (
      <Image
        src="/images/logo/osticket-icon.png"
        alt="osTicket"
        width={height}
        height={height}
        priority
        className={cn("rounded-lg", className)}
      />
    );
  }
  const width = Math.round((height * 395) / 132);
  if (forceDark) {
    return <Image src="/images/logo/osticket-logo-dark.png" alt="osTicket" width={width} height={height} priority className={className} />;
  }
  return (
    <>
      <Image src="/images/logo/osticket-logo.png" alt="osTicket" width={width} height={height} priority className={cn("dark:hidden", className)} />
      <Image src="/images/logo/osticket-logo-dark.png" alt="osTicket" width={width} height={height} priority className={cn("hidden dark:block", className)} />
    </>
  );
}
