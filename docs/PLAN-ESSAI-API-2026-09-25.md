# Plan d'essai réel de l'API publique (2026-09-25)

Je joue un client intégrateur sur l'espace **Demo** (le numéro WhatsApp de démonstration), avec les outils
d'un intégrateur : `curl`, une clé d'API, la doc publique. Je teste **la version déployée**, pas le dépôt.
L'inventaire exact de la surface (12 routes `/v1`, 9 outils MCP, 6 signaux) a été fait dans le code le même
jour ; ce plan en couvre chaque point.

## Règles de conduite

- **Séquentiel, jamais en parallèle.** L'instance n'accepte qu'UNE opération lourde à la fois
  (`contacts/batch`, `sends`), tous espaces confondus : deux essais simultanés feraient refuser un vrai client.
- **Aucune rafale de fausses clés.** Le frein des clés inconnues est GLOBAL (30 par minute) : le marteler
  retarderait la connexion des vrais clients. Les cas 401 se jouent en trois appels, pas en boucle.
- **La clé ne s'affiche jamais** : lue depuis un fichier local hors dépôt, masquée dans le rapport.
- **Les vrais envois vont vers UN seul destinataire consentant** : le mobile de Julien. Budget : au plus
  6 messages WhatsApp (dont 2 templates facturés par Meta) et, si le RCS est actif, 2 RCS.
- **Fiches jetables** : numéros de la plage réservée à la fiction par l'ARCEP (`+33 6 39 98 00 xx`), jamais
  destinataires d'un envoi. Elles ne se suppriment pas par l'API : purge dans la console en fin d'essai.
- **Irréversible, donc seulement sur une fiche jetable** : `consent: "opted_out"` (aucune machine ne le lève).

## Prérequis (à fournir par Julien)

1. **Deux clés**, créées dans Developers > Clés d'API :
   - « Essai API complet » avec les cinq droits (`contacts:write`, `contacts:read`, `sends:create`,
     `mcp:read`, `mcp:write`) ;
   - « Essai API lecture » avec `contacts:read` seul (pour prouver `missing_scope`).
   Chacune collée dans un fichier local dont je donne le chemin, jamais dans la conversation. Révoquées à la fin.
2. **Le numéro du mobile destinataire**, et Julien disponible pour écrire au numéro Demo (ouvrir la fenêtre de
   24 h), lire et répondre pendant la phase E.
3. **Ce qui existe sur l'espace Demo** : un template **utility** approuvé (son nom et sa langue), un scénario
   **publié** simple qui envoie un message, et si possible le RCS actif. Je le vérifie par les catalogues ; s'il
   manque quelque chose, je le dis avant la phase E.
4. **Signaux** : ils ne sortent QUE vers Batch. La phase I n'a lieu que si l'espace Demo est branché sur un
   projet Batch de test ; sinon elle est sautée et c'est écrit.

## Les phases

### A. La garde (aucun envoi)
| Essai | Attendu |
|---|---|
| Sans en-tête `Authorization`, puis clé mal formée | 401 `unauthorized` « clé d'API requise » |
| Clé bien formée inconnue (1 appel) | 401 `unauthorized` « clé d'API invalide ou révoquée » |
| Clé « lecture » sur `POST /v1/contacts` | 403 `missing_scope` |
| Tout appel accepté | en-têtes `x-ratelimit-limit`, `-remaining`, `-reset` ; `last_used_at` visible dans l'écran des clés |
| Route disparue `POST /v1/messages` | 404 |
| Corps non JSON, puis `Content-Type` texte, puis corps de plus de 1 Mo | `invalid_body`, 415, 413 (les deux derniers sans code : noté) |

### B. Contacts (fiches jetables, aucun envoi)
| Essai | Attendu |
|---|---|
| `POST /v1/contacts` fiche jetable avec `externalId`, `fields`, `tags` | 201 `created` ; rejeu identique : `updated`, rien ne double |
| `POST /v1/contacts/search` par `phone`, puis `externalId`, puis `bsuid` inconnu | la fiche ; `{contact: null}` ; zéro ou deux clés : 400 |
| `GET /v1/contacts/{id}`, puis UUID aléatoire | la fiche (dont `engagementRisk`) ; 404 `unknown_contact` |
| `PATCH` : `fields` (dont `null`), `addTags`/`removeTags`, `externalId` remplacé | appliqué ; `phone` dans le corps : 400 |
| Deux fiches A et B : `phone` de A avec `externalId` de B | 409 `identity_conflict`, rien d'écrit |
| `{"phone":"abc"}`, `{"name":"x"}` | 400 `invalid_phone`, 400 `invalid_recipient` |
| `consent: "opted_out"` sur une fiche jetable, puis `opted_in` | 200, puis 409 `opted_out` (le STOP ne se lève pas) |
| `POST /v1/contacts/batch` de 3 éléments dont un invalide ; puis `{"contacts":[]}` | 200 avec résultat par ligne ; 400 |
| Champ inconnu `essai_api_x` | sa définition est créée (à supprimer à la fin) |

