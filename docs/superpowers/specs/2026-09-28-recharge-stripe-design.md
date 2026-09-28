# Recharger le crédit IA par Stripe : cadrage

Validé par Julien le 2026-09-28, en trois rondes de questions. Deux lots, décrits en fin de document.

## Ce qui existe, mesuré dans le code le 2026-09-28

**Le crédit prépayé d'un espace** : `agent_credits` (solde en micro-euros, signé) et `agent_credit_mouvements`
(migration 0087). La seule recharge est `POST /ops/credits/:tenantId`, à la main, qui remonte aussi le plafond de la
clé Vercel (`remonterPlafondApresRecharge`). La page Crédit de la console affiche le solde et dit « pas encore en
ligne » pour la recharge.

**Qui paie chaque appel de modèle aujourd'hui :**

| Usage | Clé | Inscrit au solde |
|---|---|---|
| Tour d'agent IA (worker) | clé de l'espace | oui, au coût brut |
| Essai « Tester » d'un agent (console) | clé de l'espace | oui, au coût brut |
| Traduction des conversations (Inbox) | clé de l'espace | 🔴 **non** |
| Transcription des vocaux | la nôtre | sans objet |
| Bot d'aide, les deux assistants de configuration | la nôtre (assistants plafonnés par espace) | sans objet |
| Embeddings et reclassement de la connaissance, y compris pendant un tour | la nôtre | sans objet |
| Analyse des conversations | la nôtre (Anthropic en direct) | sans objet |

🔴 **La traduction consomme la clé du client sans être inscrite au solde** : le solde affiché est trop haut, et
Vercel coupe la clé avant que la console n'affiche zéro.

⚠️ **Le débit est le coût brut, sans commission**, alors que l'écran de choix du modèle affiche les prix avec
`COMMISSION_MODELE_PCT`. Le commentaire de `.env.example` le dit (« reste le coût brut du Gateway »).

⚠️ **La clé Vercel ne s'ouvre qu'à la création du premier agent** (`assurerCleGateway`) : un espace sans agent ne
peut pas traduire, quel que soit son crédit.

## Décisions de Julien

| Question | Décision |
|---|---|
| Produits | Deux prix Stripe ponctuels : **Refill 50 €** et **Refill 100 €** (créés en live) |
| Prix et crédit | **HT** ; 50 € payés donnent 50 € de crédit ; la TVA s'ajoute au paiement |
| Facture | **Stripe** l'émet (raison sociale et numéro de TVA saisis au paiement) |
| Marge | **Au débit** : chaque appel débité au coût × (1 + commission), commission **10 %** |
| Traduction | **Débitée** au solde comme un tour d'agent |
| Qui achète | Un **admin** de l'espace, sur la page de paiement hébergée par Stripe |
| Alerte de solde bas | **Le bandeau de la page Crédit seulement**, pas d'e-mail |
| Crédit offert | **5 €** à la création d'un espace, **pas rétroactif** |
| Expiration, remboursement | Le crédit **n'expire pas** et **n'est pas remboursé** (un geste exceptionnel reste manuel) |

## Design

### 1. Le débit : un seul point de calcul

Tous les appels qui tombent sur le crédit du client passent par une fonction unique qui transforme un coût brut en
montant débité : `coût brut en micro-euros × (1 + COMMISSION_MODELE_PCT / 100)`, arrondi. Ses trois appelants : le
tour d'agent (`run-turn`), l'essai de la console (`agent-test`), la traduction. Un quatrième appelant l'importe, il
ne recopie pas le calcul.

- La commission de l'écran de choix du modèle et celle du débit sont **la même variable** : le prix affiché est
  le prix payé.
- Les soldes existants (des soldes d'essai) s'useront 10 % plus vite à partir du déploiement. Aucune reprise.
- Le commentaire de `.env.example` et celui de `src/config.ts` sur la commission deviennent faux : ils changent
  dans le même commit.

### 2. La traduction est débitée

- Avant d'appeler le modèle, le traducteur vérifie qu'il reste du crédit (solde > 0), comme un tour d'agent à son
  entrée. Sans crédit, le fil s'affiche en VO, avec la cause « crédit épuisé » (distincte de « traduction
  éteinte »).
- Après l'appel, il débite le coût réel rendu par le Gateway, commission comprise.
- 🔴 **Le journal des mouvements ne prend pas une ligne par traduction** : une ouverture de fil peut en lancer
  quarante, et l'historique ne montrerait plus que ça. Les traductions d'un même jour (Paris) s'agrègent en **une
  ligne** « traductions du JJ/MM » par espace ; le solde, lui, bouge à chaque appel.

### 3. La clé Vercel

- Elle s'ouvre au premier usage qui en a besoin **s'il y a du crédit** : création du premier agent (déjà le cas),
  et désormais **première traduction**. Même fonction (`assurerCleGateway`), même garde de course.
- Son plafond reste **le cumul acheté, au coût brut**. C'est un garde-fou : le verrou est notre solde, qui
  s'épuise avant grâce à la commission. Au pire, si notre garde manquait, le client consommerait ce qu'il a payé
  sans notre marge, jamais au-delà.

### 4. Les 5 € offerts

- Dans la transaction qui crée l'espace (`src/user/store.pg.ts`, seul `insert into tenants`) : solde initial et
  mouvement de raison `offert`, note « crédit offert à l'ouverture ». Pas de clé Vercel à ce moment (elle s'ouvre
  au premier usage) : une inscription ne fabrique pas de clé facturable.
