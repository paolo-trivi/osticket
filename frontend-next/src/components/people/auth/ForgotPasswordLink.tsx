"use client";

import { useTranslations } from "next-intl";

import { Link } from "@/i18n/navigation";

/** Collegamento "Password dimenticata?" del login agenti (scp/pwreset.php). */
export default function ForgotPasswordLink() {
  const t = useTranslations("peopleAuth");
  return (
    <div className="text-center text-sm">
      <Link href="/agent/login/reset" className="text-brand-500 hover:text-brand-600 dark:text-brand-400">
        {t("forgot")}
      </Link>
    </div>
  );
}
