# Chaîne WhatsApp (Channels Me) dans Engage Me : document de conception

> Date : 2026-09-04. Statut : à relire par Julien avant plan d'implémentation.
> Ce document est la SOURCE de la feature. Le détail encyclopédique produit par les agents de rédaction
> reste dans le journal du workflow, il n'a pas vocation à être committé.

## 1. Ce que la feature fait, et pourquoi elle n'existe nulle part ailleurs

Channels Me publie un post sur une **chaîne WhatsApp** : une diffusion one-to-many, gratuite, vers des
abonnés anonymes dont nous ne connaissons ni le numéro ni le nom. Le post porte dans son texte un lien
`wa.me` pré-rempli. Quand un abonné appuie sur le bouton que WhatsApp fabrique à partir de ce lien, il
**envoie** un message à notre numéro. Ce message déclenche une automation, et un scénario Engage Me démarre.
L'abonné anonyme devient un contact identifié, dans une conversation.

Le point produit tient en une phrase. Une chaîne diffuse mais n'écoute pas : ni contact, ni consentement, ni
conversation. Un scénario écoute mais ne diffuse pas : il lui faut déjà un numéro, donc une acquisition payée
ailleurs. Cette feature colle les deux moitiés manquantes, et le pont est **un seul appui**. Il est gratuit
dans les deux sens : publier sur une chaîne ne coûte rien, et la conversation qui s'ouvre ne coûte rien non
plus parce que **c'est l'abonné qui écrit le premier**, ce qui ouvre la fenêtre de service de 24 h et dispense
de tout template approuvé.

Ce qui se vend n'est donc pas une diffusion, c'est la **conversion d'une audience anonyme en contacts
qualifiés**, mesurée par le nombre de scénarios démarrés depuis un post.

## 2. Ce qui a été MESURÉ (et qu'il ne faut pas re-deviner)

Tout ce qui suit a été vérifié empiriquement le 2026-09-04 contre l'API réelle, pas lu en diagonale.

**2.1 Le bouton « Discuter » n'existe dans aucun champ d'API.** Le POST d'un message accepte `kind`, `text`,
`media_url` (ou `media` + `media_checksum`), `published_at`, `time_zone`, `is_draft`, `publish_now`,
`apply_utms` et les trois `utm_*`. C'est tout. Le bouton est **dessiné par le client WhatsApp** parce qu'il a
détecté une URL `wa.me` ou `api.whatsapp.com/send` dans le texte. Trois conséquences :

- **le libellé du bouton ne se choisit pas**, il est imposé par WhatsApp. Une maquette qui proposerait un
  champ « texte du bouton » mentirait ;
- le seul levier est le texte du post et le paramètre `text=` de l'URL ;
- **`text=` n'est PAS le libellé, c'est le message que l'abonné ENVERRA.** C'est donc lui, et lui seul, qui
  porte le jeton de déclenchement.

Il y a par conséquent **deux textes à ne jamais confondre**, et ce document les nomme différemment partout :
le **texte du post** (ce que l'abonné LIT, il contient l'URL) et le **texte pré-rempli** (ce que l'abonné
ENVOIE, il contient la phrase lisible et le jeton).

Format constaté sur un post réellement publié de la chaîne de démo :
`https://api.whatsapp.com/send?phone=33756892263&text=Bonjour%20je%20veux%20recevoir%20la%20newsletter%20!`
La forme `https://wa.me/<chiffres>?text=<encodé>` est strictement équivalente, et c'est **la seule déjà
présente dans ce dépôt** (`waMeTestLink`, `src/workflow/test-token.ts`). On garde celle-là, on n'introduit pas
une seconde forme.

**2.2 La signature porte sur la structure IMBRIQUÉE.** Le vecteur d'or de la documentation
(`{"user_id":"azerty_1234"}` avec le secret `secret` donne `NmkAFERlEbTraKnBkYuHSVygdSA65X5oPU4duO5bRMY=`) est
reproduit exactement par `base64(HMAC-SHA256_binaire(secret, json))`, mais il n'a **qu'une seule clé plate**,
donc il ne dit pas comment signer un corps imbriqué. Mesuré par des POST volontairement invalides (l'auth
passant avant la validation, une signature fausse donne 401 et une signature juste donne 422, sans jamais rien
créer) :

