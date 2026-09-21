# Plan d'exécution du lot L4 : MCP en jeton statique, sur allowlist

> Suite de [AGENT-IA-PLAN-L2.md](AGENT-IA-PLAN-L2.md), qui a livré la deuxième famille d'outils (les
> connecteurs HTTP du client). L4 livre la troisième. Cadrage de référence :
> [AGENT-IA-CADRAGE-2026-08-23.md](AGENT-IA-CADRAGE-2026-08-23.md), décision **D3**.

**Ce que le lot promet, en une phrase :** « il crée un ticket dans Linear, une page Notion, sans que vous ayez
à décrire l'API ». Le client choisit un serveur dans une liste que nous avons validée, colle son jeton, coche
les outils qu'il veut, et son agent les appelle.

**Ce que le lot ne fait pas :** OAuth (c'est L6), URL de serveur arbitraire (c'est L7), et il n'écrit pas une
ligne de client `stdio`.

---

## 🔴 LA DÉCISION QUI CHANGE TOUT LE RESTE, ET ELLE EST DÉJÀ PRISE ICI

**Le schéma d'un outil MCP est TRADUIT dans notre modèle à la déclaration, jamais transmis tel quel.**

Un outil MCP arrive avec un `inputSchema` en JSON Schema arbitraire, écrit par un tiers. La tentation est de
l'épingler et de le repasser au fournisseur de modèle. C'est le choix qui fait exploser le lot, et ce n'est
pas une contrainte du protocole, c'est une option.

L'autre option, retenue : à l'activation, on traduit `inputSchema` en `ParamOutil[]`
([src/agent/llm/tool-schema.ts](src/agent/llm/tool-schema.ts)) et on l'écrit dans `agent_tools.params`,
exactement comme L2 le fait pour un connecteur HTTP.

- propriété `string` / `number` / `integer` / `boolean`, avec `enum` de chaînes et `description` : traduite ;
- propriété non représentable (objet, tableau, `oneOf`, `$ref`, `if`) et **facultative** : ignorée ;
- propriété non représentable et **requise** : **l'outil est refusé**, nommément, dans la console.

Ce que cette seule décision fait tomber, et c'est la raison de la retenir :

| Ce qu'on n'a plus à écrire | Pourquoi |
|---|---|
| Un second chemin d'exposition au modèle | `toolParamsToJsonSchema` sert MCP sans une ligne de plus |
| Un assainisseur de JSON Schema tiers, la profondeur, les bornes anti-DoS de validateur | On ne consomme jamais le schéma distant : on le traduit ou on le refuse |
| Le traitement de `$ref`, que la spec interdit de déréférencer | Un mot-clé non reconnu est un refus, en temps linéaire |
| Une dépendance de validation (ajv) | `schemaArguments` continue de dériver son `z.object` de `params` |
| Les colonnes `remote_schema` et `remote_desc` | `params` **EST** la définition approuvée. C'est ça, l'épinglage |

Et surtout, ce que ça **récupère** : l'injection `contact` / `fixe` de L2 marche pour MCP gratuitement. Un
outil MCP qui prend un identifiant client peut donc être épinglé au numéro authentifié par la signature du
webhook Meta. **Rien dans MCP ne fournit cette garde**, et c'est le pivot anti-IDOR du produit.

Coût assumé, à dire au client : un outil MCP à schéma imbriqué n'est pas proposable. Sur une liste de trois
serveurs, ça se constate en une heure au branchement, et le refus est visible dans la console, jamais en
conversation.

---

## Contraintes globales du lot (elles s'appliquent à chaque tâche)

Écrites en tête parce que sans elles, les pièces coupées reviennent en sous-tâches.

