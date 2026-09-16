# Connecteurs MCP : cadrage

> Décidé avec Julien le 2026-09-16 par `grilling`, cinq rounds, vingt et une décisions.
> Le plan d'exécution qui en découle : `docs/superpowers/plans/2026-09-16-connecteurs-mcp.md`.

## Objectif

Un client branche Engage Me sur un **serveur MCP tiers**, Engage Me en récupère le catalogue d'outils,
et le client déclare ensuite à son agent IA, dans `AI Agent > Outils`, lesquels il a le droit d'appeler.
Exactement le trajet qu'un connecteur API suit déjà, avec une différence de fond : **c'est le serveur
distant qui annonce ce qu'il sait faire**, là où un connecteur API est un appel que nous écrivons.

## Ce qui existe déjà, et qu'on n'invente pas

Le dépôt avait prévu MCP dès le premier jour. Ce cadrage s'y pose au lieu de s'installer à côté.

| Existant | Ce qu'il apporte |
|---|---|
| `agent_tool_sources.kind in ('http','mcp')` (0088) | La table est faite pour ça. Son commentaire le dit : « 'mcp' est declare des maintenant pour que L4 n ait pas de migration a faire, mais aucun code ne le sert. » |
| `agent_tools.origin in ('mba','http','mcp')` (0086) | La valeur existe, rien ne la produit |
| `agent_tool_consommateurs` (0127) | Le consentement par consommateur, et l'unicité du nom d'outil **par espace** |
| `agent_tools.output_paths`, `.nature` (0150) | Le filtre de sortie et le sens de l'appel, portés par l'outil |
| `agent_tool_calls` + `source` (0142) | Le journal des appels, ouvert à ses trois appelants |
| `src/lib/adresse-privee.ts` | La garde SSRF, en deux temps : le texte de l'hôte, puis ce vers quoi il résout |
| `src/lib/corps-borne.ts` | La lecture bornée d'un corps distant, en flux, avec ses trois verdicts |
| `src/agent/llm/tool-schema.ts` | La séparation `modele` / `contact` / `fixe`, c'est-à-dire la garde d'identité |
| `src/agent/resolvers/simulation.ts` | Le bac à sable, qui simule déjà tout ce qui n'est pas un outil maison |

**Conséquence : aucune table nouvelle.** La migration n'ajoute que des colonnes à `agent_tools`.

⚠️ **Et il y a un quatrième endroit qui attend MCP, celui-là visible du client.** L'assistant de
configuration d'agent propose déjà l'action `outil_mcp`, avec un libellé qui dit « pas encore disponible :
ce serait à brancher », et il porte un inventaire `mcp: string[]` (`src/agent/setup/couverture.ts`). Trois
textes y deviennent **faux** le jour où ce lot est déployé, et ils sont dans le questionnaire que le client
lit. Ils font partie du lot, pas d'un rattrapage.

## Les trois faits de la spec MCP qui cadrent l'implémentation

Lus dans le texte de la révision **2025-06-18**, pas de mémoire. Chacun a une conséquence directe.

### 1. `tools/list` est PAGINÉ

La réponse porte un `nextCursor` optionnel, et la requête accepte un `cursor`. **Ne pas suivre le curseur,
c'est importer un catalogue partiel sans que rien ne le signale**, ce qui donnerait un client convaincu
d'avoir tous ses outils alors qu'il en a les vingt premiers. L'import suit donc les pages jusqu'au bout,
avec une borne, et **dit à l'écran** s'il a buté sur cette borne. Un plafond silencieux se lit comme une
couverture complète.

### 2. Un appel n'est pas un POST isolé : il y a un cycle de vie et une session possible

Le client doit envoyer `initialize`, puis la notification `notifications/initialized`, avant toute autre
requête. Si le serveur assigne un `Mcp-Session-Id` dans la réponse d'initialisation, le client **DOIT** le
porter sur toutes les requêtes suivantes, et redémarrer une session neuve sur un 404. L'en-tête
`MCP-Protocol-Version` est obligatoire sur toutes les requêtes qui suivent l'initialisation.

