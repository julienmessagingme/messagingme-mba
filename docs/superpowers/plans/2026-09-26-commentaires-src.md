# Alléger les commentaires de `src/`

Demandé par Julien le 2026-09-26, après le bilan de l'audit ponytail : les commentaires font 42 % de `src/`
(42 000 lignes sur 99 000), et c'est ce qui rend le dépôt lourd à lire, pas le code. Cadrage tranché le même
jour : **`src/` seulement** ; les récits datés sont **supprimés** (git et `docs/JOURNAL-TECHNIQUE.md` gardent
l'histoire) ; on garde **l'invariant et le pourquoi** ; **🔴 reste** pour les invariants critiques, ⚠️ et les
majuscules d'insistance partent.

## Méthode de livraison

**Workflow multi-agents par lots de dossiers, avec une preuve MÉCANIQUE que le code n'a pas bougé**, parce que le
chantier touche presque tous les fichiers de `src/` mais ne doit changer AUCUNE instruction : un réécrivain par
lot, un vérificateur par lot, et un contrôle automatique qui compare, fichier par fichier, la sortie de
`ts.transpileModule` avec `removeComments` avant et après (identique au caractère, sinon le fichier est refusé).
L'essai réel qui clôt le chantier : la suite complète, la CI (job `integration` compris), puis le déploiement de
l'API dont le comportement doit être identique (fumée et journaux du worker).

## Ce qu'un commentaire garde

- L'**invariant** que le code tient et qu'on casserait sans le savoir (isolation par `tenant_id`, consentement,
  facturation, ordre de deux écritures, index partiel lié à une requête).
- La **contrainte externe** non visible dans le code (comportement mesuré de Meta, Vercel, pg-boss, Postgres).
- Le **piège** non évident, et pourquoi l'alternative évidente est fausse, en une à trois lignes.
- Le 🔴 devant un invariant critique.

## Ce qui part

- Les récits : « vécu le… », « relevé par la revue du… », « mesuré le… », « jusqu'au… », les numéros de lot, les
  noms de chantiers, ce que le code faisait AVANT.
- Les redites (le même pourquoi recopié dans plusieurs fichiers : on le garde au point de passage unique).
- Ce que le code dit déjà (paraphrase d'une ligne, liste des paramètres évidents).
- ⚠️ et les majuscules d'insistance.

## Ce qui ne bouge JAMAIS

- Aucune instruction : preuve mécanique ci-dessus.
- Les directives dans des commentaires (`@ts-expect-error`, `@ts-ignore`, `eslint-disable…`, `/*#__PURE__*/`,
  `/// <reference`), recopiées telles quelles : le contrôle compte leurs occurrences avant et après.
- Les chaînes de caractères (messages, prompts, SQL) : ce ne sont pas des commentaires, même quand elles
  expliquent.
- Un commentaire qu'un test lit (98 fichiers de `tests/` relisent le texte de `src/`) : si la suite casse, le
  commentaire revient, le test n'est pas modifié.

## Lots et ordre

Par dossiers de `src/`, chacun commité et poussé dès qu'il est vert, pour que la fenêtre de collision avec les
autres sessions reste courte : les réécritures se font sur un EXPORT d'`origin/main`, jamais dans l'arbre partagé,
et chaque commit se construit en plomberie, fusion en trois voies si le fichier a bougé sur `origin` entre-temps.
Au plus 20 agents par lancement ; le chantier en demande plusieurs.

## Tests attendus

- Le contrôle mécanique par fichier (sortie transpilée identique, directives conservées).
- `npx tsc --noEmit` et la suite unitaire complète verts après chaque lot ; CI verte avant le déploiement.
- Le compte de lignes de commentaires avant et après, par dossier.
