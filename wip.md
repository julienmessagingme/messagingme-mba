# WIP

> Ce fichier ne porte QUE le travail en cours. Un lot déployé en sort le jour même : son fonctionnel va dans
> [features.md](features.md), sa technique et ses gotchas dans [documentation.md](documentation.md) (section
> « Journal des lots livrés »), ce qui reste à faire dans [todo.md](todo.md).
>
> 🔴 **VIDÉ POUR LA TROISIÈME FOIS le 2026-09-04**, et c'est le chiffre qui compte. Il l'avait déjà été le
> 2026-08-29 (1341 lignes, il remontait à juillet) et le 2026-08-31. Il était remonté à 230 lignes et douze
> sections, toutes marquées « LIVRÉ ET DÉPLOYÉ ». Trois fois, c'est que le problème n'est pas la négligence :
> **un lot terminé n'a aucune raison d'attendre ici**, il a une place ailleurs le jour même. Avant de retirer
> quoi que ce soit, chaque section a été vérifiée présente dans `documentation.md`, `todo.md` ou son plan
> dédié dans `docs/`.
>
> ⚠️ **Un lot déployé qui traîne ici ne vieillit pas, il MENT.** Vérifié en 2026-08-31 : la moitié de ce que
> le lot du 29 affirmait était déjà périmée deux jours plus tard.
>
> **Au-delà de cent lignes, ce fichier a recommencé à être une archive.**

## Lot « lancer un scénario ferme le précédent » (2026-09-07, en cours de déploiement)

Règle de Julien : « on ne bloque personne sur un scénario, surtout quand on lance un nouveau scénario », et
son arbitrage du cas ambigu : quand un message est à la fois une réponse attendue et un déclencheur, **le
déclencheur gagne, toujours**.

**Le défaut vécu.** Un lien de chaîne cliqué pendant qu'un autre parcours attendait n'ouvrait jamais son
scénario : `hasWaitingRun` sautait le déclenchement, et la fenêtre de cette garde était de SEPT JOURS. Le
numéro serait resté muet jusqu'au 14 septembre. Diagnostiqué en base, pas supposé.

**Ce qui change.**
- la fermeture du parcours actif descend dans `runFrom`, passage commun des quatre chemins de démarrage
  (Inbox, jeton de test, automation, campagne et cible node). Elle vivait chez UN appelant sur quatre ;
- 🔴 elle est posée APRÈS les gardes et AVANT la persistance, et seulement si quelque chose remplace
  vraiment (`partis > 0` ou parcours persisté) : un démarrage refusé, ou un scénario d'actions seules qui
  n'envoie rien, ne doit pas tuer une conversation vivante sans rien mettre à la place ;
- 🔴 les automations passent AVANT l'avance dans le webhook et CONSOMMENT le message qui a démarré un
  scénario. Sans ça, l'ancien parcours avançait et envoyait son bloc suivant avant d'être tué : le client
  recevait deux messages, dont un venant d'un parcours abandonné ;
- `resume` écrit par `setStateSiVivant` : entre le claim du balayage et son écriture, un autre chemin peut
  avoir clos le parcours, et une écriture inconditionnelle le RESSUSCITAIT avec son échéance ;
- la session d'agent suit son parcours quand il est clos (elle restait `en_cours` jusqu'à la purge) ;
- `hasWaitingRun`, sa config et `endWaitingRun` (le doublon du jeton de test) disparaissent.

⚠️ **Migration 0115** : l'index qui sert la clause de `closeActiveByWaId`. Mesuré : AUCUN index existant ne
la servait, et elle passe d'un appel occasionnel à un par destinataire de campagne. `CONCURRENTLY`, donc
hors transaction. **Vérifier `indisvalid` après le déploiement** : `if not exists` saute un index invalide
au lieu de le réparer.

## Refonte des menus : A, B, C, D et F LIVRÉS ET DÉPLOYÉS · reste E (2026-09-08)

Trois onglets de premier niveau, l'Inbox en boîte mail, et un Performance Lab dont la page d'accueil répond
à deux questions : ce que coûte un engagement, et où se situent les conversations en urgence et en
satisfaction. **La spec des six lots**, avec ce que chacun coûte et ce qu'il ne fait pas :
[docs/superpowers/specs/2026-09-08-refonte-menus-design.md](docs/superpowers/specs/2026-09-08-refonte-menus-design.md).

### Ce qui est en ligne

**Lot A** (plan : [`plans/2026-09-08-refonte-menus-lot-a.md`](docs/superpowers/plans/2026-09-08-refonte-menus-lot-a.md)) :
les onglets **Console / Inbox / Performance Lab**. L'onglet se DÉDUIT de la clé `active` que les 33 pages
passent déjà (`ongletDeLaPage`, `web/lib/nav.ts`) : aucune page n'a été touchée, aucune adresse n'a changé.
La pastille de non-lus a migré de la barre latérale vers l'onglet Inbox, où elle est visible depuis les trois.

**Lots B+C+D** (plan : [`plans/2026-09-08-refonte-menus-lot-bcd.md`](docs/superpowers/plans/2026-09-08-refonte-menus-lot-bcd.md)) :
dossiers Tout / À traiter / Signalé / Archivé avec compteurs toujours affichés, archivage réversible par
sélection (migration **0120**), charge par collaborateur pour admin et manager.

