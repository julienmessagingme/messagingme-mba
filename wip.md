# WIP

> Ce fichier ne porte QUE le travail en cours. Un lot déployé en sort le jour même : son fonctionnel va dans
> [features.md](features.md), sa technique durable dans [documentation.md](documentation.md), son RÉCIT dans
> [docs/JOURNAL-TECHNIQUE.md](docs/JOURNAL-TECHNIQUE.md), ce qui reste à faire dans [todo.md](todo.md).
>
> ⚠️ **Un lot déployé qui traîne ici ne vieillit pas, il MENT.** Vidé pour la sixième fois le 2026-09-16 (il
> annonçait encore `93a10c4`), puis une septième le 2026-10-10 : 1 281 lignes, presque toutes déployées.

## L'ÉTAT EXACT, AU 2026-10-10

| | |
|---|---|
| `origin/main` | voir `git log` (ce fichier ne recopie plus un SHA, il a menti six fois) |
| VPS (`mba-api`, `mba-worker`, `mba-worker-analyse`) | la révision déployée se lit sous le titre de `/ops` (lot 4 du plan de performance), jamais ici |
| Vercel | suit `origin/main` tout seul (la console, et la vitrine au push qui touche `site/`) |
| Migrations | 🔴 **LE NUMÉRO SE LIT, IL NE S'ÉCRIT NULLE PART** : `npm run migrations` (le dossier pour ce qui est pris, la base pour ce qui est appliqué). |
| CI | lue job par job sur `gh run view <id> --json jobs`, jamais sur le code de sortie du watch ; un rouge `toomanyrequests` (Docker Hub) n'a rien vérifié ; un rouge `unauthorized` sur la connexion à Docker Hub = jeton expiré ou révoqué, ou secret absent (CLAUDE.md) |
| Le récit | les lots déployés sont sortis de ce fichier le 2026-10-10, texte d'origine, vers [docs/JOURNAL-TECHNIQUE.md](docs/JOURNAL-TECHNIQUE.md) ; les essais dus vivent dans `docs/prive/ESSAIS-REELS.md`, les restes dans [todo.md](todo.md) |

## LA BASCULE SCALEWAY (EN COURS)

