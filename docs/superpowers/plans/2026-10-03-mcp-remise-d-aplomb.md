# Serveur MCP : remise d'aplomb (lot 1 du plan « Engage Me pour Claude Code »)

**But** : que le serveur MCP actuel dise vrai à un assistant avant qu'on lui ajoute des outils (lot 8). Trois
défauts, aucun nouvel outil, aucune migration.

1. `get_messages` lit les 500 messages les plus ANCIENS d'un fil (`PgInboxStore.getMessages`, `limit 500` en ordre
   croissant) puis en garde la fin : sur un fil long, l'assistant résume le passé en croyant lire le présent.
   **Décision de Julien du 2026-10-03 : il rend les 50 messages les plus RÉCENTS**, dans l'ordre chronologique,
   « c'est déjà bien assez ».
2. Les schémas d'entrée ne savent pas décrire une liste (`items` absent : `tag_conversation.tags` est un `array` sans
   type d'élément) et taisent des bornes que les outils APPLIQUENT (longueur des textes, intervalle des `limit`).
3. Aucun outil ne porte d'annotations MCP : un client ne peut pas distinguer une lecture d'une écriture, ni une
   écriture qui écrase d'une écriture qui ajoute.

## Méthode de livraison

**Implémenteur par lot, puis UNE relecture indépendante du diff.** La production emprunte ce chemin (des clients
appellent `/mcp` avec leur clé) et `get_messages` lit des conversations derrière une garde d'espace ; le changement
est réversible et presque entièrement vérifiable par des tests, donc pas de workflow de relecture. L'essai réel qui
clôt le lot est décrit plus bas (« Essai réel qui clôt le lot »).

## Tâches

### 1. `get_messages` : les plus récents, lus en SQL

