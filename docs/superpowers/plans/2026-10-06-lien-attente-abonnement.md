# Lot 3c : le numéro branché depuis Claude Code, plan

Spec : `docs/superpowers/specs/2026-10-06-lien-attente-abonnement-design.md`. Plan court : tâches, interfaces, tests
attendus, ordre de déploiement. Le code se lit dans origin (l'arbre partagé peut être en retard) ; commits en
plomberie depuis une extraction, jamais depuis l'arbre partagé.

**Objectif** : Claude Code donne un lien qui ouvre la connexion du numéro sans la console, suit le branchement et
affiche le code ; un numéro fourni se paie 3,50 € HT par mois.

## Méthode de livraison

**Implémenteur par lot + revue humaine du diff**, une relecture indépendante par livraison (A, puis B), parce que la
production emprunte ces chemins : une garde d'authentification, un paiement, un webhook. Le code porte un invariant
invisible : le jeton du lien n'ouvre rien d'autre que la connexion du numéro de son espace. Aucun workflow
multi-agents pour coder.

**L'essai réel qui clôt chaque livraison** : A, depuis Claude Code sur un espace neuf, le lien ouvre la page sans connexion,
Claude affiche le code puis annonce le numéro connecté (il faut un numéro dans la réserve) ; B, un vrai paiement de
3,50 € HT depuis le lien, le numéro attribué au retour, puis une résiliation par le portail et l'alerte Telegram.

## Contraintes globales

- Aucun tiret long dans le code, les commentaires et les docs.
- `tenant_id = $1` sur chaque requête d'espace ; dépendances requises, jamais optionnelles.
- Un jeton porteur d'un `kind` n'est jamais une session (`verifySession` le refuse) ; chaque vérification refuse les
  autres genres ; le contenu relu passe par Zod.
- Attente des outils : **25 secondes au plus**. Le proxy de `api.messagingme.app` coupe à 45 s
  (`proxy_read_timeout 45s`, NPM, mesuré le 2026-10-06).
- Migration au numéro libre relu dans origin au moment de l'écrire (0214 au 2026-10-06), appliquée AVANT le `up`.
- La console n'est poussée qu'après le déploiement de l'API qui porte ses routes.
- Toute retouche de `features.md` part avec la fiche d'aide qui cite la section et son empreinte
  (`tests/aide-proposer.test.ts` vert avant de pousser).
- Le registre de routes change : `scripts/auto-attaque.mts` se lance en local avant de pousser.

## Points de vigilance (chacun avec son test dans sa tâche)

1. Un navigateur qui porte à la fois une session de la console et le jeton du lien (le cas de Julien) : `/brancher`
   n'utilise que le jeton, `/connecter-whatsapp` que la session (tâche 5).
2. L'admin qui a demandé le lien est retiré ou rétrogradé avant que le lien soit ouvert : refus (tâche 2).
3. Les événements de Stripe arrivent dans le désordre (`invoice.paid` avant `checkout.session.completed`) ou sont
   rejoués : le même état final (tâche 10).
4. Le client revient de Stripe avant le webhook : la page dit « paiement en cours de confirmation » et n'ouvre pas
   un second paiement (tâches 9 et 11).
5. L'attente interrompue côté Claude (Échap, coupure réseau) : la boucle du serveur s'arrête à son échéance, aucune
   lecture ne survit à la requête (tâche 4).

## Livraison A : le lien et l'attente (aucune migration)

**Tâche 1. Le jeton du lien** (`src/auth/token.ts`)
- `signLienNumero(l: LienNumero, secret): Promise<string>` et `verifyLienNumero(jeton, secret): Promise<LienNumero |
  null>`, sur `signerKind` / `verifierKind`, `kind: 'lien_numero'`, une heure (`DUREE_LIEN_NUMERO`).
- `LienNumero = { tenantId: string; userId: string; mode: 'fourni' | 'apporte' }`.
- Tests : `verifySession` le refuse ; `verifyLienNumero` refuse une session, un jeton OAuth, un jeton d'exploitation ;
  il expire ; un contenu mal formé est refusé.

**Tâche 2. La garde `adminOuLien`** (`src/auth/middleware.ts`, `src/server.ts`)
- `makeRequireAdminOuLien({ requireAdmin, secret, loadState, numeroConnecte })` : un Bearer qui est une session passe
  par la garde admin actuelle, inchangée ; sinon `verifyLienNumero`, puis l'utilisateur relu par `loadState` (actif,
  admin), puis, pour une méthode autre que GET et HEAD, refus 409 `lien_termine` si `numeroConnecte(tenantId)` rend
  un numéro. Elle pose `req.auth` (l'utilisateur, l'espace du jeton, `admin`, `viaLien: true`) : l'étape d'espace
  compare ensuite l'URL comme pour une session.
