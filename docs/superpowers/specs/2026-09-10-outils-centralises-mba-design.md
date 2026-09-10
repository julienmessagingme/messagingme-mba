# Un seul catalogue d'outils, pour le MBA et pour nos agents

> Spec de conception, 2026-09-10. Demandée par Julien : « il faut viser avoir une seule liste
> d'outils centralisée qui soit utilisable par le MBA ou les autres agents IA ».
> **Aucune ligne de code avant validation de ce document.**

## 1. Le constat

L'onglet « Connecteurs et outils » du Business Manager de Meta est vide sur notre numéro, et notre
écran de complétion le dit honnêtement : « Pas encore piloté depuis Engage Me. Se règle dans
WhatsApp Manager. » Deux catalogues d'outils vivraient donc en parallèle, l'un chez Meta pour le
MBA, l'autre chez nous pour nos agents IA, avec les mêmes API cibles, les mêmes secrets et deux
endroits où les tenir à jour.

Ce document décrit comment il n'y en a qu'un, chez nous.

## 2. Ce qui existe aujourd'hui, mesuré

Mesuré en base le 2026-09-10, et c'est ce qui rend le lot faisable maintenant :

| Objet | Compte |
|---|---|
| `agent_tools` | **2**, dans **1** agent, **1** espace |
| dont `origin = 'mba'` (outils maison) | 2 |
| dont actifs | **0** |
| doublons de nom entre agents | **0** |
| `agent_tool_sources` déclarées | **0** |

🔴 **La migration ne porte donc aucun risque de fusion de données.** Le jour où trois clients auront
chacun quatre agents avec des outils homonymes, la même migration devra arbitrer des collisions de
noms et des consentements contradictoires. Elle ne sera jamais moins chère qu'aujourd'hui.

Côté code, l'état est net :

- `agent_tool_sources` est **déjà au niveau de l'espace** (migration 0088), avec l'adresse de base,
  le mode d'authentification et le secret chiffré. C'est le modèle à suivre.
- `agent_tools` est **par agent** (`agent_id not null`, migration 0086), et porte à la fois la
  définition (nom, description, paramètres, liaison, risque, plafonds) et le consentement (`actif`,
  `active_par`, `active_le`, `autonome`, `autonome_par`, `autonome_le`).
- `connector_requests` (migration 0105) porte déjà la REQUÊTE hors de l'outil, précisément pour ne
  pas la redécrire par agent. La moitié du travail de mutualisation est donc faite.
- `origin` accepte déjà `'mba' | 'http' | 'mcp'`, et `kind` accepte déjà `'http' | 'mcp'`.

🔴 **Mais `'mcp'` n'est servi par AUCUN code, et il faut le dire clairement** : la route de création
de source écrit `kind: 'http'` en dur (`src/http/agent-sources.ts:27` et `:99`), et le worker ne
câble que deux résolveurs, `mba` et `http` (`src/worker.ts:1389`). Un outil `origin = 'mcp'` serait
refusé proprement par l'exécuteur en `erreur_protocole`. Ce n'est pas une régression : c'est du
vocabulaire réservé, jamais implémenté, et la migration 0088 le dit dans son propre commentaire.

⚠️ **Et « MCP » désigne chez nous l'inverse de ce qu'on croit.** `src/mcp/` est un **serveur** : il
expose NOS neuf outils (`list_conversations`, `get_contact`, `reply_in_open_window`...) à des agents
extérieurs. Consommer le serveur MCP d'un client pour en tirer des outils d'agent demande un
**client** MCP, qui n'existe nulle part dans le dépôt.

## 3. Les quatre décisions de Julien

Prises le 2026-09-10, elles cadrent tout le reste :

1. **On publie tout le catalogue au MBA, avec une case « exposé au MBA » par outil**, posée par un
   administrateur. Pas de liste séparée, pas de sélection implicite.
2. **Les outils remontent au niveau de l'espace**, comme les sources le sont déjà.
3. **MCP et HTTP tous les deux** : « tous les outils ne seront pas branchés par MCP ».
4. **Engage Me fait foi, avec publication explicite** : un bouton, un aperçu de ce qui va changer, et
   ce qui a été modifié dans WhatsApp Manager est écrasé.

## 4. Le modèle : la définition se partage, le consentement non

`agent_tools` perd `agent_id` et remonte au tenant. Mais on ne peut pas simplement le supprimer :
`actif` et `autonome` vivent dessus, et la migration 0086 en fait une propriété de sécurité, dans
ses propres termes :

> « La spec MCP exige un consentement humain avant l'invocation d'un outil ; notre agent n'a pas
> d'humain au runtime, donc on déplace le consentement du runtime vers la CONFIGURATION, et on le
> rend incontournable EN BASE. »

