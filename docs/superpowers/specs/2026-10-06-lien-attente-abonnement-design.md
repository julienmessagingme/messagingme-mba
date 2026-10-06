# Le numéro branché depuis Claude Code (lot 3c de « Messaging Me pour Claude Code »)

Spec validée par Julien le 2026-10-06, après le design présenté en conversation. Elle s'appuie sur le lot 3b, en
production et éprouvé le même jour (`docs/superpowers/specs/2026-10-05-numero-fourni-design.md`) : la page
« Connecter WhatsApp », la réserve `numeros_fournis`, le code capté par l'Asterisk (`codes_verification`), le crédit
offert selon l'origine de l'espace. Plan de référence : `docs/prive/2026-10-02-engageme-claude-code.md`.

## 1. Ce que veut Julien

- **Le client ne passe jamais par la console.** Claude Code lui donne un lien ; il clique ; la page s'ouvre dans son
  espace, sans écran de connexion. C'est le seul passage dans le navigateur pour le numéro : le paiement s'il est
  fourni, la fenêtre de Meta, le code.
- **Claude suit le branchement** : il rend la main dès qu'il se passe quelque chose (paiement, numéro, code,
  connexion) et affiche le code dans le terminal.
- **Un numéro fourni coûte 3,50 € HT par mois** (4,20 € TTC pour un client français, 3,50 € pour une entreprise de
  l'UE qui saisit son numéro de TVA), en abonnement Stripe à renouvellement automatique, **pour tous les clients**,
  qu'ils viennent de Claude Code ou de la console. Le plan disait 3,50 € TTC ; Julien a tranché HT le 2026-10-06.

Décisions de Julien du 2026-10-06, prises en cadrage :

| Question | Décision |
| --- | --- |
| Découpage | Deux livraisons : A (le lien et l'attente), puis B (l'abonnement) |
| Ce qu'ouvre le lien | La connexion du numéro de CET espace, rien d'autre |
| Durée du lien | Une heure, rouvrable ; il meurt dès que le numéro est connecté |
| Attribution d'un numéro fourni | Après le paiement confirmé par Stripe, jamais avant |
| La console | Même page, même prix : le numéro fourni n'y est plus gratuit |
| Renouvellement échoué ou résiliation | On note l'état et Julien reçoit une alerte Telegram ; rien n'est coupé avant le lot 4 |
| Outils de l'abonnement dans Claude Code | Dans la livraison B : l'état, le portail Stripe, le réabonnement |

Hors périmètre : la coupure d'un numéro impayé et la libération du numéro (lot 4, qui fixera les délais de grâce) ;
`get_onboarding_state` et `rename_workspace` ; le plugin et ses skills (lot 10) ; le code d'un numéro relié mais non
vérifié (jaune du 3b, `todo.md`).

## 2. Livraison A : le lien et l'attente

### 2.1 Le jeton du lien

Un JWT signé par `AUTH_SECRET`, d'un **genre à part** (`kind: 'lien_numero'`), sur le modèle des jetons de l'OAuth et
de l'exploitation (`src/auth/token.ts`) : `verifySession` refuse tout jeton qui porte un `kind`, donc **aucune route
d'espace ne s'ouvre avec lui**, et sa propre vérification refuse tout autre genre. Il porte l'espace, l'utilisateur
qui l'a demandé et le mode (`fourni` ou `apporte`), et expire au bout d'une heure. Rien n'est écrit en base.

### 2.2 La garde

Une garde dédiée, posée **module par module** sur les trois seuls modules dont la page a besoin : `numeroFourni` (ses
quatre routes), `embeddedSignup` (la configuration de la fenêtre, sa fin, la demande de code et l'activation) et le
module neuf de l'état de connexion (§ 2.4). Elle accepte une session normale d'admin, exactement comme aujourd'hui,
OU le jeton du lien. Pour le jeton, elle vérifie à chaque requête :

1. la signature, le genre et l'expiration ;
2. l'espace de l'URL, qui doit être celui du jeton (l'étape `etapeEspace` s'applique comme pour une session) ;
3. l'utilisateur, relu en base par le même chargeur que `makeRequireAuth` : toujours actif, toujours admin ;
4. pour une ÉCRITURE, que l'espace n'a pas encore de numéro connecté. C'est ce qui fait mourir le lien à la
   connexion ; les lectures restent permises jusqu'à l'expiration, pour que la page affiche « connecté ».

Elle pose `req.auth` comme une session d'admin de cet espace, avec une marque qui dit qu'elle vient du lien, pour que
les traces d'audit le disent.

🔴 **L'invariant de la livraison** : ce jeton n'ouvre RIEN d'autre. `tests/scope-tenant.test.ts` appelle déjà chaque
route d'espace avec la session d'un autre espace ; il appelle aussi chacune avec un jeton de lien valide, et exige un
refus partout, sauf sur la liste nommée des routes de la page.

### 2.3 La page `/brancher`

Une page autonome de la console, **sans la coquille** (`AppShell`), qui appelle des routes que le jeton n'ouvre pas.

- Le lien est `https://console.messagingme.app/brancher#<jeton>`. Le jeton voyage après le `#` : le navigateur ne
  l'envoie à aucun serveur, il n'apparaît dans aucun journal ni dans aucun en-tête `Referer`.
- La page le range dans `sessionStorage` (il meurt avec l'onglet, et survit au retour de Stripe dans le même onglet),
  puis l'efface de la barre d'adresse.
- Elle s'ouvre directement sur le choix du jeton : numéro fourni ou apporté. Elle reprend les morceaux de la page du
  3b (le numéro et son bouton Copier, la fenêtre de Meta, le code, « En obtenir un autre », « Abandonner ») : un seul
  code pour les deux pages.
- Jeton absent, expiré ou refusé : un message qui dit de redemander le lien à Claude, rien d'autre.
- Numéro connecté : « C'est bon, retournez dans Claude Code. »

### 2.4 L'état de la connexion, et les deux outils MCP

Une fonction unique dit où en est le branchement d'un espace : l'abonnement payé (livraison B), le numéro fourni
attribué (et son statut), le code reçu depuis l'attribution (`codeDeLEspace`, la même borne de 15 minutes qu'au 3b), le numéro connecté
(`phone_numbers`). Elle sert la route `GET /tenants/:tenantId/connexion-numero` de la page ET l'outil d'attente.

- **`start_whatsapp_connection`** (`mode` : `fourni` ou `apporte`). Écriture, réservé à un admin (la personne de la
  session OAuth). Rend le lien, sa date d'expiration et ce qu'il faut dire à la personne. Refuse si l'espace a déjà un
  numéro connecté. Pour `apporte`, sa description rappelle de demander si le numéro sert dans l'application WhatsApp,
  car la fenêtre de Meta le refuserait.
- **`watch_whatsapp_connection`** (`etat_connu`, facultatif : l'empreinte rendue par l'appel précédent). Rend la main
  dès que l'état diffère de `etat_connu`, sinon au bout de **45 secondes**, en relisant l'état toutes les 2 secondes.
  Il rend l'état, ce qui a changé, et le code en clair quand il est arrivé, pour que Claude l'affiche. Écriture
  (il rend un code de vérification), réservé à un admin. 45 secondes passent sous le délai par défaut de nginx
  (60 s) et sous celui de Cloudflare (100 s) : **mesuré sur `api.messagingme.app` pendant le lot**, la valeur se
  règle sur la mesure.

Ni l'un ni l'autre ne passe par le plafond coûteux : ils ne créent rien chez un tiers.

### 2.5 Ordre de déploiement

L'API d'abord (la garde, la route, les deux outils), puis la page. Entre les deux, l'outil rendrait un lien vers une
page absente : la fenêtre se dit et se réduit en poussant la page juste après le `up`. Aucune migration.

## 3. Livraison B : l'abonnement à 3,50 € HT par mois

### 3.1 Le parcours

Pour un numéro fourni, sur `/brancher` comme sur `/connecter-whatsapp` :

1. **« Payer 3,50 € HT par mois »**. La route vérifie d'abord la réserve (`reserve_vide` sinon, sans rien ouvrir chez
   Stripe), puis ouvre une session Stripe Checkout en mode abonnement, sur le client Stripe de l'espace (celui de la
   recharge, `stripe_clients`), taxe calculée par Stripe Tax et ajoutée au prix, numéro de TVA saisissable. Retour sur la page d'où l'on
   vient.