- Pas rétroactif : les espaces existants n'ont rien.
- Montant en configuration (`CREDIT_OFFERT_MICRO_EUR`, défaut 5 €, 0 l'éteint).

### 5. L'achat

- Page Crédit : deux boutons, « Recharger 50 € » et « Recharger 100 € », pour un **admin**. Un non-admin lit
  « demandez à un admin de votre espace ». Le libellé dit « HT ».
- `POST /tenants/:tenantId/credit/paiement` (`{ offre: 'refill_50' | 'refill_100' }`, admin, plafond coûteux) :
  crée une session Stripe Checkout et rend son adresse, la console y redirige.
  - Le **prix Stripe** et le **crédit accordé** de chaque offre vivent dans la configuration serveur
    (`STRIPE_PRIX_REFILL_50`, `STRIPE_PRIX_REFILL_100` ; crédit 50 et 100 €). Le client ne choisit jamais un
    montant.
  - Session : `mode: payment`, le **client Stripe de l'espace** (créé au premier achat, identifiant gardé en base,
    réutilisé ensuite), `automatic_tax`, `tax_id_collection`, adresse de facturation requise, `invoice_creation`,
    métadonnées `tenant_id` et `offre`, retour sur la page Crédit (succès et abandon).
- Au retour, la page dit « paiement reçu, le crédit arrive dans quelques secondes » et relit le solde : **le retour
  de page ne crédite rien**.

### 6. Le webhook

- `POST /webhooks/stripe`, servi par l'API (`api.messagingme.app`), classe d'accès `signature-service` dans le
  registre de `src/server.ts`.
- 🔴 **Signature vérifiée sur le corps brut, avant toute lecture** (`STRIPE_WEBHOOK_SECRET`, tolérance de
  5 minutes). Puis Zod `safeParse` sur ce qu'on lit, jamais de `as`.
- Événements traités : `checkout.session.completed` avec `payment_status = 'paid'`, et
  `checkout.session.async_payment_succeeded`. Tout autre événement rend 200 sans rien faire.
- 🔴 **Idempotence par l'identifiant de session** : une table des paiements Stripe, clé primaire sur la session.
  Le crédit, le mouvement `achat` et la ligne de paiement s'écrivent dans **une seule transaction** ; un événement
  rejoué ne crédite pas deux fois (Stripe renvoie couramment le même événement).
- Le crédit accordé est celui de l'**offre** en métadonnées, **recoupé** avec le prix réellement payé dans la
  session : une métadonnée qui ne correspond pas au prix payé ne crédite rien et se journalise en erreur.
- Après la transaction : remontée du plafond Vercel (`remonterPlafondApresRecharge`, qui ne lève jamais).
- Réponse 2xx dès que la transaction est passée ; une panne de base rend 5xx, Stripe rejoue.

### 7. Les données

Une migration additive, passée AVANT le code qui l'écrit :
- l'identifiant du client Stripe d'un espace (nullable) ;
- la table des paiements : session (clé primaire), espace (cascade), offre, crédit accordé, montant HT et TTC
  payés, identifiant de facture Stripe, date.

Le lot 1 porte sa propre migration si l'agrégat quotidien des traductions en demande une. ⚠️ Les numéros se
prennent au moment d'écrire la migration, dans le dossier `db/migrations/`, jamais dans ce document.

`agent_credit_mouvements.raison` reste du texte libre : `achat`, `offert` et `traduction` s'ajoutent à la liste
du code, et la lecture des mouvements (`PgCreditStore.mouvements`, qui ramène aujourd'hui tout ce qui n'est pas
`recharge` à `conso`) les rend telles quelles.

### 8. La page Crédit

Solde, bandeau bas et épuisé (existants), les deux boutons, l'historique des mouvements avec leur raison en clair
(achat, offert, recharge manuelle, agents, traductions du jour). Les factures arrivent par e-mail de Stripe.

## Secrets et configuration

`STRIPE_SECRET_KEY` (clé **restreinte** : sessions Checkout et clients en écriture, prix en lecture),
`STRIPE_WEBHOOK_SECRET`, `STRIPE_PRIX_REFILL_50`, `STRIPE_PRIX_REFILL_100`. Côté serveur uniquement, jamais en
`NEXT_PUBLIC_`. **Julien les pose lui-même** dans `.env.prod`. Vides : les boutons disent « recharge pas encore
disponible » et la route rend 503, rien ne casse au démarrage.

## Ce que Julien fait dans Stripe

1. Recréer les deux prix en **mode test** (les essais ne paient pas).
2. Vérifier que les prix live sont en **taxe exclue** (`tax_behavior: exclusive`), sinon Stripe Tax lirait 50 €
   comme TTC.
3. Activer **Stripe Tax** (inscription France).
4. Déclarer l'adresse du webhook (`https://api.messagingme.app/webhooks/stripe`, les deux événements ci-dessus)
   et récupérer son secret.
5. Créer la clé restreinte.

## Lots

**Lot 1, sans Stripe** : fonction unique de débit avec commission, traduction débitée (garde, débit, agrégat
quotidien), clé ouverte à la première traduction, 5 € offerts à la création d'un espace. Déployable seul.

**Lot 2, Stripe** : migration, route de paiement, webhook, page Crédit.

Méthode : implémenteur par lot et une relecture du diff (argent en production, webhook entrant).

## Essai réel qui clôt le chantier

Un vrai **Refill 50 €** en live sur l'espace MessagingMe : le solde monte de 50 € une seule fois (le webhook
rejoué depuis le tableau de bord Stripe ne crédite pas une seconde fois), la facture Stripe porte la TVA, le
plafond de la clé Vercel a monté, et une traduction puis un tour d'agent font descendre le solde au prix affiché.

## Hors périmètre

Recharge automatique sur carte enregistrée, montant libre, abonnement, e-mail de solde bas, remboursement dans
l'outil, crédit rétroactif.
