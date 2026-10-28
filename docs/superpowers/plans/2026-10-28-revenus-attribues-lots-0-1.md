# Le chiffre d'affaires attribué, lots 0 et 1 : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** mesurer ce que Shopify rend d'une commande (lot 0), puis enregistrer chaque commande payée d'un contact connu avec
sa source, sa preuve et son montant, et compter les relances, sans rien afficher encore (lot 1).

**Architecture :** l'attribution se calcule à la réception de `orders/paid`, avant l'envoi de la confirmation et sans
jamais le bloquer. Une fonction pure choisit la source parmi des « touches » qu'un store lit en base ; le résultat est
figé dans `ventes_attribuees`. Les UTM de la redirection (tâche 6) ne partent que si le lot 0 les a vus revenir.

**Tech Stack :** TypeScript, Fastify, Postgres (`pg`), Zod, vitest (unitaires, intégration en CI seulement).

**Spec :** [docs/superpowers/specs/2026-10-28-revenus-attribues-design.md](../specs/2026-10-28-revenus-attribues-design.md)

## Global Constraints

- Fenêtre : **5 jours**, fixe, constante `FENETRE_ATTRIBUTION_JOURS = 5`.
- Sources, dans cet ordre de valeurs en base : `campagne`, `relance_panier`, `scenario`, `agent` (origine `ia`),
  `agent_meta` (origine `mba`). Jamais une source : confirmation, expédition, `humain`, `mcp`, `api`, les lignes `[API] `.
- « Livré » : `delivered` ou `read` ; filière `application` : parti sans `failed`.
- Montant : total payé dans la **devise de la boutique** (`total_price_set.shop_money`), jamais en flottant.
- Une commande d'un inconnu ne crée jamais de fiche et n'écrit rien.
- UTM : `utm_source=whatsapp`, `utm_medium=messagingme`, `utm_campaign=<nom du modèle>` ; jamais `uchat`.
- Le numéro de migration se lit par `npm run migrations` au moment de l'écrire (noté `NNNN` ici).
- Pas de tiret cadratin ni demi-cadratin dans le code, les commentaires et les messages.

## Review Focus

1. **Une panne de l'attribution bloque la confirmation de commande** : le client attend son message, Shopify réessaie en
   boucle puis désabonne la boutique. Attendu : erreur journalisée, confirmation servie, 200 (tâche 4).
2. **`orders/paid` reçu deux fois** (Shopify réessaie) : une seule ligne (tâche 2).
3. **Les lignes Shopify et `[API] ` de Campagnes**, qui portent l'origine `campagne`, deviennent une touche : la
   confirmation se créditerait de la vente qu'elle confirme (tâche 2).
4. **Une commande sans `shop_money`** (ancienne version d'API) ou d'une devise illisible : repli sur `total_price` et la
   devise de la boutique, sinon rien d'écrit (tâche 3).
5. **Un numéro relié par l'application** (aucun accusé) : ses envois comptent quand même, sinon l'espace lit toujours 0
   (tâche 2).

## Méthode de livraison

**Implémenteur par lot + revue humaine du DIFF**, parce que le lot 1 touche le chemin chaud du webhook Shopify (les
confirmations de commande des clients), une migration que la purge RGPD nomme, et la redirection de tous les liens
tracés : trois chemins que la production emprunte, avec des invariants invisibles (index partiel d'unicité, ordre
migration avant code). Un implémenteur, puis UNE relecture indépendante en fin de lot.

**Essai réel qui clôt ces deux lots** : sur la boutique de dev branchée à l'espace SANDBOX, une campagne envoyée au
numéro de Julien, un clic sur son lien, une commande payée par la passerelle de test ; puis un panier abandonné, relancé,
payé. Une sonde en lecture seule de la production (`sonde-prod-scaleway`) lit deux lignes de `ventes_attribuees`
(`campagne` et `relance_panier`, preuve `panier` pour la seconde, `test = true`), et une commande payée sans envoi
préalable n'en laisse aucune.

**Ordre de déploiement** : (1) la migration seule, poussée et appliquée (`deploy-scaleway.yml`, `migration=avant`) avant
tout code qui la nomme ; (2) les tâches 2 à 5 ensemble ; (3) la tâche 6 si le lot 0 l'a permise. Les écrans et l'outil
MCP sont au lot 2, plan à part.

---

### Tâche 0 : la mesure (lot 0, aucun code)

**Fichiers :** la spec, section « La preuve par UTM » (le verdict s'y écrit).

- [ ] **Étape 1 : une commande de test venue d'une adresse UTM.** Sur la boutique de dev, ouvrir
  `https://<boutique>/products/<un produit>?utm_source=whatsapp&utm_medium=messagingme&utm_campaign=essai_utm` dans une
  fenêtre privée, cookies ACCEPTÉS, payer par la passerelle de test.
- [ ] **Étape 2 : relire la commande** par l'API Admin (jeton `client_credentials` de l'app, droit `read_orders`) :
  REST `orders/<id>.json?fields=landing_site,referring_site,test,total_price,total_price_set,currency` et GraphQL
  `order { test customerJourneySummary { lastVisit { landingPage utmParameters { source medium campaign } } } }`.
  Attendu à noter : `landing_site` porte-t-il la requête UTM ? `shop_money` est-il présent ? `test` vaut-il `true` ?
- [ ] **Étape 3 : la même commande, cookies REFUSÉS**, pour savoir ce qui reste.
- [ ] **Étape 4 : l'agent de Meta a-t-il des accusés ?** Sonde de production en lecture seule (`begin read only`,
  client dédié) : `select statut, count(*) from conversation_messages where direction = 'out' and origin = 'mba' and
  created_at > now() - interval '30 days' group by 1`. Que des `null` : ses envois suivent l'exception de la filière
  `application` (tâche 2, `livre`).
