# Canal RCS (RBM) dans mba

Date : 2026-08-17
Statut : design validé, prêt pour plan d'implémentation

## 1. Objectif

Ajouter le RCS comme canal de plein droit dans mba, à côté de WhatsApp, pour :

1. vendre des campagnes RCS dédiées (canal choisi au niveau de la campagne) ;
2. orchestrer WhatsApp et RCS dans un même scénario (canal choisi au niveau du bloc).

Objectif immédiat : disposer d'une démo qui envoie du vrai RCS, sans client signé.

Hors périmètre pour cette itération : la cascade automatique multi-canal pilotée par le
moteur (un bloc « message » unique qui choisit seul RCS, WhatsApp ou SMS). Elle est
approchée autrement, voir §5.3. Le SMS n'est pas un canal de mba dans cette itération.

## 2. Décisions structurantes

### 2.1 MessagingMe est la première marque

Un agent RCS ne peut être vérifié et lancé qu'au nom d'une marque réelle avec un
représentant habilité. Messaging Me SAS (SIREN 948 692 231, RCS Paris) remplit cette
condition, Julien est ce représentant. Le premier agent est donc « MessagingMe », qui sert
à la fois de démo commerciale et de canal sortant propre.

### 2.2 Intégration directe sur l'API RBM de Google, derrière un adaptateur

Google ouvre l'enregistrement partenaire aux « RCS Solution Provider », c'est-à-dire aux
sociétés qui créent et opèrent des agents pour des marques. C'est le statut de MessagingMe.
L'enregistrement est gratuit et donne accès à la Developer Console, à la RBM API, à la
Management API, aux clés de service account et aux appareils de test.

L'implémentation vise cette API, mais **derrière une interface `RcsProvider`** (§4). Motif :
en France, les lancements sont vraisemblablement carrier-managed, ce qui exige des accords
directs avec chaque opérateur. Si c'est confirmé, le passage à un hub agrégateur (Dotgo,
Sinch, Infobip) se fait en réécrivant la seule implémentation de l'adaptateur, environ 300 à
400 lignes, sans toucher au reste.

Cette incertitude est **commerciale, pas technique** : elle ne bloque aucun lot de
développement. Les appareils de test fonctionnent avant tout lancement opérateur.

### 2.3 Le partenaire est global, l'isolation tenant passe par l'agent

Chez Meta, chaque tenant a son WABA et son token, résolus par `MetaCredentialsResolver`.
Ici, le partenaire est MessagingMe : **une seule clé de service account, globale, côté
serveur uniquement**. Ce qui isole les tenants est le mapping `agent_id -> tenant_id` en
base. Toute lecture et tout envoi passent par ce mapping, sans exception.

Conséquence sur les pannes : une clé de service account morte est une panne **globale**,
pas un incident tenant. Elle doit lever une alerte, pas une invalidation silencieuse.

## 3. Modèle de données

Migrations **0056** et **0057** (dernière migration existante : 0055).

L'identité d'un fil est aujourd'hui `(tenant_id, wa_id)`, avec `wa_id` = E.164 dans le cas
courant. Cette identité porte le RCS sans changement.

### 0056 — canal

- `channel text not null default 'whatsapp'` sur `conversations`, `conversation_messages`
  et `campaigns`. Le `default` rend la migration rétrocompatible : l'existant reste
  WhatsApp sans réécriture.
- Unique de `conversations` : `(tenant_id, wa_id)` devient `(tenant_id, channel, wa_id)`.
  Un même numéro a deux fils distincts, un par canal. C'est voulu.
- `workflow_runs` **ne change pas**. Un run est attaché à un contact, pas à un canal.
  C'est ce qui rend possible le scénario mixte (§5.3).

### 0057 — agents et opt-out

```sql
create table rcs_agents (
  id                uuid primary key,
  tenant_id         uuid not null references tenants(id),
  agent_id          text not null,          -- identifiant Google
  brand_name        text not null,
  webhook_code      text not null unique,   -- segment d'URL public
  client_token_enc  text not null,          -- chiffré (src/crypto/secretbox.ts)
  region            text not null default 'europe',
  status            text not null default 'draft', -- draft|testing|launched
  created_at        timestamptz not null default now(),
  unique (tenant_id, agent_id)
);
```

- `contacts.rcs_optout_at timestamptz` : opt-out **par canal**. Un contact opté-out du RCS
  reste joignable en WhatsApp s'il y a consenti.
