# Lot 13 : l'API complète (fusionnée avec le lot 8)

Spec écrite le 2026-10-08 après deux rondes de questions avec Julien. Le lot est découpé en DOMAINES ; chacun arrive
avec ses routes `/v1`, son outil MCP et sa page de documentation, dans le même commit.

## 1. Les décisions de Julien (2026-10-08)

| Question | Décision |
| --- | --- |
| Premier domaine | La lecture des fils : une application qui répond (lot 12, B) a besoin du contexte |
| Format d'envoi | Celui de Meta tel quel (l'objet message de la Cloud API), avec nos gardes en plus (STOP, fenêtre de 24 h, quota) |
| Droits des clés | Un droit neuf par domaine, SANS reprise : une clé existante n'en reçoit aucun, une clé neuve peut les porter |
| Webhooks sortants | Les deux : l'API (`/v1/webhooks`, avec une clé) s'AJOUTE à la console et au MCP du lot 12 |
| Lecture en Free | Oui : l'API et Claude lisent les fils et les messages en Free ; l'écran Inbox reste Pro |
| Répondre en Free (Claude) | Oui : `reply_in_open_window` s'ouvre en Free, comme l'API ; étiqueter et affecter restent Pro |
| Médias reçus | Téléchargeables par l'API dans ce lot ; au-delà des 7 jours de Meta, la route le dit (410) |

## 2. Les domaines, dans l'ordre

1. **Lecture des fils** (ce document, § 3) : conversations, messages paginés, statut d'un message, médias reçus.
2. **Envoi au format de Meta** : `POST /v1/messages` accepte l'objet message de la Cloud API (texte, image, document,
   audio, vidéo, boutons, liste, lieu, réaction) dans la fenêtre de 24 h ; les modèles restent sur `/v1/sends`.
3. **Modèles** : créer, suivre la validation de Meta, envoyer à un contact (`list_templates`, `create_template`,
   `get_template_status`, `send_template_to_contact`).
4. **Webhooks par l'API** : `/v1/webhooks` (créer, lister, pause, renouveler le secret, essai, journal, rejeu), sous un
   droit neuf ; les mêmes fonctions que la console (`src/evenements/gestion.ts`).
5. **Contacts complets** : champs personnalisés, import d'un fichier par dépôt signé, suppression RGPD (10 par jour).

Chaque domaine aura sa propre ronde de détail avant son plan.

## 3. Domaine 1 : la lecture des fils

### Les routes, sous le droit neuf `conversations:read`

| Route | Ce qu'elle rend |
| --- | --- |
| `GET /v1/conversations` | Les fils, l'activité la plus récente d'abord, par pages (`limit` 1 à 100, défaut 50, `cursor`) ; filtre `needsReply=true` (« À traiter ») |
| `GET /v1/conversations/{conversationId}` | Un fil : le contact, qui le tient, la fenêtre de 24 h |
| `GET /v1/conversations/{conversationId}/messages` | Ses messages, le plus RÉCENT d'abord, par pages (`limit` 1 à 100, défaut 50, `cursor` vers le passé) |
| `GET /v1/messages/{messageId}` | Un message et son statut de livraison (livraison B) |
| `GET /v1/messages/{messageId}/media` | Le fichier d'un message reçu, cherché chez Meta ; 410 `media_expired` après 7 jours |

- **L'identifiant public d'un message est celui de Meta** (`wamid.…`) : c'est celui que rendent `POST /v1/messages/…`,
  `message.received` et `conversation.needs_reply`. Un message sans identifiant de Meta (rare) prend `msg_<uuid>`. Les
  deux formes sont acceptées par les routes.
- **Le curseur est opaque**, fabriqué par le serveur (instant à la microseconde et identifiant), jamais reconstruit par
  le client.
- **Qui tient le fil** se dit en trois valeurs publiques : `team` (l'équipe), `meta_agent` (l'agent de Meta),
  `automation` (un scénario, un agent IA, ou l'application en mode « mon application répond »).
- **Comptage** : une opération `conversations.read`, au plafond d'appels de l'espace, jamais au quota du jour.
- 🔴 **Isolation** : chaque requête filtre sur l'espace de la clé (`conversations.tenant_id`) ; `conversation_messages`
  n'a pas de `tenant_id`, la jointure est le contrôle.

### Le statut d'un message (livraison B, migration)

Aujourd'hui seul l'envoi d'une campagne garde son statut (`campaign_recipients.delivery_status`). Un message seul n'a
que `accuse_le` (premier accusé) et, en échec, une ligne `echecs_messages`. La livraison B ajoute
`conversation_messages.statut` (`sent`, `delivered`, `read`, `failed`) et `statut_le`, écrits par le traitement des
accusés de Meta, sans jamais reculer (un `read` arrivé avant le `delivered` ne redescend pas), `failed` toujours
écrit. `GET /v1/messages/{messageId}` rend le statut et, en échec, le code et la raison de `echecs_messages`.

### Claude (MCP)

- `list_conversations`, `get_conversation`, `get_messages` s'ouvrent en Free (lecture seule) ; les outils qui
  ÉCRIVENT (`reply_in_open_window`, `tag_conversation`, `assign_conversation`) restent dans l'offre de l'Inbox.
- `get_messages` gagne `before` (le curseur rendu par l'appel précédent) pour remonter le fil au-delà des 50 derniers.
- `get_message_status` (livraison B).

### La documentation

Une page « Conversations » (`/developers/api/conversations`), et les routes dans la liste des points d'entrée.

## 4. Domaine 2 : l'envoi au format de Meta

Décisions de Julien du 2026-10-09 :

| Question | Décision |
| --- | --- |
| Types acceptés | Les courants : texte, image, vidéo, audio, document, lieu, réaction, et les interactifs (boutons de réponse, liste, bouton lien). Hors lot : sticker, carte de contact, formulaire (Flow), demande de position, carrousel |
| Désignation | Le corps de Meta tel quel (`messaging_product`, `to`, `type`, ...) : `to` est le numéro, retrouvé sur sa fiche ; `contactId` ou `externalId` sont acceptés à la place de `to` |
| Médias | Une URL publique (`image.link`, `document.link`...) : Meta va chercher le fichier, rien ne transite chez nous. Le dépôt d'un fichier (pour un `id`) viendra plus tard |
| En plus | Rien dans ce domaine : ni « marquer lu » ni la citation d'un message |

- **La route** : `POST /v1/messages`, sous `sends:create` (le droit de `POST /v1/messages/whatsapp`, qui reste tel
  quel). Mêmes gardes que lui : fenêtre de 24 h, STOP, contact bloqué, numéro délié ou suspendu, quota du jour (hors
  mode « mon application répond »), prise du fil comme lui.
- **La validation** : un schéma Zod par type, bornes de Meta annoncées (longueurs, nombre de boutons et de lignes),
  `safeParse`, jamais `as`. Un champ inconnu de Meta est refusé (le corps est envoyé tel quel, après validation, avec
  `to` remplacé par l'adresse de la fiche).
- **L'Inbox** montre ce qui est parti : le texte, la légende d'un média, le corps d'un interactif (avec ses boutons),
  le lieu ; l'origine du message est `api`.
- **Claude** : un outil `send_message` (même validation, même route interne), sous `mcp:write`.
