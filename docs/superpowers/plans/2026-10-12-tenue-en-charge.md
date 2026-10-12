# Lot 14 : la tenue en charge

Spec : `docs/superpowers/specs/2026-10-12-tenue-en-charge-design.md` (décisions de Julien du 2026-10-12). Deux
livraisons, A puis B, aucune migration (le compteur global vit dans `compteurs_debit`).

## Méthode de livraison

**A (les protections)** : implémenteur (moi, en direct) puis UNE relecture du diff, parce que A se pose sur les deux
chemins que la production emprunte le plus : chaque appel de `/v1` et `/mcp` (le plafond global) et chaque webhook de
Meta (le pool réservé). Un seuil inversé refuserait tout le monde, un pool mal câblé couperait la réception des messages
des clients. Les critères se testent (unitaires, intégration en CI), mais le budget de connexions du pooler et l'ordre
« plafond de l'espace, puis plafond global » sont des invariants invisibles.

**B (la mesure)** : en direct, parce que c'est un banc sur une copie jetable, sans effet sur la production, dont le
produit est un chiffre ; puis UNE relecture du script avant de le lancer (il sème et tire sur une base, ses garde-fous
doivent tenir).

**L'essai réel qui clôt le lot** : le banc sur la copie jetable (la capacité mesurée, et le plafond global qui refuse
Free d'abord pour de vrai), puis une alerte Telegram de chaque sorte reçue au moins une fois (provoquée sur la copie pour
la file, la réception de Meta et la base ; la jauge Vercel lue chez Vercel).

## Livraison A : les protections

1. **Le plafond global** (`src/auth/plafond-global.ts`, neuf, branché dans la garde de clé après le plafond de l'espace) :
   compteur partagé par fenêtre de 10 s, part Free, `rate_limited` et `Retry-After`, base muette laisse passer, éteint à 0.
   Variables `API_PLAFOND_GLOBAL_PAR_10S` (défaut 0) et `API_PLAFOND_GLOBAL_PART_FREE` (défaut 50). Tests : les deux seuils
   (Free refusé au-delà de la part, payant servi jusqu'au plafond, tous refusés au-delà), l'offre lue dans le cache, la
   base muette, éteint à 0, jamais sur `/webhooks/meta` ni la console, `/v1` et `/mcp` comptés ensemble (le même compteur).
2. **Le pool réservé à Meta** (`src/index.ts`, `src/queue/pgboss.ts` ou le récepteur) : un pool de 2 connexions et
   l'enfilement de la réception dessus. Tests : `tests/budget-pooler.test.ts` (23 sous 30), et un test qui sature le pool
   applicatif et montre que la réception enfile quand même.
3. **La purge des conversations** (`src/inbox/store.pg.ts`, `src/worker.ts`) : toutes les heures, lots de 500 jusqu'à
   épuisement ou au budget de temps. Tests : une boucle bornée qui s'arrête au budget, et l'intégration (CI) qui purge plus
   de 500 conversations en une passe.
4. **La veille de charge** (`src/ops/veille-charge.ts`, neuf, tâche d'une minute du worker principal) : les quatre
   alertes, leurs seuils, une par clé et par 30 min. Le plafond global compte ses refus (Free, payant) dans
   `compteurs_debit`, que la veille lit. Tests : chaque alerte part au-dessus de son seuil, se tait en dessous et pendant
   son repos.
5. **Le plafond Vercel** (`src/agent/llm/consommation-equipe.ts`, neuf ; tâche horaire ; jauge dans `/ops`) : le point
   d'API lu dans la doc de Vercel AVANT d'écrire, `safeParse` de la réponse, alerte à 80 % et 95 % une fois par seuil et
   par mois. Tests : les deux seuils, une réponse illisible (aucune alerte, journalisée), le changement de mois.
6. Relecture, jaunes simples corrigés, push, CI lue job par job, déploiement (API, deux workers, `mba-web`), cinq portes.
   Docs : `documentation.md` (les plafonds, le pool réservé, la veille), `features.md` (les limites vues de
   l'intégrateur), `todo.md` (le hors périmètre), le journal, `.env.example`.

## Livraison B : la mesure

1. **Le banc** (`scripts/banc-api.mts`) : semer 100 espaces (clé, fiches), paliers de débit global, webhooks de Meta
   signés à débit fixe, relevés (p95 et erreurs par famille, réception, pool, files, processeur). Garde-fous :
   `BANC_CONFIRME=1`, refus d'une adresse Supabase, `DRY_RUN`. Relu avant d'être lancé.
2. **La copie jetable** : la commande donnée à Julien (Postgres jetable, API et worker principal depuis `main`, ports et
   noms dédiés, sans le `.env` de production), lancée à une heure creuse, retirée après, vérifiée retirée.
3. **Le verdict** : la capacité C, le plafond global posé à 70 % de C et la part Free à 50 % dans `.env.prod` (sans code,
   `--force-recreate` de l'API), ou, si C ne couvre pas les 50 appels par seconde de l'hypothèse, le rapport à Julien
   (ce qui sature, le coût de chaque remède). Ce que la mesure désigne (file des statuts, note de qualité, équité de
   l'analyse) se recalibre dans un commit à part, avec le chiffre qui le demande.
4. Les docs : la capacité mesurée et sa date dans le journal (jamais dans le manuel), le plafond posé dans
   `documentation.md` comme une valeur de configuration, l'essai dans `docs/prive/ESSAIS-REELS.md`.