| Corps envoyé | Signature à plat `{"message[kind]":...}` | Signature imbriquée `{"message":{"kind":...}}` |
|---|---|---|
| `application/x-www-form-urlencoded` | 401 | **422** |
| `application/json` | 401 | **422** |
| `multipart/form-data` | 401 | **422** |

Deux enseignements. D'abord **la signature se calcule sur l'objet imbriqué**, ce qui rend le tri alphabétique
EN PROFONDEUR obligatoire. Ensuite **l'encodage du corps n'a aucune importance** : les trois sont acceptés.
On envoie donc du `application/json`, et **le multipart disparaît du sujet** (ni `FormData`, ni frontière, ni
`media_checksum`).

**2.3 Sans `Accept: application/json`, l'API renvoie une page HTML d'erreur Rails en 500.** L'en-tête est
obligatoire sur tous les appels, y compris les GET.

**2.4 La signature n'est pas requise sur les GET**, conformément à la documentation (vérifié : le GET passe
avec ou sans `X-Signature`).

**2.5 Les listes ne paginent pas, et l'enveloppe est `{data:[...]}`.** Mesuré sur la chaîne de démo :
`GET messages` rend 85 éléments pour un `messages_count` de 85, donc la liste est complète. La clé racine de
la réponse est `data`, et elle seule. Le client peut donc lire une liste en un appel, sans paramètres de
requête (ce qui évite au passage d'avoir à deviner comment le fournisseur canonicalise une query string pour
la signature). À re-mesurer si une chaîne dépasse quelques centaines de publications.

**2.6 Le plafond de déclenchements est le vrai risque de la feature.**
`AUTOMATION_MAX_FIRES_PER_HOUR` vaut 200 (`src/config.ts:368`), il est câblé **globalement à l'instance**
(`src/worker.ts:302`), et quand il est atteint le runner écrit une ligne de log et **ignore le déclenchement**
(`src/automation/runner.ts:149`), sans que rien ne remonte à l'écran. Un post de chaîne partant vers 4 218
abonnés, la feature casserait précisément le jour où un post marche bien.

## 3. Décisions verrouillées par Julien

| # | Décision | Ce qu'elle implique |
|---|---|---|
| 1 | **Mono-tenant maintenant, archi multi-tenant** | Les quatre creds vivent dans `channelsme_connections`, une ligne par tenant, les deux secrets chiffrés. Une seule connexion provisionnée à la main pour le pilote, mais rien dans le code ne suppose qu'il n'y en a qu'une. Aucun cred de connexion tenant en `.env`. |
| 2 | **Déclencheur = phrase lisible + jeton caché** | L'abonné voit une phrase naturelle ; la correspondance se fait sur un jeton noyé dedans, via une automation `keyword` en mode `contains`. |
| 3 | **Plafond propre au lien de chaîne** | Le lien porte son propre plafond horaire. Les autres automations gardent leurs 200. C'est la seule option qui ouvre la vanne là où il faut sans desserrer la garde qui protège les envois facturés ailleurs. |
| 4 | **Anti-rebond de 5 minutes sur le lien** | Au lieu des 3600 s par défaut. Filtre le double-appui accidentel, laisse repartir un abonné qui revient plus tard. |
| 5 | **Sous-système autonome `src/channels-me/`** | Même rang que `src/hubspot/` ou `src/zadarma/`. |
| 6 | **Trois tables préfixées `channelsme_`** | Le préfixe n'est pas cosmétique : **le mot `channel` est déjà pris dans ce dépôt** au sens du tuyau `whatsapp` ou `rcs`. L'interdit s'étend aux types, variables et routes : `channelsMe`, `/channels-me/`, jamais `channel` seul. |
| 7 | **Le statut d'un post se LIT EN DIRECT** | On ne le miroite pas. Rien à resynchroniser, aucune file de rattrapage. |
| 8 | **Portée V1** | Image par `media_url` seulement, pas de `poll`, publication immédiate, formulaire de demande minimal notifiant par Telegram. |

## 4. Décisions tranchées dans ce document

Trois tensions avaient une réponse strictement meilleure, elles sont tranchées ici plutôt que remontées.

