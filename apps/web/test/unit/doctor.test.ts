import { createHash } from "node:crypto";

import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";

import { encrypt } from "@/server/crypto/crypto";
import { buildMessageId } from "@/server/mail/message-id";
import { formatReportText, sortChecks, verdictLine, wrapText } from "@/server/system/doctor/format";
import { analyzeGrants, parseGrantLine, recommendedGrant, schemaPatternMatches } from "@/server/system/doctor/grants";
import { extractOsTicketMessageIds, saltVerdict, tallyCredentials, tallyMessageIds } from "@/server/system/doctor/salt";
import { fsStoragePath } from "@/server/domain/file/storage";
import { compareOffsets, formatOffset, zoneOffsetMinutes } from "@/server/system/doctor/timezone";
import { summarize, type DoctorCheck } from "@/server/system/doctor/types";

const USER = "TO `tt`@`%`";

describe("doctor: SHOW GRANTS", () => {
  it("solo SELECT, INSERT, UPDATE, DELETE sullo schema: nessun problema (l'hash della password non compare)", () => {
    const lines = [`GRANT USAGE ON *.* ${USER} IDENTIFIED BY PASSWORD '*94BDCEBE19083CE2A1F959FD02F964C7AF4CFC29'`, `GRANT SELECT, INSERT, UPDATE, DELETE ON \`osticket\`.* ${USER}`];
    const a = analyzeGrants(lines, "osticket");
    expect(a).toEqual({
      dangerous: [],
      unneeded: [],
      missing: [],
      tableLevel: false,
      roles: [],
      unparsed: 0,
    });
    expect(JSON.stringify(a)).not.toContain("94BDCEBE");
  });

  it("ALL PRIVILEGES sullo schema e privilegi globali amministrativi: non consentiti", () => {
    const a = analyzeGrants([`GRANT PROCESS, SUPER ON *.* ${USER} WITH GRANT OPTION`, `GRANT ALL PRIVILEGES ON \`osticket\`.* ${USER}`], "osticket");
    expect(a.dangerous).toEqual(["PROCESS su *.* (globale)", "SUPER su *.* (globale)", "GRANT OPTION su *.* (globale)", "ALL PRIVILEGES su `osticket`.*"]);
    expect(a.missing).toEqual([]);
  });

  it("DDL sullo schema (anche con caratteri jolly) e privilegi dinamici di MySQL 8", () => {
    const a = analyzeGrants(
      [
        `GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, REFERENCES, CREATE TEMPORARY TABLES, LOCK TABLES, TRIGGER, EVENT ON \`osticket\`.* ${USER}`,
        `GRANT FILE ON \`ost%\`.* ${USER}`,
        `GRANT BACKUP_ADMIN,SYSTEM_VARIABLES_ADMIN ON *.* ${USER}`,
      ],
      "osticket",
    );
    expect(a.dangerous).toEqual([
      "CREATE su `osticket`.*",
      "ALTER su `osticket`.*",
      "DROP su `osticket`.*",
      "INDEX su `osticket`.*",
      "REFERENCES su `osticket`.*",
      "CREATE TEMPORARY TABLES su `osticket`.*",
      "LOCK TABLES su `osticket`.*",
      "TRIGGER su `osticket`.*",
      "EVENT su `osticket`.*",
      "FILE su `ost%`.*",
      "BACKUP_ADMIN su *.* (globale)",
      "SYSTEM_VARIABLES_ADMIN su *.* (globale)",
    ]);
  });

  it("privilegi su altri schemi ignorati; underscore jolly o letterale", () => {
    expect(analyzeGrants([`GRANT ALL PRIVILEGES ON \`altro\`.* ${USER}`, `GRANT SELECT, INSERT, UPDATE, DELETE ON \`osticket\`.* ${USER}`], "osticket").dangerous).toEqual([]);
    expect(schemaPatternMatches("os_ticket", "osXticket")).toBe(true);
    expect(schemaPatternMatches("os\\_ticket", "osXticket")).toBe(false);
    expect(schemaPatternMatches("os\\_ticket", "os_ticket")).toBe(true);
    expect(schemaPatternMatches("%", "osticket")).toBe(true);
  });

  it("privilegi mancanti, solo per tabella, colonne, ruoli, PROXY e SHOW VIEW", () => {
    expect(analyzeGrants([`GRANT SELECT ON \`osticket\`.* ${USER}`], "osticket").missing).toEqual(["INSERT", "UPDATE", "DELETE"]);
    const t = analyzeGrants(
      [`GRANT SELECT ON \`osticket\`.* ${USER}`, `GRANT SELECT (\`id\`, \`name\`), INSERT, UPDATE (\`name\`), DELETE ON \`osticket\`.\`ost_ticket\` ${USER}`],
      "osticket",
    );
    expect(t).toMatchObject({
      missing: ["INSERT", "UPDATE", "DELETE"],
      tableLevel: true,
      dangerous: [],
    });
    expect(analyzeGrants([`GRANT \`app_role\` ${USER}`], "osticket").roles).toEqual(["app_role"]);
    expect(analyzeGrants([`GRANT PROXY ON ''@'%' TO 'root'@'localhost' WITH GRANT OPTION`], "osticket").dangerous).toEqual(["PROXY", "GRANT OPTION"]);
    expect(analyzeGrants([`GRANT SHOW VIEW, SELECT, INSERT, UPDATE, DELETE ON \`osticket\`.* ${USER}`], "osticket").unneeded).toEqual(["SHOW VIEW su `osticket`.*"]);
    expect(parseGrantLine("SET DEFAULT ROLE `r` FOR `tt`@`%`")).toEqual({
      unparsed: true,
    });
  });

  it("GRANT consigliato: schema con jolly resi letterali, utente e host segnaposto", () => {
    expect(recommendedGrant("os_ticket")).toBe(
      "REVOKE ALL PRIVILEGES, GRANT OPTION FROM '<utente>'@'<host>';\nGRANT SELECT, INSERT, UPDATE, DELETE ON `os\\_ticket`.* TO '<utente>'@'<host>';",
    );
  });
});

