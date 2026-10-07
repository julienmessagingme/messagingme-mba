# Lot 6 : les offres et leurs limites, plan

Spec : `docs/superpowers/specs/2026-10-07-offres-et-limites-design.md` (`f7433e03`), avec les neuf points tranchés
validés par Julien le 2026-10-07. Plan court : tâches, interfaces, tests attendus, ordre de déploiement. Le code se lit
dans origin (l'arbre partagé peut être en retard) ; commits en plomberie depuis une extraction, jamais depuis l'arbre
partagé.

**Objectif** : chaque espace a une offre (Base, Pro, Entreprise), calculée et lue en un seul endroit ; ce que l'offre
ferme est refusé là où l'action s'exécute, avec un code stable et le lien « Passer en Pro » ; le Pro se paie chez
Stripe, numéro fourni inclus ; les coûts de l'IA suivent l'offre.

## Méthode de livraison

**Implémenteur par lot + revue humaine du diff**, une relecture indépendante par livraison (A, B, C), parce que la
production emprunte ces chemins : le point d'envoi unique, les chemins de création des fiches, le webhook de Stripe,
une migration, un montant débité et des prix affichés. Le code porte des invariants invisibles : une seule définition
de l'offre (en SQL) ; une fiche née d'un message entrant ne compte jamais ; un Pro vivant couvre le numéro fourni
face au balayage du lot 4 ; le gel ne coupe jamais le répondeur. Aucun workflow multi-agents pour coder.

**L'essai réel qui clôt chaque livraison** : A, un espace d'essai ramené en Base dans `/ops` : la 101e fiche refusée
par l'API avec le lien (aucun outil MCP ne crée de fiche : `get_plan` dit l'offre), l'Inbox grisée, la 11e automation
refusée ; B, Julien prend le Pro sur cet espace
avec un code promo à 100 % : les fonctions s'ouvrent, le numéro fourni reste couvert, puis une résiliation immédiate
depuis le tableau de bord de Stripe : le gel s'applique et l'abonnement du numéro seul démarre ; C, le prix d'un tour lu
dans le journal du crédit en Base puis en Pro, et une conversation de l'espace Base qui reste non analysée.

## Contraintes globales

- Aucun tiret long dans le code, les commentaires et les docs.
- `tenant_id = $1` sur chaque requête d'espace ; dépendances requises, jamais optionnelles (les fixtures disent leur
  hypothèse : `toutOuvert`, `modelesIllimites`).