**4.1 L'automation naît ÉTEINTE et s'allume à la publication.** La convention du dépôt est de créer toute
automation `enabled: false` (« on l'allume explicitement après relecture »). La contrainte produit est
inverse : un post public dont l'automation est éteinte porte un bouton mort. On concilie les deux en
**allumant l'automation au moment où la publication réussit**, pas à la création du lien. Si la publication
échoue, le lien reste éteint, ce qui est le comportement correct. Bénéfice de sécurité : un lien créé mais
jamais publié ne déclenche rien, donc un jeton qui fuiterait avant publication est inerte.

**4.2 Possession de l'automation : colonne additive `possede_par`.** Le prédicat actuel
(`src/automation/store.pg.ts:66`) est `and trigger_kind <> 'webhook'`. Une automation `keyword` possédée par
un lien de chaîne resterait donc listable, modifiable et supprimable depuis l'écran Automation, ce qui
casserait le lien en silence. On ajoute une colonne `possede_par text null` sur `automations` et le prédicat
devient `and trigger_kind <> 'webhook' and possede_par is null`. **Additif, aucun backfill, aucune régression**
sur les webhooks existants (leur exclusion continue de tenir par `trigger_kind`), et cela se généralise au
propriétaire suivant.

🔴 **Conséquence qui n'est pas facultative, et qui a failli passer inaperçue.** Ce prédicat est porté par
`update` (ligne 142) et `remove` (ligne 150), pas seulement par les lectures. Une fois l'automation possédée,
`PgAutomationStore` **ne peut plus la modifier du tout**, y compris pour l'allumer. La décision 4.1 (allumer
à la publication) serait donc morte au premier essai. C'est le même problème que les webhooks ont déjà résolu :
**le propriétaire écrit ses propres requêtes**. `PgChannelsMeLinkStore` porte donc deux méthodes à lui :

```ts
allumerAutomation(tenantId: string, linkId: string): Promise<void>
eteindreAutomation(tenantId: string, linkId: string): Promise<void>
```

Elles écrivent leur propre `update automations set enabled = ...`, bornées par le `tenant_id` **et** par
`possede_par = 'channelsme_link'`. Cette seconde clause est une **garde miroir** : elle interdit au store des
liens de toucher une automation qui ne lui appartient pas, exactement comme le prédicat interdit à l'écran
Automation de toucher les siennes. Les deux gardes se répondent, et c'est ce qui rend la frontière étanche
dans les deux sens.

**4.3 Un lien référencé par un post publié ne se supprime pas, il s'éteint.** Un post publié circule pour
toujours. La suppression dure laisserait un bouton mort sans trace. La route de suppression répond donc 409
tant que `channelsme_posts` référence le lien, et propose l'extinction, qui est réversible. Même raison pour
la clé étrangère `workflow_id` : `on delete restrict`, on ne supprime pas un scénario dont dépend un post en
ligne.

> ⚠️ **Précision du 2026-09-07, à la mise en service du front.** Ce qui suit reste vrai de la COLONNE, et
> le devient trop peu de la LECTURE. L'automation compagnon étant possédée, elle est exclue du prédicat de
> `PgAutomationStore` et absente de `GET /automations` : son état n'était donc lisible nulle part, et la
> console affichait un bouton « allumer » et un bouton « éteindre » sans savoir lequel avait un sens.
> `GET /links` rend depuis un champ `enabled` en **lecture seule**, joint depuis `automations` avec la même
> garde miroir que l'écriture (`tenant_id` ET `possede_par`). Rien ne l'écrit : la règle ci-dessous
> interdit de COPIER l'état, pas de le LIRE à sa source. `null` y veut dire « plus d'automation
> compagnon », jamais « éteint ».

🔴 **Le lien n'a PAS de colonne `enabled` à lui.** Son état allumé ou éteint EST le `enabled` de son
automation compagnon, et c'est la seule source de vérité. Poser un second drapeau sur le lien créerait deux
copies du même état, qui divergeraient au premier chemin qui n'écrit qu'une des deux. Éteindre un lien veut
donc dire écrire `enabled = false` sur son automation.

## 5. Le flux de bout en bout

1. **Provisionnement** (une fois, à la main). Un admin saisit `org_id`, `channel_id`, `api_key`, `secret`.
   La route applique `scopeTenant` (403 si null), `forbidNonAdmin`, puis un `safeParse` Zod (400). Le store
   chiffre les deux secrets **dans le store**, jamais plus haut, et insère avec son `tenant_id`. La projection
   publique ne rend jamais les colonnes chiffrées, seulement
   `{ orgId, channelId, hasApiKey, hasSecret, verifiedAt }`.
