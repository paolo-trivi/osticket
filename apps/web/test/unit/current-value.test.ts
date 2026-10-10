import { describe, expect, it } from "vitest";

import { isKnownOrCurrent, withCurrentOption } from "@/lib/admin/current-value";
import { accountUnchanged, isUnsupportedAuth } from "@/server/domain/adminsys/email-account";

const label = (v: string) => `${v} (attuale)`;

describe("withCurrentOption: il valore attuale sconosciuto resta tra le opzioni", () => {
  const opts = [{ value: "D", label: "Database" }];

  it("valori noti: elenco invariato", () => {
    expect(withCurrentOption(opts, "D", label)).toBe(opts);
  });

  it("valore vuoto o assente: elenco invariato", () => {
    expect(withCurrentOption(opts, "", label)).toBe(opts);
    expect(withCurrentOption(opts, null, label)).toBe(opts);
    expect(withCurrentOption(opts, undefined, label)).toBe(opts);
  });

  it("valore sconosciuto (es. backend F di un plugin): aggiunto in fondo con l'etichetta", () => {
    expect(withCurrentOption(opts, "F", label)).toEqual([...opts, { value: "F", label: "F (attuale)" }]);
  });
});

describe("isKnownOrCurrent: validazione che preserva il valore attuale", () => {
  it("valori noti sempre ammessi", () => {
    expect(isKnownOrCurrent("D", ["D"], "F")).toBe(true);
    expect(isKnownOrCurrent("D", ["D"], null)).toBe(true);
  });

  it("valore attuale sconosciuto ammesso solo se invariato", () => {
    expect(isKnownOrCurrent("F", ["D"], "F")).toBe(true);
    expect(isKnownOrCurrent("S", ["D"], "F")).toBe(false);
    expect(isKnownOrCurrent("F", ["D"], null)).toBe(false);
  });

  it("il valore vuoto non è un valore attuale", () => {
    expect(isKnownOrCurrent("", ["D"], "")).toBe(false);
  });
});

describe("account email con autenticazione non gestita", () => {
  it("isUnsupportedAuth: OAuth2 e tipi dei plugin", () => {
    expect(isUnsupportedAuth("oauth2:google")).toBe(true);
    expect(isUnsupportedAuth("oauth2:msauth:abc")).toBe(true);
    expect(isUnsupportedAuth("xyz")).toBe(true);
    for (const known of ["basic", "none", "mailbox", "Basic", "", null]) expect(isUnsupportedAuth(known)).toBe(false);
  });

  const mailbox = {
    active: 1,
    host: "imap.example.net",
    port: 993,
    protocol: "IMAP",
    auth_bk: "oauth2:google",
    folder: null,
    fetchfreq: 5,
    fetchmax: 30,
    postfetch: "nothing",
    archivefolder: null,
  };
  const form = {
    mailbox_active: "1",
    mailbox_host: "imap.example.net",
    mailbox_port: "993",
    mailbox_protocol: "IMAP",
    mailbox_auth_bk: "oauth2:google",
    mailbox_folder: "",
    mailbox_fetchfreq: "5",
    mailbox_fetchmax: "30",
    mailbox_postfetch: "nothing",
    mailbox_archivefolder: "",
  };

  it("accountUnchanged: form con i valori salvati (null = vuoto)", () => {
    expect(accountUnchanged("mailbox", mailbox, form)).toBe(true);
  });

  it("accountUnchanged: un campo modificato o l'autenticazione cambiata", () => {
    expect(
      accountUnchanged("mailbox", mailbox, {
        ...form,
        mailbox_host: "altro.example.net",
      }),
    ).toBe(false);
    expect(
      accountUnchanged("mailbox", mailbox, {
        ...form,
        mailbox_auth_bk: "basic",
      }),
    ).toBe(false);
    expect(accountUnchanged("mailbox", mailbox, { ...form, mailbox_active: "0" })).toBe(false);
  });

  it("accountUnchanged SMTP: porta 0 = vuota, casella di spunta assente = 0, protocollo fisso", () => {
    const smtp = {
      active: 0,
      host: "smtp.example.net",
      port: 0,
      protocol: "SMTP",
      auth_bk: "oauth2:msauth",
      allow_spoofing: 0,
    };
    expect(
      accountUnchanged("smtp", smtp, {
        smtp_active: "0",
        smtp_host: "smtp.example.net",
        smtp_port: "",
        smtp_auth_bk: "oauth2:msauth",
      }),
    ).toBe(true);
    expect(
      accountUnchanged("smtp", smtp, {
        smtp_active: "0",
        smtp_host: "smtp.example.net",
        smtp_port: "",
        smtp_auth_bk: "oauth2:msauth",
        smtp_allow_spoofing: "1",
      }),
    ).toBe(false);
  });
});
