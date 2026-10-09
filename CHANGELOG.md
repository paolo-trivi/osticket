# Changelog

Formato ispirato a [Keep a Changelog](https://keepachangelog.com/it/1.1.0/). Versioni secondo [SemVer](https://semver.org/lang/it/).

## [Non rilasciato]

### Aggiunto
- **Fork strutturato**:
  - codice osTicket in `legacy/` (storia git preservata);
  - nuova app in `apps/web/`;
  - stack di deploy in `deploy/`;
  - documentazione in `docs/`.
- **Brand TailTicket**: nome, logo, icone, colore primario indaco, tagline; i loghi caricati in osTicket restano utilizzabili.
- **Deploy in un comando** (`deploy/tailticket up`): MariaDB, osTicket classico con cron, TailTicket, Caddy con HTTPS automatico. In più: modalità "attach" verso un osTicket esistente, backup/restore, aggiornamenti.
- **Protezione dello schema**: TailTicket scrive solo su schemi osTicket verificati e passa in sola lettura sugli altri. Un test in CI segnala gli aggiornamenti upstream che cambiano lo schema.
- **Documentazione del progetto**: filosofia, scope, compatibilità, architettura, sviluppo, aggiornamenti da upstream, roadmap.

## [0.1.0] — 2026-10-09

Prima versione completa della nuova interfaccia, sullo stesso database di osTicket 1.18.4:
- pannello agenti, area admin, portale clienti;
- 308 scenari differenziali PHP vs TypeScript, tutti identici;
- CI con qualità del codice e test differenziali.

Dettaglio per milestone: [apps/web/RESTART.md](apps/web/RESTART.md).