2. **État de la connexion.** La console lit en direct `GET /organisations/{org}` et
   `GET /organisations/{org}/message_channels` : nom de la chaîne, nombre de publications, quota mensuel
   consommé. Pas d'interrupteur manuel, qui pourrait mentir.
3. **Composition.** Le client écrit son texte, joint éventuellement une image par URL, choisit **un scénario
   existant** et écrit une **phrase d'accroche** (un défaut est proposé).
4. **Création du lien.** Le serveur tire un jeton, compose le texte pré-rempli, construit l'URL `wa.me` avec
   le numéro WhatsApp du tenant, et crée l'automation compagnon `keyword` / `contains` **éteinte**, possédée
   par le lien.
5. **Publication.** Le serveur refuse si le scénario visé n'a aucune version publiée (un bouton mort dans un
   post permanent ne se rattrape pas). Sinon il ajoute le lien au texte du post, signe, et POST à Channels Me
   avec `publish_now`.
6. **Allumage.** La publication réussie allume l'automation et insère la trace fine dans `channelsme_posts`.
7. **Diffusion.** WhatsApp diffuse le post aux abonnés, le bouton « Discuter » apparaît.
8. **Appui.** L'abonné appuie. WhatsApp ouvre une conversation vers le numéro du tenant, pré-remplie avec
   `<phrase> (cm-xxxxxxxx)`. Il envoie.
9. **Réception.** Le webhook Meta arrive sur le chemin chaud existant, le message est enregistré, le contact
   est créé s'il est nouveau.
10. **Correspondance.** `matchesTrigger` normalise le corps et teste `contains` sur le jeton. Aucune ligne de
    moteur n'est écrite : `src/automation/match.ts` fait déjà exactement cela.
11. **Garde-fous.** Anti-rebond de 5 minutes, plafond propre au lien, et la garde existante « un seul parcours
    actif par contact ».
12. **Démarrage.** Le runner démarre le scénario. L'abonné anonyme est devenu un contact en conversation.

## 6. Schéma de données (migration 0114)

Dernière appliquée : 0113. **0114 est libre.** Migration transactionnelle ordinaire (aucun
`CREATE INDEX CONCURRENTLY`, donc pas de directive `no-transaction`).

```sql
-- 0114_channelsme.sql
-- Intégration Channels Me : connexion chiffrée par tenant, liens de chaîne, trace des publications.
-- ⚠️ Préfixe `channelsme_` obligatoire : `channel` désigne déjà le tuyau (whatsapp|rcs) dans ce dépôt.

create table if not exists channelsme_connections (
  tenant_id     uuid primary key references tenants(id) on delete cascade,
  org_id        text not null,
  channel_id    text not null,
  -- AES-256-GCM, format `v1.<iv>.<tag>.<data>` (src/crypto/secretbox.ts). Jamais lus par l'API publique.
  api_key_enc   text not null,
  secret_enc    text not null,
  verified_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists channelsme_links (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  -- `restrict` : on ne supprime pas un scénario dont un post publié dépend (cf. §4.3).
  workflow_id    uuid not null references workflows(id) on delete restrict,
  start_node_id  text,
  -- Le jeton caché, déjà normalisé (minuscules). C'est LUI que l'automation cherche en `contains`.
  token          text not null,
  -- La phrase que l'abonné voit avant d'envoyer.
  phrase         text not null,
  automation_id  uuid references automations(id) on delete set null,
  -- Plafond horaire PROPRE au lien (décision 3). null = plafond global de l'instance.
  max_par_heure  integer,
  created_at     timestamptz not null default now()
);

-- Un jeton doit être unique GLOBALEMENT, pas seulement par tenant : c'est un identifiant qui circule dans
-- des messages publics et qui est cherché sur le chemin chaud.
create unique index if not exists channelsme_links_token_key on channelsme_links (token);
create index if not exists channelsme_links_tenant_idx on channelsme_links (tenant_id, created_at desc);

create table if not exists channelsme_posts (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  -- Identifiant du message CHEZ Channels Me. Le statut n'est pas stocké, il se lit en direct (décision 7).
  cm_message_id text not null,
  link_id      uuid references channelsme_links(id) on delete restrict,
  created_at   timestamptz not null default now()
);
create index if not exists channelsme_posts_tenant_idx on channelsme_posts (tenant_id, created_at desc);
create unique index if not exists channelsme_posts_msg_key on channelsme_posts (tenant_id, cm_message_id);

-- Possession générique d'une automation (cf. §4.2). Additif : les webhooks existants restent exclus par
-- `trigger_kind`, aucun backfill n'est nécessaire.
alter table automations add column if not exists possede_par text;

-- Plafond horaire par automation (décision 3). null = plafond global.
alter table automations add column if not exists max_fires_per_hour integer;
```

