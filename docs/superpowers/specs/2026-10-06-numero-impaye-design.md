# Ce que devient un numéro fourni dont l'abonnement tombe (lot 4 de « Messaging Me pour Claude Code »)

Spec validée par Julien le 2026-10-06, après le cadrage et le design présentés en conversation. Elle s'appuie sur le
lot 3c, en production et éprouvé le même jour (`docs/superpowers/specs/2026-10-06-lien-attente-abonnement-design.md`) :
l'abonnement du numéro (`abonnements_numero`, migration 0214), son webhook, le portail de Stripe, la réserve
`numeros_fournis`. Plan de référence : `docs/prive/2026-10-02-engageme-claude-code.md`.

## 1. Ce que veut Julien

Un numéro fourni dont l'abonnement tombe cesse de servir proprement : ses envois sont coupés au point d'envoi unique,
le client est prévenu et peut se réabonner tant que le numéro est gardé, puis le numéro est libéré. Meta met un numéro
libéré en quarantaine : il ne revient jamais dans la réserve.

| Question | Décision de Julien (2026-10-06) |
| --- | --- |
| Après un échec de paiement | Les envois sont coupés 7 jours après le PREMIER échec ; un paiement réussi rétablit tout |
| À la fin de l'abonnement (résilié, ou impayé que Stripe abandonne) | Envois coupés tout de suite ; numéro gardé 7 jours pour un réabonnement, puis libéré |
| Ce que la suspension bloque | Tous les envois : Inbox, scénarios, campagnes, agent IA, répondeur, API, MCP. Les entrants restent enregistrés |
| La fin des relances de Stripe | Julien règle Stripe sur « annuler l'abonnement » après le dernier essai : la suppression nous parvient |
| Résiliation chez DIDWW | Automatique à la libération, avec une alerte Telegram |
| Chez Meta à la libération | Rien : le numéro est délié chez nous et résilié chez DIDWW, il reste inutilisable dans le compte du client |
| « Abandonner » d'un abonné | Le numéro retourne à la réserve ; l'abonnement est résilié en fin de période, sans nouveau prélèvement |
| Prévenir le client | Un bandeau dans la console, un rappel dans chaque réponse d'outil MCP, ET un e-mail aux admins de l'espace |
| Découpage | Deux livraisons : A (la suspension), puis B (la libération et les e-mails) |
| L'espace de l'essai du 2026-10-06 | Il suit le cycle : c'est l'essai réel du lot 4 |

## 2. Les états, calculés sur des dates

L'état se CALCULE à partir de dates gardées sur l'abonnement ; aucun balayage n'écrit de statut. « Suspendu » est vrai
dès que la date passe, même si le worker tourne en retard. Le balayage ne fait que les GESTES (alertes, e-mails,
libération). Écartés : un statut écrit par le balayage (la suspension suivrait son retard), et la réutilisation du
« délié » (le bouton « Relier » rendrait le numéro sans paiement).

**Migration 0215** (prochaine libre, à appliquer AVANT le `up` : le webhook neuf écrit les colonnes) :
- `abonnements_numero.premier_echec_le` (`timestamptz`, nullable) : posé au premier `invoice.payment_failed` d'une
  série, effacé par `invoice.paid` ;
- `.fin_prevue_le` : la résiliation programmée (`cancel_at`, ou la fin de période si `cancel_at_period_end`) ;
- `.fini_le` : la fin effective (`customer.subscription.deleted`) ;
- `.libere_le` : la libération faite (livraison B) ;
- la table `abonnements_numero_avis` (`stripe_subscription_id`, `avis`, `envoye_le`, clé primaire sur les deux
  premiers, cascade) : chaque alerte et chaque e-mail ne part qu'une fois, sur le modèle de `repondeur_alertes_credit` ;
- le CHECK `campaigns_pause_reason_check` élargi à `numero_suspendu` (sous le même nom) ;
- la reprise : les abonnements déjà `resilie` reçoivent `fini_le = maj_le` (l'espace de l'essai du 2026-10-06 : fin
  à 15 h 14 UTC, donc suspendu au déploiement et libérable dès le 13 octobre).

| État | Condition | Envois |
| --- | --- | --- |
| `actif` | payé, aucune fin prévue | ouverts |
| `fin_prevue` | payé, `fin_prevue_le` posée | ouverts ; « se termine le … » |
| `en_retard` | `premier_echec_le` posé depuis moins de 7 jours | ouverts ; rappel |
| `suspendu` | 7 jours d'impayé, ou `fini_le` posée, et pas encore libéré | coupés |
| `libere` | `libere_le` posée | le numéro n'est plus à l'espace |

