# Renvoyer les leads Click-to-WhatsApp à Meta (Conversions API), Groupama PJ d'abord

Cadrage du 2026-10-09 avec Julien, en rondes de questions. Fait suite à la spec des publicités
(`2026-09-22-pubs-ctwa-design.md`, lot 5 « conditionnels » : renvoi des conversions après une mesure).

## Le problème

Une pub Click-to-WhatsApp de Groupama amène des prospects sur WhatsApp. Meta compte les clics et les conversations
ouvertes, mais il ne sait pas qui, parmi elles, est devenu un vrai lead. Julien veut **deux événements pour deux
audiences ciblées** dans Meta : les personnes qui ont ouvert une conversation depuis une pub, et celles qu'un robot a
passées à un conseiller. Les mêmes événements permettront ensuite d'optimiser la diffusion sur les seconds.

Messaging Me garde déjà l'identifiant du clic (`ctwa_clid`) de chaque arrivée publicitaire (`arrivees_pub`, lot 1 des
pubs). Il ne renvoie rien à Meta.

## Les décisions de Julien (2026-10-09)

| Question | Décision |
|---|---|
| Quels événements | `LeadSubmitted` pour toute personne qui ouvre une conversation depuis une pub ; `QualifiedLead` pour toute personne passée à un conseiller. |
| Ce qui compte comme un passage à un conseiller | **Un robot passe la main** : l'agent IA, un bloc de scénario ou l'agent de Meta. Ni la réouverture par le client, ni la prise manuelle par un collaborateur. |
| Le grain | Un `LeadSubmitted` **par clic** : deux clics de la même personne dans la semaine font deux leads. |
| La portée | **Groupama PJ seul**, sans écran. Le code reste générique : un autre espace s'ajoute par la configuration. |
| Où ça tourne | Une **tâche du worker** de Messaging Me, pas un script planifié ni une fonction hors du produit. |

## Ce que dit Meta

