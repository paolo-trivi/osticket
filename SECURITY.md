# Sicurezza

## Segnalare una vulnerabilità
Non aprire issue pubbliche per problemi di sicurezza. Usa le **GitHub Security Advisories** del repository ("Report a vulnerability") oppure scrivi in privato ai maintainer.

Indica:
- versione o commit;
- componente (TailTicket in `apps/web/` oppure osTicket in `legacy/`);
- passi per riprodurre e impatto.

Rispondiamo entro 7 giorni.

## Ambito
- **TailTicket (`apps/web/`, `deploy/`)**: gestito qui.
- **osTicket (`legacy/`)**: se il problema esiste anche in osTicket originale, va segnalato anche al progetto upstream secondo la loro policy ([legacy/SECURITY.md](legacy/SECURITY.md)). Integreremo la correzione con un aggiornamento da upstream ([docs/upstream-sync.md](docs/upstream-sync.md)).

## Principi
- I difetti di sicurezza e permessi noti di osTicket **non** sono replicati in TailTicket. Sono elencati nel doc 14 e nel doc 17 §3 della knowledge base.
- Ogni server action ricontrolla sessione e permessi.
- Il deploy di riferimento espone solo il reverse proxy, richiede HTTPS fuori da localhost e genera segreti casuali per ogni installazione.