🔴 **Une remontée naïve rendrait un outil actif pour TOUS les agents d'un coup**, et le contrôle
d'accès de 0086 cesserait d'être un contrôle. D'où une table de liaison.

### 4.1 Deux tables

**`agent_tools`** garde la DÉFINITION, une fois par espace :
`tenant_id`, `source_id`, `request_id`, `origin`, `name`, `title`, `description`, `ne_pas_utiliser`,
`params`, `binding`, `output_paths`, `risk`, `timeout_ms`, `max_bytes`.

**`agent_tool_consommateurs`** (nouvelle) porte le CONSENTEMENT, une ligne par couple outil et
consommateur :

```
tenant_id      uuid not null references tenants(id) on delete cascade
tool_id        uuid not null references agent_tools(id) on delete cascade
consommateur   text not null            -- 'agent:<uuid>' ou 'mba:<phone_number_id>'
actif          boolean not null default false
active_par     uuid references users(id) on delete set null
active_le      timestamptz
autonome       boolean not null default false
autonome_par   uuid references users(id) on delete set null
autonome_le    timestamptz
primary key (tool_id, consommateur)
```

Les deux CHECK de 0086 sont **recopiés à l'identique** sur cette table (`actif = false or active_par
is not null`, idem pour `autonome`). Les perdre en chemin viderait la migration 0086 de son contenu
sans que rien ne le signale.

Un outil actif chez l'agent A, éteint chez B, exposé au MBA : **une** définition, **trois** lignes.
Le MBA devient un consommateur comme un autre, et la case « exposé au MBA » de Julien est
exactement une ligne de cette table.

### 4.2 L'unicité des noms change de portée

`agent_tools_name_idx` est aujourd'hui unique sur `(agent_id, name)`. Il devient unique sur
`(tenant_id, name)`. Mesuré : **0 collision** aujourd'hui. La migration vérifie quand même la
précondition avant de créer l'index, et échoue avec un message lisible plutôt que sur une violation
de contrainte anonyme.

### 4.3 DEUX migrations, pas une, et l'ordre de chacune est opposé

🔴 **C'est le piège du lot, et il vient directement de la règle du CLAUDE.md** : une migration qui
AJOUTE une colonne écrite par le code passe AVANT le déploiement, une migration qui RETIRE une
colonne encore lue par l'ancien code passe APRÈS. Ce lot fait les deux, donc il faut deux fichiers.

**0127, AVANT le déploiement** (elle ne fait qu'ajouter, rien ne casse si le code n'est pas encore
là) :

1. créer `agent_tool_consommateurs` avec ses deux CHECK ;
2. y recopier une ligne `agent:<agent_id>` par outil existant, en **transportant** `actif`,
   `active_par`, `active_le`, `autonome`, `autonome_par`, `autonome_le` (un outil actif reste actif
   pour son agent, et garde le nom de qui l'a activé) ;
3. vérifier qu'aucun `(tenant_id, lower(name))` n'est en double, sinon échouer avec le détail, puis
   créer le nouvel index unique `(tenant_id, lower(name))` **à côté** de l'ancien.

**0128, APRÈS le déploiement** : supprimer `agent_id`, les six colonnes de consentement et l'ancien
index `(agent_id, name)`.

⚠️ **Entre les deux, l'ancienne et la nouvelle forme coexistent, et c'est voulu** : c'est ce qui rend
le retour arrière possible tant que 0128 n'est pas passée. Le nouveau code écrit dans la table de
liaison et lit d'elle en priorité, en retombant sur les colonnes de `agent_tools` quand elle est
vide. Cette tolérance meurt avec 0128, sinon elle devient un mode de fonctionnement permanent que
personne ne teste.

## 5. La publication vers Meta

### 5.1 La correspondance des objets

Notre vocabulaire et celui de Meta se recouvrent presque exactement, ce qui n'est pas un hasard :
les deux décrivent un appel HTTP paramétré.

| Chez nous | Chez Meta |
|---|---|
| `agent_tool_sources` (adresse de base, authentification) | un `agent_connector` |
| `source.baseUrl` | `base_url` (obligatoire) |
| `source.authKind` | `auth_type` (obligatoire) |
| `agent_tools` + `connector_requests` | un `tool` du connecteur |
| `binding.methode`, `binding.chemin` | `request_definition.method`, `.path` |
| `ParametreUrl`, `EnTete`, `ChampCorps` | `request_definition` query, headers, body typé |
| le secret chiffré de la source | `POST /{connector_id}/upsertApiKey` |

Une source `http` donne donc **un connecteur, plus un outil Meta par outil coché**.

La correspondance de l'authentification, lue dans `BizAIOmniChannelConnectorApiKeyAuthConfig` :

| `authKind` chez nous | `auth_type` chez Meta | ce qu'on envoie à `upsertApiKey` |
|---|---|---|
| `none` | `NONE` | rien, pas d'appel |
| `bearer` | `API_KEY` | `headers: [{field_name: 'Authorization', value: <secret>, prefix: 'Bearer '}]` |
| `header` | `API_KEY` | `headers: [{field_name: <authHeaderName>, value: <secret>, prefix: null}]` |

⚠️ **Le secret POURRAIT partir dans le corps de création, et on choisit quand même la route dédiée.**
`BizAIOmniChannelConnectorRequest.auth_config.api_key` accepte la valeur directement : ce n'est donc
PAS une contrainte de Meta, c'est notre choix, et il faut le dire dans ce sens. Deux raisons :
`upsertApiKey` est le seul chemin qui sait ROTATIONNER un secret sans recréer le connecteur (« if
credentials already exist, they are replaced »), et un secret qui n'a qu'UN chemin d'écriture n'a
qu'un endroit à auditer. `auth_config` reste donc vide à la création.

### 5.2 L'écran de publication

Un bouton, et **avant lui un aperçu de ce qui va changer** : créé chez Meta, modifié, supprimé. Il
dit noir sur blanc qu'une modification faite dans WhatsApp Manager sera perdue.

⚠️ **La publication est IDEMPOTENTE et se réconcilie sur le nom.** On lit d'abord l'état chez Meta,
on compare, on n'écrit que les écarts. Republier deux fois de suite ne doit produire aucun
changement au second passage, et l'aperçu doit alors être vide. C'est le seul test qui prouve que la
réconciliation marche.

## 6. Ce qui ne traverse pas, et qui doit s'afficher

🔴 **`risk` et `autonome` n'existent pas chez Meta.** Un outil marqué `irreversible` exposé au MBA
sera appelé **sans notre garde d'autonomie**, parce que Meta n'a aucun champ pour la porter. C'est le
seul endroit de ce lot où on abaisse une protection existante.

**La case à cocher doit donc avertir au moment où on la coche**, pas dans une documentation, et
l'avertissement nomme la conséquence : « cet outil peut faire une action irréversible ; exposé au
MBA, il sera appelé sans la validation humaine que vous avez réglée ici ». Cocher reste possible :
c'est une décision du client, comme `autonome` l'est déjà depuis le 2026-08-26.

`ne_pas_utiliser` se concatène à la `description` envoyée à Meta, exactement comme on le fait déjà
pour notre propre modèle depuis le correctif du 2026-08-29.

Dans l'autre sens, Meta a des choses que nous n'avons pas, et **on ne prétend pas les gérer** au
premier lot : les macros (`USER_MESSAGE`, `WHATSAPP_PHONE_NUMBER`, `WHATSAPP_CONVERSATION_ID`) et le
`transformation_spec` à cinq étapes. Un outil publié qui les utiliserait serait modifié dans WhatsApp
Manager, donc écrasé à la publication suivante : l'aperçu doit le montrer comme une modification, pas
le taire.

🔴 **`user_auth_required` est une exception : Meta l'exige, on l'envoie à `false`.** Il est dans le
`required` de `BizAIOmniChannelConnectorToolRequest`, donc l'omettre ferait échouer la création. Le
mettre à `true` demanderait à Meta d'injecter un jeton PAR UTILISATEUR FINAL que nous ne collectons
nulle part : c'est une fonction d'authentification du contact, pas de l'espace, et elle n'a aucun
équivalent chez nous. `false` est le seul choix honnête, et il est explicite plutôt qu'omis.

## 7. MCP : vérifié à la source, et écarté du programme

🔴 **Le MBA n'appelle pas de MCP, et son modèle de données ne le prévoit pas.** Vérifié le
2026-09-10 sur le corpus OpenAPI OFFICIEL de Meta (`mba documentation/`, 16 specs et 12 pages
narratives en version 2.0.0), pas sur notre résumé. Trois constats, chacun suffisant seul :

1. **Zéro occurrence.** Aucun fichier du corpus ne contient « mcp » ni « model context protocol ».
2. **Le connecteur n'a pas de champ de protocole.** `BizAIOmniChannelConnectorRequest` exige `name`,
   `description`, **`base_url`** et `auth_type` (∈ `OAUTH2`, `OAUTH2_CLIENT_CREDENTIALS`, `API_KEY`,
   `BASIC`, `CUSTOM`, `NONE`), plus `user_auth_injection_config` et `requires_certificate` en option.
   Un connecteur Meta EST une API REST derrière une adresse de base ; il n'existe aucun champ où
   déclarer autre chose.
3. **Le tool non plus.** `BizAIOmniChannelConnectorToolRequest` exige `name`, `description`,
   `request_definition` et `user_auth_required`. C'est un appel HTTP décrit champ par champ, pas une
   découverte d'outils.

⚠️ **Ce qui resterait techniquement possible n'est pas du MCP** : décrire à la main un tool HTTP qui
poste du JSON-RPC vers un serveur MCP. Ça revient à dire que Meta sait poster du HTTP, et il faudrait
de toute façon décrire chaque outil un par un, ce que la découverte MCP est censée éviter.

**Décision de Julien, 2026-09-10 : pas de client MCP dans ce programme.** On se contente des
connecteurs HTTP existants.

⚠️ **La nuance a été posée avant de trancher, et elle ne change pas la décision** : un client MCP
aurait servi NOS agents indépendamment de Meta. Mais on a **zéro source MCP en base**, aucun client
ne l'a demandé, et le vocabulaire réservé (`kind` et `origin` acceptent déjà `'mcp'`) ne coûte rien
tant qu'aucun code ne le sert. Le sujet part dans `todo.md`, il n'est pas perdu.

🔴 **Le jour où il reviendra, il ne s'improvise pas** : il faut lever le `kind: 'http'` écrit en dur
dans la route des sources, câbler un résolveur `mcp` dans `src/worker.ts`, faire alimenter le
catalogue par `tools/list` avec la règle « la découverte PROPOSE, un humain active », et surtout
appliquer les mêmes gardes qu'au résolveur HTTP : `resolutionPublique` sur l'adresse (un serveur MCP
distant est une adresse fournie par le client, donc le même risque SSRF qu'un connecteur),
`lireCorpsBorne` sur la réponse, et les plafonds de temps et d'octets par outil.

## 8. Le découpage

| Lot | Contenu | Pourquoi dans cet ordre |
|---|---|---|
| **1** | Migrations 0127 et 0128, table de liaison, stores et routes adaptés | Gratuit aujourd'hui, cher demain |
| **2** | L'écran catalogue au niveau de l'espace | Rend la mutualisation visible avant d'y ajouter des consommateurs |
| **3** | La case « exposé au MBA » et son avertissement sur les irréversibles | Le consentement avant la publication, jamais l'inverse |
| **4** | La publication : aperçu, réconciliation, secrets par les routes dédiées | Le premier lot qui écrit chez Meta |

Chaque lot laisse le produit fonctionnel.

⚠️ **Il y avait un lot 5, « le client MCP », et il est SORTI du programme** le 2026-09-10 après la
vérification du chapitre 7. Le supprimer plutôt que le repousser est délibéré : un lot qui reste en
bas d'un tableau finit par être fait parce qu'il est écrit, pas parce qu'il sert.

## 9. Le consommateur est une clé TEXTE (tranché)

**Tranché par Julien le 2026-09-10.** `consommateur text`, avec `'agent:<uuid>'` et
`'mba:<phone_number_id>'`. La clé texte évite de fabriquer une fausse ligne `agents` sans modèle ni
crédit, et un consommateur n'est pas toujours une ligne de notre base : le MBA aujourd'hui, un jour
un canal qui n'existe pas encore. L'alternative écartée était deux colonnes nullables avec un CHECK
d'exclusivité.

🔴 **LE PRIX EST UN MÉNAGE EXPLICITE, ET IL SE PAIE EN CODE.** Il n'y a aucune clé étrangère derrière
`'agent:<uuid>'`, donc **aucune cascade ne nettoiera les lignes d'un agent supprimé** : elles
resteraient là, invisibles, et ressusciteraient le jour où un nouvel agent réutiliserait l'UUID (ce
qui n'arrive pas avec `gen_random_uuid()`, mais une ligne orpheline pollue quand même les compteurs
« utilisé par N consommateurs » de l'écran). La suppression d'un agent DOIT donc supprimer ses lignes
dans la même transaction, et un test d'intégration le tient, sinon la règle vivra dans un commentaire
que personne ne lira.

## 10. Hors périmètre, explicitement

- les macros et le `transformation_spec` de Meta (`user_auth_required`, lui, est envoyé à `false`,
  cf. chapitre 6) ;
- l'import inverse (lire les connecteurs déjà créés dans WhatsApp Manager pour les rapatrier chez
  nous) : notre mesure dit qu'il n'y en a aucun, et le sens de la vérité est tranché ;
- **le client MCP**, sorti du programme au chapitre 7 et reporté dans `todo.md` ;
- `POST /{tool_id}/run` de Meta, qui exécute un outil pour le tester. Utile, mais notre bac à sable
  (migration 0119) répond déjà à la question côté nos agents.

---

*Décisions de Julien du 2026-09-10. Mesures en base et dans le code du même jour.*
