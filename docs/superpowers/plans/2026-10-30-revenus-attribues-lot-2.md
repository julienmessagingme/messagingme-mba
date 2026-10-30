# Le chiffre d'affaires attribué, lot 2 : le lire (outil MCP, Quantitatif > Shopify, page Shopify)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** rendre lisible ce que les lots 0 et 1 enregistrent depuis le 2026-10-28 : un outil MCP pour toutes les
offres, Quantitatif > Shopify dans la console, et « récupérés » sur la page Shopify ; plus les deux suites de l'essai réel
du 2026-10-30 (l'issue de la relecture journalisée, le téléphone obligatoire dans le guide du marchand).

**Architecture :** UNE lecture, `chiffreVentes` (`src/shopify/chiffre.ts`), sur `ventes_attribuees` et
`relances_panier_jour`, appelée par la route de la console, l'outil MCP et l'état de la boutique : les trois disent le
même chiffre. Les montants restent des décimaux en texte, par devise ; les commandes de test sortent à part, dans la même
forme. Le lot A (API, outil, plugin) est déployé avant que le lot B (console) ne soit poussé.

**Tech Stack :** TypeScript, Fastify, Postgres (`pg`), vitest (intégration en CI seulement), Next.js (console), Playwright.

**Spec :** [docs/superpowers/specs/2026-10-28-revenus-attribues-design.md](../specs/2026-10-28-revenus-attribues-design.md),
§ « Où le chiffre se lit ». Ses lots 2 et 3 sont ici les lots A et B. Plan précédent :
[2026-10-28-revenus-attribues-lots-0-1.md](2026-10-28-revenus-attribues-lots-0-1.md).

## Global Constraints

- Montants : décimaux en texte calculés par Postgres (`trim_scale(sum(montant))::text`), jamais un flottant côté
  serveur, jamais une addition côté console. Totaux **par devise**, jamais deux devises additionnées.
- Commandes de test (`test = true`) : jamais dans le chiffre ; rendues à part, dans la même forme.
- Période : `DateRange` de `src/stats/range.ts` (dates de Paris, `to` inclus, 366 jours au plus, défaut 30 jours),
  bornes par `BOUNDS_CTE`. Les ventes se comptent par `payee_le` ; relancés, récupérés et montant récupéré par **date
  de relance** (`relances_panier_jour.jour`, `ventes_attribuees.relance_le`), comme la spec le décide.
- Récupérés = ventes `relance_panier`, quelle que soit leur preuve : le même ensemble que la ligne « Relance de panier ».
- La règle, en clair partout où le chiffre s'affiche : « Commandes payées dans les 5 jours après un message reçu,
  attribuées au dernier envoi. Prouvé : panier relancé payé, ou visite venue de vos liens WhatsApp. Remboursements non
  déduits. » Le mot « brut » accompagne le montant.
- Libellés des sources : `campagne` = « Campagne « <nom> » » (« Campagne supprimée » si la ligne n'existe plus),
  `relance_panier` = « Relance de panier », `scenario` = « Scénarios », `agent` = « Agent IA », `agent_meta` = « Agent
  de Meta » (le libellé de la spec). Dans l'outil MCP : `campaign`, `abandoned_checkout_reminder`, `scenario`, `ai_agent`, `meta_agent`.
- Outil MCP `get_revenue_stats` : scope `mcp:read`, `fonction: null` (toutes offres, Free comprise), textes en anglais,
  des agrégats seulement, jamais une personne ni un numéro de commande.
- Console : Quantitatif > Shopify, `fonction: 'statistiques'`, présent dans la barre seulement si l'espace a une
  boutique (connectée ou coupée : l'historique reste lisible). Vouvoiement.
- Jamais « UChat » ; aucun tiret cadratin ni demi-cadratin, dans le code, les textes et les commentaires.

## Review Focus

1. **Deux devises sur la période** (boutique changée de devise, autre boutique branchée) : deux totaux, jamais un
   seul. Test de la tâche 1 (intégration) et de la tâche 5 (l'écran affiche deux montants).
2. **Les commandes de test mêlées au chiffre** : l'espace de démonstration n'a QUE des commandes de test ; le chiffre réel
   y vaut zéro et les tests s'annoncent à part. Tâches 1, 3 et 5.
3. **Récupérés et ligne « Relance de panier » en désaccord sur le même écran** : une relance de la veille de la
   période, payée dans la période, compte dans la ligne (date de paiement) et pas dans les récupérés (date de relance).
   C'est la décision de la spec ; la carte des paniers dit donc « selon la date de la relance ». Tâche 5.
4. **Une campagne supprimée après la vente** (`campaign_id` passé à null) : la ligne reste, « Campagne supprimée »,
   jamais retirée ni fusionnée avec une autre. Tâche 1 (intégration).
5. **La console poussée avant l'API** : `/stats/ventes` rend 404, l'écran dit « pas encore disponible » ; la page
   Shopify lit les champs neufs absents comme zéro. Tâches 5 et 6.

## Méthode de livraison

**Implémenteur par lot + revue humaine du DIFF**, parce que le lot affiche un chiffre d'argent aux clients (un chiffre
faux fait prendre une décision) et que ses invariants sont invisibles du compilateur : jamais deux devises additionnées,
les tests à part, trois surfaces qui doivent dire le même nombre. Le chemin est en lecture seule et réversible, d'où pas
de migration ni de garde particulière. Un implémenteur, puis UNE relecture indépendante à la fin de chaque lot (A, puis
B).

**Ordre de déploiement** :
1. **Lot A** (tâches 1 à 4) poussé, CI lue job par job, puis `deploy-scaleway.yml`, `migration=aucune`, approuvé par
   Julien. Ensuite `plugin.yml` (la version du plugin monte dans la tâche 4).
2. **Lot B** (tâches 5 et 6) poussé APRÈS ce déploiement : la console appelle `/stats/ventes`. Puis `aide:charger` en
   production pour la fiche publique retouchée.

**Essai réel qui clôt le lot** : dans l'espace « Messaging Me demo » (boutique `messaging-me-essai`, commandes de test
des 2026-10-28 et 30), Julien demande à Claude Code « combien mes envois WhatsApp ont rapporté sur les 30 derniers
jours ? » :
l'outil rend un chiffre réel nul et, à part, 4 commandes de test pour 2 148,85 USD, dont 1 548,85 prouvés, et une
relance récupérée. Quantitatif > Shopify montre les mêmes nombres, la page Shopify ses récupérés ; dans un espace sans
boutique, l'entrée Shopify de Quantitatif n'apparaît pas.

---

### Tâche 1 : la lecture du chiffre (store et assemblage)

**Files :**
- Create : `src/shopify/chiffre.ts`
- Modify : `src/shopify/ventes.pg.ts` (méthode `lireChiffre`)
- Test : `tests/shopify-chiffre.test.ts`, `tests/integration/ventes-store.integration.test.ts`

**Interfaces :**
- Consomme : `SourceVente` (`src/shopify/attribution.ts`), `DateRange`, `BOUNDS_CTE`, `STATS_TZ` (`src/stats/range.ts`).
- Produit (dans `src/shopify/chiffre.ts`) :

```ts
export interface Montant { devise: string; montant: string }
export interface TotalVentes { devise: string; brut: string; prouve: string; commandes: number }
export interface LigneSourceVentes extends TotalVentes { source: SourceVente; campaignId: string | null; nom: string | null }
export interface BlocVentes { totaux: TotalVentes[]; sources: LigneSourceVentes[] }
export interface ChiffreVentes {
  periode: DateRange;
  reel: BlocVentes;
  test: BlocVentes;
  paniers: { relances: number; recuperes: number; montants: Montant[]; recuperesTest: number };
}
export function chiffreVentes(store: Pick<PgVentesStore, 'lireChiffre'>, tenantId: string, range: DateRange): Promise<ChiffreVentes>;
```

- Produit (dans `ventes.pg.ts`) : `lireChiffre(tenantId, range): Promise<LignesChiffre>`, où `LignesChiffre` porte
  `totaux` et `ventes` (chaque ligne avec `test`), `relances: number` et `recuperes: Array<{ test; devise; montant;
  commandes }>`.

- [ ] **Étape 1 : les tests d'intégration** (Postgres jetable de la CI), sur des ventes insérées à la main :
  `lireChiffre` sépare `test` et réel ; deux devises donnent deux totaux ; une campagne supprimée garde sa ligne avec
  `nom: null` ; une vente payée hors période n'entre pas ; `prouve` ne somme que les ventes à preuve ; `relances` somme
  `relances_panier_jour` des jours de la période ; une vente `relance_panier` relancée avant la période mais payée dedans
  entre dans `ventes` et pas dans `recuperes` ; un autre espace ne fuit jamais.
- [ ] **Étape 2 : le test unitaire de `chiffreVentes`**, avec un faux store DE CLASSE (sa méthode lit `this`) : le
  découpage `reel` / `test`, `recuperesTest`, et des tableaux vides (jamais `null`) pour un espace sans vente.
- [ ] **Étape 3 : écrire `lireChiffre`.** Trois requêtes sur un même jeu de paramètres `[tenantId, from, to, STATS_TZ]`
  avec `BOUNDS_CTE` : ventes groupées par `(test, source, campaign_id, devise)`, avec le nom de la campagne par
  `left join campaigns` sur le même espace, triées par montant décroissant, plus leurs totaux groupés par `(test, devise)` ;
  `coalesce(sum(n), 0)` de `relances_panier_jour` entre les deux dates ; récupérés groupés par `(test, devise)` sur
  `relance_le` dans les bornes ET `payee_le >= start_ts` (toujours vrai, une relance précède le paiement, et c'est ce qui
  laisse l'index `ventes_attribuees_lecture_idx` servir).
- [ ] **Étape 4 : écrire `chiffreVentes`**, qui ne fait que répartir : aucune arithmétique sur les montants.
- [ ] **Étape 5 :** `npm test`, `npm run typecheck`, `npm run lint` ; commit.

### Tâche 2 : la route de la console et l'état de la boutique

**Files :**
- Modify : `src/http/stats.ts` (`getVentes` dans `StatsRouteDeps`, route `GET /tenants/:tenantId/stats/ventes`)
- Modify : `src/shopify/gestion.ts` (`chiffreVentes` dans `DepsGestionShopify` ; `etatShopify` y lit les 7 derniers jours)
- Modify : `src/mcp/outils-shopify.ts` (`get_shopify_state` rend les récupérés)
- Modify : `src/index.ts` (câblage, UN `PgVentesStore` partagé)
- Test : `tests/http-stats-settings.test.ts`, `tests/offres-fonctions.test.ts`, `tests/shopify-gestion.test.ts`

**Interfaces :**
- Consomme : `chiffreVentes`, `ChiffreVentes` (tâche 1).
- Produit : `StatsRouteDeps.getVentes(tenantId: string, range: DateRange): Promise<ChiffreVentes>` ;
  `DepsGestionShopify.chiffreVentes(tenantId: string, range: DateRange): Promise<ChiffreVentes>` ; dans l'état de la
  boutique, `paniers.recuperes: number`, `paniers.montantsRecuperes: Montant[]`, `paniers.recuperesTest: number` ; dans
  `get_shopify_state`, `checkouts.recovered_last_7_days` et `checkouts.recovered_amount_last_7_days`.

- [ ] **Étape 1 : les tests.** La route rend 200 et le `ChiffreVentes` du dep pour une période valide, 400 sur une
  période illisible ; elle exige `statistiques` (`fonctionDesStatistiques` la classe déjà ainsi ; l'inventaire de
  `tests/offres-fonctions.test.ts` reçoit `'/stats/ventes': 'statistiques'`) ; `tests/scope-tenant.test.ts` la couvre
  sans rien ajouter. `etatShopify` appelle `chiffreVentes` sur 7 jours de Paris
  (`from = addDays(todayParis(), -6)`, `to = todayParis()`) et en reporte les trois champs.
- [ ] **Étape 2 : la route**, sur le modèle de `/stats/performance` (`espaceVerifie`, `parseRange`, 400 avec l'erreur).
- [ ] **Étape 3 : `etatShopify` et `get_shopify_state`**, sa description dit « recovered: checkouts reminded then paid,
  by reminder date, test orders excluded ».
- [ ] **Étape 4 : le câblage.** 🔴 `src/index.ts` est un fichier de câblage partagé : l'annoncer aux sessions voisines
  avant de l'éditer, et commiter en plomberie depuis `origin/main` (règle du dépôt). Un seul `new PgVentesStore(pool)`,
  réutilisé par `traitementShopify` ; les trois deps sont des flèches vers `chiffreVentes(ventesStore, ...)`.
- [ ] **Étape 5 :** `npm test`, `npm run typecheck`, `npm run lint`, `npx tsx scripts/auto-attaque.mts` ; commit.

### Tâche 3 : l'outil MCP `get_revenue_stats`

**Files :**
- Modify : `web/lib/partage/catalogue-mcp.ts` (`get_revenue_stats: { scope: 'mcp:read' }`, près des autres chiffres)
- Modify : `src/mcp/outils-chiffres.ts` (`chiffreVentes` dans `DepsChiffresMcp`, l'outil dans `OUTILS_CHIFFRES`)
- Modify : `scripts/plugin/familles-outils.ts` (famille « Statistics », après `get_ai_stats`)
- Modify : `src/index.ts` (le dep, même câblage que la tâche 2)
- Test : `tests/mcp-chiffres.test.ts`, `tests/mcp-serveur.test.ts`

**Interfaces :**
- Consomme : `chiffreVentes`, `ChiffreVentes` (tâche 1), `ENTREE_PERIODE.du` et `.au`, `lirePeriode` (période seule,
  aucune maille).
- Produit : la réponse de l'outil, en anglais :
  `{ period: { from, to, timezone }, rule, revenue: [{ currency, gross, proven, orders }], by_source: [{ source,
  campaign_id, campaign_name, currency, gross, proven, orders }], abandoned_checkouts: { reminded, recovered,
  recovered_amount: [{ currency, amount }] }, test_orders: { revenue, by_source, recovered } }`.

- [ ] **Étape 1 : les tests.** Avec un `chiffreVentes` simulé : les clés ci-dessus, les sources traduites
  (`relance_panier` donne `abandoned_checkout_reminder`), les montants rendus TELS QUELS (chaînes), `test_orders` à part ;
  sans `du` ni `au`, les 30 derniers jours ; une période illisible refusée par `RefusOutil`. Dans
  `tests/mcp-serveur.test.ts` : l'outil est listé pour une clé `mcp:read` et pour une Free (fonction `null`, donc
  absent de `FONCTION_DES_OUTILS`).
- [ ] **Étape 2 : l'outil.** `annotations: { title: 'Get the revenue from WhatsApp sends', readOnlyHint: true,
  openWorldHint: false }`. Sa description dit la règle (5 jours, dernier envoi livré, les quatre sources, ce qui n'en
  est jamais une), que « proven » veut dire panier relancé payé ou visite venue d'un lien WhatsApp, que tout le reste
  est une concordance dans le temps à présenter comme telle, que les remboursements ne sont pas déduits (gross), que
  seules comptent les commandes Shopify payées depuis le branchement, par devise, et que les commandes de test sont à
  part. Le champ `rule` redit la même chose en une phrase.
- [ ] **Étape 3 : les fichiers générés.** `npm run plugin:generer` (README du plugin et pages développeurs de la
  vitrine), puis `cd web && npm run doc:md` : dans le MÊME commit que le catalogue, sinon `ci.yml` et `ci-web.yml`
  rougissent.
- [ ] **Étape 4 :** `npm test`, puis `cd web && npm test` (la suite web ENTIÈRE, catalogue généré) ; typecheck, lint ;
  commit.

### Tâche 4 : les suites de l'essai réel (journal de la relecture, téléphone obligatoire)

**Files :**
- Modify : `src/shopify/preuve-utm.ts`
- Modify : `plugin/skills/shopify/SKILL.md`, `plugin/.claude-plugin/plugin.json` (version suivante)
- Test : `tests/shopify-preuve-utm.test.ts`

**Interfaces :**
- Produit : une ligne `shopify_preuve_utm` par relecture, `{ tenantId, commandeId, essai, issue }` au niveau `info`
  (`issue` parmi `IssuePreuve`). Aucune donnée de la personne.

- [ ] **Étape 1 : le test.** En espionnant la sortie de `journaliser` pour `info` : un cas `sans_preuve`, un cas
  `prouvee` et un cas `reessai` écrivent chacun UNE ligne `shopify_preuve_utm` avec leur issue et l'essai ; un job
  illisible garde sa seule ligne `shopify_preuve_job_illisible`.
- [ ] **Étape 2 : l'implémenter** dans `traiterPreuveUtm`, une seule sortie journalisée pour toutes ses issues.
- [ ] **Étape 3 : la skill `shopify`.** Après le branchement : faire régler dans Shopify, Paramètres > Paiement, le
  téléphone de l'adresse de livraison sur « Obligatoire » (sans lui, ni confirmation WhatsApp ni attribution) ; et une
  section « Revenue » : appeler `get_revenue_stats`, annoncer le brut et la part prouvée, ne jamais présenter une vente
  non prouvée comme causée par un message, mentionner les commandes de test à part. Ajouter `get_revenue_stats` à
  `allowed-tools`. Monter la version de `plugin.json`.
- [ ] **Étape 4 :** `npm test` ; commit. **Fin du lot A** : relecture indépendante, correctifs, push, CI, déploiement,
  puis `plugin.yml`.

### Tâche 5 : Quantitatif > Shopify (lot B, après le déploiement du lot A)

**Files :**
- Create : `web/app/dashboard/shopify/page.tsx`, `web/lib/ventes.ts`, `web/lib/ventes.test.ts`, `web/e2e/quanti-shopify.spec.ts`
- Modify : `web/lib/api.ts` (`getVentes`), `web/lib/nav.ts` (l'entrée et `navSansShopify`), `web/lib/nav.test.ts`,
  `web/components/AppShell.tsx` (`'quanti-shopify'` dans `Tab`, le filtre)

**Interfaces :**
- Consomme : `GET /tenants/:tenantId/stats/ventes?from&to` (tâche 2), `lireShopify` (`web/lib/api-shopify.ts`).
- Produit : `getVentes(tenantId: string, range: StatsRange): Promise<unknown>` ; `lireVentes(brut: unknown):
  ChiffreVentesVue | null` (mêmes champs que `ChiffreVentes`, lus défensivement : un champ absent donne un tableau vide
  ou zéro, une réponse sans `reel` donne `null`) ; `navSansShopify(items: NavEntree[], boutique: boolean): NavEntree[]`.

- [ ] **Étape 1 : les tests unitaires.** `lireVentes` : réponse complète, réponse d'une API plus ancienne (champs
  absents), réponse illisible. `navSansShopify` : retire `quanti-shopify` quand `boutique` est faux, à toute
  profondeur, et ne touche rien d'autre.
- [ ] **Étape 2 : l'entrée de barre.** `{ key: 'quanti-shopify', href: '/dashboard/shopify', label: t('Shopify',
  'Shopify'), fonction: 'statistiques' }` après `quanti-performance`. Dans `AppShell`, quand l'onglet est `perf`, lire
  `lireShopify` UNE fois par espace (une variable de module suffit) ; `boutique !== null` montre l'entrée, une panne la
  cache. Le filtre passe avant `navPourOffre`.
- [ ] **Étape 3 : la page**, sur le modèle de `web/app/dashboard/performance/page.tsx` (barre de période
  `presetRange(30)`, états chargement, prêt, indisponible sur 404, illisible, erreur ; zones d'export comme ses
  voisines). Par devise : le brut en grand avec « brut », « dont prouvé », le nombre de commandes, la règle en une phrase
  dessous ; le tableau par source ; la carte des paniers (relancés, récupérés, montant récupéré, « selon la date de la
  relance »). Quand `test` n'est pas vide : une ligne discrète « n commandes de test, non comptées : <montants> ». Un
  montant se formate par `Intl.NumberFormat` dans sa devise. Aucune vente : « Aucune commande attribuée sur la
  période. »
- [ ] **Étape 4 : l'e2e** (API simulée comme `web/e2e/quanti-performance.spec.ts`) : avec une boutique, l'entrée est
  dans la barre et la page montre deux devises séparées et la ligne des tests ; sans boutique, l'entrée est absente ;
  `/stats/ventes` en 404 donne « pas encore disponible ».
- [ ] **Étape 5 :** `npm run aide:carte` (la barre a changé) ; `cd web && npm test`, `npx tsc --noEmit`, e2e de la
  page et de `quantitatif-sous-onglets.spec.ts` (serveur de production démarré soi-même) ; puis la suite racine ENTIÈRE
  (des tests de la racine lisent `web/`) ; commit.

### Tâche 6 : la page Shopify, `features.md` et la fiche d'aide

**Files :**
- Modify : `web/lib/api-shopify.ts` (`lireEtatShopify` lit les trois champs neufs), `web/components/ReglageShopify.tsx`
- Modify : `features.md` (une section NEUVE « Le chiffre d'affaires attribué (Shopify) » ; la section citée par la fiche
  `brancher-ma-boutique-shopify` n'est PAS touchée, son empreinte ne bouge pas)
- Modify : `docs/aide/fiches/brancher-ma-boutique-shopify.md` (publique : sa page de la vitrine et sa version `en/`)
- Modify : `documentation.md` (§ des tables `shopify_*` : la lecture unique et ses invariants)
- Test : `web/lib/shopify-assistant.test.ts` (qui teste déjà `lireEtatShopify`), `web/e2e/shopify.spec.ts`

- [ ] **Étape 1 : les tests.** `lireEtatShopify` : les trois champs lus, et absents (API ancienne) donnent zéro et un
  tableau vide. L'e2e de la carte : la ligne des paniers dit « N récupérés pour <montant> » et, s'il y en a, « dont n de
  test, non comptés ».
- [ ] **Étape 2 : la ligne de `ReglageShopify`** (`data-testid="integration-shopify-paniers"`), en français et en
  anglais, montants par `Intl.NumberFormat`.
- [ ] **Étape 3 : la doc.** `features.md` : où le chiffre se lit, la règle, « brut », les tests à part, toutes offres
  par Claude Code et Pro par la console. La fiche : un paragraphe « rendez le téléphone obligatoire au paiement » et un
  autre « ce que vos envois ont rapporté » ; puis `npm run vitrine:aide`, sa version anglaise retraduite, et
  `npm run aide:proposer` relu. `documentation.md` : les invariants de ce plan (une lecture, trois surfaces, par devise,
  tests à part, paniers par date de relance).
- [ ] **Étape 4 :** suites racine et web entières, `tests/aide-proposer.test.ts` vert AVANT le push ; commit. **Fin du
  lot B** : relecture indépendante, correctifs, push, `aide:charger` en production, puis l'essai réel.

## Hors du lot

Une colonne de chiffre dans la liste des campagnes, le ROAS, le détail par scénario, la déduction des remboursements, et
les autres restes des relectures des lots 1 et 6 (`todo.md`) : non retenus ici. La vitrine (page Boutiques Shopify) ne
parle pas encore du chiffre : à décider par Julien, à part.
