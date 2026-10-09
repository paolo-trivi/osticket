# Aggiornare da osTicket upstream

TailTicket segue lo sviluppo di [osTicket](https://github.com/osTicket/osTicket). Il codice osTicket vive in `legacy/` con la storia git originale, quindi gli aggiornamenti upstream si importano con un merge.

Base attuale: osTicket **v1.18.4**, commit `8d38b06` del branch `develop` upstream.

## 1. Importare il codice

```bash
git remote add upstream https://github.com/osTicket/osTicket.git   # una volta sola
git fetch upstream
git checkout -b sync/osticket-<versione> main
git merge -X subtree=legacy upstream/develop     # oppure un tag: upstream/v1.18.5
```

`-X subtree=legacy` dice a git che la radice di upstream corrisponde a `legacy/` nel fork:
- le modifiche ai file esistenti vengono applicate;
- i **file nuovi** di upstream finiscono in `legacy/`.

La procedura è verificata simulando un commit upstream sulla nostra base.

Il branch `sync/osticket-<versione>` si apre come PR verso `main`: la CI esegue i test differenziali sul nuovo codice osTicket prima del merge.

Se ci sono conflitti, riguardano solo `legacy/`: TailTicket non modifica il codice osTicket.

## 2. Capire cosa è cambiato

```bash
git diff 8d38b06 upstream/develop --stat                 # panoramica
git diff 8d38b06 upstream/develop -- include/upgrader/   # patch di schema
git diff 8d38b06 upstream/develop -- include/class.ticket.php include/class.thread.php …
```

Cosa guardare:
- **`include/upgrader/streams/core.sig` e le nuove `*.patch.sql`**: lo schema del DB è cambiato. Vedi il punto 3.
- **`include/class.*.php`** delle aree già portate (ticket, thread, task, utenti, admin): se cambia la logica di una scrittura, il porting TypeScript va allineato.
- **Template email e variabili** (`include/i18n/en_US/templates/`): vanno controllate se cambiano le variabili disponibili.
- **Fix di sicurezza**: valutare se riguardano anche TailTicket (doc 14).

## 3. Se cambia lo schema

1. La CI fallisce sul test `schema-compat`: è voluto.
2. Aggiornare l'ambiente di sviluppo: `php legacy/manage.php upgrade` sull'istanza di sviluppo, poi rigenerare la fixture (vedi `apps/web/RESTART.md` §2).
3. Rigenerare i tipi del DB: `npm run db:codegen` (in `apps/web/`).
4. Adeguare i servizi TypeScript alle nuove colonne o tabelle, sempre replicando il PHP.
5. Eseguire **tutti** i test differenziali (`npm run test:diff`) e aggiungere scenari per i comportamenti nuovi.
6. Aggiungere la nuova firma a `VERIFIED_SCHEMAS` in `apps/web/src/server/system/schema-compat.ts` e aggiornare la tabella in [compatibility.md](compatibility.md).

Finché il punto 6 non è fatto, un TailTicket in produzione collegato a un DB aggiornato resta in **sola lettura**: è il comportamento sicuro.

## 4. Se cambia solo la logica

Allineare il porting TypeScript dell'area interessata. I file sono indicati nei contratti `apps/web/docs/contract/<area>.md`. Poi:

```bash
cd apps/web
npm run lint && npm run typecheck && npm test && npm run test:diff && npx next build
npm run docs:contracts      # se è cambiato un contratto
```

## 5. Rilascio

- Aggiornare `CHANGELOG.md` con la versione di osTicket importata.
- Aggiornare la "Baseline analizzata" in `docs/reverse-engineering/00-INDICE.md`.
- In produzione: backup, aggiornamento delle immagini (`./tailticket update`, che esegue anche `manage.php upgrade`), verifica.
