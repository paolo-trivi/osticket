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

## Modello di minaccia
- **Utenti non autenticati** (internet): portale clienti, login, reset della password, apertura di ticket come ospite, upload degli allegati quando gli ospiti possono aprire ticket. Difese: blocco dei tentativi falliti per IP, stesso messaggio per utente sconosciuto e token errato nel login con token di reset, stesso costo di bcrypt per utenti esistenti e no nel login con password, corpo degli upload limitato a `max_file_size` prima della lettura, help topic limitati a quelli pubblici, redirect dopo il login solo verso percorsi interni.
- **Contenuto non fidato nei ticket** (email in arrivo, messaggi dei clienti): HTML sanificato in scrittura e in lettura, niente script né posizionamenti CSS (nemmeno offuscati), CSP con nonce, il corpo dei messaggi non può disegnare fuori dal proprio riquadro.
- **Agenti e clienti autenticati**: ogni server action e route handler ricontrolla sessione e permessi sul singolo oggetto (anche nelle azioni di massa). Con il cambio password obbligatorio (impostato dall'amministratore o dal login con il token di reset) sono raggiungibili solo il profilo e il logout.
- **Cookie di sessione rubati**: `httpOnly`, `Secure`, `SameSite=Lax`; revocati al logout sul server, invalidati dal cambio password, durata massima assoluta di 12 ore dal login anche con il timeout di inattività disattivato; binding all'IP opzionale (`staff_ip_binding`).
- **Fuori dal modello**: chi controlla il server, il database o `APP_SESSION_SECRET` (può firmare sessioni di chiunque). La app rifiuta all'avvio un `APP_SESSION_SECRET` mancante, corto, di esempio (`.env.example`, `CHANGE_ME`, valori di build) o poco vario: generarlo con `openssl rand -base64 48` (`./tailticket init` lo fa da sé).

## Reverse proxy e IP del client
TailTicket va sempre dietro un reverse proxy e la sua porta non va esposta direttamente: l'IP del client (blocco dei tentativi falliti, binding IP della sessione, log, `thread_entry.ip_address`) viene dagli header che il proxy imposta.
- La app legge **`X-Real-IP`**; se manca, il valore **più a destra** di `X-Forwarded-For`, saltando `TAILTICKET_TRUSTED_PROXY_HOPS - 1` proxy fidati (default `1`: un solo proxy, come nel deploy di riferimento; `0` = header non attendibili, IP sconosciuto). I valori più a sinistra di `X-Forwarded-For` li sceglie il client e non contano mai.
- Il proxy **deve sovrascrivere** `X-Real-IP` (e `X-Forwarded-For` se usato) con l'indirizzo reale. Un proxy che inoltra un `X-Real-IP` ricevuto dal client permette di scegliersi l'IP.
- **Caddy** (deploy di riferimento): `reverse_proxy … { header_up X-Real-IP {client_ip} }`. Come ingresso pubblico non si fida degli `X-Forwarded-For` ricevuti: `TAILTICKET_TRUSTED_PROXIES` vale `127.0.0.1/32` (nessuno) e va impostato solo con i CIDR di un CDN o bilanciatore davanti a Caddy. Mai `private_ranges` quando Caddy riceve traffico da reti non fidate (LAN aziendale, gateway Docker): chiunque potrebbe scegliersi l'IP.
- **nginx** (`deploy/attach/nginx.conf.example`): `proxy_set_header X-Real-IP $remote_addr;` e `proxy_set_header X-Forwarded-For $remote_addr;`, mai `$proxy_add_x_forwarded_for`. Con un altro proxy davanti a nginx usare il modulo `realip` (`set_real_ip_from`).
- Lo stato di sicurezza (tentativi falliti, codici 2FA, sessioni revocate) è in memoria, con scadenza e tetto massimo di voci: **una sola istanza** della app.