- Table `rcs_capabilities_cache` : `agent_id`, `phone_e164`, `reachable boolean not null`,
  `checked_at timestamptz not null`, unique `(agent_id, phone_e164)`. TTL applicatif de
  7 jours (une entrée plus vieille est réinterrogée, pas supprimée).

Rappel du repo : les migrations ne sont pas auto-appliquées au déploiement. Toute migration
qui ajoute une colonne écrite par le code doit passer sur le VPS **avant** le déploiement de
ce code.

## 4. L'adaptateur provider

```ts
export interface RcsProvider {
  /** null = numéro non joignable en RCS. */
  capabilities(agentId: string, e164: string): Promise<RcsCapabilities | null>;
  send(agentId: string, e164: string, msg: RcsOutbound, messageId: string): Promise<SendResult>;
}
```

`RcsOutbound` est une union fermée, volontairement petite en V1 :

- `text` : texte + suggestions ;
- `card` : titre, description, média, suggestions ;
- `carousel` : liste de cartes.

Une suggestion est soit une réponse rapide avec sa donnée de postback, soit une action
(ouvrir une URL, appeler).

### 4.1 `GoogleRbmProvider`

- Endpoint régional : `https://europe-rcsbusinessmessaging.googleapis.com/v1`.
- Envoi : `POST /v1/phones/{E164}/agentMessages?messageId={id}&agentId={agentId}`.
- Joignabilité : `GET /v1/phones/{E164}/capabilities?agentId={agentId}`.
- Auth : OAuth2 par service account (scope `rcsbusinessmessaging`).
- **`messageId` fourni par nous.** La plateforme RBM ignore un message dont l'identifiant a
  déjà servi pour cet agent : idempotence native côté opérateur, qui s'ajoute au claim
  atomique de `campaign_recipients`. Un rejeu pg-boss ne peut pas produire de doublon chez
  le destinataire.
- **Cache de joignabilité obligatoire.** Un appel `capabilities` par destinataire sur une
  campagne de 5 000 numéros est inacceptable, même raisonnement que la lecture unique du
  carousel dans le moteur de campagne.

### 4.2 `FakeRcsProvider`

Pour les tests et le local, sur le patron de `src/queue/fake.ts`. Permet de livrer et de
démontrer le lot 1 sans aucun compte ouvert.

## 5. Envoi

### 5.1 Campagne RCS

`campaigns.channel = 'rcs'`. Le moteur actuel expose `EngineDeps.sender` typé
`MessageSender` (`sendMarketing` / `sendTemplate`), deux notions purement Meta. On extrait
la seule partie qui varie, sans dupliquer le moteur :

```ts
export interface CampaignSender {
  sendTo(recipient: Recipient): Promise<SendResult | { skipped: 'not_rcs_reachable' }>;
}
```

Construit par canal au lancement du run. Les garde-fous existants (fréquence, claim,
`markResult`, `recordOutbound`) ne bougent pas : ils sont déjà canal-agnostiques. Le quality
gate reste WhatsApp, le rating Meta n'ayant pas d'équivalent RCS.

Une campagne RCS en V1 est un envoi direct. Elle ne démarre pas de scénario.

### 5.2 Bloc de scénario

Un type de plus dans `WORKFLOW_NODE_TYPES` : `rcs_message`.

### 5.3 Deux sorties, et la cascade sans construire la cascade

Le bloc `rcs_message` a **deux sorties** : « envoyé » et « non joignable en RCS ».

Comme le run n'est pas attaché à un canal (§3), brancher un bloc `template` WhatsApp sur la
sortie « non joignable » produit la cascade demandée, pilotée par le client, **visible dans
le graphe** au lieu d'être une boîte noire dans le moteur. Le jour où une vraie cascade
automatique est vendue, elle se construit par-dessus, elle ne remplace pas ceci.

### 5.4 Fenêtres et consentement

La fenêtre 24 h reste attachée aux blocs WhatsApp uniquement. Un bloc `rcs_message` n'a pas
de fenêtre : il a un opt-in et un coût par message.

## 6. Webhook entrant

Route `POST /webhooks/rcs/:agentCode`, sur le patron du bouclier Meta
(`src/webhooks/receiver.ts`) : corps brut conservé, signature vérifiée, enqueue, ACK 200,
zéro métier. Le parser `application/json` en buffer est déjà enregistré globalement, donc
`rawBody` est disponible sans modification.

### 6.1 Vérification de signature