**Lot F** (livré ET déployé le 2026-09-08, migration **0121**) : l'analyse rend deux notes de 0 à 10, la
satisfaction et l'urgence, et la page **`/performance`** (adresse NEUVE, la seule de toute la refonte) en
fait un nuage de points. Abscisse satisfaction, ordonnée urgence : le coin qui alarme tombe en haut à
gauche. `/performance` est aussi devenue la porte d'entrée de l'onglet Performance Lab, à la place de
`/dashboard`, qui n'a pas bougé pour autant.
- 🔴 **`null` n'est pas `0`, et c'est tout le lot.** Une analyse d'avant la migration n'a pas de mesure (14
  en base ce jour-là, toutes à null) ; la compter comme zéro rangerait l'historique entier dans le coin
  « client furieux, urgence nulle ». Et une satisfaction de 0 est une mesure valide, celle qui alarme : un
  `if (!satisfaction)` la ferait disparaître de l'écran. Les deux sens sont gardés par des tests
  d'intégration vérifiés par MUTATION contre une vraie base.
- Le schéma tolère l'à-peu-près du modèle et ne perd JAMAIS l'analyse pour une note (absente, décimale, en
  texte ou hors échelle : seule la mesure manque). Mesuré sur zod 4.4 avant d'être écrit.
- Le nuage DIT qu'il démarre vide, et compte à part les analyses sans mesure. Il se remplira au fil des
  analyses : c'est la raison pour laquelle ce lot est passé avant E.
- Hors périmètre, décidé par Julien : réanalyser les 14 conversations existantes.
- ⚠️ `satisfaction` et `urgence` ne partent PAS vers HubSpot (`getStored` ne les relit pas, et dit
  pourquoi) : ce serait changer un contrat inter-dépôts que ce lot ne demandait pas.

### Ce qui reste

**Lot E** : coût par campagne rapporté aux engagements, sur la page de synthèse `/performance` (qui existe
maintenant, avec le nuage du lot F).
- Le coût n'est stocké nulle part : il se recalcule (envois × tarif Meta de la catégorie), donc une
  **estimation** que l'écran doit annoncer comme telle, et une colonne VIDE quand Meta ne rend aucun tarif.
- 🔴 Les clics existent pour les campagnes à TEMPLATE (le comptage filtre sur `template_name is not null`)
  et PAS pour les campagnes à scénario. ⚠️ `todo.md` affirme l'inverse : sa correction fait partie du lot.
- Deux réserves à afficher sous le tableau : les templates approuvés avant le 2026-09-02 n'ont pas de jeton
  dans leur adresse figée chez Meta (aucun clic ne remonte), et deux campagnes qui envoient la même adresse
  au même contact partagent le compteur.

⚠️ **Aucune migration en attente.** Dernière appliquée : **0121** (CLAUDE.md porte le compteur, et lui seul).

## Rien n'est en cours au 2026-09-07

Tout ce qui a été fait entre le 2026-09-02 et le 2026-09-07 est **livré, déployé et vérifié** : les sept lots
du plan post-audit, le renommage en Engage Me, la bascule du front sur Vercel, les huit constats du
contre-rapport, les quatre du contre-contre-rapport (migration 0113 comprise), l'audit de rayon de souffle
qui a suivi, puis l'audit sécurité du 2026-09-07 (plafond de débit des routes authentifiées, dépendances
`web/` remontées, script d'auto-attaque branché dans la CI). Où lire quoi :

| Ce que tu cherches | Où c'est |
|---|---|
| le tri de chaque constat externe, et ce qui reste ouvert | [todo.md](todo.md) |
| les gotchas et le pourquoi de chaque lot | [documentation.md](documentation.md) § Journal des lots livrés |
| le détail migration par migration | [documentation.md](documentation.md) § Les migrations, une par une |
| le journal d'exécution de la bascule Vercel | [docs/PLAN-BASCULE-VERCEL-2026-09-03.md](docs/PLAN-BASCULE-VERCEL-2026-09-03.md) |
| les rapports envoyés en contradiction externe | `docs/RAPPORT-*.md` |

## Ce qui attend une action de Julien

- ~~Ajouter `engageme.messagingme.app` aux domaines autorisés de l'app Meta.~~ **FAIT le 2026-09-08**
  (Facebook Login for Business > Settings) : « Valid OAuth Redirect URIs » ET « Allowed Domains for the
  JavaScript SDK » portent chacun `https://mba.messagingme.app/` ET `https://engageme.messagingme.app/`.
  ⚠️ L'ancien domaine a été CONSERVÉ, pas remplacé : `mba.` sert encore la console historique, et l'y
  retirer casserait son parcours de connexion. Google Sign-In était déjà fait. Les deux tiers qui
  vérifient l'ORIGINE sont donc à jour, cf. la règle du CLAUDE.md sur le changement de nom du front.
- **Facultatif : éteindre `mba-web`** et faire de `mba.messagingme.app/` une redirection vers `engageme`.
  Rien ne presse : le laisser tourner ne coûte presque rien et garde une porte de sortie.

## Ce qui est en PAUSE, et pourquoi

Le bloc **agent IA, lots L3 à L7** (relecture des vraies conversations, MCP délégué, et la suite). Le cadrage
est écrit, rien n'est commencé. Détail dans [todo.md](todo.md).
