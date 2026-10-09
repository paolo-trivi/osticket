"use server";

import { revalidatePath } from "next/cache";
import { getLocale } from "next-intl/server";

import { ThemeSchema, type ThemeSettings } from "@/lib/theme/schema";
import { touchStaffSession } from "@/server/auth/staff-auth";
import { saveTheme } from "@/server/theme/theme";

import { requireAdmin } from "../guard";

export type SaveThemeState = { status: "idle" | "saved" | "error"; message?: string };

export async function saveThemeAction(settings: ThemeSettings): Promise<SaveThemeState> {
  await requireAdmin(await getLocale());
  const parsed = ThemeSchema.safeParse(settings);
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.path.join(".") };
  await saveTheme(parsed.data);
  await touchStaffSession();
  // il tema è letto dal layout radice: ricarica tutte le pagine
  revalidatePath("/", "layout");
  return { status: "saved" };
}