Une seule lecture fait foi (une requête SQL, dans le magasin des abonnements) : la garde d'envoi, l'état de la
connexion, les outils MCP, le bandeau et le balayage la partagent. Un numéro est suspendu quand c'est le numéro
fourni ATTRIBUÉ à l'espace et que l'abonnement de l'espace (le vivant s'il y en a un, sinon le dernier fini, comme
`deLEspace`) est `suspendu` ; un numéro apporté
par le client n'est jamais touché.

## 3. Livraison A : la suspension

### 3.1 Les événements de Stripe

- `customer.subscription.updated` (NEUF, à ajouter au webhook chez Stripe) : `cancel_at_period_end` ou `cancel_at`
  posent `fin_prevue_le` ; une résiliation annulée dans le portail l'efface.
- `invoice.payment_failed` : `en_retard`, et `premier_echec_le` posé s'il ne l'est pas déjà.
- `invoice.paid` : `actif`, `premier_echec_le` effacé, et les pauses `numero_suspendu` des campagnes de l'espace levées.
- `customer.subscription.deleted` : `resilie` et `fini_le`.
- Toujours seulement ce qui porte `produit: numero` ; l'ordre d'arrivée ne change pas l'état final.

### 3.2 La garde au point d'envoi unique

`MetaClientFactory.verifierNumero` lit en une fois « délié » et « suspendu ». `NumeroSuspenduError` rejoint
`NumeroDelieError` sous une classe commune (le motif et son message), pour que chaque appelant qui traite déjà le
numéro délié traite aussi la suspension, sans copie :
- les campagnes se mettent en pause avec le motif `numero_suspendu` et reprennent au paiement ; le destinataire en
  cours est rendu à la file, jamais en échec ;
- l'Inbox rend un 409 lisible ; l'API publique un 409 `number_suspended` ; le MCP un refus d'outil ; un scénario
  s'arrête avant tout effet ;
- 🔴 l'agent IA et le répondeur vérifient le numéro AVANT d'appeler le modèle : aujourd'hui l'agent débite le tour
  puis échoue à l'envoi (trou existant pour le numéro délié aussi, fermé pour les deux). Le fil passe à l'équipe ;
- le message : « L'abonnement de ce numéro est impayé ou terminé : renouvelez-le pour envoyer à nouveau. »
- les entrants restent enregistrés et arrivent dans l'Inbox.

### 3.3 Se réabonner

- `en_retard` ou suspendu pour impayé : le portail de Stripe, pour payer la facture ouverte ou changer de carte ;
- suspendu parce que FINI, numéro encore gardé : un nouveau paiement (Checkout), qui rend le MÊME numéro sans refaire
  la fenêtre de Meta (la route de paiement accepte désormais cet espace dont le numéro connecté est le numéro fourni) ;
- après la libération : comme un nouveau client, un nouveau numéro ;
- dans Claude : `resubscribe_number` (personne exigée, plafond coûteux) rend l'adresse qui convient ; dans la
  console : un bouton « Se réabonner » sur `/connecter-whatsapp` et dans le bandeau ;
- une page publique `/paiement-recu` (« Paiement reçu, retournez dans Claude ») sert de retour à Stripe pour qui n'a
  pas de session console.

### 3.4 Prévenir

- une route légère, lisible par tout membre de l'espace (la suspension touche aussi les agents de l'Inbox), rend
  l'état et ses dates ; la console affiche un bandeau sur toutes les pages tant que l'état est `en_retard`,
  `suspendu` ou `fin_prevue` (le dernier en discret) ;
- chaque réponse d'outil MCP de l'espace porte un rappel quand l'état est `en_retard` ou `suspendu`
  (`src/mcp/serveur.ts`, le seul endroit qui couvre tous les outils) ;
- `get_number_subscription` rend l'état, la fin prévue et la date de libération ;
- Julien reçoit une alerte Telegram à la suspension, une fois (`abonnements_numero_avis`), par un balayage du worker.

### 3.5 Ordre de déploiement

Migration 0215 appliquée et relue en base, PUIS `up` de l'API et des deux workers, PUIS la console (le bandeau appelle
la route neuve). Julien ajoute `customer.subscription.updated` au webhook avant le `up` (sans lui, seule la fin prévue
manque).

## 4. Livraison B : la libération et les e-mails

### 4.1 La libération