- Les valeurs de la grille (spec § 1) vivent UNE fois, dans `src/offres/offres.ts` ; aucune n'est recopiée ailleurs
  (la console et la doc publique les lisent par la route de l'offre ou par un test de parité).
- L'offre se lit par `offre_de_l_espace(tenant_id)` en SQL et par `OffresEnCache.offreDe(tenantId)` en TypeScript, qui
  appelle la même fonction : jamais une seconde définition.
- Les couches 1 et 2 (débit, quotas quotidiens de l'API) ne changent pas.
- Refus : statut 402, codes `plan_feature_unavailable` et `plan_limit_reached`, champ `upgradeUrl` (`APP_URL` + `/offre`).
- Si un compteur d'offre ne répond pas, l'action passe et l'incident est journalisé.
- Migration au numéro libre relu dans origin au moment de l'écrire (0217 est annoncée par RC6), appliquée AVANT le
  `up` ; la ligne du compteur de `CLAUDE.md` part dans le commit qui prend le numéro.
- La console n'est poussée qu'après le déploiement de l'API qui porte ses routes, et tolère leur absence.
- Toute retouche de `features.md` part avec la fiche d'aide qui cite la section et son empreinte
  (`tests/aide-proposer.test.ts` vert avant de pousser).
- Le registre de routes change : `scripts/auto-attaque.mts` se lance en local avant de pousser.
- Câblage partagé (`src/server.ts`, `src/index.ts`, `src/worker.ts`, `src/socle.ts`) : annoncé à la session RC6 avant
  d'y écrire.
- Aucune écriture réelle chez Stripe ou Meta pendant le développement : transports simulés dans les tests.

## Points de vigilance (chacun avec son test dans sa tâche)

1. Une fiche née d'un entrant puis complétée par l'API, l'import ou la console reste non comptée : la mise à jour ne
   touche jamais `ne_entrant` (tâche 5).
2. Deux envois concurrents autour du 1 000e modèle du mois : un seul passe, le compteur est atomique, tout ou rien
   (tâche 4).
3. Un espace qui vient de payer est en Pro tout de suite sur la copie qui reçoit le webhook, et en moins de 30 s
   ailleurs (cache court invalidé au webhook, tâche 11).
4. Un Pro vivant ne laisse jamais le balayage du lot 4 suspendre ni libérer le numéro fourni de l'espace (tâche 12).
5. Le gel ne coupe ni le répondeur (scénario système), ni une réponse dans la fenêtre de 24 h (tâche 13).
6. Une fiche supprimée ou anonymisée libère sa place ; une fiche dont on change le numéro n'en prend pas une seconde
   (tâche 5).

## Livraison A : l'offre, les fonctions, les compteurs (une migration)

**Tâche 1. Le module des offres** (`src/offres/offres.ts`, `tests/offres.test.ts`)
- `type Offre = 'base' | 'pro' | 'entreprise'` ; `type Fonction = 'inbox' | 'scenarios' | 'statistiques' |
  'agent_meta' | 'aide' | 'assistants' | 'analyse' | 'publicites' | 'email' | 'chaines' | 'crm' | 'rcs' |
  'performance_lab'` ; `interface Limites { utilisateurs, admins, contacts, envoisModelesMois, automations,
  suppressionsJour, adressesWebhook, journalWebhooksJours, conservationJours: number | null ; commissionPct: number ;
  badge: boolean ; numeroInclus: boolean }` ; `DROITS: Record<Offre, { fonctions: ReadonlySet<Fonction>; limites:
  Limites }>` ; `droitsDe(offre, surcharge: SurchargeEntreprise | null): Droits` (`SurchargeEntreprise = {
  utilisateurs: number | null }`, `null` = sans limite ; la conservation de l'Entreprise vient de
  `conversation_retention_days`).
- Tests : chaque case de la grille de la spec, offre par offre (le tableau du test EST la grille) ; `null` = sans
  limite ; la surcharge ne touche que l'Entreprise.

**Tâche 2. La migration et l'offre calculée** (`db/migrations/<libre>_offres.sql`, `src/offres/offre.pg.ts`,
`src/offres/cache.ts`)
- `abonnements_offre (stripe_subscription_id text primary key, tenant_id, periodicite in ('mois','an'), livemode,
  statut, periode_fin, fin_prevue_le, fini_le, fin_raison in ('resiliation','impaye'), cree_le)`, CHECK
  `^sub_[A-Za-z0-9]+$`, cascade sur l'espace, index unique partiel « un abonnement vivant par espace et par mode » ;
  `tenant_settings.offre_entreprise boolean not null default false` et `.entreprise_utilisateurs integer` (nullable,
  `> 0`, `null` = sans limite) ; `contacts.ne_entrant boolean not null default false` ; `conversations.analysis_status` élargi à
  `hors_offre` (même nom de CHECK, lu en base avant d'écrire le `drop`) ; la fonction SQL `offre_de_l_espace(uuid)`
  (Entreprise si la surcharge, sinon Pro si un abonnement vivant du mode de l'instance, sinon Base) ; la reprise : tous
  les espaces existants en Entreprise, SANS limite d'utilisateurs (décision de Julien du 2026-10-07 : ce sont des
  espaces de test, rien ne doit les contraindre).
- `OffreEspace = { offre: Offre; droits: Droits; retourEnBaseLe: Date | null }` ; `PgOffresStore.offreDe(tenantId)` ;
  `OffresEnCache` (30 s par espace, `invalider(tenantId)`).
- Tests d'intégration : Base, Pro vivant, Pro fini, Pro de l'autre mode (`livemode`), Entreprise, Entreprise et Pro ;
  la reprise ; la migration rejouée sans effet.

**Tâche 3. Les fonctions gardées** (`src/server.ts`, `src/offres/etape.ts`, `src/mcp/outils.ts`, `src/mcp/serveur.ts`,
`src/api/erreurs.ts`, `tests/offres-fonctions.test.ts`)
- Le registre : `entree(nom, acces, deps, monter, { fonction?: Fonction })` ; l'étape d'offre se pose après
  `etapeEspace` sur chaque route du module ; `exigeFonction(f)` pour une route isolée d'un module mixte.
- Correspondance (à garder telle quelle sauf avis de Julien) : `inbox` → `inbox` ; `stats`, `workflowReports` →
  `statistiques` ; `workflows` (écritures), `flows` → `scenarios` (la lecture de la liste reste ouverte : l'écran du
  widget la lit) ; `mba`, `mbaPublication`, `mbaOutils` → `agent_meta` ; `mbaAssistant`, `agentSetup` → `assistants` ;
  `aide` → `aide` ; `pubs` → `publicites` ; `email` → `email` ; `channelsMe` → `chaines` ; `hubspotImport`,
  `hubspotInstall`, `hubspotPipelines`, `salesforce`, `integrationBatch` → `crm` ; `rcsMessages`, `rcsChannel`,
  `rcsMedia` → `rcs` ; les écrans du Performance Lab → `performance_lab`. Tout le reste reste ouvert (modèles,
  campagnes, contacts, import, agents, connaissance, outils d'agent, widgets, automations, webhooks entrants, numéro,
  crédit, clés, compte).
- MCP : `OutilMcp.fonction?: Fonction` ; l'outil hors offre RESTE listé et refuse (`RefusOutil`) avec la phrase et le
  lien. Le choix de l'agent de Meta dans `set_default_responder` (`src/mcp/outils-agent.ts`, touché par RC6) se garde
  APRÈS le déploiement de RC6, dans la livraison B.
- Erreurs : `plan_feature_unavailable` et `plan_limit_reached` (402) avec `upgradeUrl`, dans la table et dans la doc
  publique de l'API (`tests/api-exemples.test.ts`).
- Tests : comme `tests/scope-tenant.test.ts`, chaque route d'un module gardé refuse un espace Base (402) et passe pour un
  Pro ; la liste des routes isolées gardées est un inventaire du test ; un outil MCP hors offre listé et refusé ;
  auto-attaque.

**Tâche 4. Le compteur des modèles** (`src/offres/compteurs.ts`, `src/meta/factory.ts`, `src/socle.ts`,
`src/campaign/{run-job,engine}.ts`, `src/http/campaigns.ts`, `src/http/v1-sends.ts`, `src/automation/runner.ts`,
`src/workflow/executor.ts`, `src/mcp/outils.ts`)
- `comptageModelesDuMois(tenantId, max, n, instantMs): Comptage` (mois civil de Paris, clé `offre.modeles|<espace>|
  <AAAA-MM>`, sur `PgCompteurDebit`) ; `QuotaModeles.consommer(tenantId, n): Promise<'ok' | 'limite'>` et
  `resteDuMois(tenantId): Promise<number | null>` (`null` = sans limite, aucune écriture).
- La fabrique reçoit `quotaModeles` (requise) et le consomme dans `avantUnModele`, AVANT le retrait de la liste de
  l'agent de Meta ; `limite` lève `LimiteOffreError(tenantId, 'envoisModelesMois')`. Un message libre ne passe jamais
  par là.
- Appelants : le lancement d'une campagne et `POST /v1/sends` refusent (402) si leurs destinataires dépassent le reste
  du mois ; un épuisement en cours écarte les destinataires restants avec le motif `limite_offre` ; une automation ou un
  scénario s'arrête avant effet et le journalise ; le MCP refuse avec le lien.
- Tests : un modèle compte, un message libre non ; le 1 001e est refusé, le 1er du mois suivant passe ; vigilance 2 ;
  chaque appelant sur une limite atteinte ; un compteur en panne laisse passer et journalise.

**Tâche 5. Les créations comptées** (`src/crm/contact-store.pg.ts`, `src/api/contacts-upsert.ts`, `src/api/fiche.ts`,
`src/crm/import.ts`, `src/http/contacts.ts`, `src/automation/store.pg.ts`, `src/http/automations.ts`,
`src/http/users.ts`)
- Fiches : `upsertFromInbound` pose `ne_entrant = true` à l'insertion seulement ; les trois autres insertions
  (`upsertByPhoneReturningId`, `upsertManyByPhone`, `creerFicheApi`) reçoivent la limite de l'appelant et n'insèrent que
  si les fiches actives non nées d'un entrant sont sous la limite, en UNE instruction ; l'import refuse en entier (402)
  quand ses fiches NEUVES dépassent le reste, l'aperçu l'annonce.
- Automations : à la création et au rallumage, on compte celles dont `possede_par` est vide.
- Membres : l'invitation compte les membres actifs et les invitations en attente, et les admins à part.
- Suppressions : la purge compte ses fiches sur un compteur quotidien (10 en Base).
- Tests : vigilances 1 et 6 ; la 101e fiche refusée par chaque chemin ; l'entrant toujours accepté au-delà de 100 ;
  la 11e automation refusée, une automation possédée jamais comptée ; la 2e invitation refusée en Base, le 3e admin en
  Pro ; la 11e suppression du jour refusée.

**Tâche 6. La route de l'offre, l'exploitation, le badge et le MCP** (`src/http/offre.ts`, `src/http/ops.ts`,
`src/server.ts`, `src/widgets/{gestion,script}.ts`, `src/mcp/outils.ts`)
- `GET /tenants/:tenantId/offre` (tout membre) : `{ offre, fonctions, limites, usage: { envoisModelesMois, contacts,
  automations, membres } }` ; l'outil `get_plan` (lecture, clé ou OAuth) rend la même chose ; le badge du widget est
  `droits.limites.badge`.
- `/ops` : poser ou retirer l'Entreprise d'un espace, avec sa limite d'utilisateurs (10 proposés, vide = sans limite)
  et sa conservation
  (`conversation_retention_days`, qu'aucune route n'écrit aujourd'hui) ; trace signée de son auteur (`par`), cache de
  l'offre invalidé.
- Tests : la route refuse un autre espace (`tests/scope-tenant.test.ts`) ; l'usage exact ; le badge par offre ; la route
  `/ops` refusée sans session d'exploitation, et l'espace qui passe de l'Entreprise à la Base.

**Tâche 7. La console** (`web/lib/nav.ts`, `web/app/offre/page.tsx`, `web/lib/api/offre.ts`, les écrans gardés)
- Les menus des fonctions fermées grisés avec la raison et « Passer en Pro » ; la page `/offre` (grille, usage, et
  jusqu'à la livraison B un bouton « Passer en Pro » qui mène au contact) ; un 402 d'une action affiche la phrase et le
  lien. Sans la route de l'offre (API plus ancienne), tout reste ouvert.
- Tests : e2e d'un espace Base (menus grisés, page `/offre`, refus de la 101e fiche) et d'un Entreprise (rien de grisé).

**Tâche 8. Docs et déploiement de A**
- `features.md` (section des offres) et sa fiche d'aide (empreinte), `documentation.md` (§ offres, une définition),
  `todo.md`, `wip.md`, le journal, la ligne du compteur de migrations.
- Ordre : la migration appliquée et relue en base (la reprise : zéro espace en Base), `up` de l'API et des deux
  workers, contrôles publics, puis la console. Essai réel de A. ⚠️ Un espace créé entre A et B est en Base sans moyen
  de payer : B suit A de près.

## Livraison B : le Pro chez Stripe, le numéro inclus, le gel (aucune migration)

**Tâche 9. La mesure chez Stripe, en lecture seule**
- Les droits de la clé restreinte sur les plannings d'abonnement (`GET /v1/subscription_schedules?limit=1`) et la doc
  de Stripe pour la version épinglée (`2025-11-17.clover`) : enchaîner « Pro, puis numéro seul » par un planning, ou
  créer l'abonnement du numéro à la fin du Pro. Décision et raison au journal de travail.

**Tâche 10. Le paiement du Pro** (`src/config.ts`, `src/stripe/client.ts`, `src/stripe/offre.ts`, `src/http/offre.ts`)
- `STRIPE_PRIX_PRO_MOIS` et `STRIPE_PRIX_PRO_AN`, posés ensemble ou pas du tout (refus au démarrage sinon) ;
  `POST /tenants/:tenantId/offre/paiement { periodicite: 'mois' | 'an' }` (admin, plafond coûteux) rend l'adresse d'une
  session Checkout en mode abonnement (mêmes réglages que le numéro, métadonnée `produit: pro`) ; `POST
  /tenants/:tenantId/offre/portail` rend le portail.
- Tests : chaque périodicité, un espace déjà Pro renvoyé au portail, un membre non admin refusé, un prix absent.

**Tâche 11. Le webhook du Pro** (`src/http/credit-stripe.ts`, `src/offres/abonnements-offre.pg.ts`)
- Les objets marqués `produit: pro` : création, période, fin prévue posée ou retirée, fin effective avec sa raison
  (`cancellation_details.reason` : résiliation ou impayé) ; chaque écriture invalide le cache de l'offre.
- Tests : chaque événement, rejoué, dans le désordre (une mise à jour après la fin ne ressuscite rien), un objet sans
  notre métadonnée ignoré, illisible 422 ; vigilance 3.

**Tâche 12. Le numéro inclus** (`src/stripe/abonnements.pg.ts`, `src/stripe/etat-abonnement.ts`, `src/stripe/client.ts`,
`src/numero/balayage-abonnements.ts`, `src/http/abonnement-numero.ts`, `src/mcp/outils-numero.ts`)
- `etatDeLEspace` rend `actif` quand un Pro vivant couvre l'espace, quel que soit l'abonnement du numéro seul ; au
  passage en Pro, l'abonnement du numéro seul s'arrête avec un avoir au prorata ; à la fin prévue du Pro, la console,
  le MCP et le portail annoncent la suite (3,50 € HT par mois sur la même carte, ou rendre le numéro) ; à la fin
  effective par résiliation, l'abonnement du numéro seul démarre (mécanisme de la tâche 9), sauf numéro rendu ; par
  impayé, le chemin du lot 4.
- Tests : vigilance 4 ; l'arrêt au prorata ; la suite annoncée ; la reprise du numéro seul ; l'impayé vers le lot 4.

**Tâche 13. Le gel au retour en Base** (`src/workflow/lancements.ts`, `src/automation/runner.ts`, `src/inbox/fil.ts`,
`src/mba/activation.ts`, `src/auth/middleware.ts`)
- Un scénario du client ne démarre plus de parcours (un scénario système, si) ; les automations au-delà des 10 plus
  anciennes ne se déclenchent plus ; l'agent de Meta ne reçoit plus la main ; un membre au-delà de la limite (le plus
  ancien admin reste) reçoit `plan_limit_reached` à chaque requête ; rien n'est effacé. ⚠️ `fil.ts` et
  `mba/activation.ts` sont touchés par RC6 : écrire après son déploiement, et l'annoncer.
- Le choix de l'agent de Meta dans `set_default_responder` exige `agent_meta` (reporté de la tâche 3).
- Tests : vigilance 5 ; chaque gel, puis tout revient au réabonnement ; `set_default_responder` vers l'agent de Meta
  refusé en Base.

**Tâche 14. La console de B** (`web/app/offre/page.tsx`, `web/components/BandeauAbonnement.tsx`)
- « Passer en Pro » (mensuel ou annuel) et le portail ; l'annonce de la suite du numéro à la fin prévue du Pro.
- Tests : e2e du paiement simulé, du portail et de l'annonce.

**Tâche 15. Docs, réglages de Julien, déploiement de B**
- Docs comme en tâche 8. Julien, chez Stripe : le produit et ses deux prix, puis leurs identifiants dans `.env.prod` ;
  le portail (changement de périodicité, résiliation en fin de période) ; les droits de la clé selon la tâche 9 ; le
  code promo de l'essai.
- Ordre : `up` de l'API et des deux workers, contrôles publics, puis la console. Essai réel de B.

## Livraison C : les coûts selon l'offre (aucune migration)

**Tâche 16. La mesure des coûts sur notre clé, en lecture seule**
- Le coût réel, par appel, de la vectorisation, de la recherche (vecteur et reranker) et de la transcription, lu dans
  l'usage de la passerelle et dans les journaux de transcription : de quoi les débiter au prix client.

**Tâche 17. La commission par offre** (`src/agent/devise.ts`, `src/agent/brain.gateway.ts`, `src/traduction/traduire.ts`,
`src/agent/modeles.ts`, `src/http/agents.ts`, `src/index.ts`, `src/worker.ts`)
- `commissionPct: number` devient `commissionPour(tenantId): Promise<number>` (requise), lue dans l'offre ; le catalogue
  des modèles affiché porte la commission de l'espace.
- Tests : le même tour coûte plus cher en Base qu'en Pro, par le seul `prixClientMicroEur` ; le catalogue par offre ; un
  test d'inventaire : plus aucune lecture de `COMMISSION_MODELE_PCT` hors du module des offres.

**Tâche 18. Les coûts sur le crédit du client** (`src/agent/recherche.ts`, `src/agent/resolvers/connaissance.ts`,
`src/worker.ts`, `src/index.ts`)
- La vectorisation, la recherche et la transcription de l'Inbox sont débitées au prix client de l'offre ; sans crédit,
  une fiche attend sa vectorisation ; le pont des codes de Meta reste à nos frais.
- Tests : chaque débit, au prix de l'offre ; sans crédit, rien ne part ; le pont jamais débité.

**Tâche 19. L'analyse, la conservation, le crédit offert** (`src/analysis/store.pg.ts`, `src/inbox/store.pg.ts`,
`src/inbox/retention.ts`, `src/config.ts`, `src/account/es-store.pg.ts`)
- La réclamation passe les conversations d'un espace Base en `hors_offre` au lieu de `queued` ; un nouveau message
  remet une conversation `hors_offre` en `pending` ; la purge garde 30 jours en Base, à partir de 30 jours après un
  retour en Base ; le crédit offert vaut 1 € pour toutes les origines.
- Tests : une conversation Base jamais réclamée, puis analysée après le passage en Pro et un nouveau message ; la purge
  aux bornes ; 1 € des deux portes.

**Tâche 20. Docs et déploiement de C**
- Docs comme en tâche 8 ; Julien vérifie qu'aucune surcharge de `CREDIT_OFFERT_MICRO_EUR` ne reste dans `.env.prod`.
- Ordre : `up` de l'API et des deux workers, contrôles publics, puis la console. Essai réel de C.