## 7. Module `src/channels-me/`

**`signature.ts`.** Une seule dérivation, et c'est la clé de la correction : la **même chaîne canonique** est
signée et envoyée comme corps. Aucune divergence possible entre ce qu'on signe et ce qu'on transmet.

```ts
/** Tri alphabétique EN PROFONDEUR (mesuré obligatoire, cf. §2.2), sans espaces, slashes non échappés. */
export function corpsCanonique(v: unknown): string;
/** base64(HMAC-SHA256 binaire). Tenu par le vecteur d'or de la documentation. */
export function signer(canonique: string, secret: string): string;
```

**`client.ts`.** Hôte FIXE et de confiance, donc **pas de `resolutionPublique`** (même traitement que les
clients Meta et Zadarma, conformément à la doctrine du dépôt). Réponses validées par `safeParse`, jamais
`parse` ni `as`. `Accept: application/json` sur tous les appels (cf. §2.3). Timeout par `AbortSignal`.

```ts
listChannels(cx: Connexion): Promise<MessageChannel[]>
getOrganisation(cx: Connexion): Promise<Organisation>
createMessage(cx: Connexion, m: { text: string; mediaUrl?: string }): Promise<Message>
getMessages(cx: Connexion): Promise<Message[]>
```

## 8. Endpoints

Tous sous `/tenants/:tenantId/channels-me/*`, tous en écriture réservés aux admins.

