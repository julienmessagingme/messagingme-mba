# Le Crédit WhatsApp, notre côté : lots 1 à 4 (plan)

> **Pour l'exécutant :** superpowers:executing-plans, tâche par tâche (méthode ci-dessous). Les étapes se cochent
> (`- [ ]`). Plan court et sans code, comme le veut le `CLAUDE.md` global : les tâches, les interfaces, les tests attendus,
> l'ordre de déploiement. Ce qui dépend du partenaire (la fenêtre de Meta avec l'identifiant de la solution, l'attache de
> sa ligne) fera l'objet d'un plan à part, quand Julien l'aura (lot 5).

**But :** tout ce qui ne dépend pas du partenaire : la grille de Meta, le Crédit WhatsApp (solde, provisions, garde avant
chaque envoi, ajustement à l'accusé), les achats, la régularisation sur les volumes de Meta, l'option à 30 € par numéro et
la recharge automatique. Rien n'est visible d'un client tant qu'aucun de ses numéros n'est « sur la ligne ».

**Architecture :** un module neuf `src/credit-whatsapp/`. La garde vit **dans la fabrique d'envoi**
(`MetaClientFactory.clientForTenant`, le point de passage unique de tous les envois Meta, API et worker), comme les gardes
du numéro délié, du numéro suspendu et du quota des modèles : une dépendance REQUISE de la fabrique, et un inventaire dérivé
du code. Chaque chemin qui attrape `NumeroBloqueError` apprend le refus de crédit. Un numéro se met « sur la ligne » à la
main dans `/ops` tant que le partenaire n'est pas là : le solde, la garde et la régularisation s'éprouvent sur nos propres
numéros de test, encore payés par carte, donc avec le vrai `COST` de Meta pour comparer.

**Pile :** TypeScript, Fastify, Postgres et pg-boss, Next.js (console), Stripe, vitest.

**Spec :** [2026-10-30-credit-whatsapp-design.md](../specs/2026-10-30-credit-whatsapp-design.md). Cartographie du code
relevée le 2026-10-30 sur `origin/main` `18cb1c22` (sept parties, lecture seule).

## Méthode de livraison

**Implémenteur par lot (Claude implémente lui-même) et une relecture indépendante du diff à la fin de chaque lot**, parce
que chaque lot touche des chemins que la production emprunte (chaque envoi WhatsApp, l'accusé de Meta, un montant débité,
un paiement Stripe) et porte des invariants invisibles (provision et régularisation qui se compensent sans double débit,
idempotence des paiements, un seul crédit par paiement, une seule recharge en vol) ; ce n'est ni un balayage mécanique (pas
de workflow) ni une suite de critères testables sans œil (pas de feature-loop). Le correctif d'un rouge de relecture ne se
fait pas relire : son test, vérifié dans les deux sens, suffit.

**Essai réel qui clôt chaque lot**, en production, sur nos espaces de test (jamais Groupama) :
- lot 1 : Julien met un de nos numéros de test sur la ligne dans `/ops` ; à solde nul, une réponse de l'Inbox est refusée
  avec le lien de recharge, un lancement de campagne est refusé avec « il vous manque X € » ; sur un espace de test passé
  en Entreprise open bar, des envois partent et chacun apparaît dans `/ops` au prix de la grille, rendu quand l'accusé dit
  « non facturable » ;
- lot 2 : un achat de 50 € (carte de Julien, mode live) crédite une fois, avec sa facture ; une petite campagne débite au
  bon prix, se met en pause à zéro et repart seule après un second achat, sans double envoi ;
- lot 3 : le lendemain, la ligne de régularisation égale les volumes de Meta multipliés par la grille, et sur notre numéro
  payé par carte, le coût recalculé tombe à moins de 2 % du `COST` que Meta rend ;
- lot 4 : l'option prise par Stripe débloque une place ; la recharge automatique (seuil 10 €, montant 20 €) part une fois au
  seuil, et une campagne plus chère que le solde est rechargée avant le départ, en une facture.

## Contraintes globales

- **Le partenaire n'est nommé nulle part dans le dépôt** (code, commentaires, commits, docs) : « le partenaire ».
  `git grep -i <son nom>` vide avant chaque commit du chantier.
- Montants en **micro-euros** (`bigint`), un seul calcul du prix d'un message (`prixMessage`, tâche 2), réutilisé par la
  garde, l'estimation, l'ajustement, la régularisation et les écrans ; `facteurCommission` et `eurosDepuisMicro` de
  `src/agent/devise.ts`, jamais `microEurosDepuisDollars`.
- Commission des messages : **5 % pour toutes les offres**, réglable dans `/ops` sans déploiement, négociable par espace
  pour l'Entreprise ; jamais affichée en taux (un prix « commission comprise » s'affiche, jamais son taux).
- Recharges à la main : 50, 100, 250, 500 € HT. Recharge automatique : seuil d'au moins 5 €, montant de 20 à 1 000 € HT,
  sans plafond de fréquence, une seule en vol par espace. Option : 30 € HT par numéro et par mois, sans essai.
- **Tout s'arrête à zéro** : un envoi part si `solde - provision >= 0` ; un solde négatif (après une régularisation)
  n'envoie plus rien, même gratuit. Entreprise open bar : provision enregistrée, jamais refusée.
- Hors garde : un numéro qui n'est pas sur la ligne, un compte 360dialog (décidé sur le fournisseur que rend déjà
  `resolvePourEnvoi`, sans nouvel appelant), le mode `DRY_RUN`, l'agent de Meta (`agentEvent`), le RCS.