- **Zéro dépendance npm nouvelle.** Le client MCP s'écrit sur le `HttpTransport` maison, comme tout le reste
  du dépôt. Le SDK officiel embarque `cross-spawn` (stdio, interdit) et `pkce-challenge` (OAuth, c'est L6).
- **Zéro nouvelle file pg-boss, zéro cron.**
- **Au plus une colonne de migration** (la 0089 est libre). `agent_tools.binding` est déjà un jsonb lu
  défensivement : il porte `{methode, chemin}` pour HTTP, il portera `{remoteName, empreinte}` pour MCP.
- **Un seul commit, cinq tâches au plus.** Un plan plus gros ne sera pas fini d'une traite, et il finirait
  déployé à moitié sur un chemin conversationnel en production.
- Les règles du dépôt continuent de valoir : `tenant_id = $1` sur chaque requête, `safeParse` jamais `parse`,
  4xx et jamais 5xx pour une erreur destinée au client, pas de tirets longs.

---

## 🔴 CE QUI EST DÉJÀ LÀ, ET QU'IL NE FAUT PAS RÉÉCRIRE

- **La table des sources porte déjà `kind in ('http','mcp')`** (migration 0088). La valeur a été déclarée
  d'avance exactement pour ce lot.
- **`SourceVue` contre `SourceAppel`** ([src/agent/sources.ts](src/agent/sources.ts)) : la première ne porte
  jamais le secret, la seconde le déchiffre et n'a qu'un appelant. `SourceAppel` suffit telle quelle pour un
  jeton statique.
- **L'aiguillage par origine** est déjà en place et c'est le SEUL de tout le runtime :
  `deps.resolveurs[outil.origin]` ([src/agent/executor.ts](src/agent/executor.ts), étape 6). Brancher `mcp`
  ne demande aucune modification de l'exécuteur, seulement le câblage dans `src/worker.ts` et `src/index.ts`.
- **`enTetesAuthSource`** ([src/agent/http-cible.ts](src/agent/http-cible.ts)) est le point de passage obligé
  des en-têtes d'authentification. Il s'étend, il ne se recopie pas.
- **Le compteur d'outils actifs par source** est déjà calculé en SQL (`SourceVue.outilsActifs`) : le plafond
  de dix outils par serveur se pose en refus de route, sans nouveau compteur.
- **Le consentement humain** est déjà en base : `check (actif = false or active_par is not null)`
  (migration 0086). C'est la bonne réponse au `MUST` de consentement de la spec MCP, à une condition posée
  en tâche T3 : le geste doit porter sur l'**empreinte du texte approuvé**, pas sur le nom de l'outil.
- **`redirect: 'error'`** ([src/agent/resolvers/http.ts](src/agent/resolvers/http.ts)) et sa doctrine : une
  API qui redirige est une anomalie. À reporter tel quel.

---

## ⚠️ TROIS TROUS À FERMER AVANT D'OUVRIR CE LOT

Ce ne sont pas des tâches L4 : ce sont des dettes que L4 rendrait exploitables. Les deux premières ont été
corrigées le 2026-08-29, la troisième reste ouverte.

1. ✅ **Le bloc délimité était contournable** ([src/agent/bloc-donnees.ts](src/agent/bloc-donnees.ts)). Un seul
   passage de neutralisation laissait un délimiteur doublé se reformer. Corrigé, mesuré, testé dans les deux
   sens. Sans ça, tout texte rendu par un serveur MCP sortait du bloc et se lisait comme une consigne.
2. ✅ **Le retour du `catch` de l'exécuteur court-circuitait la borne de taille.** Un résolveur qui laisse
   remonter une erreur du serveur d'en face faisait entrer son message dans le prompt sans plafond. Inoffensif
   tant que chaque résolveur attrape tout lui-même ; or un client MCP transforme les erreurs JSON-RPC en
   exceptions **dont le message est écrit par le distant**. Corrigé.
3. 🔴 **Le croisement `origin` / `kind` n'est vérifié nulle part.** `sourceExiste`
   ([src/index.ts](src/index.ts)) ne contrôle que l'existence, et la route connecteur écrit `origin='http'` en
   dur. Dès qu'une source `mcp` pourra exister, elle sera sélectionnable dans la route du connecteur HTTP,
   ce qui produirait un outil `http` **envoyant le jeton MCP en Bearer sur des chemins arbitraires sous le
   point d'entrée**. À fermer par une contrainte de base, pas seulement en route : c'est le seul contrôle qui
   survit à un appelant oublié. **Inclus en T3.**

---

## ❓ CE QUI DOIT ÊTRE TRANCHÉ AVANT D'ÉCRIRE LE CODE

### D3. Allowlist de serveurs, ou URL libre ?

**Recommandation : allowlist, et rien d'autre dans ce lot.** Elle vit dans une **constante gelée**
(`src/agent/mcp-allowlist.ts`), pas dans une table : elle contiendra trois lignes que Julien seul peut
valider, et une allowlist « validée par nous » change quand Julien déploie. Une table, une migration, des
routes et un écran pour trois lignes, c'est du tailor-made.

Le drapeau par tenant « URL libre » du cadrage est **L7**, un lot séparé. Un booléen que personne ne lit
n'est pas une préparation, c'est une trappe. Et L7 ne doit pas partir sans le correctif du rebinding DNS,
qui devient son ticket d'entrée (voir plus bas).

**Comparer l'hôte, jamais le préfixe de chaîne.** Mesuré : un `startsWith` accepte
`https://mcp.serveur-valide.example@evil.test/` et `https://mcp.serveur-valide.example.evil.test/`, et refuse
le même hôte en majuscules. La comparaison porte sur `new URL(x).host` normalisé, plus un refus explicite de
`username` / `password` non vides. Et elle est **rejouée à l'appel**, pas seulement à l'écriture : retirer un
serveur de la liste doit couper les sources déjà créées, même doctrine que `source.status !== 'active'`.

### La question que le cadrage n'avait pas vue : d'où vient `risk` pour un outil MCP ?

Pour un connecteur HTTP, le risque est **dérivé de la méthode** et ne peut pas être abaissé
(`risqueSelonMethode`, `risqueAuMoins`), et le commentaire dit pourquoi : laisser le client le déclarer « lui
permettrait de marquer `read` un `DELETE`, donc de désarmer la garde d'autonomie sur une action
irréversible ». **Un appel MCP n'a pas de méthode HTTP : ce plancher n'existe pas.** Les seules annotations
disponibles (`readOnlyHint`, `destructiveHint`) sont déclarées non fiables par la spec elle-même.

Sans plancher, `risk` redevient déclaratif, et la garde `risk === 'irreversible' && !autonome` de l'exécuteur
se désarme d'une case à cocher.

**Recommandation : plancher `write` pour tout outil MCP.** Un outil MCP n'est jamais `read` : on ne sait pas
ce que le serveur fait. `irreversible` reste un choix explicite du client, et l'autonomie reste interdite
dessus, exactement comme aujourd'hui. **À valider par Julien, c'est un choix de produit.**

### Deux points d'exploitation, hors du lot mais à décider

- **Le rebinding DNS reste ouvert, et ce n'est pas une ligne.** *(Fermé le 2026-09-21, par un `fetch` et un
  `Agent` pris dans le MÊME paquet `undici` et un connecteur qui juge aussi les littéraux :
  `src/lib/connexion-publique.ts`. Le constat ci-dessous reste juste, c'est lui qui a dicté la forme.)* Mesuré sur ce poste : `setGlobalDispatcher`
  depuis le paquet npm ne s'applique PAS au `fetch` global de Node, et la requête **passe** sans erreur. Un
  correctif écrit comme ça serait un fail-open silencieux qu'une suite de tests verte ne verrait pas. Et
  `connect.lookup` n'est jamais appelé quand l'hôte est un littéral IP. La voie sans dépendance est
  `node:https.request({ lookup })`, au prix d'écrire la lecture du corps à la main. Pour L4 en allowlist,
  l'adresse vient de nous : le risque est faible. **Pour L7, il est le ticket d'entrée.**
- **Isoler `mba-worker` du réseau `mcp-robot_default` n'est PAS possible en l'état.** Vérifié sur le VPS :
  `CONNECTOR_PUSH_URL=http://mm-hubspot-api:8096/ingest` et `HUBSPOT_SERVICE_URL=http://mm-hubspot-api:8096`.
  Le worker a réellement besoin de ce réseau. La vraie manœuvre est un réseau dédié portant `mba-worker` ET
  `mm-hubspot-api`, ce qui fermerait `odalys-admin`, `ganprev-app` et l'admin NPM. C'est une opération
  d'exploitation à part entière, à ne pas mêler au déploiement du lot.

---

## Les cinq tâches

### T1. Le client de protocole et le résolveur

**Fichiers :** créer `src/agent/mcp.ts` et `src/agent/resolvers/mcp.ts` ; câbler dans `src/worker.ts` et
`src/index.ts`.

`mcp.ts` : un POST JSON-RPC sur le point d'entrée, `fetchImpl` injectable comme partout,
`accept: 'application/json, text/event-stream'` (la spec l'exige, et le serveur choisit lequel il rend).
Corps borné pendant la lecture, jamais sur `content-length` (doctrine déjà écrite dans `page-distante.ts`).
Si la réponse est un flux d'événements, on prend le dernier `data:` qui parse en réponse JSON-RPC portant
notre identifiant : une vingtaine de lignes, pas de machine à états, puisqu'on ne consomme aucune
notification de progression.

`resolvers/mcp.ts` : calqué sur `resolvers/http.ts`. `redirect: 'error'`, `secure-json-parse` (déjà en
dépendance) sur un corps non fiable, **seuls les blocs de contenu textuels traversent**, un résultat d'erreur
du serveur rendu en `ok: false` sans marquer la source morte, et **le résolveur ne lève jamais**, même
doctrine que son voisin.

⚠️ **À revérifier sur la spec au moment d'écrire**, parce que ces points viennent d'une lecture par agent et
pilotent l'implémentation : la révision courante n'a plus d'échange `initialize`, les capacités client sont un
champ requis de chaque requête, et les interactions serveur vers client sont embarquées dans le résultat au
lieu d'être des requêtes. Si c'est confirmé, la garde n'est pas « ne pas enregistrer de gestionnaire » (il n'y
en a plus), c'est **refuser tout résultat qui n'est pas complet**, avec un test.

### T2. La traduction du schéma et l'empreinte

**Fichier :** créer `src/agent/mcp-schema.ts`. Module pur, testable sans réseau, une soixantaine de lignes.

La traduction décrite en tête de ce document, plus le calcul de l'empreinte (sha256 sur une forme canonique).
L'empreinte porte sur **ce qui sera exposé au modèle** : le nom, la description et les paramètres traduits.

**Deux refus, pas des troncatures.** La description distante n'est bornée par rien dans le protocole, et elle
part dans le tableau d'outils à **chaque aller-retour de chaque tour**. Le plafond se pose à la
synchronisation, et c'est un refus : tronquer après le calcul de l'empreinte la rend fausse, tronquer avant
fait approuver un texte différent de celui qui sera exposé.

### T3. Les routes

**Fichiers :** `src/http/agent-sources.ts`, `src/http/agent-tools.ts`, `src/agent/sources.pg.ts`,
`src/agent/catalog.pg.ts`, migration `0089`.

- créer une source `kind: 'mcp'`, l'adresse validée contre la constante d'allowlist, hôte normalisé ;
- l'épreuve d'une source MCP est une liste d'outils, pas un `GET` (aujourd'hui `epreuveSchema` force un chemin
  et passe par `construireCible`, qui ne sert pas ici) ;