| Méthode et chemin | Rôle |
|---|---|
| `GET /connection` | état de la connexion. Relaie côté serveur `GET /organisations/{org}` et `GET .../message_channels` pour rendre le nom de la chaîne, le nombre de publications et le quota mensuel. C'est la seule route qui produit ces compteurs. |
| `PUT /connection` | provisionner ou remplacer les creds (admin) |
| `POST /connection/test` | vérifier les creds sans rien publier, met à jour `verified_at` |
| `GET /links` | liens existants, avec leur scénario |
| `POST /links` | créer un lien (jeton, phrase, scénario) et son automation éteinte |
| `POST /links/:id/disable` | éteindre un lien (l'extinction remplace la suppression, cf. §4.3) |
| `GET /posts` | publications, statut lu en direct, jointes à leur lien |
| `POST /posts` | composer, publier, allumer l'automation, tracer |
| `POST /activation-request` | formulaire de demande, notifie par Telegram |

🔴 **Rayon de souffle, à ne pas oublier :** `src/server.ts:229` porte une liste `modulesTenant` de **36
modules**, et `tests/scope-tenant.test.ts` la garde. Ajouter `deps.channelsMe` **dans les deux**, sinon le
module se monterait sans authentification et `scopeTenant` distribuerait à chacun l'espace demandé dans l'URL.

## 9. Le lien de chaîne et le déclenchement

**Jeton.** Préfixe `cm-` suivi de 8 caractères tirés d'un alphabet minuscule alphanumérique sans caractères
ambigus. Il doit survivre à `normalizeText` (qui minuscule, retire les accents et resserre les espaces) : un
jeton déjà minuscule et sans accent en sort inchangé. Unique globalement.

**Texte pré-rempli.** `<phrase> (cm-xxxxxxxx)`. La phrase est libre, le jeton est entre parenthèses pour se
lire comme une référence technique anodine.

**Correspondance.** Automation `trigger_kind: 'keyword'`, `triggerConfig: { keywords: ['cm-xxxxxxxx'], mode:
'contains' }`, `cooldownSeconds: 300`, `possede_par: 'channelsme_link'`, `max_fires_per_hour` recopié du lien.
Le mode `contains` est ce qui rend l'ensemble robuste : un abonné qui ajoute un mot devant ou derrière la
phrase déclenche quand même.

**Cas limites traités.** Abonné qui édite le texte avant d'envoyer : tant que le jeton reste, ça marche.
Jeton apparaissant dans un message ordinaire : improbable par construction (8 caractères aléatoires préfixés).
Aucun numéro WhatsApp connecté : la création du lien répond 409 avec un message explicite, plutôt qu'un lien
cassé. Deux liens vers le même scénario : autorisé, chacun a son jeton, ce qui permet justement de mesurer
quel post convertit le mieux.

**La seule modification du moteur**, rendue nécessaire par la décision 3 : le runner lit
`a.maxFiresPerHour ?? deps.maxFiresPerHour` au lieu du seul plafond global. Changement additif, à couvrir par
un test qui prouve qu'un plafond par automation l'emporte et qu'une automation sans plafond garde le global.

## 10. Interface

Section **Chaîne** de premier niveau, juste après Campagnes (sa soeur en one-to-many), visible même sans
chaîne connectée pour porter la demande d'activation. Maquette validée :
https://claude.ai/code/artifact/cb5fb856-8ddb-4dda-96b5-bc4cc88091b0

Quatre écrans : la carte de connexion en données réelles, le composeur avec aperçu du rendu (en distinguant
visuellement ce qu'on écrit de ce que WhatsApp dessine), la liste des publications avec statut, scénario
rattaché et **nombre de conversations démarrées**, et l'état vide avec le bouton de demande.

## 11. Sécurité

- Les deux secrets sont chiffrés au repos par `encryptSecret` (`src/crypto/secretbox.ts`), chiffrés **dans le
  store**, et ne sortent jamais de l'API : la projection publique ne porte que des booléens `hasApiKey` et
  `hasSecret`.
- Filtrage `tenant_id` sur **chaque** requête (le pooler est superuser, la RLS est contournée, c'est le seul
  contrôle).
- `safeParse` sur tout ce qui vient de Channels Me et du client.
- **Le jeton n'est jamais journalisé.** Il circule dans des messages publics mais reste l'identifiant qui
  déclenche un scénario.
- `media_url` est fourni par le client mais **nous ne le récupérons jamais** (c'est Channels Me qui le fait),
  donc pas de SSRF contre nous. On exige tout de même `https` et on refuse les littéraux privés par la
  vérification textuelle existante, sans résolution DNS qui n'aurait pas de sens ici.
- Toute erreur destinée à l'utilisateur sort en **4xx**, jamais 5xx (Cloudflare remplacerait le corps).
- 🔴 **Le corps de réponse du tiers ne se relaie JAMAIS tel quel**, ni au client ni dans un journal. Deux
  raisons mesurées : sans `Accept: application/json` l'API rend une page HTML entière (§2.3), et un corps
  distant peut porter des données d'un autre espace. On ne garde que le **code de statut** et, quand la
  réponse est du JSON valide, le seul champ `error.message`, tronqué. Le reste est jeté.

## 12. Ce qu'on ne fait PAS en V1

Upload multipart et `media_checksum` (rendus inutiles par la mesure §2.2), type `poll`, planification
(`published_at` et `time_zone`), UTM, édition et suppression d'un post déjà publié, pagination des listes,
création de chaîne en self-service, et multi-chaînes par tenant.

**Repointer un lien vers un autre scénario** n'est pas offert non plus : un lien est créé pour un post, avec
son scénario. Pour un autre scénario, on crée un autre lien, ce qui a l'avantage de garder deux jetons
distincts et donc deux mesures de conversion distinctes. La clé étrangère en `restrict` empêche par ailleurs
de se retrouver avec un lien orphelin.

## 13. Questions restées ouvertes

- **Longueur maximale du texte d'un post** : non mesurée chez Channels Me ni chez WhatsApp. La console compte
  sans refuser, et relaie le 422 distant. À mesurer avant d'imposer une borne qui refuserait des posts valides.
- **Rapatrier les automations `webhook` sur `possede_par`** pour n'avoir qu'un seul mécanisme : hors périmètre,
  la ceinture à deux clauses suffit. À ranger dans `todo.md`.
- **Volume réel du premier post.** Le plafond propre au lien (décision 3) doit être réglé sur une valeur, et
  personne ne sait encore combien d'abonnés appuient sur le bouton dans l'heure qui suit une publication. On
  pose une valeur généreuse pour le pilote, puis on la règle sur la mesure du premier vrai post.