2. **Le webhook confirme** (`checkout.session.completed` en mode abonnement) : l'abonnement est enregistré, et **le
   numéro est attribué par le webhook**, dans la même transaction. Au retour, la page affiche le numéro.
3. La suite est celle du 3b : la fenêtre de Meta, le code, la connexion.

Cas rare : la réserve se vide entre l'ouverture du paiement et sa confirmation. L'abonnement est enregistré, Julien
reçoit une alerte urgente, et la page dit « paiement reçu, votre numéro est en préparation ». Le numéro sera attribué
à la déclaration suivante d'un numéro dans /ops, aux abonnés en attente d'abord.

### 3.2 Les données

Une table d'abonnements, la seule migration du 3c : l'espace, l'abonnement Stripe, le mode (test ou live), l'état
(`actif`, `en_retard`, `resilie`) et la fin de la période payée. Un abonnement actif au plus par espace.

### 3.3 Les événements de Stripe

Signés et filtrés comme ceux de la recharge (`src/http/credit-stripe.ts`), idempotents (un même événement rejoué ne
change rien) :

- `invoice.paid` : état `actif`, fin de période prolongée ;
- `invoice.payment_failed` : état `en_retard`, alerte Telegram ;
- `customer.subscription.deleted` : état `resilie`, alerte Telegram.