**Conséquence** : une session est ouverte, utilisée, puis jetée, **à l'échelle d'une opération**. Un
rafraîchissement de catalogue ouvre une session, pagine, ferme. Un tour d'agent ouvre une session au premier
appel d'outil et la réutilise pour les suivants **du même tour**, en mémoire du process.

Elle n'est jamais mise en cache au-delà : l'API et le worker sont deux process, le déploiement en lance
d'autres, et un identifiant de session partagé entre deux process rend un 404 qu'il faudrait rattraper.
Le coût assumé est de deux allers-retours de plus au premier appel d'un tour, dans un budget qui est déjà
de 8 secondes par outil (`agent_tools.timeout_ms`).

### 3. Une réponse à un POST peut revenir en flux d'événements

Le serveur **MAY** répondre `Content-Type: text/event-stream` à un POST plutôt que `application/json`, et
le client **MUST** savoir lire les deux. La requête doit annoncer `Accept: application/json, text/event-stream`.
Un client qui ne sait lire que du JSON tombe donc en marche sur une moitié des serveurs conformes.

**Conséquence** : le client lit le flux jusqu'à la réponse JSON-RPC qui porte son `id`, puis s'arrête. Il ne
tient aucun flux ouvert et n'ouvre jamais le `GET` SSE optionnel, dont il n'a aucun usage (nous ne recevons
pas de requêtes du serveur).

### Et un quatrième, sur la confiance

La spec dit, en toutes lettres, que les `annotations` d'un outil (`readOnlyHint`, `destructiveHint`) sont à
**considérer comme non fiables** sauf serveur de confiance. Elles servent donc à **pré-remplir** le risque
proposé au client, jamais à décider : c'est le client qui confirme, comme il le fait déjà pour l'autonomie
d'un outil irréversible.

Même raisonnement pour le `description` d'un outil distant, qui part dans le schéma envoyé au modèle : c'est
du texte écrit par un tiers, qui arrive dans le contexte du modèle. La parade n'est pas technique, elle est
déjà là : **l'activation est un acte humain nommé** (doctrine de 0086), et le client lit la description avant
d'activer. L'écran la montre donc en entier, sans la tronquer.

## Modèle de données

### `agent_tool_sources` : rien à changer

Un serveur MCP est une ligne avec `kind = 'mcp'`. `base_url` porte **l'adresse du point MCP** (l'endpoint
unique, par exemple `https://exemple.com/mcp`), pas une racine sous laquelle on composerait des chemins :
il n'y a pas de chemin à composer. `auth_kind` reste `none` / `bearer` / `header`, et c'est exactement
le « jeton simple ». `status`, `last_ok_at` et `last_error` servent tels quels.

### `agent_tools` : quatre colonnes de plus

Un outil importé est une ligne avec `origin = 'mcp'` et `source_id` renseigné, ce que la contrainte
`agent_tools_origin_src_chk` exige déjà. `request_id` reste `null`. `binding` porte `{ outilDistant: "<nom>" }`,
sur le même patron que `binding.handler` d'un outil maison.

| Colonne | Type | Rôle |
|---|---|---|
| `mcp_annonce` | `jsonb` nullable | L'annonce BRUTE du serveur pour cet outil (`name`, `title`, `description`, `inputSchema`, `outputSchema`, `annotations`), telle qu'elle est arrivée |
| `mcp_non_activable` | `text` nullable | `null` = activable. Sinon, la raison en clair, affichée telle quelle |
| `mcp_indisponible_le` | `timestamptz` nullable | L'outil a disparu du catalogue distant. On ne le supprime pas |
| `mcp_vu_le` | `timestamptz` nullable | Dernier rafraîchissement où le serveur l'annonçait encore |

`mcp_annonce` est ce qui permet de **dire ce qui a changé** au rafraîchissement, et c'est la seule raison
d'être de cette colonne. Sans elle, on saurait qu'un schéma a bougé sans pouvoir dire en quoi.