- `Gardes.adminOuLien: Guard`, requise ; sans authentification câblée, elle refuse tout. Posée sur les modules
  `numeroFourni`, `embeddedSignup` et `connexionNumero` (tâche 3) à la place de `g.admin`.
- Tests unitaires : session d'admin inchangée ; jeton valide accepté ; jeton d'un autre espace refusé par l'étape ;
  utilisateur révoqué ou rétrogradé refusé ; écriture refusée et lecture permise une fois le numéro connecté.
- 🔴 `tests/scope-tenant.test.ts`, sur le serveur construit : chaque route `:tenantId` d'un module `tenant`, appelée
  avec un jeton de lien de l'espace A dans l'espace A, est refusée, SAUF les routes des trois modules nommés ; et
  chacune de ces trois, appelée avec ce jeton dans l'espace B, est refusée sans atteindre le handler. Vérifié dans
  les deux sens (un quatrième module ajouté à la liste fait échouer le premier cas).

**Tâche 3. L'état de la connexion** (`src/numero/etat-connexion.ts`, `src/http/connexion-numero.ts`)
- `lireEtatConnexion(deps, tenantId): Promise<EtatConnexion>` : `{ fourni: { numero, statut } | null; code: { code,
  recuLe } | null; connecte: { numero } | null }` (B y ajoute `abonnement`), sur `numeroDeLEspace`, `codeDeLEspace`
  (sa borne de 15 minutes) et `numeroConnecte`. `empreinteEtat(e): string`, stable, qui change à chaque étape.
- Route `GET /tenants/:tenantId/connexion-numero`, module `connexionNumero` de classe `tenant`, garde `adminOuLien`.
- Tests : chaque étape produit une empreinte différente ; un code antérieur à l'attribution n'apparaît pas.

**Tâche 4. Les deux outils MCP** (`src/mcp/outils-numero.ts`, `src/mcp/outils.ts`, `src/index.ts`)
- `OUTILS_NUMERO`, ajoutés à `OUTILS` comme `OUTILS_AGENT` ; `DepsMcp.numero: { signerLien(l: LienNumero): Promise<string>;
  etat(tenantId): Promise<EtatConnexion>; urlConsole: string; attendre(ms): Promise<void>; maintenant(): number }`.
- `start_whatsapp_connection` (`mode`), `mcp:write`, `exigePersonne` : refus si un numéro est connecté ; rend `url`
  (`<urlConsole>/brancher#<jeton>`), `expire_le`, et la consigne à dire. La description de `apporte` demande si le
  numéro sert dans l'application WhatsApp.
- `watch_whatsapp_connection` (`etat_connu` facultatif), `mcp:write`, `exigePersonne` : relit l'état toutes les
  2 s jusqu'à une empreinte différente ou 25 s ; rend `etat`, `change` (booléen), `empreinte`, et `code` s'il est là.
  Ni l'un ni l'autre ne consomme le plafond coûteux.