- [ ] **Étape 5 : écrire le verdict** dans la spec (trois lignes : UTM relus ou non, `shop_money`, accusés de `mba`).
  `landing_site` sans UTM et parcours vide : la tâche 6 et la règle 2 sortent du lot, `modeleUtm` reste `null`.

### Tâche 1 : la migration (déployée SEULE)

**Fichiers :**
- Créer : `db/migrations/NNNN_ventes_attribuees.sql`

**Interfaces :**
- Produit : les tables `ventes_attribuees` et `relances_panier_jour`, que les tâches 2 à 5 lisent et écrivent.

- [ ] **Étape 1 : écrire la migration**

```sql
create table if not exists ventes_attribuees (
  id           bigserial primary key,
  tenant_id    uuid not null references tenants(id) on delete cascade,
  -- NULL après anonymisation (fiche purgée, customers/redact, boutique effacée) : le fait reste, l'identité part.
  commande_id  text,
  contact_id   uuid references contacts(id) on delete set null,
  montant      numeric(18,3) not null check (montant >= 0),
  devise       text not null check (devise ~ '^[A-Z]{3}$'),
  payee_le     timestamptz not null,
  source       text not null check (source in ('campagne', 'relance_panier', 'scenario', 'agent', 'agent_meta')),
  campaign_id  uuid references campaigns(id) on delete set null,
  preuve       text check (preuve is null or preuve in ('panier', 'utm')),
  relance_le   timestamptz,
  test         boolean not null default false,
  cree_le      timestamptz not null default now(),
  constraint ventes_attribuees_relance_chk check ((source = 'relance_panier') = (relance_le is not null))
);
create unique index if not exists ventes_attribuees_commande_uidx
  on ventes_attribuees (tenant_id, commande_id) where commande_id is not null;
create index if not exists ventes_attribuees_lecture_idx on ventes_attribuees (tenant_id, payee_le);

create table if not exists relances_panier_jour (
  tenant_id uuid not null references tenants(id) on delete cascade,
  jour      date not null,
  n         integer not null default 0 check (n >= 0),
  primary key (tenant_id, jour)
);
```

- [ ] **Étape 2 :** `npm run typecheck && npm test -- tests/migration-directives.test.ts`, attendu vert.
- [ ] **Étape 3 : commit et push SEULS**, `docs(journal)` à part ; puis `gh run list` vert, déploiement
  `gh workflow run deploy-scaleway.yml --ref main -f migration=avant` (approbation de Julien) ; relire en base
  colonnes, CHECK sous leur nom (`pg_get_constraintdef`), prédicat exact de l'index partiel.

### Tâche 2 : le store des ventes

**Fichiers :**
- Créer : `src/shopify/ventes.pg.ts`, `src/shopify/attribution.ts` (les types seuls ; les fonctions à la tâche 3)
- Modifier : `src/shopify/store.pg.ts` (`effacerBranchement`, nouvelle méthode `compterRelance`)
- Test : `tests/integration/ventes-store.integration.test.ts`, `tests/integration/shopify-store.integration.test.ts`

