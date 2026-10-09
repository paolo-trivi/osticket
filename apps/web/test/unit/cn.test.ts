import { describe, expect, it } from "vitest";

import { cn } from "@/utils";

describe("cn (tailwind-merge con i token del tema)", () => {
  it("non scarta le dimensioni di testo del tema accanto a un colore", () => {
    expect(cn("dropdown-toggle", "text-theme-sm text-gray-700")).toBe("dropdown-toggle text-theme-sm text-gray-700");
    expect(cn("text-title-md", "text-brand-500")).toBe("text-title-md text-brand-500");
  });
  it("risolve i conflitti tra dimensioni", () => {
    expect(cn("text-theme-sm", "text-theme-xs")).toBe("text-theme-xs");
  });
});