- Une catégorie de modèle se lit chez Meta, jamais dans la requête ni dans `campaigns.category` (choix de consentement).
- Migrations : le numéro se lit par `npm run migrations` au moment d'écrire ; celles que nomme un chemin chaud (l'envoi, la
  purge) partent SEULES et `migration=avant`, appliquées avant que leur code n'arrive sur `main`.
- Commits en `git commit --only <ses chemins>` ; un fichier de câblage partagé (`src/index.ts`, `src/server.ts`,
  `src/worker.ts`, `src/socle.ts`) se commite en plomberie et s'annonce aux sessions voisines.
- Chaque lot met à jour `documentation.md` (le présent : la garde dans la fabrique, les tables, les files) et le journal
  technique ; `features.md` à partir du lot 2, quand l'onglet existe, fiche d'aide et empreinte vérifiées par
  `tests/aide-proposer.test.ts` avant de pousser.
- Avant de pousser : `npm run typecheck`, `npm run lint`, la suite racine entière, `npx tsx scripts/auto-attaque.mts`, la
  suite de `web/` si la console bouge (`npm run doc:md` si un outil MCP change). Ni cadratin ni demi-cadratin ;
  vouvoiement dans la console.

## Points à surveiller en relecture

1. **Deux envois simultanés sur un solde qui n'en couvre qu'un** : un seul part. Test en tâche 3 (deux provisions
   concurrentes sur une vraie base, en intégration).
2. **Un envoi refusé par Meta après la provision** : un refus net (4xx) rend la provision, un doute (délai, réseau) la
   garde jusqu'à la régularisation, un rejeu interne (`withRetry`, repli de `sendMarketing` sur 134101) ne provisionne pas
   deux fois. Tests en tâche 4.
3. **Un accusé rejoué ou dans le désordre** (`sent` à tarif après `failed`) : l'ajustement est idempotent et l'échec
   l'emporte. Test en tâche 7.
4. **Un `COST` absent de `pricing_analytics`** : jamais lu comme un tarif nul, donc jamais « gratuit » à l'écran. Test en
   tâche 9.
5. **Une campagne qui tombe à zéro en route** : destinataires rendus à la file, pause `credit_whatsapp_epuise`, reprise
   après un achat sans double envoi. Tests en tâches 5 et 11.

## Choix de Claude à relire (la cartographie les a soulevés)

- La garde dans la fabrique plutôt que dans chaque interface d'envoi (la spec disait « dépendance requise de chaque
  interface ») : un seul point, que l'inventaire tient, comme délié, suspendu et quota.
- Un refus neuf, `CreditWhatsappRefus` (402 pour le solde, 409 pour une ligne inactive), plutôt qu'un troisième motif de
  `NumeroBloqueError`, dont toutes les traductions sont binaires.
- Destinataire sans numéro (identifiant Meta seul) ou catégorie de modèle illisible : provision au tarif le PLUS HAUT de la
  catégorie (ou des modèles) ; la régularisation corrige.
- Un parcours qui bute sur le crédit laisse le contact sur son bloc et met une campagne de scénario en pause (comme un
  numéro bloqué) ; hors campagne, il ne reprend pas seul.
- Une campagne programmée est contrôlée à son départ, pas à sa programmation ; un envoi unitaire (`/v1/sends`, Shopify,
  action HubSpot, `send_template_to_contact`) est refusé à la création plutôt que mis en pause des heures.
- **Codes promo fermés** sur les achats du Crédit WhatsApp et sur l'option (le crédit IA les garde ouverts) : un code à
  100 % y offrirait de vrais messages, payés au partenaire.
- Un achat de Crédit WhatsApp n'est permis qu'à un espace qui a au moins un numéro sur la ligne (hors Entreprise open bar).
- La marque « sur la ligne » vit dans une table à part, sans cascade depuis `phone_numbers`, pour que `/ops` sache encore
  qu'un compte reste sur la ligne après une déconnexion.
- Un seul numéro par espace aujourd'hui (`SecondNumeroRefuseError`) : l'option a une place en v1, la quantité Stripe est
  gardée pour plus tard.
