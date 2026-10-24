# Shopify sur la vitrine, sans attendre le produit : l'aide publique, la page Intégrations, l'accueil, les tarifs

**Plan du 2026-10-24.** Il livre la partie de la conception `docs/superpowers/specs/2026-10-23-vitrine-shopify-design.md`
qui ne dépend pas du chantier produit « Shopify sur un numéro relié par QR code » (plan `2026-10-23-shopify-numero-qr.md`),
dans une session à part, par décision de Julien du 2026-10-24.

**Dans le périmètre** : du lot 1, la fiche d'aide publique et la correction de `features.md` ; le lot 2 entier (page
Intégrations, bandeau de l'accueil, tarifs).
**Hors périmètre** : la page « Boutiques Shopify » (`/solutions/shopify/`) et le film, qui attendent le produit.

## Décisions de Julien (2026-10-24)

- Le logo Shopify vient du **kit officiel** (shopify.com/brand-assets) : seules ses versions monochromes, noire et
  blanche, entrent dans le dépôt.
- Tant que `/solutions/shopify/` n'existe pas, la carte Shopify de la page Intégrations mène à la **fiche d'aide publique**
  « Brancher ma boutique Shopify ». Elle se rebranchera sur la page Boutiques Shopify quand celle-ci sortira.

## Tâches

1. **`features.md` § Boutique Shopify** : « Deux messages » devient trois (commande payée, expédition, relance du panier),
   en disant que la relance est un modèle marketing et les deux autres de service. L'empreinte de la fiche suit.
2. **La fiche publique** `docs/aide/fiches/brancher-ma-boutique-shopify.md` : `publique: oui`, rubrique « Parler aux
   clients », offre Pro, prérequis « Connecter mon numéro WhatsApp », pas de `comment_faire` (l'écran Paramètres porte bien
   d'autres réglages). Réécrite à la grammaire des fiches publiques : chapeau, étapes `**N. Titre.**` du chemin de la
   console, encadrés, puis la prose (relance, prénom, import, RGPD, Claude Code). Aucun accent grave, aucun lien.
3. **Sa version anglaise** `docs/aide/fiches/en/brancher-ma-boutique-shopify.md` (`slug`, `traduit_de`).
4. **Ses captures** : un scénario `web/e2e/captures/brancher-ma-boutique-shopify.capture.ts`, la vraie console et des
   données inventées (les simulations de `web/e2e/shopify.spec.ts`), une capture par étape, FR et EN, converties par
   `scripts/aide/captures-webp.mjs`. Lancé seul, sur un port libre vérifié avant (un serveur d'une autre session sur le
   3000 serait capturé à la place).
5. **`npm run vitrine:aide`** : la page FR et EN, l'accueil du centre, les menus des autres pages, le plan du site,
   `llms.txt`.
6. **Le logo Shopify** : le kit téléchargé dans un dossier vide du scratchpad, le SVG noir et le blanc copiés sous
   `site/img/logos/`. HubSpot et Salesforce reprennent les tracés déjà montrés sur l'accueil, Claude et Codex ceux de
   `scripts/vitrine/logos-assistants.ts`.
7. **La page `/integrations/`** (écrite à la main) et sa jumelle `/en/integrations/` (générée, dictionnaire
   `scripts/vitrine/anglais/integrations.json`, entrée dans `JUMELLES`) : Shopify, HubSpot, Salesforce, Claude Code,
   Codex, un logo et une ligne chacun, sans offre ni état, puis une case « vos autres outils » (API, webhooks, MCP).
   Shopify mène à la fiche publique, HubSpot et Salesforce à « Analyse de conversations », Claude Code et Codex aux pages
   développeurs. Au menu Ressources (gabarits `entete.<langue>.html`, puis `npm run vitrine:entete`), au plan du site,
   dans `llms.txt`, avec son fil d'Ariane en JSON-LD.
8. **L'accueil** : une rangée de logos après « Ils nous font confiance », « Se branche à vos outils », qui mène à
   `/integrations/`. La jumelle anglaise par `npm run vitrine:anglais`.
9. **Les tarifs** : dans la Free, Shopify par Claude Code (relance de panier et messages de commande) ; dans le Pro, la
   carte Shopify de la console. Sans `data-fonction` : Shopify n'est pas une fonction d'offre du code.

**Marque Shopify** (§ 5 de la conception) : mentions de compatibilité seulement, logo noir ou blanc d'au moins 80 px de
large avec sa marge, jamais « partenaire », « officiel », « certifié » ni badge.

## Tests attendus

- `tests/aide-fiches-format`, `aide-fiches-anglais`, `aide-structure`, `aide-proposer`, `vitrine-aide` (la page égale à sa
  génération, une capture par étape et par langue), `vitrine-entete`, `vitrine-anglais`, `vitrine-pages`,
  `vitrine-langues`, `registre-vitrine`, `plan-methode` : la suite racine ENTIÈRE et le typecheck, lancés sur
  l'arbre exact du commit (extraction d'origin), avant le push.
- Un test qui garde la marque sur la page Intégrations : le logo Shopify monochrome, au moins 80 px, aucun des mots
  interdits sur les pages qui nomment Shopify.

## Ordre de déploiement

1. Rendu montré à Julien (bureau et téléphone, deux langues) : page Intégrations, bandeau de l'accueil, tarifs, page
   d'aide. Rien ne part sans son oui.
2. Annonce à la session « Cadrage du connecteur Shopify » (son lot B retouchera la même section et la même fiche), et
   aux sessions voisines : le push touche `site/`, donc lance la CI racine. Pas de push pendant la CI d'un pair.
3. Un seul commit en plomberie sur origin, puis la CI lue job par job.
4. `aide:charger` en production, pour que le bot d'aide de la console connaisse la fiche.

## Méthode de livraison

**En direct, sans agent**, parce que tout est réversible et qu'aucun chemin de production n'est touché : des pages
statiques, une fiche de doc et un scénario de capture lancé à la main, sans envoi, sans webhook, sans migration, sans
chiffre calculé. Un `git revert` et le redéploiement automatique de Vercel défont la vitrine ; un nouveau
`aide:charger` défait le bot. Les critères qui comptent sont visuels et de copie (promesse honnête, marque Shopify),
ce qu'un œil juge mieux qu'un test : d'où le rendu montré à Julien, et une seule relecture indépendante en fin de lot,
tournée vers la promesse et la marque.

**L'essai réel qui clôt** : Julien relit en ligne, sur ordinateur et sur téléphone, en français et en anglais, la page
Intégrations, le bandeau de l'accueil, les tarifs et la page d'aide ; chaque logo mène où il faut depuis l'accueil, la
page Intégrations et les tarifs ; et le bot d'aide de la console, interrogé sur « brancher ma boutique Shopify » après
`aide:charger`, répond avec la fiche.
