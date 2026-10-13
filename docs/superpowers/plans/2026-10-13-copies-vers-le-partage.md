# Les copies serveur / console vers `web/lib/partage/` (audit ponytail du 2026-10-13, point 1)

**But.** Une règle pure écrite deux fois (une fois dans `src/`, une fois dans `web/`) puis tenue alignée par un test
de parité ne s'écrit plus qu'une fois, dans `web/lib/partage/`. La copie de la console et le test de parité
disparaissent ; les cas de comportement que ces tests exerçaient sont conservés ailleurs.

**Ce qui n'en fait pas partie**, et reste tel quel (inventaire refait sur les 43 tests de parité, comme le lot B du
2026-10-09) : les libellés d'écran, les tests qui lisent la documentation, la base ou les migrations, ceux qui
montent les vraies routes (OAuth, widgets), et les paires que le lot B a écartées (performance, conditions de
scénario, offres).

## Tâches, un groupe par domaine

| Groupe | Partagé | Supprimé |
|---|---|---|
| RCS | types du message, `RCS_TEXTE_MAX` | `web/lib/rcs-limits.ts`, `web/lib/rcs-types.ts`, `web-rcs-limits-parity` |
| Langues des modèles | la liste (code et autonyme), sa vérification | `web/lib/languages.ts`, `src/meta/languages.ts`, `web-languages-parity` |
| Champs | types de champ perso, champs socle | `web-field-kinds-parity`, `web-socle-fields-parity` |
| Textes reconnus | corps opaque d'un 5xx, code de second facteur refusé | `corps-opaque-parite`, `web-second-facteur-parite` |
| Droits d'API | droits, plafond de clés, droit du relais | `api-droits-parite` |
| Blocs de scénario | types de bloc, plafond de destinataires e-mail | `web-node-types-parity`, `web-email-recipients-parity` |
| Sorties d'agent | code de sortie (forme, plafond, normalisation), sorties réservées | la copie de `web/lib/agent-sorties.ts` |
| Agent de Meta | fichiers de connaissance, titre de compétence, bornes, prix | les copies de `web/lib/mba-files.ts`, `web/lib/mba-skills.ts`, `mba-prix-parite` |
| Pièce jointe | plafonds de l'assistant | `web-piece-jointe-parity` |
| Automations | types de déclencheur, opérateurs d'analyse | `web-automations-parite` |
| Autres | à trancher au cas par cas en lisant les deux côtés | seulement si la copie disparaît vraiment |

**Interfaces.** Chaque fichier de `web/lib/partage/` n'importe que lui-même (`tests/partage.test.ts`). Le serveur
l'importe en relatif ; la console aussi depuis `web/lib`, par l'alias `@/lib/partage/...` depuis un composant.

**Tests attendus.** Un test de parité disparaît quand il n'y a plus deux exemplaires ; un cas qui éprouvait un
COMPORTEMENT (une table de cas, une borne, une valeur par défaut) est gardé, réécrit contre la règle unique.
Typage de la racine et de `web/`, tests unitaires des deux, lint et build de la console, auto-attaque.

**Ordre de déploiement.** Aucune migration, aucun contrat HTTP changé. La console (Vercel) et l'API (VPS) peuvent
partir dans n'importe quel ordre : chacune embarque sa copie du dossier partagé, identique au même commit.

## Méthode de livraison

**En direct, puis une relecture indépendante en fin de lot.** Réversible, sans changement de comportement, et
chaque déplacement est vérifié mécaniquement par les deux typages (un nom recopié de travers ne compile pas) ;
mais le lot touche des chemins que la production emprunte (envoi RCS, validation des modèles, droits d'API), d'où
la relecture du diff avant de pousser.

**L'essai réel qui clôt le lot** : rien à cliquer de neuf. Après déploiement, ouvrir la console sur un écran de
chaque groupe (création de modèle, réponse RCS, champs, clés d'API, scénario) et vérifier qu'il se comporte comme
avant.
