# Recharger le crédit IA par Stripe : plan

**Spec :** [docs/superpowers/specs/2026-09-28-recharge-stripe-design.md](../specs/2026-09-28-recharge-stripe-design.md)
(à lire en entier avant ce plan : les décisions de Julien et la carte des payeurs y sont).

**Contraintes globales :** pas de tiret long dans aucun texte ; `tenant_id = $1` sur chaque requête ; Zod
`safeParse` sur toute entrée externe ; secrets serveur uniquement ; toute migration additive passe AVANT le `up`
du code qui la lit ; le compteur de migrations se met à jour dans `CLAUDE.md` dans le commit qui prend le numéro.

## Méthode de livraison

**Implémenteur par lot, puis UNE relecture du diff du lot**, parce que les deux lots touchent de l'argent sur des
chemins que la production emprunte (débit de chaque tour d'agent, traduction de chaque fil, webhook entrant de
paiement) et portent des invariants invisibles (idempotence d'un paiement, plafond Vercel ordonné avec le solde).
Aucun workflow. Les jaunes de la relecture se poussent après le déploiement.

Essai réel qui clôt le lot 1 : sur l'espace MessagingMe, une traduction dans l'Inbox fait descendre le solde du
coût majoré de 10 % et ajoute (ou grossit) la ligne « traductions du jour » ; un espace créé pour l'essai
affiche 5 € offerts.
Essai réel qui clôt le lot 2 : un vrai Refill 50 € en live sur l'espace MessagingMe (solde +50 € une seule fois,
webhook rejoué depuis Stripe sans second crédit, facture avec TVA, plafond Vercel remonté).

## Lot 1 : le débit juste (sans Stripe)

### Tâche 1 : le prix client, en un seul point

