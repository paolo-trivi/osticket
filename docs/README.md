# Documentazione di TailTicket

## Il progetto
- [Presentazione](index.html): la pagina pubblica del progetto. È statica e si pubblica con GitHub Pages da `docs/` (Settings → Pages → branch `main`, cartella `/docs`): https://paolo-trivi.github.io/TailTicket/.
- [Filosofia](philosophy.md): i principi con cui prendiamo le decisioni.
- [Scope](scope.md): cosa TailTicket è e non è, funzioni, limiti noti.
- [Roadmap](roadmap.md): fatto e prossimi passi.
- [Brand](brand/README.md): nome, logo, colori, regole d'uso.

## Usarlo
- [Deploy](../deploy/README.md): stack completo in un comando, HTTPS, email, backup, aggiornamenti, collegamento a un osTicket esistente.
- [Compatibilità con osTicket](compatibility.md): promessa sul database, test differenziali, versioni supportate.

## Svilupparlo
- [Architettura](architecture.md): componenti, struttura del repo, flusso di una scrittura, sicurezza.
- [Sviluppo](development.md): ambiente locale, verifiche, come aggiungere una scrittura.
- [Aggiornare da osTicket upstream](upstream-sync.md): merge in `legacy/`, schema, verifica.
- [Contribuire](../CONTRIBUTING.md) · [Sicurezza](../SECURITY.md) · [Changelog](../CHANGELOG.md).

## Knowledge base di osTicket
L'analisi completa di osTicket 1.18.4 da cui nasce TailTicket. Si parte da [reverse-engineering/00-INDICE.md](reverse-engineering/00-INDICE.md):
- architettura, database, ORM ed eventi;
- ticket, thread ed email, form, task e KB;
- code e ricerca, utenti e permessi, API, frontend;
- impostazioni e sicurezza;
- il **contratto di scrittura** (doc 17), cioè le righe che ogni operazione scrive nel DB.