**Interfaces :**
- Produit, dans `src/shopify/attribution.ts` :
  `type SourceVente = 'campagne' | 'relance_panier' | 'scenario' | 'agent' | 'agent_meta'` ;
  `interface Touche { source: SourceVente; le: Date; campaignId: string | null; modele: string | null; lanceScenario: boolean }` ;
  `interface VenteAttribuee { source: SourceVente; campaignId: string | null; preuve: 'panier' | 'utm' | null; relanceLe: Date | null }`.
- Produit, `class PgVentesStore` :
  - `touches(tenantId: string, contactId: string, depuis: Date, jusqua: Date, filiereApplication: boolean): Promise<Touche[]>`
  - `derniereToucheDuModele(tenantId: string, contactId: string, modele: string, jusqua: Date, filiereApplication: boolean): Promise<Touche | null>`
  - `panierRelance(tenantId: string, jeton: string): Promise<{ relanceLe: Date } | null>`
  - `enregistrer(tenantId: string, v: VenteAEnregistrer): Promise<'enregistree' | 'deja'>` où
    `VenteAEnregistrer = { commandeId: string; contactId: string; montant: string; devise: string; payeeLe: Date; test: boolean } & VenteAttribuee`
  - `anonymiserCommandes(tenantId: string, commandeIds: readonly string[]): Promise<number>`
- Produit, `PgShopifyStore.compterRelance(tenantId: string, le: Date): Promise<void>` (jour de Paris).

Les touches se lisent en deux sources :
- **`campaign_recipients` joint à `campaigns`** (index `(contact_id, sent_at desc)` existant) : `status = 'sent'`,
  `sent_at` dans la période, `delivery_status in ('delivered','read')` (ou, filière `application` ou campagne à
  `workflow_id`, simplement partie). `name = 'Shopify · panier abandonné'` donne `relance_panier` ; un nom qui commence
  par `'Shopify · '` ou par `PREFIXE_ENVOI_API` (`src/api/cible-rcs.ts`) n'est PAS une touche ; le reste est
  `campagne`, `lanceScenario = workflow_id is not null`, `modele = template_name`.
- **`conversation_messages`** des fils du contact (`matchWaIdPredicat`, `src/crm/contact-store.pg.ts`) :
  `direction = 'out'`, origine `scenario` / `ia` / `mba` vers `scenario` / `agent` / `agent_meta`, livré au sens des
  contraintes globales, `modele = template_name`.

- [ ] **Étape 1 : écrire les tests d'intégration qui échouent**, dans `ventes-store.integration.test.ts` :
  - `'une campagne livrée dans la période est une touche campagne, avec son modèle'`
  - `'🔴 les lignes Shopify (confirmation, expédition) et [API] ne sont jamais une touche'` : trois campagnes nommées
    `Shopify · commande payée · #1002`, `Shopify · commande expédiée · #1002`, `[API] essai`, livrées : `touches` rend `[]`.
  - `'la relance de panier est une touche relance_panier'`
  - `'un envoi seulement parti (sent) ne compte pas, sauf en filière application'`
  - `'les messages ia et mba sont des touches agent et agent_meta, humain mcp et api non'`
  - `'🔴 enregistrer deux fois la même commande rend deja et laisse une ligne'`
  - `'anonymiserCommandes vide commande_id et contact_id, garde montant, devise, source'`
  - dans `shopify-store.integration.test.ts` : `'effacerBranchement anonymise les ventes au lieu de les supprimer'` et
    `'compterRelance additionne par jour de Paris'` (deux appels à 23 h 30 UTC et 00 h 30 UTC un 28 octobre : deux jours).
- [ ] **Étape 2 :** ces tests ne tournent qu'en CI (Postgres jetable), jamais en local (le `DATABASE_URL` du poste
  pointe sur l'ancienne base) : `npm run typecheck`, attendu vert (les tests compilent contre les signatures).
- [ ] **Étape 3 : implémenter `PgVentesStore` et les deux changements de `PgShopifyStore`.** `effacerBranchement` :
  `update ventes_attribuees set commande_id = null, contact_id = null where tenant_id = $1` avant ses `delete`.
- [ ] **Étape 4 :** `npm run typecheck && npm run lint`, puis CI verte sur le job `integration`.
- [ ] **Étape 5 : commit** (`git commit --only` des fichiers de la tâche).

### Tâche 3 : le choix de la source (fonction pure) et le montant

**Fichiers :**
- Modifier : `src/shopify/attribution.ts` (créé à la tâche 2), `src/shopify/donnees.ts` (`schemaCommande`, `montantBoutique`)
- Test : `tests/shopify-attribution.test.ts`, `tests/shopify-donnees.test.ts`

