import GridShape from "@/components/common/GridShape";
import ThemeTogglerTwo from "@/components/common/ThemeTogglerTwo";
import BrandLogo from "@/components/brand/BrandLogo";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

/** Layout a due colonne per le pagine di accesso, con il marchio TailTicket (o il logo caricato in osTicket). */
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
  const tb = useTranslations("brand");
  return (
    <div className="relative z-1 bg-white p-6 sm:p-0 dark:bg-gray-900">
      <div className="relative flex min-h-screen w-full flex-col justify-center sm:p-0 lg:flex-row dark:bg-gray-900">
        {children}
        <div
          className="hidden min-h-screen w-full items-center bg-gray-900 bg-cover bg-center lg:grid lg:w-1/2 dark:bg-white/5"
          style={backdropUrl ? { backgroundImage: `linear-gradient(rgb(16 24 40 / 0.75), rgb(16 24 40 / 0.75)), url(${backdropUrl})` } : undefined}
        >
          <div className="relative z-1 flex items-center justify-center">
            <GridShape />
            <div className="flex max-w-xs flex-col items-center">
              <BrandLogo forceDark height={72} className="mb-6" />
              <h2 className="sr-only">{sideTitle}</h2>
              <p className="text-center text-gray-400 dark:text-white/60">{sideText}</p>
              <p className="mt-8 text-center text-theme-xs text-gray-500 dark:text-white/40">{tb("basedOn")}</p>
            </div>
          </div>
        </div>
        <p className="pt-6 pb-2 text-center text-theme-xs text-gray-400 lg:hidden dark:text-white/40">{tb("basedOn")}</p>
        <div className="fixed end-6 bottom-6 z-50 hidden sm:block">
          <ThemeTogglerTwo />
        </div>
      </div>
    </div>
  );
}