```
X-Goog-Signature == base64( HMAC-SHA512( clé = clientToken de l'agent,
                                         données = octets du payload décodé de base64 ) )
```

Comparaison en temps constant (`timingSafeEqualStr` existe déjà dans `src/lib/signature.ts`).

Le `clientToken` dépend de l'**agent**, donc de l'URL appelée. Le bouclier doit résoudre
`agentCode -> clientToken` avant de valider, ce qui écarte le principe « aucune DB dans le
receiver ». Écart assumé, payé par un **cache mémoire** des agents rafraîchi
périodiquement, plutôt qu'un aller-retour Postgres par événement.

### 6.2 Événements

- **Message entrant** : texte libre, ou réponse à une suggestion avec sa `postbackData`. Le
  second cas est l'équivalent d'un clic de bouton WhatsApp et alimente
  `src/webhooks/workflow-advance.ts` sans logique nouvelle.
- **Événements utilisateur** : DELIVERED, READ, IS_TYPING. Les deux premiers alimentent
  `campaign_recipients.delivery_status` avec l'écriture monotone par `message_id` déjà en
  place (migration 0007).
- Réconciliation du contact par E.164 via `src/crm/recognize.ts`, fil créé avec
  `channel = 'rcs'`.

## 7. Flux STOP

Obligatoire pour l'approbation de lancement, et traité **au niveau plateforme, jamais dans
un scénario** : si c'est un bloc que le client doit penser à poser, un client l'oubliera et
c'est l'agent qui saute.

À la réception d'un entrant RCS dont le texte correspond à la famille STOP :

1. écrire `contacts.rcs_optout_at` ;
2. répondre une confirmation ;
3. arrêter les runs de scénario en cours pour ce contact ;
4. refuser tout envoi RCS ultérieur vers ce numéro **au niveau du sender**, pas au niveau de
   l'appelant.

## 8. Erreurs

| Cas | Traitement |
|---|---|
| `capabilities` sans correspondance | Pas une erreur. `skipped` en campagne, sortie « non joignable » en scénario |
| 401 / 403 (service account) | Arrêt des envois, **alerte globale** (clé partenaire unique) |
| 429 | Backoff, la file pg-boss absorbe |
| 5xx | Retry existant (migration 0048) |
| Signature invalide | 403, aucun enqueue |

## 9. Tests

Unitaires : mapping `RcsOutbound` vers payload RBM (une variante par forme) ; vérification
de signature sur vecteur figé ; TTL du cache de joignabilité ; branchement de canal en
campagne ; deux sorties du bloc ; détection STOP.

Intégration : run de campagne complet contre `FakeRcsProvider` ; receveur vers file.

## 10. Livraison

### Lot 1 — multi-canal, sans aucun compte

Migrations 0056 et 0057, `RcsProvider` + `FakeRcsProvider`, modèle de message, bloc
`rcs_message` à deux sorties, campagne `channel = 'rcs'`, UI (sélecteur de canal à la
création de campagne, bloc dans l'éditeur de scénario, badge canal dans l'inbox).

À la fin de ce lot, mba est multi-canal avec un provider factice. Ne dépend de personne.

### Lot 2 — vrais envois

`GoogleRbmProvider`, webhook, STOP, invitation d'un **Android** en appareil de test (les
appareils de test documentés sont Android, ne pas compter sur un iPhone), captation vidéo de
l'agent qui tourne.

À la fin de ce lot : envoi de vrai RCS depuis mba, et la vidéo exigée par le dossier de
lancement est la captation de cette démo, pas une maquette.

### Lot 3 — premier client

Dossier de lancement complet, agent par marque cliente, coût par canal dans les stats.

## 11. Prérequis hors code

À lancer en parallèle du lot 1, aucun ne bloque le développement :

- Formulaire d'enregistrement partenaire Google (compte Google sur domaine d'entreprise,
  pas Gmail).
- Prise de contact avec un hub agrégateur pour un agent de test, en parallèle.
- Sur messagingme.app : politique de confidentialité et CGU accessibles publiquement,
  exigées par le dossier de lancement.

## 12. Points ouverts

1. Les opérateurs français sont-ils carrier-managed ? Réponse visible dans la Developer
   Console après l'enregistrement partenaire. N'affecte que le choix du provider, pas le
   code.
2. Lequel de Google ou d'un hub répond en premier. Le premier qui répond donne le bac à
   sable ; l'adaptateur rend le choix réversible.
