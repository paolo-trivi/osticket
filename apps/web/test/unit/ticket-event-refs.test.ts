import { describe, expect, it } from "vitest";

import { eventCollabs, eventPair, eventRef, eventValueText } from "@/server/domain/ticket/event-refs";
import { agentLocalToIso, dbDateToInput } from "@/server/domain/ticket/edit-values";

describe("eventRef", () => {
  it("id semplice o [id, nome] come ThreadEvent::template", () => {
    expect(eventRef(3)).toEqual({ id: 3, fallback: "" });
    expect(eventRef("7")).toEqual({ id: 7, fallback: "" });
    expect(eventRef([3, "Closed"])).toEqual({ id: 3, fallback: "Closed" });
    expect(eventRef(["4", "Resolved"])).toEqual({
      id: 4,
      fallback: "Resolved",
    });
  });
  it("valori non validi: nessun id", () => {
    expect(eventRef(null)).toEqual({ id: null, fallback: "" });
    expect(eventRef("abc")).toEqual({ id: null, fallback: "" });
    expect(eventRef(0)).toEqual({ id: null, fallback: "" });
    expect(eventRef([null, "Nome"])).toEqual({ id: null, fallback: "Nome" });
  });
});

describe("eventCollabs", () => {
  it("aggiunti con nome e origine, rimossi con nome o stringa", () => {
    expect(
      eventCollabs({
        add: { "12": { name: "Mario Rossi", src: "Email (to)" } },
      }),
    ).toEqual({
      added: [{ id: 12, name: "Mario Rossi", src: "Email (to)" }],
      removed: [],
    });
    expect(eventCollabs({ del: { "5": { name: "Anna" }, "6": "Luca" } }).removed).toEqual([
      { id: 5, name: "Anna", src: "" },
      { id: 6, name: "Luca", src: "" },
    ]);
    // proprietario di un figlio unito: chiave vuota
    expect(eventCollabs({ add: { "": { name: "Owner" } } }).added).toEqual([{ id: null, name: "Owner", src: "" }]);
  });
});

describe("eventValueText / eventPair", () => {
  it("scelte JSON e liste come elenco, scalari come testo", () => {
    expect(eventValueText('{"a":"Alfa","b":"Beta"}')).toBe("Alfa, Beta");
    expect(eventValueText(["x", "y"])).toBe("x, y");
    expect(eventValueText(null)).toBe("");
    expect(eventValueText(5)).toBe("5");
    expect(eventValueText("{non json")).toBe("{non json");
  });
  it("coppia [vecchio, nuovo]", () => {
    expect(eventPair([1, 2])).toEqual([1, 2]);
    expect(eventPair(3)).toEqual([null, 3]);
  });
});

describe("scadenza nel fuso dell'agente", () => {
  it("datetime-local → ISO con l'offset del fuso", () => {
    expect(agentLocalToIso("2026-10-10T12:00", "Europe/Rome")).toBe("2026-10-10T12:00:00+02:00");
    expect(agentLocalToIso("2026-12-10 12:00", "Europe/Rome")).toBe("2026-12-10T12:00:00+01:00");
    expect(agentLocalToIso("2026-10-10T12:00", "UTC")).toBe("2026-10-10T12:00:00Z");
  });
  it("vuoto o già con offset: invariato", () => {
    expect(agentLocalToIso("", "Europe/Rome")).toBe("");
    expect(agentLocalToIso("2026-10-10T12:00:00+05:00", "Europe/Rome")).toBe("2026-10-10T12:00:00+05:00");
  });
  it("DB → campo nel fuso dell'agente (andata e ritorno stabili)", () => {
    expect(dbDateToInput("2026-10-10 10:00:00", "UTC", "Europe/Rome")).toBe("2026-10-10T12:00");
    expect(dbDateToInput("2026-10-10 10:00:00", "UTC")).toBe("2026-10-10T10:00");
    expect(dbDateToInput(null, "UTC", "Europe/Rome")).toBe("");
  });
});
