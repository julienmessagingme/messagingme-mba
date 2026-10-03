# Le banc des trente espaces (2026-10-03)

Point 2 de ce qui reste de l'audit de performance du 2026-10-02 (le profil « inbox-30 » de son § 12, et « tuer un
worker en plein travail »), recadré par Julien : le cas réel n'est pas un gros client à 30 agents, c'est **30 espaces
avec chacun quelques conversations**. Profil retenu par Julien : par espace, 2 personnes avec l'Inbox ouverte en même
temps et une dizaine de conversations, plus un pic où les 30 espaces reçoivent des messages dans la même minute.

## Méthode de livraison

**En direct, puis UNE relecture du script**, parce que le lot n'ajoute qu'un script de banc qui ne tourne jamais
contre la production (gardes à l'entrée, base jetable) et ne touche aucun chemin de production. L'essai réel est le
banc lui-même, joué sur le VPS contre un Postgres jetable, et son rapport chiffré. Un défaut qu'il trouverait dans le
code de production fera l'objet d'un lot à part, avec sa propre relecture.

## Ce que le banc reproduit, et d'où viennent les chiffres

- **Les écrans, aux vraies cadences** (`web/app/inbox/page.tsx`, `web/components/AppShell.tsx`, `web/lib/poll.ts`) :
  par onglet, le fil ouvert toutes les 4 s (en delta, avec le curseur rendu par le serveur), la liste toutes les 15 s
  suivie des compteurs du menu, la pastille des non-lus toutes les 30 s, chaque attente à ±20 %. Un message neuf dans
  le fil ouvert déclenche « lu » puis une relecture de la pastille.
- **Les espaces naissent par le vrai code** (`db/seed.ts`, deux comptes par espace) ; les sessions sont signées avec le
  secret du banc, et la garde relit l'utilisateur en base à chaque requête, comme en production.
- **Les conversations naissent par de vrais webhooks signés** : un message entrant par conversation à la préparation,
  puis le pic.
- **Le délai réseau vers la base est celui de la production** : 10 ms d'aller-retour mesurés entre l'API de
  production et Supabase le 2026-10-03 ; le Postgres jetable reçoit ce délai (`tc netem`), sinon il répondrait
  cinquante fois plus vite et le banc conclurait trop vite que le pool tient.
- **Les tailles de pool de la production** : API 10, worker principal 8, worker d'analyse 3, pg-boss 2.

## Ce que le banc ne reproduit pas

Ses conclusions valent pour l'API et les workers, jamais pour la base. Ne sont pas reproduits : le pooler de Supabase
(Supavisor, son « Pool Size » partagé avec mm-hubspot, ses files d'attente muettes), le calcul d'une base Supabase
Micro partagée et ses tables peuplées, TLS, les accusés de campagne, les analyses, les tours d'agent, l'agent de Meta,
les automations et la traduction (des espaces sans scénario ni agent, en `DRY_RUN` : le traitement d'un entrant prend
son chemin le plus léger). Les onglets ne changent pas de conversation et sont tous administrateurs. Le script le
rappelle en tête de ses verdicts.

## Les épreuves (une par lancement)

1. `charge` : cinq minutes de sondage par 60 onglets, avec le pic des 30 espaces à la deuxième minute. Rapport : p50,
   p95 et maximum par route vus du client ET relus dans `http_latences` (la mesure livrée le jour même), attentes de
   pool, âge des tâches `webhook` (attente et bout en bout, par espace), refus éventuels.
2. `crash` : le même pic, et le worker principal tué (`docker kill`) pendant qu'il traite. Rapport : chaque message
   finit-il en base (aucune perte), en combien de temps, combien de tâches ont été rejouées, et la file d'échec reste-t-
   elle vide (le rejeu d'un message déjà écrit ne doit pas finir en échec sur la contrainte d'unicité). ⚠️ Attendu à
   vérifier : pg-boss 12 ne rejoue une tâche active qu'au bout de son délai d'expiration (15 min par défaut, aucune
   file de mba ne pose `heartbeatSeconds`), donc un message en vol au moment d'un crash attendrait un quart d'heure.
3. `arret` : le même pic, et le worker arrêté proprement (`docker stop`, le geste d'un déploiement, 30 s de grâce).

Un « non éprouvé » ne vaut pas un succès : une épreuve dont la condition n'a pas été réunie le dit, et sort en échec.
Le geste se cale sur un repère que le script écrit au milieu du pic, et il est PROUVÉ par l'heure de démarrage du
worker principal (`worker_heartbeat.booted_at`) ; seule une reprise APRÈS le délai d'expiration prouve qu'un crash a
frappé une tâche en vol ; et une tâche restée active à la fin de l'épreuve est un échec (tâche abandonnée).

## Montage et démontage

Celui du second banc, dans un dossier, une image, un réseau et un Postgres DÉDIÉS (`banc=inbox30`), jamais dans
`/home/ubuntu/mba`, secrets jetables jamais affichés. Démontage par l'étiquette à la fin.