Rien n'est coupé : le numéro continue d'envoyer jusqu'au lot 4.

### 3.4 Les trois outils

- **`get_number_subscription`** : l'état et la prochaine échéance.
- **`manage_number_subscription`** : une session du portail client de Stripe (carte, factures, résiliation).
- **`resubscribe_number`** : un nouveau lien de paiement quand l'abonnement est tombé.

`start_whatsapp_connection` rend le lien de la page, qui porte le paiement : la confirmation arrive par
`watch_whatsapp_connection`, qui suit aussi l'état « payé ».

### 3.5 Ce que Julien fait chez Stripe

Le prix existe en production, lu chez Stripe le 2026-10-06 : `price_1UNUMXF67GfPqM0XcYpVkdhS`, produit « WhatsApp
number » (`prod_VOGuX58b8RLLXE`, code de taxe des services fournis électroniquement), récurrent mensuel, 3,50 €, taxe
en sus (`tax_behavior: exclusive`), conforme à la décision HT. Le code refuse au démarrage un prix qui ne serait pas
récurrent, mensuel et en euros, lu chez Stripe comme le prix de la recharge.

Il reste à Julien : poser ce prix dans une variable de `.env.prod`, activer le portail client, et ajouter les trois
événements au webhook existant. Les étapes lui sont données.

### 3.6 Le numéro déjà attribué

Le seul numéro attribué sans abonnement est celui de l'essai du 3b. Il reste tel quel ; le lot 4 dira ce que devient
un numéro sans abonnement.

## 4. Méthode de livraison

**Implémenteur par lot, avec revue humaine du diff**, une relecture indépendante par livraison. La production
emprunte ces chemins (une garde d'authentification, un paiement, un webhook), et la garde porte un invariant
invisible : un jeton qui ne doit rien ouvrir d'autre que la connexion du numéro.

## 5. Les tests attendus

**A.**
- Jeton : `verifySession` le refuse, sa vérification refuse une session et tout autre genre, il expire.
- Garde : refus sur un autre espace, pour un utilisateur révoqué ou devenu non admin, et pour une écriture une fois le
  numéro connecté ; lecture permise après la connexion.
- 🔴 Le jeton n'ouvre aucune route d'espace hors de la liste nommée (dynamique, sur toutes les routes montées).
- Outils : le lien porte le jeton après le `#` ; l'attente rend tout de suite sur un état neuf, au plus tard au bout
  du délai sinon (horloge simulée) ; le code n'est rendu que s'il est arrivé après l'attribution.
- E2e `/brancher` : le jeton lu puis effacé de l'adresse, le parcours fourni, le refus sans jeton, l'état connecté.
- L'auto-attaque déclare la nouvelle autorité si elle en a besoin (`FAUSSES_AUTORITES`).

**B.**
- Paiement refusé sans rien ouvrir chez Stripe quand la réserve est vide.
- Webhook : attribution à la confirmation, chaque événement et son état, l'idempotence, le mode incohérent refusé,
  les alertes ; le cas de la réserve vidée entre-temps.
- Les trois outils ; l'e2e du paiement sur les deux pages.

## 6. Les essais réels qui closent

- **A** : depuis Claude Code, sur un espace neuf, Claude donne le lien, la page s'ouvre sans connexion, Claude
  affiche le code dans le terminal puis annonce le numéro connecté. Il faut un numéro dans la réserve : rachat chez
  DIDWW, ou le numéro de l'essai du 3b libéré de son portefeuille.
- **B** : un vrai paiement de 3,50 € depuis le lien, le numéro attribué au retour, puis une résiliation par le portail
  et l'alerte Telegram.