- `PgInboxStore.getDerniersMessages(conversationId, n)` (`src/inbox/store.pg.ts`) : les `n` messages les plus récents
  du fil, rendus dans l'ordre chronologique `(created_at, id)`, le MÊME ordre que `getMessages`. La liste de colonnes
  et la traduction d'une ligne en `ConversationMessage` sont PARTAGÉES avec `getMessages` (extraites une fois), jamais
  recopiées : ce `select` nomme des colonnes dont la migration doit précéder le code, deux copies dériveraient.
  `getMessages` ne change pas de comportement (la console l'appelle toutes les 4 s).
- `DepsMcp.inbox` (`src/mcp/outils.ts`) remplace `getMessages` par `getDerniersMessages` : le MCP ne lit plus jamais
  le début d'un fil. Le câblage (`src/index.ts`) passe déjà le store entier, il ne bouge pas.
- L'outil : `limit` de 1 à 50, défaut 50 (une constante nommée). Il demande `limit + 1` messages : `tronque` vaut
  vrai s'il en reçoit plus que `limit`, et il rend les `limit` derniers. La garde d'espace (`contexteOuRefus`) reste
  AVANT toute lecture. La description dit « les plus récents, 50 au plus, du plus ancien au plus récent » et ce que
  `tronque` veut dire.
- La page « Serveur MCP » de la console (`web/lib/mcp-outils.ts`) dit « les 50 derniers messages d'un fil ».

### 2. Schémas : `items`, et chaque borne appliquée annoncée

- `ProprieteEntree` gagne `items` (le schéma d'un élément), `minItems` et `maxItems`.
- `tag_conversation.tags` : éléments `string` non vides, 1 à 10.
- Chaque texte lu par `texteObligatoire(args, cle, N)` annonce `minLength: 1` et `maxLength: N` ; chaque entier lu par
  `entierBorne(args, cle, d, min, max)` annonce `minimum` et `maximum`.
- `assign_conversation.member_id` accepte `null` (il libère) : son type le dit (`['string', 'null']`).

### 3. Annotations MCP (spécification 2025-06-18)

- `OutilMcp.annotations`, REQUIS : `title` (en français), `readOnlyHint`, `openWorldHint`, et pour un outil
  d'écriture `destructiveHint` et `idempotentHint` OBLIGATOIRES (le type l'impose : absent, un client suppose
  `destructiveHint: true`, ce qui serait faux pour `tag_conversation`).
- `tools/list` rend `title` et `annotations` pour chaque outil (`descriptionOutil`, `src/mcp/serveur.ts`).
- Valeurs, décidées ici :

| Outil | readOnly | destructive | idempotent | openWorld |
| --- | --- | --- | --- | --- |
| les huit lectures (`list_*`, `get_*`, `search_contacts`) | oui | | | non |
| `reply_in_open_window` | non | **oui** (l'envoi PREND le fil, le scénario s'arrête) | non | **oui** (un message part chez une personne) |
| `tag_conversation` | non | non | oui | non |
| `assign_conversation` | non | **oui** (remplace l'assignation) | oui | non |
| `create_widget` | non | non | non | non |
| `update_widget` | non | **oui** (écrase, peut éteindre une bulle publique) | oui | non |

## Tests attendus

- Unitaires (`tests/mcp-serveur.test.ts`) : `get_messages` demande `limit + 1` au store, ramène 200 à 50, rend les
  derniers dans l'ordre chronologique, `tronque` juste dans les deux sens, et ne lit RIEN pour la conversation d'un
  autre espace.
- Catalogue : `readOnlyHint` vaut exactement « le scope est `mcp:read` » pour chaque outil ; chaque écriture déclare
  `destructiveHint` et `idempotentHint` ; `tools/list` les rend.
- Bornes : pour chaque outil, chaque appel `texteObligatoire` et `entierBorne` lu dans la source de son `executer` a sa
  borne annoncée dans SON schéma, avec la même valeur ; le test échoue s'il ne trouve aucun appel (aveugle sinon).
- Intégration (CI seulement) : `getDerniersMessages(c, 3)` sur un fil de 7 messages dont deux au même horodatage rend
  exactement la fin de `getMessages(c)`.
- Chaque test de non-régression vérifié dans les deux sens (le défaut remis, il échoue sur ce qu'il garde).

## Ordre de déploiement

Aucune migration. L'API sur le VPS (`compose up -d --build`, rechargement NPM, contrôle public), la console suit au
push (texte seulement, aucune route neuve).

## Essai réel qui clôt le lot

Depuis Claude Code, par le connecteur `mba` branché sur la production : la liste des outils porte les annotations,
et `get_messages` sur un vrai fil de plus de 50 messages rend les 50 derniers, comparés à la console.

## Hors lot

- Les `null` dans `type` et `enum` des schémas des widgets (jaune du lot 5) : aucun client MCP qui les refuse n'a été
  MESURÉ ; on ne change pas un contrat sur une supposition. À reprendre le jour où un client réel échoue.
- La console charge elle aussi les 500 PREMIERS messages d'un fil à son ouverture (même requête) : sujet distinct,
  hors de ce lot.

## Relecture (2026-10-03) : aucun rouge

Corrigés dans le lot, chacun avec son test vérifié dans les deux sens : la description de `get_messages` disait « que
cet outil ne lit pas » même sous 50 ; `reply_in_open_window` passe en `destructiveHint: true` (il prend le fil) ;
`assign_conversation` exige `member_id` (oublié, il LIBÉRAIT la conversation, défaut antérieur au lot) ; les valeurs
d'annotations du tableau sont tenues par un test ; le test d'intégration pose les identifiants des deux messages
jumeaux à l'inverse de leur ordre d'écriture, pour voir à coup sûr un tri sur `created_at` seul ; la page console est
comparée à `MAX_MESSAGES_MCP`.

Ouverts :
- notre propre client MCP pré-remplit le risque d'un outil à partir des annotations (`risquePropose`) : un espace qui a
  branché le serveur d'Engage Me comme connecteur verra les outils en `schema_change` à son prochain rafraîchissement,
  et devra les revalider (étape notée dans `wip.md`) ;
- aucune longueur maximale par tag dans `tag_conversation`, quand les autres surfaces plafonnent à 64 ;
- `maxLength` de JSON Schema compte des caractères, `texteObligatoire` des unités UTF-16 : un texte chargé d'emoji
  annoncé valide peut être refusé (avec sa raison).
