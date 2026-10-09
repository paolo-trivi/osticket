# Filosofia di TailTicket

TailTicket nasce da una constatazione semplice: **osTicket funziona, ma non lo si vede più**. Il motore regge da anni, mentre l'interfaccia ha smesso di invecchiare bene.

Questo documento spiega i principi con cui prendiamo le decisioni. Quando una scelta è in dubbio, vale ciò che è scritto qui.

## 1. Rispetto per ciò che funziona

osTicket contiene vent'anni di decisioni su casi reali: thread email, SLA con orari e festività, collaboratori, merge di ticket, filtri, permessi. Molte sembrano stranezze e sono in realtà risposte a problemi veri.

- Non riscriviamo il comportamento: lo **portiamo**. Ogni scrittura riproduce esattamente le righe che scriverebbe il PHP.
- Le stranezze innocue si **replicano e si annotano** nel codice, così un ticket gestito da TailTicket è indistinguibile da uno gestito dal pannello classico.
- Le eccezioni sono i difetti di **sicurezza o permessi**: non si replicano mai. Si applica la regola più stretta e la differenza si documenta (doc 14 e doc 17 §3).

## 2. Il database è un contratto

Il database di osTicket è il punto d'incontro tra il vecchio e il nuovo, e chi ha osTicket in produzione ha lì i propri dati. Per questo:

- **Nessun DDL**: TailTicket non crea tabelle, non aggiunge colonne, non migra nulla. La sua configurazione vive in righe `config` con namespace `nextui.*`.
- **Stesse righe, stesse email**: lo dimostrano i test differenziali, non le buone intenzioni.
- **Schema verificato o sola lettura**: se un aggiornamento di osTicket cambia lo schema, TailTicket smette di scrivere finché la nuova versione non è verificata ([compatibility.md](compatibility.md)).

## 3. Coesistenza, non sostituzione forzata

TailTicket e il pannello classico possono girare **insieme sugli stessi dati**. È una scelta deliberata:

- si adotta gradualmente: prima gli agenti, poi l'admin, poi il portale, oppure in qualsiasi ordine;
- si torna indietro senza migrazioni: basta spegnere TailTicket;
- ciò che TailTicket non fa resta a osTicket: cron, fetch delle email, API REST, plugin PHP.

## 4. Moderno dove conta

L'obiettivo non è la moda, ma l'esperienza quotidiana di agenti e clienti:

- **responsive davvero**: un agente deve poter rispondere da telefono e un cliente aprire un ticket dal suo smartphone;
- **veloce e chiaro**: interfaccia React con componenti coerenti, tema chiaro/scuro, italiano e inglese;
- **brandizzabile** dall'area admin: colori, logo, nome e font, senza toccare codice;
- **sicuro per default**:
  - CSP con nonce;
  - cookie `Secure`;
  - permessi ricontrollati a ogni azione sul server;
  - i bug di sicurezza noti di osTicket non replicati.

## 5. Facile da mettere in produzione

Un helpdesk è utile solo se è acceso. TailTicket si installa con **un comando** (Docker Compose) e si collega in modo altrettanto semplice a un osTicket esistente. Backup, aggiornamenti e HTTPS fanno parte del pacchetto, non sono lasciati al lettore.

## 6. Verificabile e documentato

- Ogni comportamento è documentato nella knowledge base (`docs/reverse-engineering/`, doc 00–17) prima di essere implementato.
- Ogni scrittura ha almeno uno scenario differenziale verde in CI.
- Le differenze volute rispetto a osTicket sono elencate, mai implicite.

## 7. Aperto e onesto

TailTicket è software libero come osTicket (GPL v2), ne riconosce apertamente l'origine e non usa il marchio osTicket come proprio. I limiti noti stanno in [scope.md](scope.md), non nascosti in fondo a una issue.