- une route qui rend la liste traduite, **avec les refus motivés** : le client doit voir pourquoi un outil
  n'est pas proposable ;
- déclarer un outil `mcp`, avec le plafond de dix par source ;
- 🔴 **la garde de `kind`**, en route ET en contrainte de base (voir le trou n°3 ci-dessus) ;
- ⚠️ **le nom.** `agent_tools.name` impose `^[a-z0-9_]{1,64}$`, ce qui refuse les noms MCP réels
  (`github.create_issue`, `get-weather`). D'où `remoteName` dans `binding` : le nom distant part au serveur,
  le nom exposé reste le nôtre. Et l'index unique est **par agent**, donc deux serveurs exposant `search`
  entrent en collision : le nom exposé doit être dérivé du couple source plus outil distant.

### T4. L'écran

**Fichiers :** `web/components/ConnecteursBibliotheque.tsx`, `web/components/AgentConnecteurs.tsx`.

Un serveur MCP est **un connecteur de plus dans la bibliothèque Tools > Connecteurs API**, pas une liste à
part : c'est la même phrase pour le client (« les systèmes que vos agents peuvent interroger »), et une
seconde liste rouvrirait exactement le piège de vocabulaire du 2026-08-28.

Mais **le formulaire n'est pas le même**, et c'est la vraie différence : un connecteur HTTP se décrit à la
main, un serveur MCP décrit ses outils tout seul. Donc : un sélecteur de type, un formulaire à trois champs
(serveur choisi dans la liste, libellé, jeton), et dans l'onglet Outils d'un agent une liste d'outils distants
à cocher, avec les refus motivés. Pas de tableau de bord par serveur, pas de visionneuse de différences : le
badge d'épreuve que L2 rend déjà suffit.