- Tests (horloge simulée) : l'URL porte le jeton après le `#` et le jeton se vérifie ; retour immédiat sans
  `etat_connu` ; retour dès le changement ; retour à 25 s sans changement, sans lecture au-delà ; le code rendu
  seulement s'il est arrivé ; refus quand le numéro est connecté ; les deux outils absents avec une clé d'API
  (`outilsPour`) ; le test des bornes annoncées des schémas MCP passe.

**Tâche 5. La page `/brancher`** (`web/`)
- Le corps de `/connecter-whatsapp` sort dans `web/components/ConnexionNumero.tsx`, qui reçoit `api:
  ApiConnexionNumero` (les fonctions du numéro fourni, de la fenêtre Meta et de l'état), `tenantId` et
  `modeInitial` ; `useConnexionNumero` reçoit la même `api`. `/connecter-whatsapp` lui passe l'API de la session ;
  rien ne change à l'écran.
- `web/lib/api/lien-numero.ts` : la même `api`, avec le jeton du lien en Bearer, sans JAMAIS lire la session de la
  console ; un 401 devient l'état « lien expiré ».
- `web/app/brancher/page.tsx`, sans `AppShell` : lit le jeton dans `location.hash`, le range dans `sessionStorage`,
  l'efface de l'adresse (`history.replaceState`) ; lit l'espace et le mode dans le jeton (pour l'affichage, le
  serveur vérifie) ; « C'est bon, retournez dans Claude Code » une fois connecté ; sans jeton ou expiré : « Redemandez
  le lien à Claude ».
- Tests : e2e `web/e2e/brancher.spec.ts` (jeton lu puis effacé de l'adresse, Bearer du lien sur chaque appel, parcours
  fourni, état connecté, sans jeton, 401) ; le cas d'un navigateur qui porte AUSSI une session de la console : seul
  le jeton part ; `web/e2e/connecter-whatsapp.spec.ts` reste vert ; `web-formes` et `web-icones` passent.

**Tâche 6. Docs et déploiement de A**
- `features.md` (la connexion du numéro depuis Claude Code) avec sa fiche d'aide et son empreinte ; `documentation.md`
  (le genre de jeton, la garde et son invariant) ; `wip.md`.
- Ordre : CI verte lue job par job ; API (`up -d --build`, aucune migration), rechargement NPM, portes publiques à
  200 ; puis la console. Essai réel de A.

## Livraison B : l'abonnement à 3,50 € HT par mois

**Tâche 7. Migration 0214 et magasin** (`db/migrations/0214_abonnements_numero.sql`, `src/stripe/abonnements.pg.ts`)
- Table `abonnements_numero` : `tenant_id` (cascade), `stripe_subscription_id` unique, `livemode`, `statut` (CHECK
  `actif`, `en_retard`, `resilie`), `periode_fin`, `cree_le`, `maj_le` ; index unique partiel `(tenant_id) where
  statut <> 'resilie'`.
- `PgAbonnementsNumeroStore` : `enregistrer({ tenantId, abonnementId, livemode, periodeFin })` qui, dans la même
  transaction, attribue le numéro (`attribuer`) et rend `{ numero | null }` ; `majStatut(abonnementId, statut,
  periodeFin?)` idempotent ; `deLEspace(tenantId)` ; `enAttenteDeNumero()`.
- Tests d'intégration : enregistrer deux fois ne crée qu'un abonnement et n'attribue qu'un numéro ; réserve vide :
  abonnement gardé, `numero: null` ; un second abonnement actif pour l'espace refusé.

**Tâche 8. Stripe : l'abonnement et le portail** (`src/stripe/client.ts`, `src/stripe/paiement.ts`, `src/config.ts`)
- `creerSessionAbonnement` (mode `subscription`, le prix, `automatic_tax`, `tax_id_collection`, `customer_update`,
  métadonnées `tenant_id` et `produit: numero` sur la session ET sur l'abonnement, sans `invoice_creation`, interdit
  en mode abonnement) ; `creerSessionPortail(client, urlRetour)`.