- `src/agent/devise.ts` : une fonction `prixClientMicroEur(coutDollars, tauxEurParDollar, commissionPct)` =
  `microEurosDepuisDollars` majoré de la commission, arrondi. `microEurosDepuisDollars` reste pour NOTRE
  dépense (les deux assistants la gardent, c'est notre clé).
- `src/agent/brain.gateway.ts` : `usage.coutMicroEur` se calcule par `prixClientMicroEur` (nouvelle dépendance
  `commissionPct`, câblée depuis `COMMISSION_MODELE_PCT` dans le worker ET dans l'API pour le bac à sable). Tout
  l'aval (débit du solde, coût de session, plafond budgétaire de l'agent, coût affiché) lit donc le prix client.
- Les commentaires devenus faux changent dans le même commit : `src/agent/modeles.ts` (« environ 10 % sous le
  tarif annoncé »), `src/config.ts` et `.env.example` sur `COMMISSION_MODELE_PCT` (« reste le coût brut »).
- Tests : la fonction (0 %, 10 %, arrondi, taux invalide) ; un tour du cerveau avec une commission rend le coût
  majoré ; un test d'inventaire qui refuse `microEurosDepuisDollars` hors de `devise.ts` et des deux assistants
  (un nouveau chemin client ne peut pas l'oublier). Chaque test vérifié dans les deux sens.

### Tâche 2 : la traduction débitée, et la clé qui s'ouvre pour elle

- Migration (prochain numéro libre du DOSSIER) : `agent_credit_mouvements.jour` (`date`, nullable) et un index
  unique partiel `(tenant_id, jour) where raison = 'traduction'`. Additive.
- `PgCreditStore` : `debiterTraduction(tenantId, montantMicroEur)` retire du solde et ajoute le montant à la ligne
  `traduction` du jour (Paris), créée si absente, dans une transaction. `mouvements()` rend la raison telle quelle
  (`conso`, `recharge`, `traduction`, `offert`, plus tard `achat`) au lieu de tout ramener à `conso`.
- `src/traduction/traduire.ts` : avant l'appel, solde > 0 sinon VO avec une cause « crédit épuisé » distincte
  de « traduction éteinte » (l'Inbox dit laquelle) ; après l'appel, débit du prix client (`prixClientMicroEur` sur
  le coût rendu par le Gateway). Un débit qui échoue se journalise et ne casse pas l'affichage.
- `cleDisponible` devient « s'assurer d'une clé » : clé existante, sinon `assurerCleGateway` si le solde est
  positif (même garde de course que la création d'agent), sinon pas de traduction.
- Tests : solde nul, pas d'appel ; un appel débite le prix majoré ; deux traductions le même jour font UNE ligne ;
  un espace sans clé mais avec crédit en obtient une ; `mouvements()` rend `traduction`. Intégration (CI) pour
  l'agrégat et l'index.

### Tâche 3 : 5 € offerts à la création d'un espace

- `src/config.ts` : `CREDIT_OFFERT_MICRO_EUR` (défaut 5 000 000, 0 l'éteint), documentée dans `.env.example`.
- `src/user/store.pg.ts`, dans la transaction de l'`insert into tenants` : solde initial et mouvement `offert`
  (« crédit offert à l'ouverture »). Pas de clé Vercel ici.
- Tests : un espace créé porte 5 € et une ligne `offert` ; à 0, rien. Intégration (CI).

**Déploiement du lot 1 :** CI verte lue job par job ; migration appliquée et relue en base AVANT le `up` ; `up`
de l'API et du worker ; fumée publique ; `features.md` (crédit, traduction payante), `documentation.md` (la table
« qui paie quoi »), `CLAUDE.md` (« QUI PAIE QUOI » et le compteur).

## Lot 2 : Stripe

### Tâche 4 : données et client Stripe

- Migration : `stripe_clients (tenant_id pk, cascade ; customer_id unique)` et `stripe_paiements (session_id pk ;
  tenant_id, cascade ; offre ; credit_micro_eur ; montant_ht_centimes ; montant_ttc_centimes ; facture_id ;
  cree_le)`.
- `src/config.ts` : `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRIX_REFILL_50`,
  `STRIPE_PRIX_REFILL_100`, vides par défaut.
- `src/stripe/` : un client REST sans SDK (créer un client, créer une session Checkout), comme les clients Meta et
  Vercel du dépôt ; la vérification de signature (HMAC SHA-256 de `t.corps`, comparaison à temps constant,
  tolérance 5 minutes) ; les offres (`refill_50`, `refill_100` : prix configuré, crédit 50 et 100 €).
- Tests : signature valide, falsifiée, périmée, en-tête absent ; corps de requête de session (taxe auto, numéro de
  TVA, facture, métadonnées).

### Tâche 5 : la route de paiement et le webhook

- `POST /tenants/:tenantId/credit/paiement` (admin, plafond coûteux) : offre validée, client Stripe créé ou relu,
  session créée, adresse rendue. 503 si Stripe n'est pas configuré.
- `POST /webhooks/stripe` (classe `signature-service` au registre de `src/server.ts`, corps brut) : signature
  d'abord ; `checkout.session.completed` payé et `checkout.session.async_payment_succeeded` ; offre recoupée
  avec le prix payé ; dans UNE transaction : ligne `stripe_paiements` (conflit = déjà crédité, on rend 200),
  crédit, mouvement `achat` ; puis `remonterPlafondApresRecharge`. Autres événements : 200 sans effet.
- Tests : double livraison du même événement = un seul crédit ; métadonnée qui ne correspond pas au prix = aucun
  crédit ; non payé = aucun crédit ; signature fausse = 400 sans lecture ; espace d'un autre sur la route de
  paiement = 403 ; membre = 403. Inventaire des webhooks entrants mis à jour s'il existe.

### Tâche 6 : la page Crédit

- Deux boutons HT pour un admin, message pour un non-admin, retour de paiement (« le crédit arrive dans quelques
  secondes », relecture du solde), historique des mouvements avec leur raison en clair.
- 🔴 La console part sur Vercel au push, avant l'API : un 404 ou un 503 de la route de paiement affiche
  « recharge pas encore disponible », jamais une erreur brute.
- e2e : boutons, redirection, retour, non-admin, route absente.

**Déploiement du lot 2 :** migration avant le `up` ; Julien pose les secrets dans `.env.prod` et déclare le
webhook ; `up` ; fumée ; l'essai réel ci-dessus ; docs.