Aucun index nouveau : les lectures passent par `source_id`, qui porte déjà `agent_tools_source_idx`.

### Le nom d'un outil importé

`agent_tools.name` doit matcher `^[a-z0-9_]{1,64}$` et il est **unique par espace**. Le nom distant, lui,
n'a aucune contrainte dans la spec.

L'import construit donc `<prefixe_serveur>_<nom_distant_normalisé>`, tronqué à 64. Le préfixe vient du libellé
de la source. Trois choses en découlent, toutes voulues :

- deux serveurs qui exposent chacun un `search` ne se marchent plus dessus, **par construction** et non par
  un message d'erreur au deuxième ;
- le modèle **voit d'où vient l'outil**, ce qui l'aide à choisir quand il en a quinze ;
- le nom distant reste dans `binding.outilDistant` et dans `mcp_annonce`, et **c'est lui qu'on envoie** au
  serveur. Notre nom est une étiquette locale, jamais une donnée de protocole.

Si la troncature produit un doublon, un suffixe numérique tranche, et l'écran le dit.

## Les paramètres, c'est-à-dire la sécurité

C'est le cœur du cadrage, et la seule partie où une erreur fait fuiter la donnée d'un client vers un autre.

### Le risque, en une phrase

Un agent parle à un contact. **Ce que le contact écrit entre dans le modèle**, et le modèle remplit les
paramètres des outils. Un outil `get_orders(customer_id)` dont le `customer_id` est rempli par le modèle
laisse donc un contact demander les commandes de quelqu'un d'autre. C'est un IDOR, et le produit s'en protège
depuis 0086 en donnant à chaque paramètre une **source** : `modele` (le modèle le remplit et le voit),
`contact` (le runtime l'injecte, le modèle ne le voit même pas), `fixe` (une constante de l'espace).

### L'aplatissement par chemin

Notre système de paramètres est **plat** (`string`, `number`, `integer`, `boolean`), un `inputSchema` MCP ne
l'est pas. L'import **énumère les feuilles scalaires** du schéma distant et en fait un paramètre chacune :

```
inputSchema : { filtres: { ville: string, date: string }, limite: integer }
        ->    filtres_ville   (chemin "filtres.ville")
              filtres_date    (chemin "filtres.date")
              limite          (chemin "limite")
```

Chaque feuille reçoit sa source, donc **le clouage descend jusque dans les sous-objets**. À l'appel, on
rebâtit l'objet imbriqué depuis les chemins. `ParamOutil` gagne un champ `cheminMcp?: string` : le `name`
reste le nom exposé au modèle (plat, normalisé), le chemin reste une donnée interne que le modèle ne voit pas.

Deux feuilles dont le nom final se collisionne (`a.ville` et `b.ville`) sont désambiguïsées par leur chemin.

### Les trois formes qu'on ne peut pas aplatir

| Forme | Pourquoi elle résiste |
|---|---|
| Tableau d'objets (`lignes: [{sku, qte}]`) | Le nombre d'éléments n'est pas connu, il n'y a pas de jeu de chemins fixe |
| Alternatives (`oneOf` / `anyOf`) | Deux formes possibles, donc pas un jeu de feuilles unique |
| Objet libre (aucune propriété déclarée) | Rien à énumérer |

Ces outils sont **importés, stockés, affichés avec leur schéma complet, et non activables**.
`mcp_non_activable` porte la raison en clair (« le paramètre `lignes` est une liste d'articles, on ne sait
pas encore la remplir en sûreté »).

Ce n'est pas une limitation qu'on cache : c'est une mesure qu'on va chercher. Tant qu'on n'a pas branché de
vrais serveurs, personne ne sait quelle proportion ça représente. Le jour où le chiffre est là, il décide
s'il faut un lot pour ça.

### Le clouage s'ouvre aux champs du mini-CRM

Aujourd'hui, `source: 'contact'` ne peut désigner que `wa_id` et `nom` (`CHAMPS_CONTACT_AUTORISES`, liste
fermée volontairement : « un `contactPath` libre ferait dériver un paramètre de n'importe quelle clé future »).