- `STRIPE_PRIX_NUMERO` (`.env.example`, `socle.ts`) ; le prix relu chez Stripe avant d'ouvrir un paiement, refusé
  s'il n'est pas récurrent, mensuel, en euros.
- Tests : les formulaires envoyés à Stripe (champs exacts, aucun `invoice_creation`) ; un prix ponctuel refusé.

**Tâche 9. Les routes du paiement** (`src/http/numero-fourni.ts`)
- `POST /tenants/:tenantId/numero-fourni/abonnement` (`retour` : `brancher` ou `console`), garde `adminOuLien`,
  plafond coûteux : 409 si un numéro est connecté ou un abonnement actif ; 409 `reserve_vide` sans rien ouvrir chez
  Stripe ; sinon l'URL de paiement.
- `POST /tenants/:tenantId/numero-fourni` n'attribue plus sans abonnement actif (409 `abonnement_requis`), sauf pour
  rendre un numéro déjà attribué.
- Tests : chaque refus ; aucun appel à Stripe sur réserve vide ; le retour vers la bonne page.

**Tâche 10. Le webhook** (`src/http/credit-stripe.ts`, `src/http/ops-numeros.ts`)
- `checkout.session.completed` en mode abonnement avec `produit: numero` : `enregistrer` (attribution) ; réserve vide :
  alerte Telegram urgente. `invoice.paid` : `actif`, fin de période prolongée. `invoice.payment_failed` : `en_retard`
  et alerte. `customer.subscription.deleted` : `resilie` et alerte. Le mode incohérent refusé comme aujourd'hui.
- Un événement d'abonnement inconnu (arrivé avant la session) crée l'abonnement depuis les métadonnées de
  l'abonnement : l'ordre d'arrivée ne change pas l'état final.
- La déclaration d'un numéro dans /ops l'attribue d'abord à un abonné en attente (`enAttenteDeNumero`).
- Tests : chaque événement et son état ; chaque événement rejoué ; `invoice.paid` avant la session ; la réserve
  vidée entre-temps puis un numéro déclaré ; une recharge de crédit inchangée (non-régression).

**Tâche 11. La page : le paiement** (`web/components/ConnexionNumero.tsx`)
- Numéro fourni sans abonnement actif : « Payer 3,50 € HT par mois », puis la page de Stripe ; au retour, « paiement
  en cours de confirmation » tant que le webhook n'est pas passé (l'état est relu), puis le numéro ; abonnement actif
  sans numéro (réserve vidée entre-temps) : « paiement reçu, votre numéro est en préparation ». `EtatConnexion`
  gagne `abonnement: { statut, periodeFin } | null`, et `watch_whatsapp_connection` le suit.
- Tests : e2e sur les deux pages (bouton, retour avant le webhook sans second paiement, numéro affiché après).

**Tâche 12. Les trois outils de l'abonnement** (`src/mcp/outils-numero.ts`)
- `get_number_subscription` (lecture) ; `manage_number_subscription` (le portail, plafond coûteux) ;
  `resubscribe_number` (un nouveau lien de paiement, refus si un abonnement est actif). Tous `exigePersonne`.
- Tests : chacun, dont les refus ; absents avec une clé d'API.

**Tâche 13. Docs, actions de Julien, déploiement de B**
- Docs comme en tâche 6 ; `features.md` : le numéro fourni passe payant pour tous.
- Julien, chez Stripe : `STRIPE_PRIX_NUMERO=price_1UNUMXF67GfPqM0XcYpVkdhS` dans `.env.prod` ; le portail client
  activé ; les trois événements ajoutés au webhook ; la clé restreinte autorisée à ouvrir une session du portail
  (droit à vérifier par un essai avant le déploiement).
- Ordre : CI verte ; `build`, `pg_stat_activity`, `migrate` (0214), relue en base ; `up` ; NPM ; portes publiques ;
  puis la console. Essai réel de B.