Le balayage du worker (rôle principal, toutes les 15 minutes) libère chaque abonnement fini depuis 7 jours et pas
encore libéré, ligne prise en `for update skip locked`, chaque geste rejouable :
- le numéro a été connecté : il est délié chez nous (`delie_le`, les campagnes en pause), résilié chez DIDWW
  (`PATCH /dids/{id}`, `terminated: true` : retrait à la fin du cycle de facturation de DIDWW, réversible d'ici là),
  et passe en `resilie` dans la réserve ;
- le numéro n'a jamais été connecté : il retourne `libre` dans la réserve (jamais vu de Meta, donc pas en quarantaine),
  sans rien chez DIDWW ;
- puis `libere_le`, et une alerte Telegram ; un échec chez DIDWW laisse `libere_le` vide, alerte, et se rejoue au tour
  suivant.

Le client DIDWW gagne `resilier(didId)` et le worker reçoit la clé DIDWW (aujourd'hui l'API seule l'a).

### 4.2 « Abandonner » d'un abonné

Le numéro retourne à la réserve comme aujourd'hui, et l'abonnement est résilié en fin de période chez Stripe
(`POST /v1/subscriptions/{id}`, `cancel_at_period_end=true`). Un refus de Stripe n'empêche pas l'abandon : Julien est
alerté pour résilier à la main. À la fin de période, la suppression arrive ; il n'y a plus de numéro à libérer.

### 4.3 Les e-mails

Par Resend, à chaque admin de l'espace, une fois chacun (`abonnements_numero_avis`) : à la suspension (pourquoi, et
comment se réabonner), 2 jours avant la libération (la date), et à la libération. Un envoi raté se rejoue au tour
suivant ; aucun n'empêche la libération.

### 4.4 Ordre de déploiement

Aucune migration (0215 porte déjà tout). `up` de l'API et des deux workers. Julien a réglé Stripe (section 5) avant
la première libération.

## 5. Ce que Julien règle chez Stripe

- Webhook : ajouter l'événement `customer.subscription.updated` (livraison A).
- Facturation, paiements échoués : « annuler l'abonnement » après le dernier essai (livraison A).
- Clé restreinte de l'API : le droit d'écrire les abonnements, pour « Abandonner » (livraison B).

## 6. Méthode de livraison

Implémenteur par lot et revue humaine du diff : ce lot touche des chemins que la production emprunte (le point
d'envoi unique, le webhook de Stripe, une migration, une écriture chez DIDWW et chez Stripe). Une relecture
indépendante par livraison ; les rouges corrigés avant le déploiement, les jaunes poussés après.

## 7. Les tests attendus

- L'état : chaque ligne du tableau de la section 2, aux bornes (6 jours et 23 heures d'impayé : ouvert ; 7 jours :
  coupé), et un numéro apporté jamais suspendu.
- Le webhook : chacun des quatre événements, rejoué, et dans le désordre ; `updated` sans nos métadonnées ignoré.
- La garde : chaque appelant du numéro délié traite la suspension (campagne en pause et reprise au paiement, 409 de
  l'Inbox et de l'API, refus MCP, scénario arrêté) ; l'agent et le répondeur ne débitent rien quand le numéro est bloqué.
- Le réabonnement : le paiement d'un espace fini rend le même numéro ; la route refuse toujours un espace dont le
  numéro connecté n'est pas le numéro fourni.
- Le rappel MCP et le bandeau ; la page `/paiement-recu` sans session.
- La libération : connecté (délié, DIDWW, `resilie`), jamais connecté (`libre`), échec de DIDWW rejoué, deux copies
  du worker qui ne libèrent pas deux fois ; « Abandonner » qui programme la résiliation ; chaque e-mail une seule fois.
- L'isolation : la route d'état refuse un autre espace (`tests/scope-tenant.test.ts`).

## 8. Les essais réels qui closent

- **A** : au déploiement, l'espace de l'essai du 2026-10-06 (abonnement résilié à 15 h 14 UTC) est suspendu. Une
  réponse depuis l'Inbox est refusée avec le message, le bandeau s'affiche, `get_number_subscription` et le rappel
  MCP le disent dans Claude Code, et Julien a reçu l'alerte. Vérifié en base et dans la console.
- **B** : la libération de ce même espace (due dès le 13 octobre) : le numéro délié, `terminated` chez DIDWW (relu en
  lecture seule), `resilie` dans la réserve, les e-mails reçus sur le Gmail de l'essai, l'alerte Telegram.