C'est trop étroit pour MCP : beaucoup de serveurs identifient par e-mail ou par référence client, et ces
paramètres-là retomberaient sur le modèle, c'est-à-dire précisément là où on ne les veut pas.

**On ouvre aux champs DÉCLARÉS de l'espace** (ceux que le client a créés dans `Bibliothèque > Champs`),
choisis dans une liste déroulante. L'esprit de la fermeture est conservé : on désigne un champ qui existe,
jamais un chemin libre tapé à la main. Et la donnée est déjà sous la main au runtime, la projection du
contact portant `{nom, tags, champs}` : aucune requête de plus sur le chemin chaud.

Un champ est désigné par **son identifiant**, pas par son libellé : un client qui renomme un champ ne doit pas
débrancher un outil sans le savoir.

### Un champ cloué qui est vide

**On envoie vide, et le serveur décide** (décision de Julien). Refuser l'appel serait faux pour un paramètre
optionnel : un outil qui refuse de chercher parce que le contact n'a pas renseigné sa ville serait absurde.

Le schéma distant dit lesquels sont **obligatoires** (`required`). C'est là que l'avertissement se pose :
**au moment du clouage**, sur l'écran, pas à l'exécution. « Ce paramètre est obligatoire pour le serveur.
S'il est vide sur un contact, l'appel partira sans, et c'est le serveur qui décidera quoi en faire. »

## Ce que l'agent reçoit en retour

Un `tools/call` rend un tableau `content` (blocs `text`, `image`, `audio`, `resource_link`, `resource`), un
`structuredContent` optionnel, et un `isError`.

**Le retour part au modèle tel quel**, borné par `max_bytes` comme tout le reste : on concatène les blocs
`text`, et les blocs non textuels sont remplacés par une mention courte de leur type. La spec prévoit qu'un
outil qui rend du `structuredContent` en rende **aussi** la forme sérialisée dans un bloc texte, donc le texte
porte l'essentiel dans le cas général.

**`output_paths` est explicitement IGNORÉ pour les outils MCP, et c'est écrit dans le code.** Le laisser
simplement vide reproduirait exactement le défaut que 0150 a corrigé : un filtre vide rend zéro champ, l'agent
ne reçoit rien, et rien ne le signale.

### Les deux mécanismes d'erreur, et où ils tombent

La spec en distingue deux, et ils tombent tous les deux au même endroit chez nous :

| Cas | Ce que le résolveur rend |
|---|---|
| `isError: true` dans le résultat (échec métier) | `ok: false`, avec le texte comme raison lisible |
| Erreur JSON-RPC (outil inconnu, arguments invalides, panne serveur) | `ok: false`, avec le message |
| Transport cassé, délai dépassé, corps trop gros | `ok: false`, raison nommée |

Aucun de ces cas ne **lève**. C'est la doctrine écrite du résolveur HTTP et elle vaut ici pour la même raison :
lever produit une `erreur_protocole` qui **arrête le tour**, alors que le client peut corriger son branchement
dans sa console. Un outil qui échoue doit laisser l'agent dire quelque chose au contact.

## Le cycle de vie d'un serveur, à l'écran

`Tools > Connecteurs MCP`, à côté de `Connecteurs API`. Le menu `Developers > Serveur MCP` garde son nom :
il décrit le sens inverse (ce que **nous** exposons), et les deux ne partagent aucun mot à part MCP.

1. **Déclarer** : libellé, adresse du point MCP, mode d'authentification, secret. L'adresse passe par
   `urlRecuperable` puis `resolutionPublique`, comme toute adresse saisie par un client.
2. **Éprouver** : `initialize`. Un serveur qui refuse le transport Streamable HTTP est **refusé avec un message
   qui le nomme** (« ce serveur parle l'ancien transport HTTP+SSE de la révision 2024-11-05, non pris en
   charge »), jamais par un échec muet.
