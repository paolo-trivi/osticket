import { describe, expect, it } from "vitest";

import { InstallConfigError, parseOstConfigPhp, resolveInstallConfig } from "@/server/env";

const PHP = `<?php
define('OSTINSTALLED',TRUE);
define('SECRET_SALT','salt\\'s');
define('ADMIN_EMAIL','admin@example.com');
define('DBTYPE','mysql');
define('DBHOST','db.local:3307');
define("DBNAME", "osticket");
define("DBUSER", "ost");
define("DBPASS", "p\\"w\\$x");
define('TABLE_PREFIX','ost_');
`;

const read =
  (src = PHP) =>
  (path: string) => {
    if (path !== "/etc/ost-config.php") throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return src;
  };
const withFile = (env: Record<string, string> = {}, src?: string) => resolveInstallConfig({ OST_CONFIG_PATH: "/etc/ost-config.php", ...env }, read(src));

describe("configurazione di installazione da una sola fonte", () => {
  it("legge le define con apici singoli e virgolette doppie", () => {
    const d = parseOstConfigPhp(PHP);
    expect(d).toMatchObject({
      SECRET_SALT: "salt's",
      DBNAME: "osticket",
      DBUSER: "ost",
      DBPASS: 'p"w$x',
      DBHOST: "db.local:3307",
    });
  });

  it("con OST_CONFIG_PATH il file è la fonte", () => {
    expect(withFile()).toEqual({
      dbHost: "db.local",
      dbPort: 3307,
      dbName: "osticket",
      dbUser: "ost",
      dbPass: 'p"w$x',
      tablePrefix: "ost_",
      secretSalt: "salt's",
      adminEmail: "admin@example.com",
      connectionOverrides: [],
    });
  });

  it("variabili uguali al file (o vuote) sono ammesse", () => {
    expect(
      withFile({
        OST_DB_NAME: "osticket",
        OST_DB_HOST: "db.local",
        OST_DB_PORT: "3307",
        OST_SECRET_SALT: "salt's",
        OST_DB_PASS: "",
      }).dbName,
    ).toBe("osticket");
  });

  it("variabili diverse dal file bloccano l'avvio, con le chiavi ma senza i valori", () => {
    let err: unknown;
    try {
      withFile({
        OST_DB_NAME: "altro",
        OST_SECRET_SALT: "segreto-diverso",
        OST_TABLE_PREFIX: "xx_",
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InstallConfigError);
    const msg = (err as Error).message;
    expect(msg).toContain("OST_DB_NAME");
    expect(msg).toContain("OST_SECRET_SALT");
    expect(msg).toContain("OST_TABLE_PREFIX");
    expect(msg).not.toContain("altro");
    expect(msg).not.toContain("segreto-diverso");
    expect(msg).not.toContain("salt's");
  });

  it("OST_CONFIG_OVERRIDE: la variabile indicata vince sul file (sviluppo e test)", () => {
    expect(
      withFile({
        OST_DB_NAME: "osticket_diff_ts",
        OST_CONFIG_OVERRIDE: "OST_DB_NAME",
      }).dbName,
    ).toBe("osticket_diff_ts");
    expect(() => withFile({ OST_SECRET_SALT: "x", OST_CONFIG_OVERRIDE: "OST_DB_NAME" })).toThrow(/OST_SECRET_SALT/);
  });

  it("host, porta, utente e password possono differire dal file (utente dedicato) e restano segnalati", () => {
    const c = withFile({
      OST_DB_HOST: "host.docker.internal",
      OST_DB_PORT: "3306",
      OST_DB_USER: "tt_attach",
      OST_DB_PASS: "altra",
    });
    expect(c).toMatchObject({
      dbHost: "host.docker.internal",
      dbPort: 3306,
      dbUser: "tt_attach",
      dbPass: "altra",
      dbName: "osticket",
    });
    expect(c.connectionOverrides.sort()).toEqual(["OST_DB_HOST", "OST_DB_PASS", "OST_DB_PORT", "OST_DB_USER"]);
    // DBHOST socket nel file: ammesso se la connessione arriva da OST_DB_HOST
    expect(withFile({ OST_DB_HOST: "10.0.0.5:3306" }, PHP.replace("db.local:3307", "localhost:/var/run/mysqld/mysqld.sock")).dbHost).toBe("10.0.0.5");
  });

  it("senza OST_CONFIG_PATH valgono le variabili d'ambiente", () => {
    const c = resolveInstallConfig({
      OST_DB_HOST: "localhost",
      OST_DB_NAME: "n",
      OST_DB_USER: "u",
      OST_SECRET_SALT: "s",
    });
    expect(c).toMatchObject({
      dbHost: "127.0.0.1",
      dbPort: 3306,
      dbName: "n",
      tablePrefix: "ost_",
    });
  });

  it("socket Unix e file non leggibile: errore chiaro", () => {
    expect(() => withFile({}, PHP.replace("db.local:3307", "localhost:/var/run/mysqld/mysqld.sock"))).toThrow(/socket/);
    expect(() =>
      resolveInstallConfig({
        OST_DB_HOST: "/tmp/mysql.sock",
        OST_DB_NAME: "n",
        OST_DB_USER: "u",
        OST_SECRET_SALT: "s",
      }),
    ).toThrow(/socket/);
    expect(() => resolveInstallConfig({ OST_CONFIG_PATH: "/manca.php" }, read())).toThrow(/non leggibile/);
  });
});
