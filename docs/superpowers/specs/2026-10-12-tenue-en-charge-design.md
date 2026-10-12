# Lot 14 : la tenue en charge, avant l'ouverture du site

Lot 14 de « Messaging Me pour Claude Code » (plan privé ; périmètre posé par la spec des offres, § 10). Décisions de
Julien du 2026-10-12, en deux rondes de questions.

## Ce qu'on veut

Ouvrir le site (le tunnel de la Base, lot 19) sans qu'une centaine d'espaces actifs, ni un seul espace qui s'emballe, ne
ralentissent la réception des messages des clients ou ne coupent l'API pour tous. Savoir ce que tient une copie de
l'API, et être prévenu AVANT que ça casse.

## Les décisions

| Sujet | Décision |
| --- | --- |
| Cible | Une centaine d'espaces actifs |
| Mesure | Sur une copie jetable sur le VPS (Postgres jetable et copie de l'API, à une heure creuse, retirés après) |
| Saturation | Free d'abord : les espaces Free reçoivent le 429 en premier, Pro et Entreprise gardent une part |
| Plafond Vercel | Lecture de la consommation de l'équipe, Telegram à 80 % puis 95 %, jauge dans `/ops` ; Julien relève lui-même |
| Alertes Telegram | File en retard, réception de Meta lente, plafond global atteint, base saturée |
| Cloudflare | Non : le plafond vit dans l'API (Cloudflare Pro reste dans `todo.md`) |
| Si une copie ne tient pas | Julien décide sur la mesure : ce qui sature en premier et le coût de chaque remède, rien acheté sans lui |

## Ce qui existe, inventorié le 2026-10-12

- **Les plafonds sont PAR ESPACE** : 60 appels par minute et 1 000 par heure (`/v1` et `/mcp` confondus), 2 000 envois et
  20 000 fiches par jour, comptés dans `compteurs_debit`, partagés entre copies. **Aucun plafond ne compte tous les
  espaces ensemble.** Cent espaces à leur plafond font 100 appels par seconde.
- **Un seul pool de 10 connexions par copie d'API** sert tout : la réception de Meta (une requête par webhook,
  l'enfilement pg-boss), `/v1`, `/mcp`, la console, les liens tracés. Une rafale sur l'API fait attendre la réception des
  messages des clients. Aucune durée limite de requête (`statement_timeout`) sur ce pool. Le budget du pooler Supabase
  (base Micro, 30 connexions) est tenu par `tests/budget-pooler.test.ts`.
- **La purge des conversations plafonne à 2 000 par jour** (500 par passe, toutes les 6 h) : au-delà, le retard grossit
  sans fin, et la conservation de 30 jours de la Base n'est plus tenue.
- **Les alertes existantes** : file d'échec qui grossit, webhooks reçus sans événement enregistré, worker silencieux.
  **Rien** sur l'âge d'une file vivante, la latence de la réception de Meta ou l'attente du pool ; les mesures existent
  pourtant en base (`http_latences`, `pool_attentes`, l'âge des files lu par `/ops`).
- **Aucune lecture de la consommation de l'équipe chez Vercel** : le plafond de 100 $ par mois coupe les bots de tous les
  clients d'un coup, sans prévenir.
- **Aucune mesure de `/v1` ni de `/mcp`.** Les bancs existants (`scripts/banc-*.mts`) mesurent la réception et les
  campagnes. L'usage réel est minuscule (6 appels de l'API publique en deux heures, le 2026-10-04).

## Livraison A : les protections

1. **Le plafond global de `/v1` et `/mcp`.** Un compteur partagé (`compteurs_debit`) par fenêtre de 10 secondes, toutes
   clés, tous jetons OAuth et tous espaces confondus, pris APRÈS le plafond de l'espace. Deux seuils : au-delà de la part
   Free (50 % du plafond par défaut), un espace Free reçoit 429 ; au-delà du plafond, tout le monde. Le code reste
   `rate_limited`, avec `Retry-After` jusqu'à la fin de la fenêtre et une phrase qui dit que la plateforme est saturée
   (le geste de l'intégrateur est le même : attendre). L'offre se lit dans le cache existant (`OffresEnCache`). Base
   muette : l'appel passe, comme pour le plafond de l'espace. Valeurs par variables d'environnement (le plafond, la part
   Free), **le plafond à 0 (éteint) jusqu'à la mesure de B**. Jamais sur `/webhooks/meta` ni sur la console.
2. **Une part du pool réservée à la réception de Meta.** Un petit pool dédié (2 connexions) pour l'enfilement des
   webhooks de Meta dans l'API : la réception n'attend plus jamais `/v1`, `/mcp` ni la console. Le budget du pooler suit
   (21 connexions applicatives, 23 avec ce pool, sous les 30), tenu par son test.
3. **La purge des conversations sans plafond journalier.** Toutes les heures, par lots de 500 jusqu'à épuisement ou à
   un budget de temps par passe ; l'ordre « agrégats d'abord, purge ensuite » ne bouge pas.
4. **La veille de charge** (worker principal, chaque minute), une alerte Telegram par clé au plus toutes les 30 minutes :
   - **file en retard** : le plus vieux job prêt attend depuis plus de 60 s sur `webhook` et `webhook-status`, plus de
     5 min ailleurs ;
   - **réception de Meta lente** : p95 de `POST /webhooks/meta` au-dessus de 2 s sur une fenêtre de 5 min d'au moins 20
     requêtes (`http_latences`) ;
   - **base saturée** : attente d'une connexion au-dessus de 200 ms en p95 sur une minute, par processus (`pool_attentes`) ;
   - **plafond global atteint** : au moins un refus dans la minute, avec le nombre de refus Free et payants.
5. **Le plafond Vercel.** Lecture horaire de la consommation de l'équipe sur la passerelle d'IA (le point d'API et sa
   réponse se lisent dans la documentation de Vercel avant d'écrire une ligne, puis `safeParse`), Telegram à 80 % puis à
   95 %, une fois par seuil et par mois, et la jauge dans `/ops`.

## Livraison B : la mesure

- **Le banc** (`scripts/banc-api.mts`, sur le modèle des bancs existants et de leurs garde-fous : `BANC_CONFIRME=1`,
  refus d'une adresse Supabase, `DRY_RUN`) : il sème 100 espaces, chacun avec sa clé et quelques fiches, puis envoie un
  trafic mêlé (lecture des fils, écriture de fiches, envois, appels MCP) par paliers croissants de débit global, tout en
  envoyant des webhooks de Meta signés à débit fixe. Il relève le p95 et les erreurs par famille, la latence de la
  réception de Meta, l'attente du pool, l'âge des files et le processeur du conteneur.
- **La copie** : un Postgres jetable, une copie de l'API et le worker principal, construits depuis `main`, sur le VPS, à
  une heure creuse, lancés par une commande donnée à Julien (son accord à ce moment-là), retirés après. ⚠️ La base est
  locale (pas les 10 ms jusqu'à Londres) : la mesure est optimiste, d'où la marge ci-dessous.
- **Le verdict** : la capacité C est le débit où le p95 de `/v1` dépasse 1 s, où un 5xx apparaît, ou où la réception de
  Meta dépasse 2 s. Le plafond global se pose à 70 % de C (variable d'environnement, sans code), la part Free à 50 %.
  L'hypothèse à couvrir : 100 espaces actifs à 10 appels par minute en moyenne, pics à trois fois plus, soit environ
  50 appels par seconde. Si C ne la couvre pas, Julien reçoit ce qui sature en premier (la base, le processeur, le pool)
  et le coût de chaque remède.
- **Ce que la mesure recalibre, s'il le faut** : la file des statuts (`webhook-status`, une seule à la fois, réveil toutes
  les 30 s), la relecture de la note de qualité du numéro, l'équité de l'analyse entre espaces. Rien n'est changé sans
  un chiffre qui le demande.

## Hors périmètre, noté dans `todo.md`

- La durée limite des requêtes (`statement_timeout`) : à juger sur la mesure, le pooler en mode transaction ne prend pas
  tous les paramètres de session.
- Cloudflare Pro et ses règles de limitation (décision du 2026-10-12).
- Le téléchargement des médias reçus sans borne de concurrence (`todo.md`).
- Une seconde copie de l'API, une base plus grosse : sur la mesure, par décision de Julien.

## L'essai réel qui clôt le lot

Le banc lui-même sur la copie jetable (ses chiffres, et le plafond global qui refuse Free d'abord pour de vrai), plus,
en production, une alerte Telegram de chaque sorte reçue au moins une fois : provoquée sur la copie pour la file, la
réception et la base, et lue chez Vercel pour la jauge.