Relevé le 2026-10-09 sur
[Conversions API for Business Messaging](https://developers.facebook.com/documentation/ads-commerce/conversions-api/business-messaging),
complété par la spec des pubs ([DOC] du 2026-09-22).

- **Appel** : `POST https://graph.facebook.com/{version}/{dataset_id}/events`, `action_source: "business_messaging"`,
  `messaging_channel: "whatsapp"`.
- **Quatorze événements** acceptés : `Purchase`, `LeadSubmitted`, `InitiateCheckout`, `AddToCart`, `ViewContent`,
  `OrderCreated`, `OrderShipped`, `OrderDelivered`, `OrderCanceled`, `OrderReturned`, `CartAbandoned`, `QualifiedLead`,
  `RatingProvided`, `ReviewProvided`.
- **`user_data`** porte `whatsapp_business_account_id` et `ctwa_clid` (en clair, jamais haché). Rien d'autre n'est exigé :
  ni téléphone, ni nom.
- **Jeton** : il doit porter `whatsapp_business_management` ET `whatsapp_business_manage_events`. Il peut venir de
  l'inscription WhatsApp, d'un utilisateur système, ou d'un utilisateur. 🔴 **Notre inscription WhatsApp ne demande pas
  la seconde** (`src/meta/embedded-signup.ts` ne connaît que `whatsapp_business_management` et
  `whatsapp_business_messaging`) : d'où le jeton d'un utilisateur système du Business Manager du client.
- **Jeu de données** : il se rattache au compte WhatsApp (`POST /{WABA_ID}/dataset`). Celui de Groupama existe déjà,
  créé par Meta : « WhatsApp Marketing Message Event Sharing », que Julien a relié le 2026-10-09 au compte publicitaire
  des pubs (son identifiant est dans le Gestionnaire d'événements, pas ici : le dépôt est public). La mesure du § 5 confirme que c'est bien lui qui reçoit.
- **Dédoublonnage** : Meta ne dédoublonne pas, l'annonceur doit le faire avant d'envoyer.
- **Âge** : un événement de plus de 7 jours est refusé [DOC, spec des pubs].
- **Géographie** : rien d'écrit pour cette API. La détection AUTOMATIQUE des leads (Automatic Events), elle, n'est pas
  ouverte dans l'Union européenne : c'est pourquoi les événements sont envoyés par nous.

## 1. Ce qui part, et quand

- **`LeadSubmitted`** : pour chaque ligne d'`arrivees_pub` d'un espace configuré qui porte un `ctwa_clid` et a moins de
  7 jours. `event_time` = `arrivee_le`. Une arrivée en `standby` compte comme les autres.
- **`QualifiedLead`** : au premier passage de main par un robot qui suit un clic. L'événement se rattache à l'arrivée
  la plus récente du contact qui porte un `ctwa_clid` et a moins de 7 jours ; sans elle, rien ne part. `event_time` =
  l'heure du passage. Un second passage pour le même clic n'envoie rien.
- **Ne part jamais** : une conversation née hors d'une pub, un clic de plus de 7 jours, une réouverture par le client,
  une conversation envoyée à l'équipe faute de robot (crédit épuisé, répondeur indisponible, mode équipe), une prise
  manuelle.
- **Le corps envoyé**, un événement par appel :

```json
{ "data": [{ "event_name": "QualifiedLead", "event_time": 1760000000, "event_id": "<arrivee_id>:QualifiedLead",
  "action_source": "business_messaging", "messaging_channel": "whatsapp",
  "user_data": { "whatsapp_business_account_id": "<waba>", "ctwa_clid": "<clid>" } }] }
```

## 2. Comment ça tourne

### Le signal du passage de main

Les vrais passages de main passent par deux méthodes du contrôleur de conversation (`src/inbox/fil.ts`) :
`passerAUnHumain` (l'outil d'escalade de l'agent IA, câblé dans `src/worker.ts`, et le bloc de transfert d'un
scénario, `src/workflow/wiring.ts`) et `agentDeMetaPasseLaMain` (la passation de l'agent de Meta). Les autres envois à
l'équipe (`aLEquipe`, `CAUSES.*`, la réouverture) ont leur propre chemin : les exclure se fait donc par construction,
pas en lisant un texte de cause.

`passerAUnHumain` l'appelle quand le fil a réellement basculé (`setControlOwner` rend `true`) ;
`agentDeMetaPasseLaMain` l'appelle à chaque passation, parce que `marquerEscalade` ne dit pas s'il a changé quelque
chose : l'unicité du journal absorbe un webhook de passation reçu deux fois. La note,
`conversions.noterPassageDeMain(tenantId, waId)`, est une dépendance REQUISE du contrôleur (les fixtures passent
`conversionsMuettes`, qui dit l'hypothèse au lieu de la cacher). Elle :
- ne fait rien pour un espace absent de la configuration ;
- sinon insère la ligne `QualifiedLead` de l'arrivée retenue, `on conflict do nothing` ;
- 🔴 **ne fait jamais échouer le passage de main** : son erreur est journalisée puis avalée. Un lead non renvoyé coûte
  moins qu'un client que personne ne reprend.

### Le journal `conversions_meta` (migration suivante, numéro pris au plan)

Une ligne par clic et par événement :
`id`, `tenant_id` (cascade), `arrivee_id` (cascade depuis `arrivees_pub`), `evenement` (CHECK : les deux noms),
`survenu_le`, `statut` (`a_envoyer`, `envoye`, `refuse`, `abandonne`), `essais`, `prochain_essai_le`, `envoye_le`,
`erreur`, `cree_le`. Unique `(tenant_id, arrivee_id, evenement)` : c'est elle qui garantit qu'aucun événement ne part
deux fois. Un index partiel sert la seule requête de la tâche (`statut = 'a_envoyer'`). Aucune donnée personnelle :
l'identifiant du clic reste dans `arrivees_pub`, où la purge RGPD l'efface déjà (`purgeMany`).

### La tâche `conversions-meta`

`taches.programmer('conversions-meta', 60_000, …)` dans le worker principal, mesurée dans `/ops` comme les autres. À
chaque passage, pour chaque espace configuré :
1. elle insère les lignes `LeadSubmitted` des arrivées de moins de 7 jours qui n'en ont pas ;
2. elle réclame au plus 50 lignes dues, avec un bail (`prochain_essai_le` repoussé de 2 minutes dans la même
   requête), pour que deux copies du worker n'envoient jamais la même ;
3. pour chacune : sans `ctwa_clid` (purgé) ou de plus de 7 jours, `abandonne` ; sinon l'appel à Meta. Une réponse 2xx
   avec `events_received` ≥ 1 donne `envoye`. Un 4xx donne `refuse`, avec le message de Meta, sans nouvel essai. Une
   panne réseau, un 5xx ou un délai dépassé donnent un nouvel essai à 1, 5, 15 puis 60 minutes, puis `abandonne` après
   5 essais.

### La configuration, sans écran

`CONVERSIONS_META` dans `.env.prod` : une liste JSON `[{ "espace": "<tenant_id>", "dataset": "<id>", "jeton": "<jeton>" }]`,
lue par `src/config.ts` avec `safeParse`. Vide : la tâche ne fait rien et la note non plus. Mal formée : un avertissement
au démarrage, rien ne part, le worker démarre quand même. Le compte WhatsApp vient de notre base (le WABA du numéro de
l'espace). 🔴 **Le jeton est posé par Julien, jamais par Claude**, et ne s'écrit jamais dans un journal.

### Le jeton de Groupama

Un utilisateur système du Business Manager « Groupama Protection Juridique », avec le contrôle du compte WhatsApp et du
jeu de données, et un jeton généré pour notre app avec `whatsapp_business_management` et
`whatsapp_business_manage_events`. Julien a un rôle sur l'app : l'accès standard doit suffire pour ce Business Manager,
ce que la mesure du § 5 tranche. Un autre client exigera l'accès avancé de cette permission, donc la revue de Meta.

## 3. Cas limites

| Cas | Ce qui se passe |
|---|---|
| Deux clics de la même personne dans la semaine | Deux `LeadSubmitted` ; le `QualifiedLead` suit le plus récent. |
| Passage de main sans clic de pub de moins de 7 jours | Rien. |
| Deux passages de main pour le même clic | Un seul `QualifiedLead` (unicité du journal). |
| Activation de la fonction | Les arrivées des 7 derniers jours partent au premier passage : ce sont de vrais leads. |
| Purge RGPD du contact | `ctwa_clid` effacé, la ligne en attente passe `abandonne`. |
| Jeton révoqué ou expiré | `refuse`, avec le message de Meta dans `erreur` et dans les journaux du worker. |
| Deux copies du worker | Le bail de la réclamation : chaque ligne n'est envoyée qu'une fois. |

## 4. Tests

- Unitaires : le corps envoyé (champs, heure en secondes, `event_id`), la lecture de la configuration (valide, vide, mal
  formée), le choix de l'arrivée d'un passage de main (la plus récente, moins de 7 jours, avec clic), les règles de
  nouvel essai et d'abandon selon la réponse de Meta.
- 🔴 La note qui échoue ne fait pas échouer `passerAUnHumain` ni `agentDeMetaPasseLaMain`, vérifié dans les deux sens.
- 🔴 Les autres chemins vers l'équipe (`aLEquipe`, la réouverture) n'appellent jamais la note.
- Intégration (CI) : l'unicité du journal, l'insertion des `LeadSubmitted`, la réclamation avec bail.

## 5. Mesure avant de construire

| Mesure | Comment | Décision |
|---|---|---|
| Le jeton a les droits | Dès qu'il existe : un envoi à la main avec le code de test du Gestionnaire d'événements | Accepté ou refusé pour le seul `ctwa_clid` : on construit. Refusé pour les droits : on règle le jeton avant tout code. |
| Un événement accepté pour un numéro français | Au premier vrai clic sur une pub Groupama : un `QualifiedLead` à la main sur ce clic | Visible dans le Gestionnaire d'événements : on allume. Refusé : on s'arrête là. |

## 6. Essai réel qui clôt la feature

Un vrai clic sur une pub Groupama, depuis un téléphone. Il faut **voir**, dans le Gestionnaire d'événements du jeu de
données : `LeadSubmitted` après le premier message, puis `QualifiedLead` une fois que l'agent IA a passé la conversation
à un conseiller. Et dans le Gestionnaire de publicités, les deux audiences créées à partir de ces événements.

## 7. Méthode de livraison

**En direct, avec une relecture indépendante en fin de lot.** Une tâche neuve et isolée, une table neuve, et une note
qui ne bloque rien sur deux chemins existants : le rayon de souffle est petit, et vider `CONVERSIONS_META` coupe tout.

## 8. Déploiement

1. La migration du journal, appliquée AVANT le code qui l'écrit (règle du dépôt), après lecture de `pg_stat_activity`.
2. L'API et les deux workers : la note vit dans le contrôleur, que les deux utilisent.
3. Julien pose `CONVERSIONS_META` dans `.env.prod`, puis `--force-recreate` de l'API et des workers.
4. La seconde mesure du § 5, puis l'essai réel.

## 9. Rayon de souffle repéré

- Le contrôleur de conversation gagne une dépendance requise : il est construit dans `src/worker.ts` et `src/index.ts`
  (câblages partagés, à annoncer aux autres sessions avant de les éditer, commit en plomberie) et dans les fixtures.
- Aucun type d'événement de conversation n'est ajouté : la page Performance et la frise de l'Inbox ne bougent pas.
- `purgeMany` n'a rien à apprendre : le journal ne porte aucune donnée personnelle.
- La revue de Meta de `whatsapp_business_manage_events` (accès avancé) et l'écran de réglage par espace sont hors de ce
  chantier : ils viendront le jour où un second client le demande.
