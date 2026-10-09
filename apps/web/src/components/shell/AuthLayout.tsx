import GridShape from "@/components/common/GridShape";
import ThemeTogglerTwo from "@/components/common/ThemeTogglerTwo";
import BrandLogo from "@/components/brand/BrandLogo";
import type { ReactNode } from "react";

/** Layout a due colonne per le pagine di accesso, con il marchio osTicket. */
export default function AuthLayout({
  children,
  sideTitle,
  sideText,
  backdropUrl,
}: {
  children: ReactNode;
  sideTitle: string;
  sideText: string;
  /** sfondo di accesso caricato in osTicket (core.staff_backdrop_id) */
  backdropUrl?: string;
}) {
  return (
    <div className="relative z-1 bg-white p-6 sm:p-0 dark:bg-gray-900">
      <div className="relative flex h-screen w-full flex-col justify-center sm:p-0 lg:flex-row dark:bg-gray-900">
        {children}
        <div
          className="hidden h-full w-full items-center bg-gray-900 bg-cover bg-center lg:grid lg:w-1/2 dark:bg-white/5"
          style={backdropUrl ? { backgroundImage: `linear-gradient(rgb(16 24 40 / 0.75), rgb(16 24 40 / 0.75)), url(${backdropUrl})` } : undefined}
        >
          <div className="relative z-1 flex items-center justify-center">
            <GridShape />
            <div className="flex max-w-xs flex-col items-center">
              <BrandLogo forceDark height={72} className="mb-6" />
              <h2 className="sr-only">{sideTitle}</h2>
              <p className="text-center text-gray-400 dark:text-white/60">{sideText}</p>
            </div>
          </div>
        </div>
        <div className="fixed end-6 bottom-6 z-50 hidden sm:block">
          <ThemeTogglerTwo />
        </div>
      </div>
    </div>
  );
}