**Interfaces :**
- Consomme : `Touche`, `SourceVente`, `VenteAttribuee` (tâche 2).
- Produit :
  - `const FENETRE_ATTRIBUTION_JOURS = 5`
  - `function choisirSource(e: { payeeLe: Date; touches: readonly Touche[]; panierRelance: { relanceLe: Date } | null; toucheUtm: Touche | null }): VenteAttribuee | null`
  - `function montantBoutique(c: CommandeShopify, deviseBoutique: string | null): { montant: string; devise: string } | null`
  - `schemaCommande` gagne `test: z.boolean().nullish()`, `landing_site: texte` et `shop_money` dans `total_price_set`
    (facultatif, `presentment_money` le devient aussi : `montantAffiche` doit garder son comportement).

Règles de `choisirSource`, dans l'ordre : panier relancé (`relance_panier`, preuve `panier`, `relanceLe` du panier) ;
`toucheUtm` (sa source, preuve `utm`, sans fenêtre) ; la touche la plus récente de `[payeeLe - 5 j, payeeLe]` ; sinon
`null`. Une touche gagnante `scenario` précédée, dans la fenêtre, d'une touche `campagne` à `lanceScenario` est créditée
à cette campagne (`source: 'campagne'`, son `campaignId`).

- [ ] **Étape 1 : tests qui échouent** (`shopify-attribution.test.ts`) :
  - `'le panier relancé gagne, même après une conversation avec l’agent'` : touches `[agent à J-1]`, panier relancé à
    J-2 : `{ source: 'relance_panier', preuve: 'panier', relanceLe: J-2 }`.
  - `'la touche UTM gagne, même hors fenêtre'` : `toucheUtm` campagne à J-9, touche agent à J-1 :
    `{ source: 'campagne', preuve: 'utm' }`.
  - `'sinon la dernière touche de la fenêtre, sans preuve'`
  - `'une touche à 5 jours pile compte, à 5 jours et une seconde non'`
  - `'un scénario lancé par une campagne revient à la campagne'`
  - `'aucune touche : null'`
  - dans `shopify-donnees.test.ts` : `'montantBoutique lit shop_money'`, `'repli sur total_price et la devise de la
    boutique'`, `'montant ou devise illisible : null'`, `'montantAffiche lit toujours presentment_money'`.
- [ ] **Étape 2 :** `npx vitest run tests/shopify-attribution.test.ts tests/shopify-donnees.test.ts`, attendu FAIL
  (fonctions absentes).
- [ ] **Étape 3 : implémenter.**
- [ ] **Étape 4 :** même commande, attendu PASS ; `npm run typecheck`.
- [ ] **Étape 5 : commit.**

### Tâche 4 : l'attribution à la réception de `orders/paid`

**Fichiers :**
- Modifier : `src/shopify/traitement.ts` (cas `orders/paid`, `effacerClient`, `DepsTraitementShopify`)
- Modifier : `src/shopify/attribution.ts` (`attribuerCommande`)
- Modifier : `src/http/shopify-webhooks.ts` (la `BoutiqueRecue` passée à `traiter` porte `devise`, déjà lue sur la boutique)
- Modifier : `src/index.ts` (câblage : fichier PARTAGÉ, annoncer avant, commit en plomberie)
- Test : `tests/shopify-traitement.test.ts`

**Interfaces :**
- Consomme : `PgVentesStore` (tâche 2), `choisirSource`, `montantBoutique` (tâche 3), `deps.ficheParTelephone`,
  `deps.filiere`.
- Produit : `DepsTraitementShopify.ventes: Pick<PgVentesStore, 'touches' | 'derniereToucheDuModele' | 'panierRelance' | 'enregistrer' | 'anonymiserCommandes'>` ;
  `BoutiqueRecue.devise: string | null` ;
  `attribuerCommande(deps: DepsTraitementShopify, b: BoutiqueRecue, c: CommandeShopify): Promise<void>`.

`attribuerCommande` : téléphone (`telephoneDeCommande`), fiche existante, montant, puis touches et choix ; une vente
`null` n'écrit rien. Appelée dans le cas `orders/paid` AVANT `fermerSiPanier` et `servir`, dans un `try/catch` qui
journalise `shopify_attribution_en_echec` (sans valeur personnelle) et laisse la suite se dérouler. `modeleUtm` se lit
de `landing_site` seulement si la tâche 0 l'a validé (sinon `toucheUtm = null`). `effacerClient` appelle
`anonymiserCommandes(orders_to_redact)` avant `effacerFiches`.

