# Roadmap

Lo stato dettagliato per milestone è in [apps/web/RESTART.md](../apps/web/RESTART.md).

## Fatto (v1.0)

- [x] **Fondamenta**:
  - DB condiviso senza DDL;
  - login agenti;
  - harness differenziale PHP vs TypeScript;
  - tema configurabile.
- [x] **Pannello agenti** completo: code, ticket, azioni, creazione, massa, export, task, utenti, organizzazioni, profilo, 2FA.
- [x] **Portale clienti** completo.
- [x] **Area amministrazione**: impostazioni, oggetti, email, template, filtri, form, liste, pagine, API, log, plugin.
- [x] **Compatibilità**: 351 scenari differenziali in CI; sola lettura su schemi osTicket non verificati.
- [x] **Board Kanban, statistiche, knowledge base** e profili con permessi effettivi.
- [x] **Qualità del codice**: refactoring YAGNI/SSOT/SRP, knip in CI, audit di sicurezza e collaudo E2E prima della release.
- [x] **Fork strutturato**: `legacy/` e `apps/web/`, brand TailTicket, documentazione, deploy Docker in un comando.

## Prossimi passi

### Completezza
- [ ] Creazione e modifica delle code (criteri, colonne, ordinamenti).
- [ ] Configurazione dei singoli campi dei form e proprietà avanzate delle liste.
- [ ] "Gestisci form" del ticket, "modifica e reinvia", stampa PDF.
- [ ] Risposte predefinite nel form di apertura; apertura di un ticket da una voce di thread.
- [ ] Captcha del portale.
- [ ] Caricamento dei loghi dall'area admin.

### Scalabilità e operatività
- [ ] Stato condiviso (codici 2FA, tentativi falliti) fuori dalla memoria, per più istanze, sempre senza DDL: righe `config` `nextui.*` o uno store esterno opzionale.
- [ ] Endpoint di health e metriche.
- [x] Rilasci versionati su GHCR (`v1.0.0`).
- [ ] Immagini firmate.

### Ecosistema osTicket
- [ ] Verifica e supporto delle prossime versioni 1.18.x e 1.19 di osTicket ([upstream-sync.md](upstream-sync.md)).
- [ ] OAuth2 per gli account email.
- [ ] Altre lingue oltre a italiano e inglese.

### Esplorazioni
- [ ] Deploy su piattaforme serverless (es. Cloudflare Workers + Hyperdrive). Richiede connessione al DB per richiesta e stato condiviso esterno.