3. **Importer** : `tools/list`, pagination suivie, catalogue stocké **en entier et brut**.
4. **Régler** : pour chaque outil, le client voit le schéma, marque chaque paramètre, choisit le risque
   (pré-rempli depuis les annotations, jamais décidé par elles).
5. **Déclarer à un agent** : `AI Agent > Outils`, inchangé. C'est là que le consentement se donne.

### Le rafraîchissement

Un bouton. Pas de flux tenu ouvert, pas de balayage planifié : `notifications/tools/list_changed` n'est
lisible que sur un flux qu'on ne tient pas, et un rafraîchissement automatique ferait apparaître des outils
que personne n'a regardés.

Ce qu'il fait, outil par outil :

| Constat | Effet |
|---|---|
| Schéma inchangé | Rien, `mcp_vu_le` avancé |
| **Schéma changé** | **Le consentement tombe** sur tous les consommateurs, et l'écran dit ce qui a bougé (`mcp_annonce` porte l'avant) |
| Outil disparu | `mcp_indisponible_le` posé, consentement tombé, **ligne conservée** : c'est la trace de ce qui a tourné |
| Outil nouveau | Importé, inactif, en attente du réglage du client |

Un outil dont le schéma a changé **n'est plus l'outil qui a été autorisé**. C'est la lecture stricte de 0127,
où le consentement porte sur un outil précis, et c'est la seule qui empêche un serveur distant d'élargir en
silence ce qu'un outil autorisé sait faire.

### Quand ça casse

Aux **deux** endroits qui comptent, sans mécanique nouvelle : `last_ok_at` / `last_error` sur la fiche du
serveur (colonnes existantes, écrites pour ça), et le bandeau de manques de l'agent, qui dit qu'un outil a
été désactivé et pourquoi. Pas d'alerte poussée : le produit n'a pas de canal d'alerte vers le client, et en
construire un est un autre chantier.

## Le bac à sable

Un outil MCP y est **simulé**, ce qui est déjà le comportement (`if (outil.origin !== 'mba') return
connecteurSimule(outil)`), et pour la raison que ce module écrit lui-même : un appel réel ferait un dégât réel
pendant qu'on croit essayer.

Ce qui est à réparer, c'est le **libellé** : `connecteurSimule` lit `binding.methode` et `binding.chemin`,
que n'a pas un outil MCP, et afficherait « l'appel ? ? vers votre système ». Il dira « l'appel `search` sur le
serveur Notion ».

## Hors périmètre, et pourquoi

| Écarté | Raison |
|---|---|
| **OAuth** | Aucun flux OAuth sortant n'existe dans ce dépôt. C'est un sous-système entier (redirection à déclarer chez chaque fournisseur, `state`, échange de code, rafraîchissement, expiration, stockage chiffré) qui mérite son cadrage. Lot 2 |
| **Exposition à l'agent de Meta** | Meta n'accepte pas MCP. Relayer ferait de nous le porteur des identifiants d'un serveur tiers pour le compte de Meta, sur un chemin que personne ne voit. L'écran le **dit**, il ne grise pas une case sans explication |
| **Appel MCP depuis un bloc de scénario** | Un outil MCP porte un schéma que le **modèle** remplit ; un scénario n'a pas de modèle, il faudrait mapper chaque paramètre à la main. C'est un écran à part entière |
| **Transport stdio** | Il lance un sous-processus. Sans objet pour un serveur distant |
| **Ressources et prompts MCP** | Le besoin exprimé est l'outillage. Les ajouter maintenant serait du câblé-et-inerte |
| **Le flux GET SSE** | Il sert au serveur pour nous envoyer des requêtes. Nous n'en recevons pas |

## Migration

**Une seule**, et elle n'ajoute que des colonnes à `agent_tools` (`mcp_annonce`, `mcp_non_activable`,
`mcp_indisponible_le`, `mcp_vu_le`), toutes nullables, sans défaut, sans index.

Elle **AJOUTE des colonnes que le code écrit**, donc elle passe **AVANT** le déploiement.

