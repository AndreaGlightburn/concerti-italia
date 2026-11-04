# Concerti Italia — versione server (GitHub)

Motore di ricerca e confronto dei concerti in Italia. Funziona interamente su GitHub, senza server da gestire e senza database:

- **GitHub Actions** fa da server. Ogni 6 ore legge le fonti, unisce le date uguali, confronta i prezzi tra i rivenditori e invia gli avvisi per gli artisti preferiti.
- **GitHub Pages** pubblica la PWA, installabile sul telefono, che legge i dati già pronti.
- Le chiavi API restano nei *secrets* del repository e non arrivano mai al browser.
- Nessun dato personale viene salvato: niente account, agenda o preferenze nel browser. L'unico stato è il file `data/events.json`, che serve a riconoscere le date nuove.

## Fonti

| Fonte | Come viene letta | Serve |
|---|---|---|
| Ticketmaster | API ufficiale Discovery | secret `TM_KEY` (gratuita) |
| TicketOne | API pubblica di ricerca Eventim (non documentata) | niente |
| Vivaticket | dati strutturati schema.org delle pagine indicate in `config.json` | niente |
| Siti di locali e festival | dati strutturati schema.org delle pagine indicate in `config.json` | niente |
| Bandsintown | API per artista, solo per gli artisti preferiti | secret `BIT_APP_ID` (facoltativo) |

Ogni fonte è indipendente: se una non risponde le altre continuano a funzionare. La scheda **Fonti** dell'app e il riepilogo di ogni esecuzione in Actions mostrano quali fonti hanno funzionato. Lettura di TicketOne, Vivaticket e siti può interrompersi se i siti cambiano struttura o bloccano le richieste automatiche.

## Installazione (una volta)

1. **Crea il repository** su GitHub e carica tutti i file di questa cartella, inclusa `.github/`. Il repository deve essere **pubblico** per usare GitHub Pages con un account gratuito.
2. **Chiave Ticketmaster**: registrati su <https://developer.ticketmaster.com/>, apri *My Apps* e copia la *Consumer Key*.
3. **Secrets**: in *Settings → Secrets and variables → Actions → New repository secret* aggiungi:
   - `TM_KEY`: la Consumer Key di Ticketmaster (obbligatoria)
   - `BIT_APP_ID`: l'app_id di Bandsintown (facoltativo)
   - `NTFY_TOPIC`: un nome lungo e difficile da indovinare, per esempio `concerti-andrea-7f3k9q`, per ricevere gli avvisi sul telefono (facoltativo)
   - `TELEGRAM_BOT_TOKEN` e `TELEGRAM_CHAT_ID`: per ricevere gli avvisi su Telegram (facoltativi)
4. **Pages**: in *Settings → Pages → Build and deployment → Source* scegli **GitHub Actions**.
5. **Primo avvio**: in *Actions → Aggiorna concerti → Run workflow*. Dopo qualche minuto l'app è su `https://<utente>.github.io/<repository>/`.

## Uso quotidiano

- **Artisti preferiti**: modifica `config/artisti.txt` direttamente da GitHub, anche dal telefono. Ogni modifica avvia subito un aggiornamento.
- **Casa, raggio, fonti, pagine di locali e festival**: modifica `config/config.json`.
- **Avvisi**: installa l'app *ntfy* (Android/iOS) e iscriviti al tuo `NTFY_TOPIC`. Arriva una notifica quando un artista preferito annuncia una data in Italia. Il primo avvio non manda avvisi: registra solo la situazione di partenza.
- **Ricerca condivisibile**: i filtri finiscono nell'indirizzo della pagina (`?q=vasco&citta=Milano&r=50`), quindi una ricerca si può salvare tra i preferiti del browser o inviare a qualcuno.

## Aggiungere locali e festival

In `config.json`, sotto `siti.pagine`, aggiungi le pagine "programma" o "eventi" dei locali. Funzionano le pagine che pubblicano i dati in formato schema.org `Event` o `MusicEvent`, cosa che molti siti fanno per Google. Se la pagina contiene solo un elenco di link, lo script apre fino a `maxDettagli` pagine evento. Per capire se una pagina funziona, guarda il risultato nella scheda Fonti dopo il primo aggiornamento.

## Limiti

- Ticketmaster: 5000 richieste al giorno. Un aggiornamento completo ne usa in genere 20–60.
- I prezzi sono il minimo e il massimo pubblicati dai rivenditori, commissioni escluse. Per gli eventi senza prezzo nell'elenco, lo script legge la pagina evento solo dove serve al confronto, al massimo `prezziMax` pagine per esecuzione.
- I dati si aggiornano ogni 6 ore. Per un aggiornamento immediato usa *Run workflow*.

## Struttura

```
index.html              PWA (ricerca, mappa, confronto, preferiti, fonti)
sw.js, manifest.webmanifest, icon.svg
scripts/aggiorna.mjs    "server": fonti, fusione, prezzi, avvisi (Node 20, senza dipendenze)
config/config.json      casa, fonti, pagine da leggere
config/artisti.txt      artisti preferiti
data/                   generata automaticamente (non modificare)
.github/workflows/aggiorna.yml
```

Prova in locale: `TM_KEY=xxx node scripts/aggiorna.mjs && npx serve .`
