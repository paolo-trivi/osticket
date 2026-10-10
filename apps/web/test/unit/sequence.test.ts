import { describe, expect, it } from "vitest";

import { formatSequence, randNumber } from "@/server/domain/sequence";

describe("Sequence::format", () => {
  // Valori attesi ottenuti da include/class.sequence.php (RandomSequence::format)
  it.each([
    ["######", 42, "0", "000042"],
    ["TX-###-##-US", 1234567, "0", "TX-123-4567-US"],
    ["\\###-##", 7, "0", "#00-07"],
    ["#", 13, "0", "13"],
    ["AB-##", 123456789, "0", "AB-123456789"],
    ["##-##-##", 915323, "0", "91-53-23"],
    ["####-#", 12, "x", "xxx1-2"],
  ])("%s con %s (padding %s) → %s", (format, number, padding, expected) => {
    expect(formatSequence(format, number, padding)).toBe(expected);
  });
});

describe("Misc::randNumber", () => {
  it("numeri di N cifre senza zeri iniziali", () => {
    for (const len of [1, 6, 9]) {
      for (let i = 0; i < 200; i++) {
        const n = randNumber(len);
        expect(String(n)).toMatch(new RegExp(`^[1-9]\\d{${len - 1}}$`));
      }
    }
  });

  it("6 cifre per default (codice 2FA)", () => {
    expect(String(randNumber())).toHaveLength(6);
  });
});
