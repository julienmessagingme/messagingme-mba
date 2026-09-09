# WIP

> Ce fichier ne porte QUE le travail en cours. Un lot déployé en sort le jour même : son fonctionnel va dans
> [features.md](features.md), sa technique durable dans [documentation.md](documentation.md), son RÉCIT dans
> [docs/JOURNAL-TECHNIQUE.md](docs/JOURNAL-TECHNIQUE.md), ce qui reste à faire dans [todo.md](todo.md).
>
> 🔴 **VIDÉ POUR LA QUATRIÈME FOIS le 2026-09-09**, et c'est le chiffre qui compte. La troisième était le
> 2026-09-04. Il l'avait déjà été le
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

## Rien n'est en cours au 2026-09-09

Tout ce qui a été fait jusqu'ici est **livré, déployé et vérifié**. Ce fichier est reparti de zéro pour la
QUATRIÈME fois : les trois derniers lots (« le déclencheur gagne », les neuf demandes de Julien du 8, la
refonte des menus) y attendaient encore alors qu'ils étaient en production depuis des jours, sous une section
qui affirmait par ailleurs que rien n'était en cours. Où lire quoi, désormais :

| Ce que tu cherches | Où c'est |
|---|---|
| ce que le produit fait, vu du client | [features.md](features.md) |
| comment le système est fait, et ce qu'il ne faut pas casser | [documentation.md](documentation.md) |
| le récit d'un lot, ses mesures, ses incidents | [docs/JOURNAL-TECHNIQUE.md](docs/JOURNAL-TECHNIQUE.md) |
| ce qui reste ouvert | [todo.md](todo.md) |
| le journal d'exécution de la bascule Vercel | [docs/PLAN-BASCULE-VERCEL-2026-09-03.md](docs/PLAN-BASCULE-VERCEL-2026-09-03.md) |

## Ce qui attend une action de Julien

- 🔴 **Activer les deux outils de l'agent « Conseiller IA Gan Prevoyance »** : `mba_chercher_connaissance`
  et `mba_escalader_humain` sont INACTIFS en base (vérifié le 2026-09-09). C'est la cause de l'essai raté du
  2026-09-08, et le changement de modèle ne la corrige pas : Haiku sait appeler des outils, mais on ne lui en
  expose aucun. Onglet Outils de la fiche. C'est une décision qui change ce que l'agent a le droit de faire
  chez un client en secteur RÉGULÉ, donc elle ne se prend pas sans lui. ⚠️ Le modèle, lui, est déjà passé sur
  `anthropic/claude-haiku-4.5` (écriture en base du 2026-09-09, vérifiée, et le modèle appelle bien l'outil).
- **Poser une photo de profil sur le numéro WhatsApp** : la pastille de l'Accueil n'affiche rien tant qu'il
  n'y en a pas, et aucun des deux numéros du parc n'en a (mesuré).
- **Régler les heures d'ouverture dans Paramètres** avant d'utiliser la case « heures ouvrées » d'une
  campagne ou le bloc Attente « jusqu'aux prochaines heures ouvrées » : sans aucun jour ouvert, la campagne se
  met en pause et le dit, mais ne repart pas toute seule, et le bloc Attente ne retient personne.
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