### C. Catalogues
`GET /v1/templates`, `/v1/scenarios`, `/v1/rcs-messages` : la liste réelle de l'espace. Vérifier qu'un template
à variable d'en-tête n'y figure pas, et relever le nom du template utility et le `scn_` du scénario pour E.

### D. Envois refusés ou vides (aucun message ne part)
| Essai | Attendu |
|---|---|
| `POST /v1/sends` sans clé d'idempotence | 400 `idempotency_key_required` |
| Cible valide, `recipients: [{"phone":"abc"}]` | 201 `recipientCount: 0`, motif `invalid_phone` |
| Rejeu identique, même clé | le MÊME 201, aucune seconde campagne |
| Même clé, autre corps | 422 `idempotency_key_reused` |
| Template inexistant, `scn_` inexistant, `nod_` inexistant, message RCS inexistant | 404 avec le bon code chacun |
| `category` posé sur un template ; mauvais nombre de `params` | 400 `invalid_body` ; 422 `unsendable_target` |
| `POST /v1/messages/whatsapp` vers une fiche jetable qui n'a jamais écrit | 422 `window_closed` |
| `POST /v1/messages/rcs` vers une fiche jetable au consentement inconnu | 409 `no_consent` (ou `rcs_not_enabled`) |
| `/v1/sends` template marketing vers une fiche `opted_out` | 201, écart `opted_out` |

### E. Vrais envois vers le mobile de Julien
1. `POST /v1/sends` cible template utility, un destinataire (le mobile, avec un `externalId`). Suivre
   `GET /v1/sends/{sendId}` jusqu'à `delivered` puis `read`. **Julien confirme la réception.**
2. **Rejouer l'étape 1 avec la même clé** : 201 scellé identique, et **Julien ne reçoit rien de plus**.
3. Julien écrit au numéro Demo (la fenêtre s'ouvre). `POST /v1/messages/whatsapp` : reçu ; dans l'Inbox, le fil
   est pris par l'API (le scénario et l'agent de Meta se taisent le temps réglé).
4. `POST /v1/sends` cible `scenario` (catégorie utility) : le parcours part et arrive.
5. `POST /v1/sends` cible `node` (un bloc précis du même scénario).
6. Si le RCS est actif : `POST /v1/messages/rcs`, puis `POST /v1/sends` cible `rcsMessage`.

### F. Le serveur MCP
`initialize`, `tools/list` (avec la clé complète : les 9 outils ; avec la clé lecture : liste vide), puis
`list_conversations`, `get_conversation` (`window_open: true` sur le fil de E), `get_messages`,
`search_contacts`, `get_contact`, `list_members`, `tag_conversation`, `assign_conversation` (puis libérer),
`reply_in_open_window` (**reçu par Julien**). `GET /mcp` : 405. Lot JSON-RPC : erreur -32600.

### G. Le plafond par espace (une fois déployé)
Par `/ops/plafond-api/{espace Demo}` : régler la minute à 5, faire 6 appels de lecture : le 6e rend 429
`rate_limited`, `Retry-After`, un message qui nomme la minute ; un appel MCP entre dans le même compteur ; la
clé du relais de l'agent de Meta n'est pas touchée. Même chose sur l'heure (heure à 8). Puis remettre le
réglage à `null` et vérifier le retour à 60 et 1 000.

### H. Numéro délié (optionnel, avec le feu vert de Julien)
Délier depuis l'Accueil : `POST /v1/messages/whatsapp` rend 409 (code `number_unlinked` une fois les jaunes
déployés), `POST /v1/sends` rend 201 puis la campagne passe en pause « numéro délié ». Relier : elle repart
toute seule dans la minute, sans destinataire perdu.

### I. Les signaux (seulement si Batch est branché sur Demo)
Le profil Batch dont le `custom_id` vaut l'`externalId` du mobile reçoit `em_message_delivered`,
`em_message_read`, puis `em_replied` après la réponse de Julien ; `em_opted_out` arrive pour la fiche jetable
désabonnée en B (si elle porte un `externalId`).

### J. Nettoyage
Révoquer les deux clés (et vérifier le 401 juste après) ; purger les fiches jetables dans la console ;
supprimer le champ `essai_api_x` ; libérer les affectations ; remettre le plafond à `null`. Les campagnes
« [API] … » restent dans l'historique (aucune suppression par l'API) : elles sont nommées « essai » pour être
reconnues.

## Ce que je rends

Un tableau point par point (attendu, obtenu, verdict), la requête et la réponse de chaque écart (clé masquée),
et la liste des écarts entre la doc publique et le comportement réel. Écarts déjà connus avant l'essai, à
confirmer en réel : le 413 et le 415 sans code ; la durée des clés d'idempotence (la doc dit « parfois un peu
plus », le code dit exactement 24 h) ; `GET /v1/sends/{id}` lit aussi les campagnes créées dans la console ; le
rattachement d'une clé neuve même quand l'envoi qui suit est refusé ; la résurrection d'une fiche supprimée
qui portait le même numéro.