describe("doctor: SECRET_SALT", () => {
  const SALT = "ilSaltDiOsTicketDiProva0123456789";
  const OTHER = "unSaltDiversoDaQuelloDiOsTicket987";
  const mid = (salt: string, from = "support@example.com") =>
    buildMessageId({
      secretSalt: salt,
      fromAddress: from,
      recipientUserId: 7,
      entryId: 42,
      threadId: 9,
      utype: "U",
    });

  it("estrae i Message-ID di osTicket dagli header di una risposta", () => {
    const a = mid(SALT);
    const b = mid(SALT, "help-desk@example.com");
    const headers = `Message-ID: <CAF123@mail.gmail.com>\nIn-Reply-To: <${a}>\nReferences: <foo@bar> <${a}>\n <${b}>`;
    expect(extractOsTicketMessageIds(headers).sort()).toEqual([a, b].sort());
  });

  it("sysid e firma confrontati con il salt configurato, solo per le email di sistema", () => {
    const own = ["support@example.com"];
    const ids = [mid(SALT), mid(SALT), mid(OTHER, "help@altro-osticket.org")];
    // due Message-ID distinti (parte casuale diversa) firmati dall'email di sistema; il terzo è di un altro osTicket
    expect(tallyMessageIds(ids, SALT, own)).toEqual({ match: 2, mismatch: 0 });
    expect(tallyMessageIds(ids, OTHER, own)).toEqual({ match: 0, mismatch: 2 });
    expect(tallyMessageIds([ids[0], ids[0]], SALT, own)).toEqual({
      match: 1,
      mismatch: 0,
    });
  });

  it("credenziali email cifrate dal PHP: decifrabili solo con lo stesso salt", () => {
    const ns = "email.1.account.2";
    const md5 = (s: string) => createHash("md5").update(s, "utf8").digest("hex");
    const creds = [
      {
        namespace: ns,
        values: {
          username: "box@example.com",
          passwd: encrypt("segreta", SALT, md5(`box@example.com${ns}`)) as string,
        },
      },
      // formato non gestito (lib 1, mcrypt): ignorato
      {
        namespace: "email.3.account.4",
        values: { username: "x", passwd: "$1$abc" },
      },
    ];
    expect(tallyCredentials(creds, SALT)).toEqual({ match: 1, mismatch: 0 });
    expect(tallyCredentials(creds, OTHER)).toEqual({ match: 0, mismatch: 1 });
  });

  it("esito: nessuna fonte = non verificabile, una discordanza = incoerente", () => {
    expect(saltVerdict({ match: 0, mismatch: 0 }, { match: 0, mismatch: 0 })).toBe("unverifiable");
    expect(saltVerdict({ match: 3, mismatch: 0 }, { match: 0, mismatch: 0 })).toBe("ok");
    expect(saltVerdict({ match: 3, mismatch: 0 }, { match: 0, mismatch: 1 })).toBe("mismatch");
  });
});

