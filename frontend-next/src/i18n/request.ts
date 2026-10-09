import { getRequestConfig } from "next-intl/server";

import { MESSAGE_AREAS } from "../messages/areas";
import { type Locale, routing } from "./routing";

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = routing.locales.includes(requested as Locale)
    ? (requested as Locale)
    : routing.defaultLocale;

  const messages: Record<string, unknown> = { ...(await import(`../messages/${locale}.json`)).default };
  for (const area of MESSAGE_AREAS) {
    Object.assign(messages, (await import(`../messages/${area}/${locale}.json`)).default);
  }
  return { locale, messages };
});
