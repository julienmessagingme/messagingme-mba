# WIP

> Ce fichier ne porte QUE le travail en cours. Un lot déployé en sort le jour même : son fonctionnel va dans
> [features.md](features.md), sa technique durable dans [documentation.md](documentation.md), son RÉCIT dans
> [docs/JOURNAL-TECHNIQUE.md](docs/JOURNAL-TECHNIQUE.md), ce qui reste à faire dans [todo.md](todo.md).
>
> 🔴 **VIDÉ POUR LA CINQUIÈME FOIS le 2026-09-13 au soir**, et le chiffre est le sujet. Il avait atteint
> 245 lignes en portant SIX chantiers déjà déployés, c'est-à-dire en redevenant une archive. La règle n'est
> pas « y penser », c'est : **un lot déployé n'a aucune raison d'attendre ici**.
>
> ⚠️ **Un lot déployé qui traîne ici ne vieillit pas, il MENT.**

## 🔴 L'ÉTAT EXACT, AU 2026-09-15 EN FIN DE JOURNÉE

| | |
|---|---|
| `origin/main` | `93a10c4` |
| VPS (`mba-api`, `mba-worker`, `mba-web`) | `93a10c4`, aucun écart |
| Vercel (`engageme`) | `93a10c4`, suit `origin/main` tout seul |
| Migrations | **0149 et 0150 appliquées**, relues en base après `migrate`. **Prochaine libre : 0151** |
| CI | ✅ verte, les DEUX workflows (voir le découpage ci-dessous) |
| Contrôle public | ✅ les quatre noms à 200, après un reload NPM (le 502 est arrivé à trois déploiements sur quatre) |

## 🔴 CE QUI A CHANGÉ DANS LE FONCTIONNEMENT, ET QU'UNE SESSION SUIVANTE DOIT SAVOIR

- 🔴 **LE DÉPÔT EST PUBLIC depuis le 2026-09-15**, décision de Julien pour rendre GitHub Actions gratuit
  (20 € consommés en 10 jours, mesurés : 4 524 minutes facturées sur 13 jours, dont 58 % pour le seul job du
  front). Il redeviendra privé « à un moment ». **Conséquence immédiate : plus rien de sensible ne s'écrit
  dans ce dépôt**, y compris dans ce fichier. L'adresse d'origine du VPS en a été retirée le jour même (elle
  reste dans l'historique git, cf. `todo.md`).
- 🔴 **LA CI EST DÉCOUPÉE EN DEUX WORKFLOWS.** `ci.yml` porte `securite`, `unit` et `integration` ;
  `ci-web.yml` porte le job du front et ne se déclenche que sur `web/**`. Mesuré : 47 % des pushs ne
  touchaient que le backend et payaient 8,8 minutes pour re-vérifier un front identique. ⚠️ **L'inverse est
  FAUX** : 43 tests de la racine LISENT des fichiers de `web/`, donc `ci.yml` garde un `paths-ignore` et
  jamais un filtre positif. `tests/ci-decoupage.test.ts` tient l'asymétrie ET sa raison.
- ⚠️ **UNE AUTRE SESSION TRAVAILLE DANS LE MÊME DOSSIER** (renommage `requireAuth` -> `garde` sur 47 fichiers
  de `src/http`). Tant qu'elle tourne, `npm test` à la racine est rouge sans que ça veuille rien dire, et
  `git commit --only <chemins>` n'est pas une précaution mais la seule façon de ne pas emporter son travail.

## Ce qui attend UN ESSAI RÉEL de Julien

Deux chantiers sont livrés, déployés et verts, mais **aucun n'a encore été éprouvé sur un vrai échange**. Un
mécanisme qui n'a jamais tourné sur de vraies données n'est pas éprouvé, il est seulement vert.

### 1. La remise du fil à l'agent de Meta (migration 0149)

Relancer un scénario, attendre sa fin, puis **attendre deux à trois minutes** avant d'écrire en tant que
client. L'agent de Meta doit répondre. Écrire PENDANT l'attente doit allumer la pastille « À traiter ».

Ce qui a été mesuré et qui explique le correctif : Meta acquitte nos envois avec DEUX MINUTES de retard, et
envoyer un message PREND le fil implicitement. La remise partait donc avant que l'envoi ne soit traité, et
l'envoi reprenait le fil juste derrière. Trois releases émis deux secondes après un envoi ont échoué, celui
émis quatorze minutes après a marché.

### 2. « Ça pousse ou ça intègre » (migration 0150)

- Donner `testadd` (`POST /subscriber/add-tag`) à un agent IA en répondant **« ça pousse »**, l'essayer depuis
  le bac à sable, puis **vérifier DANS UChat que l'étiquette est réellement posée**.
- Refaire avec un appel qui **intègre**, cocher un champ, et vérifier que la valeur remonte mot pour mot.
- Et par le chemin direct : **Tools > Outils > « + un outil pour l'agent de Meta »**, sans agent IA.

⚠️ **Le bac à sable est à revérifier en particulier** : il rendait zéro champ pour tout outil de connecteur
depuis le 2026-09-02, en promettant « exactement ce que l'agent recevra ». Le lot 1 le répare, mais la
réparation n'a jamais tourné sur de vraies données.
