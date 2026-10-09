import { BrandingProvider } from "@/context/BrandingContext";
import { SidebarProvider } from "@/context/SidebarContext";
import { THEME_STORAGE_KEY, ThemeProvider } from "@/context/ThemeContext";
import { isRtl } from "@/i18n/languages";
import { type Locale, routing } from "@/i18n/routing";
import { DEFAULT_THEME, loadTheme, themeCss, type ResolvedTheme } from "@/server/theme/theme";
import "flatpickr/dist/flatpickr.css";
import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { FONT_CLASS } from "@/lib/fonts";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import "../globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const theme = await safeTheme();
  return {
    title: { default: theme.displayName, template: `%s · ${theme.displayName}` },
    description: "TailTicket — l'helpdesk moderno, compatibile con osTicket",
    applicationName: "TailTicket",
  };
}

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

/** Il tema arriva dal DB: se il DB non risponde la UI resta utilizzabile con il tema predefinito. */
async function safeTheme(): Promise<ResolvedTheme> {
  try {
    return await loadTheme();
  } catch {
    return { ...DEFAULT_THEME, displayName: "TailTicket", staffLogoId: 0, clientLogoId: 0, backdropId: 0 };
  }
}

export default async function RootLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}>) {
  const { locale } = await params;
  if (!routing.locales.includes(locale as Locale)) notFound();
  setRequestLocale(locale);

  const theme = await safeTheme();
  // nonce della Content-Security-Policy (src/proxy.ts) per lo script inline
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  // Applica chiaro/scuro prima del primo paint (preferenza utente se consentita, altrimenti quella di admin)
  const antiFlash = `(function(){try{var d=${JSON.stringify(theme.mode_default)},a=${theme.allow_user_mode ? "true" : "false"};var m=(a&&localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)}))||d;if(m==="auto")m=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";if(m==="dark")document.documentElement.classList.add("dark")}catch(e){}})()`;

  return (
    <html lang={locale} dir={isRtl(locale as Locale) ? "rtl" : "ltr"} suppressHydrationWarning>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: antiFlash }} />
        <style id="ost-theme" nonce={nonce} dangerouslySetInnerHTML={{ __html: themeCss(theme) }} />
      </head>
      <body className={`${FONT_CLASS[theme.font]} dark:bg-gray-900`}>
        <NextIntlClientProvider>
          <BrandingProvider
            value={{
              displayName: theme.displayName,
              sidebarStyle: theme.sidebar_style,
              hasStaffLogo: theme.staffLogoId > 0,
              hasClientLogo: theme.clientLogoId > 0,
              hasBackdrop: theme.backdropId > 0,
              loginTagline: theme.login_tagline,
            }}
          >
            <ThemeProvider defaultMode={theme.mode_default} allowUserMode={theme.allow_user_mode}>
              <SidebarProvider>{children}</SidebarProvider>
            </ThemeProvider>
          </BrandingProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