- [ ] **Étape 1 : tests qui échouent** (`shopify-traitement.test.ts`, faux `ventes` en classe dont les méthodes lisent
  `this`, règle du store injecté) :
  - `'🔴 une panne de l’attribution n’empêche pas la confirmation : 200 et envoi servi'`
  - `'une commande d’un numéro inconnu n’écrit rien et ne crée aucune fiche'`
  - `'une commande sans téléphone n’écrit rien'`
  - `'l’attribution se fait même quand la confirmation est éteinte'`
  - `'une commande de test s’enregistre avec test = true'`
  - `'customers/redact anonymise les commandes nommées'`
- [ ] **Étape 2 :** `npx vitest run tests/shopify-traitement.test.ts`, attendu FAIL.
- [ ] **Étape 3 : implémenter, puis câbler dans `src/index.ts`** (annonce aux sessions voisines avant l'édition).
- [ ] **Étape 4 :** suite entière `npm test`, `npm run typecheck`, `npm run lint`, `npx tsx scripts/auto-attaque.mts`.
- [ ] **Étape 5 : commit en plomberie** (patch sur origin, `GIT_INDEX_FILE` temporaire) à cause de `src/index.ts`.

### Tâche 5 : la purge RGPD et le compteur des relances

**Fichiers :**
- Modifier : `src/crm/contact-store.pg.ts` (`purgeMany`)
- Modifier : `src/shopify/relance.ts` (appel de `compterRelance` sur l'issue `envoye`)
- Test : `tests/integration/purge-rgpd.integration.test.ts`, `tests/shopify-relance.test.ts`

**Interfaces :**
- Consomme : `PgShopifyStore.compterRelance` (tâche 2).
- Produit : `DepsRelance.store` gagne `'compterRelance'`.

- [ ] **Étape 1 : tests qui échouent** :
  - `purge-rgpd.integration` : `'🔴 une vente attribuée perd son numéro de commande, garde montant, devise et source'`
  - `shopify-relance` : `'une relance envoyée compte une fois, une relance refusée ou fermée ne compte pas'`
- [ ] **Étape 2 :** `npx vitest run tests/shopify-relance.test.ts`, attendu FAIL.
- [ ] **Étape 3 : implémenter** : dans la transaction de `purgeMany`,
  `update ventes_attribuees set commande_id = null where tenant_id = $1 and contact_id = any($2::uuid[])`.
- [ ] **Étape 4 :** `npm test`, `npm run typecheck`, CI verte (`integration`).
- [ ] **Étape 5 : commit.**

### Tâche 6 : les UTM de la redirection (seulement si la tâche 0 les a vus revenir)

**Fichiers :**
- Créer : `src/links/utm.ts`
- Modifier : `src/links/tracked-links.pg.ts` (`DestinationLien` et sa requête), `src/http/links.ts` (`traiter`)
- Test : `tests/links-utm.test.ts`, `tests/http-links.test.ts`

**Interfaces :**
- Produit : `DestinationLien` gagne `modele: string | null` et `boutique: boolean` (boutique `connectee` de l'espace,
  lue DANS la même requête que le lien) ;
  `avecUtm(destination: string, modele: string): string` ;
  `modeleDeLanding(landing: string | null): string | null` (rend `utm_campaign` quand `utm_source=whatsapp` et
  `utm_medium=messagingme`), consommée par `attribuerCommande` (tâche 4) pour chercher `derniereToucheDuModele`.

- [ ] **Étape 1 : tests qui échouent** :
  - `'avecUtm ajoute source, medium et campagne'` ;
  - `'avecUtm n’écrase aucun utm_ déjà présent'` ;
  - `'avecUtm laisse une adresse illisible telle quelle'` ;
  - `'modeleDeLanding lit le modèle de nos seuls UTM'` (une adresse `utm_source=whatsapp` sans `utm_medium=messagingme` rend `null`) ;
  - `http-links` : `'sans boutique branchée, la destination ne change pas'`, `'avec boutique, la redirection porte les UTM après le remplissage des champs'`.
- [ ] **Étape 2 :** `npx vitest run tests/links-utm.test.ts tests/http-links.test.ts`, attendu FAIL.
- [ ] **Étape 3 : implémenter** (UTM appliqués après `remplirChampsUrl`).
- [ ] **Étape 4 :** suite entière, typecheck, lint, auto-attaque.
- [ ] **Étape 5 : commit**, puis le récit du lot au journal et `wip.md` à jour.
