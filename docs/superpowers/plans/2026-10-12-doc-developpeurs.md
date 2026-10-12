# Lot 17 : la documentation pour développeurs

Spec : `docs/superpowers/specs/2026-10-12-doc-developpeurs-design.md` (décisions de Julien du 2026-10-12). Deux
livraisons, aucune migration.

## Méthode de livraison

**A (le serveur)** : implémenteur (moi, en direct) puis UNE relecture du diff par un relecteur indépendant, parce que A
touche le gestionnaire d'erreurs commun, que TOUTE route de l'API traverse, et le contrat que le SDK publié lit : une
réponse de la console changée par mégarde ou un corps de refus perdu ne se voient d'aucun écran. Les critères se
vérifient par des tests (chaque route `/v1` appelée en faute), mais le périmètre « `/v1` seulement » est un invariant
invisible.

**B (la doc)** : en direct, puis UNE relecture en fin de livraison, parce que ce sont des pages publiques réversibles à
chaque push, tenues par des tests de parité (codes, pages, `.md`, exemples compilés) ; le risque est un texte faux, que
la relecture et l'essai réel attrapent mieux qu'une boucle.

**L'essai réel qui clôt le lot** : Julien, sur un projet Next.js vide, colle le prompt de la recette dans Claude Code,
pose sa clé, envoie un modèle à son téléphone, reçoit le webhook et voit la signature vérifiée ; puis demande à Claude,
avec `console.messagingme.app/llms.txt` pour seule source, ce que veut dire `131047`. Contrôle de A en production :
`curl` d'un JSON illisible et d'une route inconnue sous `/v1` (leur `code`). Essai n° 88 de `docs/prive/ESSAIS-REELS.md`.

## Livraison A : un `code` sur toute erreur de `/v1`

1. **La table des codes** (`src/api/erreurs.ts`) : `internal_error: 500` et `route_not_found: 404` ; le commentaire de
   `meta_rejected` élargi. `CODES_DOCUMENTES` (`web/lib/api-exemples.ts`) reçoit les deux, avec leur sens.
   Tests : `tests/api-erreurs.test.ts` (la table recopiée), `tests/api-exemples.test.ts` (parité, inchangé).
2. **Le gestionnaire commun** (`src/server.ts`), sur une adresse `/v1/` seulement : `MetaApiError` rend 422
   `{ error: "Meta: …", code: "meta_rejected", metaCode }` ; une erreur de Fastify sous 500 sans code (`FST_ERR_CTP_*`,
   corps trop gros) rend `invalid_body` au même statut ; un 5xx rend `{ error: CORPS_OPAQUE_5XX, code: "internal_error" }`.
   Un gestionnaire de route inconnue limité à `/v1` rend 404 `route_not_found` ; hors `/v1`, le 404 de Fastify.
   Tests : `tests/v1-erreurs-code.test.ts` (neuf), sur le serveur monté comme dans `tests/openapi.test.ts` : chaque route
   POST et PATCH du registre avec un corps non JSON puis illisible, une route inconnue, un refus de Meta et une panne
   simulés ; chaque réponse porte un code de la table. Et l'inverse : une route de la console garde `{ error }` seul
   (refus de Meta, 5xx, 404), vérifié dans les deux sens.
3. **Le contrat et le SDK** : `SCHEMA_ERREUR` (`src/api/openapi/document.ts`) gagne `metaCode` (entier ou `null`, sur
   `meta_rejected`) et sa description de `code` ; `ApiError.metaCode` dans `sdk/src/index.ts` ; `npm run sdk:contrat`.
   La version reste 0.1.0 dans ce commit. Tests : `tests/sdk-contrat.test.ts`, `tests/openapi.test.ts`, les tests du SDK.
4. Relecture, jaunes simples corrigés, push, CI lue job par job, déploiement (API, deux workers, `mba-web`), cinq portes,
   puis les deux `curl` en production.
5. **SDK 0.2.0, avec l'accord de Julien** (la publication écrit dans un dépôt public) : `sdk/package.json` et la version
   de la page SDK dans le même commit, puis l'action de publication, puis l'installation essayée depuis GitHub.

## Livraison B : quatre pages, les `.md` et le `llms.txt`

Poussée APRÈS le déploiement de A : le catalogue décrit ses codes, et l'encadré « réponses sans code » de la page
Authentification, limites et erreurs devient faux au `up` de A ; il part avec B.

1. **La carte** (`web/lib/doc-api-pages.ts`) : les quatre pages (`quickstart`, `meta-pitfalls`, `errors`, `nextjs`) et un
   champ `resume` bilingue requis sur toutes. `web/e2e/developers-api.spec.ts` : leurs sections.
2. **Le catalogue** : `geste` requis dans `CODES_DOCUMENTES` (les deux langues, chaque code) ; `ERREURS_META` dans
   `web/lib/` (code, ce que Meta dit, notre traduction, le geste, où on le lit chez nous) ; la page `errors` ; un lien
   `<LienErreur code>` typé sur les deux listes, pour les autres pages ; la page Authentification garde la forme d'un refus
   et renvoie au catalogue. Tests : chaque geste non vide ; `tests/doc-erreurs-meta.test.ts` (neuf) : chaque code de Meta
   que `src/` nomme est au catalogue, vérifié dans les deux sens.
3. **Pièges de Meta** et **Démarrer** : le texte, chaque piège relié à son code par `<LienErreur>`.
4. **La recette Next.js et les exemples compilés** : le code de la recette et les exemples de la page SDK dans un module
   de textes (`web/lib/exemples-code.ts`), affiché par les pages ; `tests/doc-exemples-compiles.test.ts` (neuf, racine)
   les écrit dans un dossier temporaire et les compile contre `sdk/src` (`tsc`, comme `tests/sdk-contrat.test.ts`).
   Vérifié dans les deux sens (une faute de type remise dans un exemple rend le test rouge).
5. **Le générateur** (`web/scripts/doc-md`, lancé par `npm run doc:md` dans `web/`) : chaque page de `PAGES_DOC` rendue
   dans les deux langues, le cadre remplacé par son contenu, convertie par un convertisseur limité à nos balises (une
   balise inconnue échoue) ; écrit `web/public/developers/**/*.md`, `web/public/llms.txt`, `llms-full.txt`,
   `llms-full.en.txt`. Test (vitest de la console) : refait et compare au caractère près. `site/llms.txt` pointe vers le
   `llms.txt` de la console.
6. Relecture, e2e de la doc lancé en local (serveur démarré soi-même), push, CI des deux côtés, publication Vercel, puis
   `curl -I` d'un `.md` (type servi) et du `llms.txt`.
7. **Les docs** : `features.md` (développeurs, fiche d'aide et son empreinte si une section citée change),
   `documentation.md` (l'invariant « toute erreur de `/v1` porte un code », le générateur des `.md`), `todo.md` (le hors
   périmètre de la spec), le journal, `wip.md`, le plan privé et son Claude Doc, l'essai n° 88.