⚠️ Le numéro se lit dans `CLAUDE.md` au moment d'écrire le fichier (`prochaine libre = 0152` à la date de ce
cadrage), et **se RELIT en base juste après `migrate`**, jamais en écrivant la ligne. Ce compteur a dérivé
huit fois.

## Méthode de livraison

**Implémenteur par lot, avec revue humaine du diff.**

Les quatre questions qui tranchent répondent oui aux deux qui pèsent : **la production emprunte ce chemin**
(un tour d'agent en conversation réelle), et **le code touché porte des invariants invisibles** (la garde
`modele`/`contact`/`fixe`, l'unicité du nom par espace, le filtre de sortie de 0150, la contrainte
`origin`/`source_id` de 0088).

`feature-loop` aurait convenu si les critères étaient mécaniquement vérifiables et le rayon de souffle faible.
Ici, un test vert ne prouve rien du seul risque qui compte : qu'un contact lise la donnée d'un autre. Ça se
regarde sur le diff.

## L'essai réel qui clôt la feature

**Engage Me branché sur notre propre serveur MCP** (`/mcp` sur `api.messagingme.app`).

Il coche tout sans dépendre de personne : authentification par clé d'API, donc « jeton simple » ; JSON-RPC sur
un seul POST, donc Streamable HTTP ; outils connus (`list_conversations`, `get_contact`, `search_contacts`) ;
et un `get_contact` dont un paramètre se cloue naturellement au contact, donc la garde d'identité est éprouvée
pour de vrai et pas seulement en test.

Le geste qui clôt : depuis un agent IA, poser une question dont la réponse exige l'appel de l'outil MCP, et
vérifier que l'agent répond avec la donnée du **bon** contact.

⚠️ Un second essai contre un serveur tiers reste souhaitable, parce que lui seul mesure la proportion de
schémas irréductibles. Il n'est pas la porte de sortie du lot.

## Les vingt et une décisions

| # | Décision |
|---|---|
| 1 | Un onglet **Outils** dans le paramétrage du MBA, livré **avant et à part** |
| 2 | Un serveur MCP vit dans `agent_tool_sources`, `kind = 'mcp'` |
| 3 | Ses outils vivent dans `agent_tools`, `origin = 'mcp'` |
| 4 | Menu **Tools > Connecteurs MCP**. `Developers > Serveur MCP` garde son nom |
| 5 | Transport **Streamable HTTP seulement**. L'ancien SSE est refusé avec un message qui le nomme |
| 6 | Authentification par **jeton simple** au lot 1. OAuth au lot 2 |
| 7 | `tools/list` à la connexion, catalogue **copié**, rafraîchi par un **bouton** |
| 8 | On récupère et on stocke **tout**, brut, y compris l'inexploitable |
| 9 | **Aplatissement par chemin** des feuilles, marquage `modele`/`contact`/`fixe` par feuille |
| 10 | Les trois formes irréductibles : **visibles, pas activables**, raison en clair |
| 11 | Le clouage s'ouvre aux **champs déclarés du mini-CRM**, par identifiant, dans une liste |
| 12 | Champ vide : **on envoie vide**. L'avertissement se pose au clouage, sur les `required` |
| 13 | Le retour part **tel quel**, borné. `output_paths` **ignoré**, et c'est écrit |
| 14 | Noms **préfixés par le serveur**. Le nom distant est conservé et c'est lui qu'on envoie |
| 15 | Schéma changé = **le consentement tombe**. Outil disparu = indisponible, pas supprimé |
| 16 | Pannes visibles sur la fiche du serveur **et** dans le bandeau de manques de l'agent |
| 17 | Bac à sable : **simulé**, libellé réparé |
| 18 | **Pas** d'exposition à l'agent de Meta, et l'écran le dit |
| 19 | **Pas** d'appel MCP depuis un bloc de scénario au lot 1 |
| 20 | Essai réel : Engage Me branché sur **notre propre serveur MCP** |
| 21 | Livraison : **implémenteur par lot + revue humaine du diff** |