L'état de chaque lot se lit dans [le plan avant la bascule](docs/superpowers/plans/2026-10-14-avant-bascule-scaleway.md),
la séquence du jour J dans [docs/ARCHITECTURE-CIBLE.md](docs/ARCHITECTURE-CIBLE.md) § 10, le récit dans le journal. Ce
qui reste avant le jour J, au 2026-10-15 :
- un premier déploiement par le workflow avec la taille déclarée (`ops/scaleway/conteneur-api.json`), approuvé par
  Julien, puis le second banc sur le conteneur serverless (l'essai réel qui clôt le plan du 2026-10-15) ;
- le script des secrets de production, lancé par Julien la veille ;
- la date ;
- la suppression de `mba.`, une fois ses journaux muets quelques jours (lot 7).

## TOUT SUR LA FICHE (LOTS 1 À 3 DÉPLOYÉS ET ESSAYÉS ; LOT 4 EN COURS)

Spec `docs/superpowers/specs/2026-09-30-fiche-unique-design.md`, plan
`docs/superpowers/plans/2026-09-30-fiche-unique.md` (le plan veut chaque lot essayé avant le suivant). Le récit
des trois lots est dans le journal technique, le présent dans `documentation.md` § Contacts.

- ✅ **Lot 1** (la dernière analyse recopiée sur la fiche) : essai réel fait le 2026-09-30, la copie s'est posée
  sur la fiche de Julien dans l'espace SANDBOX.
- ✅ **Lot 2a** (liste unique, connecteurs sur l'origine `fiche`) et **lot 2b** (filtres de la liste et du
  ciblage, bloc Condition), déployés et vérifiés par le vrai code en production.
- ✅ **Essai réel du lot 2 fait le 2026-10-02** : les filtres « sentiment négatif, urgence au moins 7 » trouvent la
  fiche dans la liste et dans le ciblage (Julien), et l'appel `signaler` de Messaging me Brevo envoie les vraies
  valeurs de la fiche (`EM_URGENCY` = 9 vu dans Brevo, l'ancien appel envoyait 8 en dur).
- ✅ **Lot 3** (« la dernière analyse d'un contact change », filtres de « conversation analysée », délai de
  relance réglable à l'écran) : déployé et ESSAYÉ le 2026-10-02 (journal technique : un contact qui reste mécontent
  ne relance rien, un contact qui le devient déclenche, dans la seconde). Plus deux corrections demandées pendant
  l'essai : le premier clic d'un choix remplace la valeur cochée d'office, et une automation se modifie.
- **Lot 4** (API contacts `lastAnalysis`, MCP, trois attributs de signaux, outil « Lire la fiche » de l'agent IA) :
  en cours.
- 🟡 **Jaunes du lot 2a encore ouverts** : les connecteurs et les signaux ne lisent pas encore la même liste
  (divergence voulue jusqu'au lot 4) ; le format des dates envoyées (ISO complet) reste à confirmer avec un
  premier intégrateur ; une note du journal sur le retour arrière du lot 2a (une API d'avant refuserait
  `fiche:*` à l'enregistrement).

## RENVOI DES LEADS À META (CADRAGE, RIEN DE CODÉ)

Spec [docs/superpowers/specs/2026-10-09-renvoi-leads-meta-design.md](docs/superpowers/specs/2026-10-09-renvoi-leads-meta-design.md),
Groupama PJ d'abord : `LeadSubmitted` pour chaque arrivée d'une publicité Click-to-WhatsApp, `QualifiedLead` quand un
robot passe la main à un humain, envoyés par une tâche du worker à la Conversions API for Business Messaging.

- **Attend Julien** : la validation de la spec, qui ouvre le plan ; l'utilisateur système et son jeton dans le BM
  Groupama ; la ligne `CONVERSIONS_META` dans `.env.prod`, posée par lui ; le code « Test events » du jeu de données.
- **Mesure 0a** (avant le plan) : un événement d'essai avec ce jeton, lu côté serveur sans jamais l'afficher.
- **Mesure 0b** : au premier vrai clic sur une publicité Groupama (aucune arrivée sur l'espace à l'écriture de la spec).

## LES ACTIONS DE L'AGENT IA (A, B ET C LIVRÉES LE 2026-10-13)

Plan : [docs/superpowers/plans/2026-10-13-actions-agent.md](docs/superpowers/plans/2026-10-13-actions-agent.md). Le
moteur, la console et Claude Code (plugin 0.1.5) sont livrés ; restent la date du jour dite au modèle (pour les
champs date) et l'essai réel 108.

## LE RÉPERTOIRE DE CLAUDE (EN PAUSE JUSQU'À LA BASCULE SCALEWAY)

Plan : [docs/superpowers/plans/2026-10-14-repertoire-claude.md](docs/superpowers/plans/2026-10-14-repertoire-claude.md).
Livrés : les outils MCP en anglais et annotés (livraison A, en production), le plugin 0.2.0 sur `main` (licence,
icône, liens légaux, section « Data and privacy »), pas encore publié dans le dépôt public (qui sert la 0.1.5).
Décision de Julien le 2026-10-14 : on reprend juste après la bascule Scaleway, dans cet ordre :

1. les pages légales, françaises et anglaises, mises en ligne sur www.messagingme.fr (Geoffrey a les fichiers) ;
2. la publication du plugin 0.2.0 (`gh workflow run plugin.yml --ref main`), pas avant : ses liens viseraient des
   pages absentes ;
3. ✅ l'espace de démo peuplé (livraison D, 2026-10-15) et le compte du relecteur créé par Julien ;
4. la soumission par Julien : le connecteur, puis le plugin. Les champs à recopier vivent dans `docs/prive/`.

L'espace de démo est « Messaging Me demo » (ex « Espace de Test superchat », +33 5 25 68 02 47), PAS la sandbox, qui
porte des contacts tiers et le travail des prospects (décision de Julien, 2026-10-15). Son jeton propre est un
utilisateur système qui n'expire jamais. Rempli le 2026-10-15 par nos propres outils MCP, signés par son
administrateur (autorisation révoquée ensuite) : un agent IA actif et répondant de l'espace, la vitrine importée,
deux modèles approuvés, une bulle, 10 € de crédit IA. Reste : des conversations depuis nos téléphones
(`docs/prive/ESSAIS-REELS.md`).

## LOT 6 ET 6 BIS : LES CAS D'USAGE, LA RUBRIQUE « SOLUTIONS », LES TARIFS ET LE DÉPÔT DU PLUGIN (CADRÉ LE 2026-10-15, REVU LE 2026-10-16)

Specs : [lot 6](docs/superpowers/specs/2026-10-15-cas-d-usage-design.md) (toutes les adresses, l'anatomie d'une page) et
[lot 6 bis](docs/superpowers/specs/2026-10-16-cas-d-usage-par-profil-design.md) (les profils, le registre, les dépôts),
en attente de la relecture de Julien ; le plan du 2026-10-15 est à réécrire pour les deux. Le menu devient
Fonctionnalités, Solutions (trois secteurs, deux métiers, les cas), Développeurs, Tarifs ; sept pages de cas, en
français et en anglais, avec un film par cas. Le film 1 (prise de rendez-vous) est fait. Précédé de l'audit SEO de la
vitrine (`docs/prive/2026-10-15-audit-seo-vitrine.md`) et d'un geste de Julien : la Search Console et Bing Webmaster
Tools. À corriger d'abord : les liens de confidentialité et de conditions d'utilisation du plugin 0.2.0 (404).

## CE QUI ATTEND UN ESSAI RÉEL

🔴 **La liste unique et à jour des essais réels de Julien vit dans `docs/prive/ESSAIS-REELS.md`** (2026-10-09, à sa
demande), non versionnée parce qu'elle porte des numéros de téléphone. Elle est tenue à chaque livraison. Cette section
en portait une copie partielle datée de septembre (l'agent de Meta après un silence, le lien de test, le journal
d'audit, « ça pousse ») : ses essais y sont repris, et son détail reste dans l'historique git.