- La franchise de service se compte par numéro et par mois civil UTC, sur notre journal des provisions (Meta compte par
  numéro ; le fuseau exact se vérifie au premier mois, la régularisation corrige l'écart).

---

## Lot 1 : la grille, le solde, la garde (rien de visible sans numéro sur la ligne)

Déploiement : la migration (tâche 1) part seule, `migration=avant`, appliquée et relue en base ; puis l'API et les workers
(tâches 2 à 9) ; la console `/ops` après l'API.

### Tâche 1 : la migration du lot 1

**Fichiers :** `db/migrations/<NNNN>_credit_whatsapp.sql` (numéro lu par `npm run migrations`), `tests/migration-<NNNN>.test.ts`,
`tests/numero-suspendu.test.ts` (dernière migration qui pose le CHECK des pauses).

**Interfaces produites (tables) :**
- `credits_whatsapp (tenant_id pk fk tenants on delete cascade, solde_micro_eur bigint not null default 0, maj_le)`.
- `credit_whatsapp_provisions (id uuid pk, tenant_id, phone_number_id, wamid text null, pays text null, categorie text not null,
  montant_micro_eur bigint not null, etat text check in ('provisionne','rendu','ajuste'), cree_le, livre_le null)`, unique
  `(tenant_id, wamid) where wamid is not null`, index `(tenant_id, cree_le)`.
- `credit_whatsapp_mouvements (id, tenant_id, delta_micro_eur bigint, raison text, jour date null, reference text null,
  note text null, le)`, unique `(tenant_id, reference) where reference is not null` (un paiement ne crédite qu'une fois),
  unique `(tenant_id, raison, jour) where raison = 'regularisation'`.
- `lignes_credit_whatsapp (id, tenant_id, phone_number_id, waba_id, origine text check in ('ops','option'), depuis, arretee_le
  null, note)`, SANS clé étrangère vers `phone_numbers`, index partiel `(phone_number_id) where arretee_le is null`.
- `grilles_meta (id, en_vigueur_le date, chargee_le, chargee_par, devise text check = 'EUR')` et
  `grille_meta_tarifs (grille_id, marche, categorie, palier int, prix_micro_eur bigint)`.
- `grille_prix.commission_messages_pct int not null default 5` (CHECK 0 à 100, bornes de `tests/prix-bornes.test.ts`).
- `tenants.entreprise_open_bar_whatsapp boolean not null default false`, `tenants.entreprise_commission_messages_pct int null`.
- `campaigns_pause_reason_check` redéfinie sous son nom (drop if exists puis add) avec `credit_whatsapp_epuise` et
  `ligne_credit_inactive` en plus des motifs existants ; `set local lock_timeout = '5s'` en tête.

- [x] Écrire `tests/migration-<NNNN>.test.ts` sur le SQL réel (`decouperInstructions`) : `lock_timeout` en premier, aucun
  accent grave, le CHECK des pauses porte exactement `MOTIFS_DE_PAUSE`, aucune clé étrangère vers `phone_numbers` sur
  `lignes_credit_whatsapp`. Le voir échouer.
- [x] Écrire la migration ; passer `tests/numero-suspendu.test.ts` sur la nouvelle migration du CHECK ; le test passe.
- [ ] Commit seul, déploiement `migration=avant`, relecture en base point par point (colonnes, CHECK sous leur nom, index
  partiels exacts).

### Tâche 2 : la grille de Meta et le prix d'un message

**Fichiers :** créer `src/credit-whatsapp/grille.ts`, `src/credit-whatsapp/marches-meta.ts`, `src/credit-whatsapp/grille.pg.ts` ;
modifier `src/http/ops.ts` (routes de la grille), `web/app/ops/page.tsx` (carte de l'onglet Réglages), `web/lib/api/compte.ts` ;
tests `tests/credit-whatsapp-grille.test.ts`, `tests/integration/credit-whatsapp-grille.integration.test.ts`.

**Interfaces produites :**
- `type CategorieMeta = 'marketing' | 'utility' | 'authentication' | 'authentication_international' | 'service'`.
- `normaliserCategorie(lue: string | null): CategorieMeta | null` (`marketing_lite` vaut `marketing`), partagée avec
  `parsePricing` et `extraireTarif`.
- `marcheDuPays(pays: string | null): string` (table `MARCHES_META` relevée sur la page de Meta, `'autres'` par défaut).
- `prixMessage(g: GrilleMeta, pays: string | null, categorie: CategorieMeta | null, commissionPct: number, palier = 0): number`
  en micro-euros, commission comprise ; pays ou catégorie inconnus : le prix le plus haut de la catégorie, ou des modèles.
- `PgGrilleMetaStore.enVigueur(): Promise<GrilleMeta | null>` en cache de 60 s par processus ;
  `charger(g, auteur): Promise<string>` ; `GET /ops/grille-meta`, `PUT /ops/grille-meta` (Zod strict, refus qui nomme la
  ligne fautive, note signée, `journaliser('warn')`), drapeau « périmée » si elle date d'avant le trimestre en cours.
- La carte `/ops` lit le CSV en euros que Meta publie DANS le navigateur et envoie le JSON validé : un seul geste pour Julien.

- [x] Récupérer le CSV en euros de Meta du trimestre et le figer en fixture (`tests/fixtures/grille-meta-eur.csv`).
- [x] Tests unitaires : prix France marketing et utility égaux à la fixture fois 1,05 ; `+1` et `+44` départagés par le pays
  (`paysDuNumero`) ; pays inconnu et catégorie nulle au plus haut ; `marketing_lite` normalisé ; palier 1 moins cher que le
  palier 0 pour utility. Les voir échouer, implémenter, les voir passer.
- [x] Intégration (CI) : chargement daté, lecture de la version en vigueur, refus d'une ligne invalide.
- [x] Commit.

### Tâche 3 : le magasin du Crédit WhatsApp

**Fichiers :** créer `src/credit-whatsapp/credit.ts` (types, raisons), `src/credit-whatsapp/credit.pg.ts` ; construire le
magasin dans `src/socle.ts` (partagé API et worker, à côté de `PgCreditStore`) ;
tests `tests/credit-whatsapp-credit.test.ts`, `tests/integration/credit-whatsapp-credit.integration.test.ts`.

**Interfaces produites (`PgCreditWhatsappStore`) :**
- `provisionner(p: { tenantId: string; phoneNumberId: string; pays: string | null; categorie: CategorieMeta; montantMicroEur:
  number; openBar: boolean }): Promise<{ ok: true; provisionId: string } | { ok: false; soldeMicroEur: number }>` : un seul
  `update credits_whatsapp ... where tenant_id = $1 and solde_micro_eur - $2 >= 0 returning` (sans condition en open bar),
  puis l'insertion de la provision, dans une transaction.
- `rattacher(provisionId: string, wamid: string): Promise<void>` ; `rendre(provisionId: string): Promise<void>` (idempotent).
- `ajusterParWamid(tenantId: string, wamid: string, a: { facturable: boolean | null; type: string; categorie: CategorieMeta |
  null; echec: boolean }): Promise<void>` (tâche 7).
- `crediter(tenantId: string, deltaMicroEur: number, raison: 'achat' | 'recharge_auto', reference: string): Promise<{
  applique: boolean }>` : idempotent par `reference` (session Checkout ou facture).
- `solde(tenantId): Promise<number>` ; `historique(tenantId, depuis): Promise<LigneHistoriqueWa[]>` : les envois agrégés par
  jour de Paris à la lecture, les achats, les régularisations, sans note.
- `serviceDuMois(phoneNumberId: string, mois: string): Promise<number>` (franchise, sur les provisions de service).
- `regulariser(tenantId: string, jour: string, montantMicroEur: number): Promise<void>` : remplace la ligne `regularisation`
  du jour, et le solde bouge de la seule différence avec la ligne précédente (tâche 12).

- [x] Intégration (CI) : deux `provisionner` simultanés sur un solde qui n'en couvre qu'un, un seul `ok` ; `crediter` rejoué
  avec la même référence, un seul crédit ; `rendre` deux fois, un seul retour ; open bar, solde négatif permis. Les voir
  échouer, implémenter, les voir passer.
- [x] Unitaires : historique agrégé par jour de Paris (minuit du 1er novembre à Paris reste au 1er), aucune note exposée.
- [x] Commit (le socle en plomberie, annoncé).

### Tâche 4 : la garde dans la fabrique d'envoi

**Fichiers :** créer `src/credit-whatsapp/garde.ts`, `src/credit-whatsapp/refus.ts`, `src/credit-whatsapp/lignes.pg.ts` ;
modifier `src/meta/factory.ts` (option requise `creditWhatsapp`, Proxy de `clientForTenant`), `src/socle.ts` (construction),
les tests qui construisent la fabrique (fixture `sansLigneDeCredit` qui dit son hypothèse) ;
tests `tests/credit-whatsapp-garde.test.ts`, `tests/credit-whatsapp-inventaire.test.ts`.

**Interfaces :**
- Consomme : `prixMessage` (tâche 2), `PgCreditWhatsappStore` (tâche 3), `paysDuNumero` (`src/crm/phone.ts`), la catégorie
  du modèle lue chez Meta par un lecteur en liaison tardive (comme `listeDeLAgent` dans `src/socle.ts`).
- Produit : `class CreditWhatsappRefus extends Error { statusCode: 402 | 409; motif: 'solde' | 'ligne_inactive';
  manqueMicroEur: number | null }` ; `interface GardeCreditWhatsapp { avant(c: EnvoiAGarder): Promise<{ provisionId: string |
  null }>; apres(provisionId: string, wamid: string): Promise<void>; surEchec(provisionId: string, net: boolean):
  Promise<void> }` ; `MetaClientFactoryOpts.creditWhatsapp: GardeCreditWhatsapp` (requise) ; `PgLignesCreditStore.ligneDuNumero(
  phoneNumberId): Promise<LigneCredit | null>` en cache de 5 s, `poser`, `arreter`.
- Règles : provision AVANT l'appel à Meta, placée avant `avantUnModele` (un refus ne consomme ni modèle du mois ni retrait de
  liste) ; une provision par appel de méthode, hors des rejeux de `MetaClient.call` ; envois libres = `service`, modèles =
  catégorie lue chez Meta ; service dans la franchise du numéro = provision nulle ; ligne arrêtée = refus `ligne_inactive`.

- [x] Tests unitaires (fabrique au transport factice) : à solde insuffisant, chacune des neuf méthodes `send*` lève
  `CreditWhatsappRefus` SANS aucun POST ; un 4xx de Meta rend la provision, une erreur réseau la garde ; un rejeu de
  `withRetry` et le repli de `sendMarketing` ne provisionnent qu'une fois ; un client 360dialog, un numéro hors ligne et
  `DRY_RUN` ne provisionnent jamais ; le wamid rendu est rattaché.
- [x] Inventaire `tests/credit-whatsapp-inventaire.test.ts`, sur le modèle de `tests/optout-chemins.test.ts` : (a) les
  méthodes `send*` dérivées de `src/meta/client.ts` ; (b) `new MetaClient(` n'apparaît que dans `src/meta/factory.ts` ;
  (c) tout fichier qui attrape `NumeroBloqueError` traite aussi `CreditWhatsappRefus`, ou est classé avec une raison de plus
  de 60 caractères ; (d) aucune entrée fantôme.
- [x] Voir les tests échouer, implémenter, les voir passer ; commit (la fabrique et le socle en plomberie, annoncés).

### Tâche 5 : les chemins qui reçoivent le refus

**Fichiers :** `src/campaign/pause.ts` (motifs et messages), `src/campaign/engine.ts` (catch d'envoi et scénario),
`src/campaign/run-job.ts` (solde nul au démarrage : pause sans réserver), `src/account/numero-delie.pg.ts`
(`pauserCampagne` aux deux nouveaux motifs, `leverPausesCreditWhatsapp`), `src/numero/liberation.pg.ts`, `src/workflow/envois-bloc.ts`,
`src/workflow/executor.ts`, `src/agent/run-turn.ts`, `src/inbox/fil.ts`, `src/inbox/repondre.ts`, `src/inbox/envoi-operateur.ts`,
`src/http/inbox.ts`, `src/http/v1-messages.ts`, `src/mcp/outils.ts`, `src/mcp/outils-campagnes.ts`, `src/http/hubspot-modeles.ts`,
`src/http/hubspot-conversation.ts`, `src/shopify/envoi.ts`, `src/automation/runner.ts`, `src/server.ts` (gestionnaire commun),
`src/api/erreurs.ts` (codes `whatsapp_credit_exhausted` en 402 et `whatsapp_credit_line_inactive` en 409, OpenAPI).

**Interfaces :**
- Consomme : `CreditWhatsappRefus` (tâche 4).
- Produit : `MotifDePause` étendu de `'credit_whatsapp_epuise' | 'ligne_credit_inactive'` ;
  `leverPausesCreditWhatsapp(tenantId: string): Promise<number>` (tâche 11 l'appelle après un crédit).

- [x] Tests : le moteur rend le destinataire et pause `credit_whatsapp_epuise` (jamais `failed` ni `skipped`, jamais la porte
  de qualité) ; `run-job` pause avant tout `claim` ; un parcours à crédit nul n'exécute pas l'e-mail placé avant le modèle
  (vérification avant effets aux quatre points) ; un tour d'agent dont la réponse ne partirait pas ne débite pas le crédit
  IA ; le répondeur IA ne démarre pas, l'agent de Meta n'est pas bloqué ; Inbox, `/v1/messages`, MCP, HubSpot (clé
  d'idempotence rendue), Shopify (issue propre) rendent le code dédié ; `refuserLaReponse` reste exhaustive.
- [x] Voir échouer, implémenter, voir passer ; l'inventaire de la tâche 4 passe au vert ; commit.

### Tâche 6 : l'estimation avant un lancement

**Fichiers :** créer `src/credit-whatsapp/estimation.ts` ; modifier `src/campaign/lancement.ts` (dépendance requise à côté de
`modelesDuLancement`), `src/campaign/store.pg.ts` (requête calquée sur `modelesEnAttente`, avec `to_e164`),
`src/campaign/schedule-sweep.ts` (contrôle au départ), `src/api/envoi-public.ts` (refus à la création), `src/http/campaigns.ts`,
`src/mcp/outils-campagnes.ts` (`prepare_campaign` et `launch_campaign`), `web/components/campagne/EtapeRecap.tsx`.

**Interfaces produites :** `estimerCampagne(tenantId: string, campaignId: string): Promise<{ montantMicroEur: number;
soldeMicroEur: number; manqueMicroEur: number } | null>` (`null` hors ligne ou en open bar) ; issue de lancement
`{ ok: false; raison: 'credit_whatsapp'; manqueMicroEur: number }`.

- [x] Tests : un lancement dont l'estimation dépasse le solde est refusé avec le montant manquant en euros HT et le lien de
  l'onglet ; le `switch` de la route traite le cas (aucune réponse vide) ; une campagne de scénario s'estime sur son premier
  modèle ; un envoi unitaire à solde insuffisant est refusé à la création ; un espace hors ligne n'est pas estimé.
- [x] La règle « aucun prix en euros » de `EtapeRecap` et de `prepare_campaign` ne vaut plus pour un espace sur la ligne :
  test qui l'affiche sur la ligne et jamais ailleurs.
- [x] Voir échouer, implémenter, voir passer ; commit.

### Tâche 7 : l'ajustement à l'accusé

**Fichiers :** `src/webhooks/delivery.ts`, `src/webhooks/handler.ts` (puits requis à côté de `tarifsMeta`),
`tests/webhook-fixtures.ts` (fixture neutre), câblage des files `webhook` et `webhook-status` dans `src/worker.ts`.

**Interfaces :** consomme `PgCreditWhatsappStore.ajusterParWamid` (tâche 3) et `normaliserCategorie` (tâche 2).

- [x] Tests : `facturable: false` ou type `free_*` rend la provision ; une catégorie différente la corrige au prix de la
  grille ; `failed` la rend même traité après un `sent` à tarif ; un accusé rejoué ne change rien ; l'instant `delivered`
  date la provision (`livre_le`) ; best-effort : un échec d'ajustement ne fait pas échouer le job.
- [x] Voir échouer, implémenter, voir passer ; commit (le worker en plomberie, annoncé).

### Tâche 8 : `/ops`, numéro de test sur la ligne, Entreprise open bar, commission

**Fichiers :** `src/http/ops-offre.ts` (open bar et commission négociée dans le corps de l'Entreprise),
`src/offres/offre.pg.ts`, `src/offres/offres.ts` (`SurchargeEntreprise`), `src/credit-whatsapp/commission.ts`, une route `/ops`
« numéro sur la ligne » (dans `opsOffre`, sans entrée de registre neuve), `src/stats/prix.ts` et `src/settings/store.pg.ts`
(commission globale dans la grille de prix), `web/app/ops/page.tsx`, `web/lib/ops-offre.ts`, `web/lib/partage/actions-journal.ts`.

**Interfaces produites :** `commissionMessagesPour(tenantId: string): Promise<number>` (la négociée de l'Entreprise, sinon la
globale) ; `POST /ops/tenants/:tenantId/ligne-credit` `{ phoneNumberId, poser: boolean, note }` : numéro de CET espace,
fournisseur Meta, hors coexistence, note signée, trace.

- [x] Tests : open bar et commission négociée ignorés hors Entreprise (état effectif après écriture) ; la route refuse un
  numéro d'un autre espace (404), un numéro 360dialog, un numéro en coexistence ; la commission globale garde ses bornes
  (`tests/prix-bornes.test.ts`) ; l'action entre au journal avec ses libellés.
- [x] Voir échouer, implémenter, voir passer ; commit.

### Tâche 9 : les écrans de coût sur la ligne

**Fichiers :** `src/meta/pricing.ts` (`COST` absent distingué de zéro), `src/stats/chiffrage.ts` (`prixFactures`, `getPricing`),
`src/stats/cout-messages.ts`, `src/http/stats.ts` (champ facultatif `surLaLigne`), `src/mcp/outils-chiffres.ts`,
`web/lib/api/stats.ts`, `web/components/...` des cartes de coût (`FactureCard`, `TemplateBreakdownCard`, `CostChartCard`),
l'Accueil et la page Campagnes.

- [x] Tests : `parsePricing` sans `COST` rend un coût inconnu, jamais 0, et aucun écran ne lit « gratuit » ; un espace sur la
  ligne lit ses montants dans le journal des provisions (ce qu'il a payé), commission comprise, sans parler de facture Meta ;
  un espace hors ligne ne change pas d'un caractère ; `cout_estime` du MCP suit.
- [ ] Voir échouer, implémenter, voir passer ; commit. Fin du lot 1 : relecture indépendante, puis essai réel.

### Écarts du lot 1, relevés à la livraison (2026-10-30)

1. La commission globale vit dans `credit_whatsapp_reglages` (une ligne, migration 0264), pas dans la grille de prix :
   `src/stats/prix.ts` et `src/settings/store.pg.ts` ne bougent pas. Sa borne (0 à 100) est tenue par la contrainte et par
   la route (`tests/ops-credit-whatsapp.test.ts`).
2. Le magasin expose des primitives (`rendreParWamid`, `corrigerParWamid`, `marquerLivre`, `provisionDuWamid`) au lieu d'un
   `ajusterParWamid` unique ; l'ajustement de la tâche 7 les compose (`src/credit-whatsapp/ajustement.ts`).
3. La ligne a une date de retrait (`retiree_le`) en plus de l'arrêt : un numéro arrêté reste bloqué par la garde, un numéro
   retiré revient à la normale. L'unicité d'une ligne en cours porte sur `retiree_le is null`.
4. Les codes publics `whatsapp_credit_*` entrent au contrat de l'API au lot 2, avec le refus à la création d'un envoi
   unitaire (`src/api/envoi-public.ts`) : aucun client n'est sur la ligne avant. D'ici là, la garde refuse l'envoi.
5. La route du numéro sur la ligne est `GET|POST /ops/credit-whatsapp/ligne/:tenantId`, dans le module `/ops` du Crédit
   WhatsApp ; elle rend aussi le solde et les 50 dernières provisions, que l'essai réel du lot 1 lit dans `/ops`.
6. Les conditions (open bar, commission négociée) se lisent par `PgConditionsCreditStore` (`conditions.pg.ts`, cache de 5 s
   sans invalidation à câbler), et l'open bar retombe en base quand l'Entreprise est retirée.
7. Le prix en euros de `EtapeRecap` passe au lot 2 : la console crée la campagne au clic, sans identifiant avant, et le prix
   par catégorie viendra de la route d'espace du lot 2. D'ici là, le refus du lancement dit « il vous manque X € HT » sous
   le bouton et la campagne reste en brouillon ; `prepare_campaign` donne déjà l'estimation (son brouillon existe).
8. Les cartes de coût lues dans le journal des provisions (`FactureCard`, `TemplateBreakdownCard`, `CostChartCard`, Accueil,
   Campagnes, `cout_estime`) passent au lot 2, avec la route d'espace : aucun espace n'est payé par la ligne d'un partenaire
   avant le lot 5 (un numéro d'essai posé dans `/ops` reste facturé à notre carte, et Meta rend son `COST`). La protection
   vaut dès le lot 1 : un `COST` absent rend le résumé inconnu (`parsePricing` rend `null`), l'écran montre le volume seul.
9. Une campagne programmée mise en pause à son départ faute de crédit garde son `scheduled_at` passé : la reprise du lot 2
   (`leverPausesCreditWhatsapp`) la remet en `scheduled`, que le balayage reprend aussitôt, et non en `running`.
10. 🔴 POUR LE LOT 2, AVANT TOUT CLIENT SUR LA LIGNE (relecture du lot 1, constat 1) : un refus du crédit au MILIEU de la
    liste d'un bloc de scénario rejoue, à la reprise, ce qui était déjà parti (le modèle est envoyé et payé deux fois),
    pour une campagne de scénario comme pour la réponse d'un contact (`apply` relance le refus sans écrire le parcours).
    Correctif : convertir le refus en refus d'étape dès qu'un envoi du bloc est parti, et lire `bloque()` aux points où
    `verifierNumeroWhatsApp` est déjà lu (un bloc e-mail avant un modèle ne part plus à sec). Impossible au lot 1 : aucun
    solde n'y est jamais positif (aucun achat, l'open bar ne refuse rien).
11. La déconnexion d'un numéro ne retire pas sa ligne (aucune clé étrangère vers `phone_numbers`, par choix) : relié ensuite
    à un autre espace, il y est bloqué. `/ops` le retire désormais depuis l'espace de sa ligne, même sorti de l'espace
    (relecture, constat 2) ; au lot 4, la sortie de l'option le retire d'elle-même.
12. La migration prend le numéro 0264 : des pairs ont pris 0262 puis 0263 pendant le lot (`0262_seuils_capacite.sql`,
    `0263_etage_repondeur.sql`). Elle part SEULE,
    par un commit construit sur `origin/main` (la migration, son test, `pause.ts` et la partie CHECK de
    `tests/numero-suspendu.test.ts`), déployée en `migration=avant` avant que le code n'arrive sur `main`.
13. Corrigés après la relecture du lot 1 (constats 3, 5, 6, 7, 9, 10) : un solde nul ne laisse plus rien partir, même un
    message de la franchise (« tout s'arrête à zéro, réponses comprises ») ; le répondeur arrêté par le Crédit WhatsApp passe
    à l'équipe avec sa propre cause ; seul un compte sans AUCUN coût facturé rend le résumé de Meta inconnu ; l'accusé
    compare le PRIX exact de la catégorie facturée au montant provisionné ; un 5xx de Meta garde la provision ; les
    destinataires se groupent par neuf caractères, et la franchise se compte par un index partiel ; `/ops` refuse de
    poser un numéro tant qu'aucune grille n'est en vigueur.
14. Pour les lots suivants : après « Retirer », l'accusé ne corrige plus les provisions du numéro (il lit la ligne en
    cours ; la régularisation du lot 3 tranche) ; la ligne d'un numéro et la catégorie d'un modèle se relisent sans
    mutualiser les lectures en vol, et un échec de lecture chez Meta n'est pas gardé en cache (lot 2) ; les textes du
    refus et de la pause promettent la recharge et la reprise automatique, que le lot 2 rend vraies.
15. Essai réel du lot 1 : retirer l'open bar (ou l'Entreprise) laisse le solde négatif des envois de l'essai, et chaque
    envoi est alors refusé ; aucun crédit n'est possible au lot 1, seul « Retirer » le numéro de la ligne rend l'espace à
    la normale.

## Lot 2 : acheter et suivre son Crédit WhatsApp

### Tâche 10 : les achats par Stripe

**Fichiers :** créer `src/stripe/offres-whatsapp.ts` (quatre offres, crédit dérivé du HT), `src/stripe/achat-whatsapp.ts` ;
modifier `src/stripe/traitement-recharge.ts` (aiguillage par `metadata.produit = 'credit_whatsapp'` AVANT la recharge IA),
`src/stripe/store.pg.ts` (transaction sœur de `crediterPaiement`), `src/stripe/client.ts` (codes promo fermés pour ce produit),
`src/config.ts` et `.env.example` (`STRIPE_PRIX_WA_50`, `_100`, `_250`, `_500`, ensemble ou aucun ; vides = 503),
route d'achat dans un module d'espace neuf `creditWhatsapp` (`src/server.ts`, classe `tenant`, admin et `limiteCouteuse`).

**Interfaces produites :** `ouvrirAchatCreditWhatsapp(tenantId: string, offre: OffreWa, userId: string): Promise<{ url: string }>`
(prix relu chez Stripe avant d'ouvrir, euros, refus Free et sans numéro sur la ligne).

- [ ] Tests : un avis rejoué ne crédite qu'une fois ; un montant encaissé différent de l'offre ne crédite rien et alerte ; un
  achat WhatsApp ne crédite jamais le crédit IA et n'appelle pas `remonterPlafondApresRecharge` ; une image plus ancienne
  qui reçoit le produit inconnu alerte au lieu d'acquitter ; la route refuse la Free et un espace sans ligne ; mode test
  réservé aux exploitants.
- [ ] Voir échouer, implémenter, voir passer ; commit.

### Tâche 11 : l'onglet Crédit WhatsApp, Claude, les alertes, la reprise

**Fichiers :** créer `web/components/OngletCreditWhatsapp.tsx`, `web/lib/api-credit-whatsapp.ts` ; modifier
`web/app/offre/page.tsx` (troisième onglet `?tab=whatsapp`, absent en Free et en open bar), `src/offres/vue.ts` et
`web/lib/offre.ts` (champs facultatifs), `src/mcp/outils-agent.ts` (`get_credit` montre le solde WhatsApp,
`buy_credit` prend le solde visé), `src/emails-produit/catalogue.ts` et `alertes.ts` (bas sous 10 € une fois par recharge,
zéro une fois par jour, FR et EN, partenaire jamais nommé), `src/mcp/mise-en-service.ts` (avertissement de solde nul),
l'appel de `leverPausesCreditWhatsapp` après chaque crédit, et un balayage de secours horaire (`src/worker.ts`,
`src/worker/roles.ts`).

- [ ] Tests : l'onglet affiche solde, historique (envois du jour, achats, régularisations), les quatre boutons et le prix
  d'un message par catégorie pour la France, commission comprise, jamais son taux ; retour de
  paiement lu sur la ligne d'achat ; `get_credit` et `buy_credit` ; e-mails dédoublonnés par leur occasion ; une campagne en
  pause `credit_whatsapp_epuise` repart après un crédit, et pas une campagne dont le numéro a été libéré ; doc générée et FAQ
  du plugin à jour.
- [ ] Voir échouer, implémenter, voir passer (suite `web/` comprise) ; commit. Fin du lot 2 : relecture, essai réel.

## Lot 3 : la régularisation sur les volumes de Meta

### Tâche 12 : lire les volumes, recalculer, régulariser

**Fichiers :** `src/meta/pricing.ts` (méthode neuve `volumesDuCompte`, sous un autre nom que `getPricingAnalytics`),
créer `src/credit-whatsapp/regularisation.ts` ; minuterie horaire dans `src/worker.ts`, rangée dans `TACHES_PAR_ROLE`
(`principal`) ; vue `/ops` du mois par espace (`src/ops/store.pg.ts`, `web/app/ops/page.tsx`).

**Interfaces produites :** `volumesDuCompte(wabaId: string, debut: number, fin: number): Promise<VolumeMeta[] | null>`
(dimensions `COUNTRY`, `PHONE`, `PRICING_CATEGORY`, `PRICING_TYPE`, `TIER`, granularité `DAILY`, pagination suivie, jeton
du compte par `resolveForWaba`) ; `passeRegularisation(deps): Promise<number>` (espaces un par un, un échec n'arrête pas
les autres) ; pour chaque jour UTC d'aujourd'hui et d'hier : coût recalculé (volumes `REGULAR` × grille au palier lu ×
commission) moins les provisions livrées ce jour-là = la ligne `regularisation` du jour, remplacée à chaque passe.

- [ ] Tests : régularisation idempotente (deux passes, une seule ligne du jour) ; volumes facturés au-delà de nos envois
  = « hors Messaging Me » (e-mail au client, alerte `/ops`), les réponses de l'agent de Meta vues passer exclues ; solde
  sous -50 € = alerte « faire retirer la ligne » ; open bar : le montant du mois à facturer ; sur un compte qui rend
  encore `COST`, l'écart entre recalcul et `COST` est affiché dans `/ops`.
- [ ] Voir échouer, implémenter, voir passer ; commit. Fin du lot 3 : relecture, essai réel.

## Lot 4 : l'option et la recharge automatique

### Tâche 13 : l'option à 30 € par numéro

**Fichiers :** migration `options_credit_whatsapp` (modèle `abonnements_offre`, une vivante par espace, quantité bornée) ;
créer `src/stripe/option-credit-whatsapp.ts` ; modifier `src/stripe/client.ts` (produit, jamais d'essai, métadonnées
session et abonnement), `src/stripe/traitement-abonnements.ts` (aiguillage par `metadata.produit` avant le numéro, quantité
relue à chaque mise à jour, fin sur impayé), `src/offres/numero-inclus.ts` et `src/http/ops-offre.ts` (fin de l'option quand
plus aucune offre n'y donne droit, résiliation sans remboursement), `src/ops/suppression-espace*.ts` (troisième produit),
`src/config.ts` (`STRIPE_PRIX_OPTION_WA`), routes du module `creditWhatsapp`.

**Interfaces produites :** `placesPayees(tenantId): Promise<number>` ; `placeLibre(tenantId): Promise<boolean>` (lue par la
connexion du lot 5) ; `ouvrirOption(tenantId, userId): Promise<{ url: string }>` ; `finDeDroitOption(tenantId): Promise<void>`.

- [ ] Tests : une place n'existe que quand Stripe la relit payée ; la fin du Pro sans Business ni Entreprise résilie
  l'option, une Entreprise qui reste ne la résilie pas ; un retrait du Business dans `/ops` l'annonce puis la résilie ; un
  impayé abandonné par Stripe arrête les envois des numéros de la ligne (`ligne_credit_inactive`), pas le premier échec ;
  la suppression d'un espace résilie l'option.
- [ ] Voir échouer, implémenter, voir passer ; commit (migration d'abord, seule, `migration=avant`).

### Tâche 14 : la recharge automatique et la recharge avant le départ

**Fichiers :** migration `credit_whatsapp_recharge_auto (tenant_id pk, active, seuil_micro_eur, montant_micro_eur,
eteinte_le, raison)` ; créer `src/credit-whatsapp/recharge-auto.ts` ; modifier `src/stripe/client.ts` (ligne de facture d'un
montant libre, facture `charge_automatically` sur la carte de l'abonnement de l'option, paiement hors session, clé
d'idempotence déterministe par seuil franchi), `src/stripe/traitement-abonnements.ts` (`invoice.paid` et
`invoice.payment_failed` d'une facture de recharge, aiguillées avant le numéro), une file pg-boss neuve
`credit-whatsapp-recharge` (BASE_QUEUES, rôle, consommateur là où Stripe est câblé), le verrou à trois pièces (bail, jeton,
relance) sur le modèle de `src/campaign/run-lock.ts`, `src/credit-whatsapp/estimation.ts` (recharge avant le départ),
l'onglet (réglage seuil et montant), les e-mails (recharge refusée, avec le lien de la facture).

**Interfaces produites :** `declencherRecharge(tenantId: string, cause: 'seuil' | 'campagne', montantMicroEur: number):
Promise<void>` (enfile) ; une campagne qui attend sa recharge passe en pause `credit_whatsapp_epuise` et repart au crédit.

- [ ] Tests : seuil franchi par une rafale d'envois = une seule facture ; montant hors bornes refusé (moins de 20 €, plus de
  1 000 €, seuil sous 5 €) ; échec ou authentification exigée = recharge éteinte, e-mail avec le lien ; avis de facture
  rejoué = un seul crédit ; une campagne plus chère que le solde, recharge active, déclenche une facture de ce qui manque
  (arrondi au multiple supérieur du montant choisi) et part au crédit ; recharge éteinte, le refus « il vous manque » reste.
- [ ] Voir échouer, implémenter, voir passer ; commit. Fin du lot 4 : relecture, essai réel.

## Lot 5 : avec le partenaire (plan à part, plus tard)

La fenêtre de Meta avec l'identifiant de la solution (`extras.setup.solutionID`), la marque « sur la ligne » posée par
`/embedded-signup/complete` sur une place payée et libre, l'attache de la ligne à notre demande, « ligne active » lue sur
141006, le repérage des comptes sur la ligne sans place payée, les textes de 141006 et de la carte Meta pour un numéro de la
ligne, la page « Connecter WhatsApp » et le guide (« Qui règle Meta ? », grisé en Free), la vitrine, l'aide et le plugin,
dès la livraison ; hors code, les conditions générales de Julien. Rien de ce lot ne s'écrit avant que Julien ait le
partenaire.