describe("doctor: fuso del DB", () => {
  const summer = DateTime.fromISO("2026-07-01T12:00:00Z");
  const winter = DateTime.fromISO("2026-01-15T12:00:00Z");

  it("offset coerenti, con arrotondamento al minuto", () => {
    expect(
      compareOffsets({
        mysqlSeconds: 7200,
        appZone: "Europe/Rome",
        ostZone: "Europe/Rome",
        at: summer,
      }).coherent,
    ).toBe(true);
    expect(
      compareOffsets({
        mysqlSeconds: 3599,
        appZone: "Europe/Rome",
        ostZone: "",
        at: winter,
      }).coherent,
    ).toBe(true);
    expect(
      compareOffsets({
        mysqlSeconds: 7200,
        appZone: "Europe/Rome",
        ostZone: "Europe/Berlin",
        at: summer,
      }).coherent,
    ).toBe(true);
  });

  it("incoerenze: app, osTicket, fuso non valido o non determinato", () => {
    expect(
      compareOffsets({
        mysqlSeconds: 0,
        appZone: "Europe/Rome",
        ostZone: "",
        at: summer,
      }),
    ).toMatchObject({ coherent: false, mysqlMinutes: 0, appMinutes: 120 });
    expect(
      compareOffsets({
        mysqlSeconds: 7200,
        appZone: "Europe/Rome",
        ostZone: "UTC",
        at: summer,
      }),
    ).toMatchObject({ coherent: false, ostMinutes: 0 });
    expect(
      compareOffsets({
        mysqlSeconds: 0,
        appZone: "UTC",
        ostZone: "Mars/Olympus",
        at: summer,
      }),
    ).toMatchObject({ coherent: false, invalid: ["Mars/Olympus"] });
    expect(
      compareOffsets({
        mysqlSeconds: 0,
        appZone: null,
        ostZone: "",
        at: summer,
      }).coherent,
    ).toBe(false);
  });

  it("formato degli offset", () => {
    expect(formatOffset(120)).toBe("+02:00");
    expect(formatOffset(-330)).toBe("-05:30");
    expect(formatOffset(0)).toBe("+00:00");
    expect(zoneOffsetMinutes("America/New_York", winter)).toBe(-300);
  });
});

// layout del plugin storage-fs usato dal controllo dello storage (funzione condivisa con la lettura dei file)
describe("doctor: layout dei file 'F' (storage-fs)", () => {
  it("<cartella>/<iniziale della chiave>/<chiave>", () => {
    expect(fsStoragePath("/data/attachments", "Xk3jd9alsd0vmA8f")).toBe("/data/attachments/X/Xk3jd9alsd0vmA8f");
  });

  it("chiavi che uscirebbero dalla cartella rifiutate", () => {
    expect(fsStoragePath("/data", "../etc/passwd")).toBeNull();
    expect(fsStoragePath("/data", "a/b")).toBeNull();
    expect(fsStoragePath("/data", "")).toBeNull();
  });
});

describe("doctor: report testuale", () => {
  const checks: DoctorCheck[] = [
    {
      id: "schema",
      level: "ok",
      title: "Connessione e versione dello schema",
      detail: "Firma verificata.",
    },
    {
      id: "plugins",
      level: "warn",
      title: "Plugin di osTicket",
      detail: "Plugin attivi: Auth::LDAP 0.6.",
    },
    {
      id: "db_grants",
      level: "block",
      title: "Privilegi dell'utente del database",
      detail: "Privilegi DDL o amministrativi non consentiti: ALL PRIVILEGES su `osticket`.*.",
      hint: "Concedi solo i privilegi necessari:\nGRANT SELECT, INSERT, UPDATE, DELETE ON `osticket`.* TO '<utente>'@'<host>';",
    },
    {
      id: "write_mode",
      level: "info",
      title: "Modalità di scrittura",
      detail: "Effettiva readonly.",
    },
  ];

  it("ordine per gravità, suggerimenti con gli a capo, esito in fondo", () => {
    const report = { checks, summary: summarize(checks) };
    const text = formatReportText(report);
    const lines = text.trimEnd().split("\n");
    expect(lines.at(-1)).toBe("Scrittura bloccata: 1 problemi");
    expect(lines.at(-2)).toBe("Riepilogo: 1 ok, 1 avvisi, 1 blocchi");
    expect(text.indexOf("BLOCCO")).toBeLessThan(text.indexOf("AVVISO"));
    expect(text.indexOf("AVVISO")).toBeLessThan(text.indexOf("INFO"));
    expect(text.indexOf("INFO")).toBeLessThan(text.indexOf("OK  "));
    expect(text).toContain("  GRANT SELECT, INSERT, UPDATE, DELETE ON `osticket`.* TO '<utente>'@'<host>';");
    expect(sortChecks(checks).map((c) => c.id)).toEqual(["db_grants", "plugins", "write_mode", "schema"]);
    expect(text).toMatch(/^[\x20-\x7e\nÀ-ÿ]*$/u);
  });

  it("senza blocchi: scrittura consentita", () => {
    const ok = checks.filter((c) => c.level !== "block");
    expect(verdictLine({ summary: summarize(ok) })).toBe("Scrittura consentita");
    expect(
      formatReportText({ checks: ok, summary: summarize(ok) })
        .trimEnd()
        .endsWith("Scrittura consentita"),
    ).toBe(true);
  });

  it("a capo sulle parole", () => {
    expect(wrapText("uno due tre quattro", 8)).toEqual(["uno due", "tre", "quattro"]);
    expect(wrapText("riga1\nriga2", 80)).toEqual(["riga1", "riga2"]);
  });
});
