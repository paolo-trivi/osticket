import { redirect } from "@/i18n/navigation";

export const dynamic = "force-dynamic";

// Il portale clienti arriverà con la milestone M4: per ora la home porta al pannello agenti.
export default async function Home({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  redirect({ href: "/agent", locale });
}
