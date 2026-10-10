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
| Migrations | 🔴 **LE COMPTEUR N'EST PAS ICI, IL EST DANS [CLAUDE.md](CLAUDE.md), SECTION DÉPLOIEMENT.** En cas de doute, la BASE tranche. |
| CI | lue job par job sur `gh run view <id> --json jobs`, jamais sur le code de sortie du watch ; un rouge `toomanyrequests` (Docker Hub) n'a rien vérifié |
| Le récit | les lots déployés sont sortis de ce fichier le 2026-10-10, texte d'origine, vers [docs/JOURNAL-TECHNIQUE.md](docs/JOURNAL-TECHNIQUE.md) ; les essais dus vivent dans `docs/prive/ESSAIS-REELS.md`, les restes dans [todo.md](todo.md) |

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

## CE QUI ATTEND UN ESSAI RÉEL

🔴 **La liste unique et à jour des essais réels de Julien vit dans `docs/prive/ESSAIS-REELS.md`** (2026-10-09, à sa
demande), non versionnée parce qu'elle porte des numéros de téléphone. Elle est tenue à chaque livraison. Cette section
en portait une copie partielle datée de septembre (l'agent de Meta après un silence, le lien de test, le journal
d'audit, « ça pousse ») : ses essais y sont repris, et son détail reste dans l'historique git.
