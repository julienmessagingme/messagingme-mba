# Lot 17 : la documentation pour développeurs

Lot 17 de « Messaging Me pour Claude Code » (plan privé, section « Ce qu'il faut construire »). Décisions de Julien du
2026-10-12, en deux rondes de questions, puis le design accepté le même jour.

## Ce qu'on veut

Un développeur, ou un « vibe coder » dans Lovable, Cursor ou Claude Code, branche Messaging Me SEUL : il crée son espace,
envoie un premier modèle, reçoit un premier webhook, et quand Meta refuse, il sait pourquoi et quoi faire. Un modèle qui
lit la doc pour lui (Claude, ChatGPT, Cursor) y trouve le même texte, sans exécuter de JavaScript.

## Les décisions

| Sujet | Décision |
| --- | --- |
| Recettes | Next.js seul dans ce lot (Lovable et Supabase, Make, n8n : plus tard) |
| Forme d'une recette | Un prompt à coller dans l'outil, plus le code qu'il doit produire, compilé par un test |
| Catalogue des erreurs | Tous nos codes, chacun avec sa cause et le geste qui règle, plus les erreurs de Meta qui nous concernent |
| Refus de Meta et pannes | Un `code` stable dans nos réponses, et le numéro de Meta à côté |
| Langue des `.md` | Les deux, comme la doc : `<page>.md` en français, `<page>.en.md` en anglais, tirés du même texte |
| Page « Démarrer » | Part de l'inscription (le tunnel `/demarrer` du lot 19), puis la clé, le premier envoi, le premier webhook |
| Prix de Meta | Aucun chiffre : ce qui est facturé et quand, et un lien vers la grille officielle de Meta |
| « Une route, sa page » | Tenu par la CI : une route, un code ou une page sans sa documentation rend la CI rouge |

## Ce qui existe déjà, mesuré le 2026-10-12

- La doc compte 14 pages (`web/lib/doc-api-pages.ts`), bilingues par `t(fr, en)`. Chaque route `/v1` y a son entrée,
  sa page et son ancre, et `tests/api-doc-endpoints.test.ts` tient l'index égal aux routes montées : la règle « une
  route, sa page » est DÉJÀ tenue pour les routes. Les outils MCP ont la leur (`tests/mcp-doc-parite.test.ts`).
- Les codes de l'API vivent dans une table (`STATUT_PAR_CODE`, `src/api/erreurs.ts`), recopiée pour la doc dans
  `CODES_DOCUMENTES` (`web/lib/api-exemples.ts`) et tenue égale par `tests/api-exemples.test.ts`. Le tableau dit le
  statut et le sens d'un code, jamais le geste qui le règle.
- Quatre réponses de `/v1` n'ont pas de `code` : le refus de Meta relancé jusqu'au gestionnaire commun (422,
  `error: "Meta: …"`), la panne (500 opaque), les refus de forme de Fastify (corps non JSON, trop gros), et la route
  inconnue (le 404 par défaut de Fastify). Le contrat OpenAPI le dit (`code` non requis), le SDK aussi (`code: null`).
- 🔴 **Le HTML de la doc est vide côté serveur** : `CadreDoc` attend la session, lue dans le navigateur, avant de rendre
  le contenu. Un modèle qui lit l'adresse d'une page sans exécuter de JavaScript n'y trouve rien. Les `.md` deviennent
  sa porte d'entrée.
- 🔴 **La production n'a encore vu aucune erreur de Meta** : 28 destinataires de campagne, aucun échec, aucun code
  d'erreur dans les statuts bruts d'un mois (sonde en lecture seule du 2026-10-12). La liste des erreurs de Meta ne se
  fonde donc pas sur notre trafic : elle croise la page officielle de Meta (lue le 2026-10-12) et les codes que notre code
  nomme déjà.

## Livraison A : toute réponse d'erreur de `/v1` porte un `code`

Sur une adresse `/v1/...` seulement ; les routes de la console ne changent pas (leur écran lit `error`, et
`tests/corps-opaque-parite.test.ts` tient le texte opaque des 5xx).

- **Refus de Meta** : la phrase « Meta: … », classée comme les routes classaient déjà (`refusDeMeta`, extrait dans
  `src/api/refus-meta.ts`) : le jeton refusé en 409 `meta_auth_failed`, une limite ou une panne passagère de Meta en
  429 `rate_limited` avec `retry-after`, tout autre refus en 422 `meta_rejected` avec `metaCode` (le numéro de Meta,
  `null` s'il n'en donne pas). Les routes qui nomment elles-mêmes un refus de Meta portent aussi `metaCode`.
  ⚠️ Décision prise en écrivant A, sur la relecture (une version « toujours 422 » disait `meta_rejected` d'une panne de
  Meta, et l'intégrateur ne l'aurait jamais réessayée) : coût si faux, un statut à revoir sur une route `/v1`.
- **Panne** : 500 avec `code: "internal_error"`, code neuf. La doc dit qu'un 5xx peut arriver sans corps lisible
  (Cloudflare remplace la page de l'origine, mesuré sur un 502) : réessayer, un envoi se rejoue avec la même clé
  d'idempotence.
- **Refus de forme de Fastify** (corps trop gros, type de contenu sans analyseur) : `code: "invalid_body"`, statut
  inchangé. ⚠️ Mesuré en écrivant A : un JSON illisible n'est PAS un refus de Fastify. L'analyseur JSON du récepteur de
  Meta (`src/webhooks/receiver.ts`), posé pour tout le serveur, le lit comme un objet vide, et la route refuse ensuite ce
  qui manque, avec son code. On n'y touche pas : cet analyseur sert la réception de Meta.
- **Route inconnue** : 404 `{ error, code: "route_not_found" }`, code neuf. Les adresses hors `/v1` gardent le 404 de
  Fastify.
- Le contrat OpenAPI : `metaCode` dans le schéma d'erreur ; `code` reste non requis (un 5xx peut ne pas venir de nous),
  mais sa description change : présent sur toute réponse JSON de l'API. Le SDK : `ApiError.metaCode`, types
  régénérés (`npm run sdk:contrat`), version **0.2.0** (ajout seul), publiée APRÈS le `up` de l'API et avec l'accord de
  Julien (la publication écrit dans un dépôt public).
- **Le test qui tient la règle** : chaque route du registre `/v1` est appelée avec une clé valide et une requête fautive
  (corps non JSON, corps illisible), plus une route inconnue et une panne simulée ; chaque réponse porte un `code` de la
  table.

## Livraison B : quatre pages, les `.md` et le `llms.txt`

Les adresses suivent celles qui existent (anglaises, déjà publiées).

| Page | Adresse | Groupe | Contenu |
| --- | --- | --- | --- |
| Démarrer | `/developers/api/quickstart` | Démarrer | Créer son espace par `/demarrer` (numéro fourni ou le sien), créer sa clé, envoyer un premier modèle (curl et SDK), déclarer une adresse et recevoir un premier webhook signé, le vérifier. Ce qu'on doit voir à chaque étape, et le code d'erreur le plus probable si ça casse |
| Pièges de Meta | `/developers/api/guides/meta-pitfalls` | Guides | La fenêtre de 24 h et les modèles ; la validation et les catégories d'un modèle (Meta peut recatégoriser) ; ce que Meta facture et quand, sans chiffre, lien vers sa grille ; la carte dans le Business Manager ; le consentement et STOP ; la qualité du numéro et ses paliers d'envoi ; le plafond par destinataire et le débit ; la limite marketing par personne ; le nom affiché ; le numéro injoignable ; un modèle mis en pause ; les médias reçus gardés 7 jours. Chaque piège renvoie à son code dans le catalogue |
| Catalogue des erreurs | `/developers/api/errors` | Plateforme | Une ancre par code (`#invalid_body`). Pour nos codes : statut, quand il arrive, le geste qui règle. Pour Meta (`#meta-131047`) : sa signification, notre traduction, où on le lit chez nous (`metaCode` d'un refus, `meta_code` de `message.failed`, `error.code` d'un message, `error.metaCode` d'un envoi suivi), et le geste |
| Recette Next.js | `/developers/api/guides/nextjs` | Guides | Le prompt à coller dans Claude Code ou Cursor ; le code : la clé en variable d'environnement, une route qui envoie un modèle par le SDK, une route qui reçoit un webhook et vérifie sa signature. Route handlers en `Request`/`Response` standard, sans import de Next, pour qu'un test les compile contre le SDK seul |

- **Authentification, limites et erreurs** garde son ancre `#erreurs` : la forme d'un refus, puis un lien vers le
  catalogue ; le tableau des codes et l'encadré « réponses sans code » en partent.
- **Les exemples compilés** : le code de la recette ET les exemples de la page SDK sortent des pages vers un module de
  textes, que les pages affichent et qu'un test compile contre `sdk/src` (CI de la racine). Ferme le jaune du lot 16.
- **Les `.md`** : un générateur rend chaque page de `PAGES_DOC` dans les deux langues (React côté serveur, le cadre
  remplacé par son contenu) et la convertit en Markdown par un convertisseur limité aux balises de nos composants de doc
  (une balise inconnue le fait échouer, au lieu de la perdre). Sorties versionnées dans `web/public/` :
  `/developers/api.md` et `.en.md`, `/developers/api/<page>.md` et `.en.md`, `/developers/mcp.md` et `.en.md`. Un
  test les refait et les compare au caractère près, sur le modèle de `sdk:contrat` (`npm run doc:md` dans `web/`).
- **Le `llms.txt` de la console** (`console.messagingme.app/llms.txt`), généré au même endroit : chaque page, sa phrase
  (un champ `resume` neuf dans `PAGES_DOC`), ses deux `.md`, plus le contrat OpenAPI. `llms-full.txt` (français) et
  `llms-full.en.txt` concatènent toutes les pages. Le `llms.txt` de la vitrine pointe vers lui.

## Ce que la CI tient en plus

1. Chaque code de `STATUT_PAR_CODE` a son geste dans les deux langues (champ requis de `CODES_DOCUMENTES`).
2. Chaque code de Meta que `src/` nomme (un nombre de six chiffres en 13xxxx, plus 190, 368, 4 et 80007) a son
   entrée au catalogue.
3. Chaque page de `PAGES_DOC` a ses deux `.md` à jour et sa ligne dans le `llms.txt`.
4. Chaque réponse d'erreur de `/v1` porte un `code` de la table (livraison A).
5. Le code des recettes et des exemples du SDK compile contre le SDK.

## Hors périmètre, noté dans `todo.md`

- Rendre le HTML de la doc côté serveur (le contenu public d'abord, la console ensuite) : utile aux moteurs et aux
  modèles, mais touche le cadre de toutes les pages.
- Un lien vers la doc dans chaque corps d'erreur (`docUrl`).
- Les trois noms du code de Meta dans nos réponses (`metaCode`, `meta_code`, `error.code`) : les unifier casserait ce
  qui est publié ; le catalogue les nomme tous.
- Les recettes Lovable et Supabase, Make, n8n.

## L'essai réel qui clôt le lot

Julien, sur un projet Next.js vide : coller le prompt de la recette dans Claude Code, poser sa clé, envoyer un modèle à
son téléphone, recevoir le webhook et voir la signature vérifiée. Puis demander à Claude, sans autre source que
`console.messagingme.app/llms.txt`, ce que veut dire `131047` et quoi faire. Contrôle de A en production : un corps en
`application/xml` (415) et une route inconnue rendent leur `code` (`curl`).