Le bouton **« resynchroniser »**, nécessaire de toute façon pour ajouter des outils, recalcule les empreintes
et affiche « 3 outils ont changé ». C'est tout le dispositif de détection de dérive dont ce lot a besoin :
avec le schéma épinglé dans `params`, un changement de définition ne peut plus changer ce que le modèle voit.

### T5. Les tests

Ce que seul un test peut tenir, et rien de décoratif :

- la traduction du schéma, y compris **le refus** d'une propriété requise non représentable ;
- l'empreinte change quand la description change, et **ne change pas** quand le serveur réordonne ses clés ;
- l'allowlist refuse les deux formes d'hôte mesurées ci-dessus, et accepte le même hôte en majuscules ;
- l'allowlist est rejouée à l'appel : retirer un serveur coupe une source déjà créée ;
- le croisement `origin` / `kind` est refusé dans les deux sens ;
- le plafond de dix outils par source est un refus de route ;
- un résultat d'erreur du serveur distant rend `ok: false` sans marquer la source morte, et **ne lève pas** ;
- le résolveur ne laisse passer que du contenu textuel.

---

## Ce qui est délibérément hors du lot

Écrit ici pour que la question ne se repose pas à chaque tâche.

- La conformité complète au protocole. On écrit un client pour trois serveurs connus, pas une bibliothèque.
  L'allowlist est précisément ce qui transforme la conformité en non-objectif : ce qui passe sur la liste
  passe.
- Le plafond du nombre d'outils actifs **par agent**, qui n'existe nulle part aujourd'hui. C'est un réglage
  transversal aux trois familles, pas une pièce MCP : le poser ici le rendrait invisible dans le lot où on le
  cherchera. À noter dans `todo.md`, avec la remarque que le plafond utile se mesure en **octets** du tableau
  d'outils, pas en nombre.
- La détection périodique de dérive, sa file et son écran de différences.
- Le rebinding DNS et l'isolement réseau (voir plus haut).
- OAuth (L6) et l'URL arbitraire (L7).
