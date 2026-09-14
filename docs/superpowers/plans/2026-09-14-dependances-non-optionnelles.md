# Une règle transverse ne voyage jamais dans une dépendance optionnelle

**14 septembre 2026.** Trois lots, livrés et déployés l'un après l'autre.

## Pourquoi ce plan existe

Le dépôt nomme déjà le symptôme, trois fois dans `CLAUDE.md` : « une capacité câblée sur un consommateur
sur trois ». Ce plan retire la CAUSE à trois endroits.

La cause est une forme d'interface. Quand une règle qui doit tenir PARTOUT est portée par une dépendance
déclarée **optionnelle**, un câblage qui l'oublie compile, passe les tests, se déploie, et la règle ne
s'applique pas sur ce chemin. Rien ne le signale, parce qu'il n'y a rien à signaler : le programme est
valide. Ce qui manque n'est pas une vérification, c'est une couture.

🔴 **Ce n'est pas théorique, et le prix est déjà payé deux fois en 48 heures.** Le 13 septembre,
`optInAllows` n'était appelée qu'à la construction des listes de campagne : scénario, automation et agent
passaient à travers. Le 14 septembre, la réponse de l'agent IA part par `envoyerTexteAgent`, donc pas par
`WorkflowExecutor.apply` où la garde venait d'être posée. Deux fois, un contact ayant répondu STOP pouvait
être atteint.

⚠️ **Et le filet actuel reconnaît par écrit ce qu'il ne prouve pas.** `tests/optout-chemins.test.ts` grep
`src/` à la recherche des méthodes d'envoi et exige un classement à la main : « un inventaire prouve que la
LISTE est complète, jamais que les VERDICTS sont justes. Celui-ci a été écrit par la même main que la garde,
dans la même heure, depuis la même croyance. »

## Ce que la mesure dit, avant d'écrire une ligne

Tous ces chiffres sont mesurés sur `HEAD` = 942a0b4, pas repris d'un rapport.

| Mesure | Valeur |
|---|---:|
| Membres de `ServerDeps` | 55 |
| dont **optionnels** | 54 |
| Gardes `if (deps.x)` dans `buildServer` | 49 |
| Noms de modules énumérés **à la main** pour la couverture tenant | 40 |
| Noms dans la liste du test qui relit le texte source | 37 |
| Modules de routes déclarant `guard?: Guard` | 29 |
| Occurrences de `guard ? { preHandler: guard } : {}` | 30 |
| Montages `registerX` dans `src/server.ts` | 48 |
| Interfaces déclarant `estDesabonne?(...)` | 4 |
| Câblages qui la fournissent | 4 |
| Fichiers de tests appelant `buildServer` | 73 |
| Fichiers de tests construisant `WorkflowExecutor` **sans** `estDesabonne` | 16 sur 17 |

⚠️ **Deux comptes du dépôt ont dérivé, et ce plan ne les recopie pas.** `src/http/scope.ts` annonce « le
motif est dans 38 fichiers » : il y en a 29. `src/campaign/run-job.ts:110` affirme « MÊME NOM ET MÊME CONTRAT
QUE LES TROIS AUTRES » à propos du numéro de l'espace, qui existe sous quatre noms. Les corriger n'est pas
dans ce plan, mais les croire l'aurait faussé.

⚠️ **Les signatures ne sont pas homogènes, et le registre doit l'absorber sans le cacher** : 4 montages
prennent 2 paramètres (les publics), 36 en prennent 3, 4 en prennent 4, et `registerInbox` en prend 5. Le
même rôle s'appelle `guard?` dans certains fichiers et `requireAuth?` dans d'autres.

## Méthode de livraison

**Implémenteur par lot, avec revue humaine sur le DIFF**, un lot par livraison, un déploiement et un contrôle
public entre chaque.

Ce choix est fait **parce que** les quatre questions de la règle donnent deux « oui » en haut de liste : la
production emprunte ce chemin (toute garde d'envoi et le contrôle d'isolation entre clients y sont), et rien
n'est réversible (un message parti ne se rappelle pas, une route silencieusement démontée ne se voit pas).
`feature-loop` est écarté pour la même raison : ses critères seraient mécaniquement testables, mais sa porte
est la complétude, pas le rayon de souffle. La revue porte sur le diff, jamais sur un rapport d'agent.

🔴 **L'essai réel qui clôt chaque lot, et aucune méthode ne le remplace.**

- **Lot 1** : la table de routes de Fastify est capturée AVANT le refactor, recapturée APRÈS, et elle doit
  être identique au caractère. C'est la seule preuve qui couvre les 48 montages d'un coup, là où un test par
  route en couvrirait un. Puis contrôle public sur `api.messagingme.app` ET sur le chemin
  `mba.messagingme.app/api/backend/`, parce que le 502 de NPM après un `up --build` est intermittent.
- **Lot 2** : monter un module porteur de `:tenantId` sans garde et vérifier que le serveur REFUSE de
  démarrer, en vrai, pas dans un faux.
- **Lot 3** : un contact de test marqué désabonné dans l'espace de démo, puis les quatre chemins tentés en
  production (scénario, agent IA, réponse Inbox, MCP). Quatre refus attendus. Un mécanisme qui n'a jamais
  tourné sur de vraies données n'est pas éprouvé, il est seulement vert.

## Lot 1 : le registre de montage

**Intention unique** : la liste des modules porteurs de tenant cesse d'être écrite à la main.

Aujourd'hui, la couverture du garde-fou d'authentification tient sur une liste de 40 noms recopiée dans
`buildServer`, elle-même vérifiée par un test qui relit le TEXTE de `src/server.ts` avec sa propre liste de
37 noms. Le 41e module ne sera vu par aucun des deux.

1. Introduire un helper `entree<D>({ nom, deps, acces, monter })` dans `src/server.ts`. Le générique `D` est
   inféré par entrée, et `monter` reçoit les deps **déjà vérifiées non nulles** : c'est ce qui garantit
   qu'aucun `deps.x!` ne subsiste. Chaque montage garde sa propre arité dans sa closure.
2. `acces` est une **union**, jamais un booléen : `'tenant' | 'code-url' | 'signature-meta' | 'cle-api'`.
   🔴 Un `porteDeTenant: false` serait un désengagement SILENCIEUX, c'est-à-dire la classe de défaut que ce
   plan ferme. L'union oblige l'auteur du 49e module à dire de quoi il se protège.
3. Déclarer les **48** montages, pas seulement les 40 porteurs de tenant. La portée complète est ce qui donne
   son sens à l'essai (le diff de la table de routes) et ce qui rend impossible d'ajouter un module sans se
   prononcer sur son accès. Les quatre publics par code dans l'URL sont `links`, `rcs-callback`,
   `webhook-entrant`, `hubspot-events` ; `/mcp` est en `cle-api` (gardé par `requireApiKey`, pas par le JWT).
4. Dériver la liste de la couverture tenant des entrées `acces: 'tenant'`, et remplacer les 49 gardes
   `if (deps.x)` par une itération sur le registre.
5. Remplacer `tests/scope-tenant.test.ts` par un test de COMPORTEMENT : un module `acces: 'tenant'` monté sans
   garde, `buildServer` lève. La complétude étant désormais portée par le type, le grep n'a plus rien à
   prouver, et il cessera de rougir à la moindre reformulation.

**Ce qui ne change pas** : `ServerDeps` garde sa forme et ses 54 membres optionnels. Les rendre requis ferait
payer 73 fichiers de tests pour un gain que la dérivation obtient déjà. Le registre n'est pas un service
locator : les dépendances restent passées explicitement, seul le MONTAGE est factorisé.

**Où il vit** : dans `src/server.ts`, qui importe déjà les 48 modules. Un fichier séparé recréerait un hub
d'imports pour rien.

## Lot 2 : la garde cesse d'être optionnelle

**Intention unique** : un module porteur de `:tenantId` ne peut plus se monter sans contrôle.

Le commentaire de `src/http/scope.ts` le dit mieux que ce plan : « un contrôle d'accès dont la sûreté dépend
d'un appelant lointain n'est pas un contrôle d'accès, c'est une convention ».

1. Retirer le `?` du paramètre de garde dans les 29 modules concernés, et supprimer les 30 occurrences du
   motif `guard ? { preHandler: guard } : {}`.
2. Normaliser le nom en **`garde`** dans les 45 fichiers. Le lot touche déjà ces signatures : renommer dans
   le même passage coûte zéro diff supplémentaire, et deux noms pour un même rôle font chercher une
   différence qui n'existe pas.
3. Les tests reçoivent un adaptateur **nommé**, `gardeOuverte`, exporté une fois. Le besoin de monter un
   module sans authentification est réel ; il se satisfait par un adaptateur qui DIT son hypothèse, pas par un
   `undefined` que la production peut atteindre.
4. Les modules non `'tenant'` gardent une signature sans garde : leur accès est déclaré dans le registre.

## Lot 3 : le consentement cesse d'être optionnel

**Intention unique** : « a-t-il dit STOP ? » ne peut plus être oubliée par un chemin d'envoi.

1. Retirer le `?` de `estDesabonne` dans les quatre interfaces : `src/workflow/executor.ts:159`,
   `src/agent/run-turn.ts:94`, `src/http/inbox.ts:243`, `src/inbox/repondre.ts:55`.
2. Les quatre câblages la fournissent déjà (`index.ts:923`, `index.ts:2250`, `worker.ts:1644`,
   `wiring.ts:566`) : **aucun comportement ne change**. Le gain est qu'un cinquième chemin ne compilera plus
   sans elle.
3. Une vingtaine de fixtures ajoutent une ligne, avec `jamaisDesabonne` nommé, pour que l'hypothèse du test
   soit lisible. Mesuré : 16 des 17 fichiers qui construisent `WorkflowExecutor`, 6 sur 6 pour l'Inbox, 1 sur
   `repondre`.
4. Remplacer `tests/optout-chemins.test.ts` par quatre tests de comportement, un par chemin : un contact
   désabonné ne reçoit rien.

🔴 **`optInAllows` N'ENTRE PAS DANS CE LOT, et la mesure le tranche.** Elle n'a que deux appelants
(`campaign/build.ts:69`, `api/sends-build.ts:27`), tous deux à la CONSTRUCTION de la liste, quand
`estDesabonne` se pose À L'ENVOI. Ce sont deux questions distinctes. Les réunir ferait entrer dans une
dépendance partagée une décision qui dépend du chemin, ce que l'invariant §12.7 de `documentation.md` interdit
nommément.

## Ce que ce plan ne fait PAS, et pourquoi

- **Il ne rend pas les 54 membres de `ServerDeps` requis.** Ce serait la forme juste sur le fond, mais 73
  fichiers de tests paieraient pour un gain déjà obtenu. C'est un lot séparé, à découper par domaine.
- **Il n'uniformise pas les arités en un objet `Gardes` unique.** Ce serait un changement de signature sur 45
  fichiers, bien au-delà de retirer un point d'interrogation.
- **Il ne crée pas le point d'envoi unique** (`envoyerAuContact`). C'est le vrai remède au fond du problème,
  mais il doit ÉMERGER du lot 3, jamais être planifié d'un bloc : 8 méthodes d'envoi sont appelées depuis 13
  sites dans 4 modules, et aucune interface commune n'existe alors que les trois adaptateurs de canal sont
  déjà là.
- **Il ne touche ni `workflow/executor.ts`, ni `worker.ts`, ni les stores SQL.** Les audits des 9, 13 et 14
  septembre l'ont tranché, et la profondeur leur donne raison : ce sont de gros modules DEEP.

## Rayon de souffle connu

À énumérer avant chaque commit, `hooks/rayon-de-souffle.js` n'en calculant que la moitié mécanique.

- **Lot 1** : `buildServer` a deux appelants réels (l'API et les 73 tests). Une route qui cesse d'être montée
  ne produit aucune erreur : c'est exactement ce que l'essai par diff de table de routes attrape.
- **Lot 2** : les 2 fichiers de tests qui montent un module de routes en direct, plus tout test qui s'appuyait
  sur l'absence de garde pour ne pas fabriquer de jeton.
- **Lot 3** : les ~23 fixtures listées plus haut. ⚠️ Aucune n'est un test d'intégration branché sur la vraie
  base, donc la CI les attrapera toutes, mais seulement après le typecheck.
- **Textes qui deviennent faux** : le commentaire de `src/http/scope.ts` (son « 38 fichiers », et sa
  justification entière, qui décrit une optionalité qui n'existera plus), celui de `src/index.ts:2225` sur les
  gardes partagées avec MCP, et les deux commentaires de `src/agent/run-turn.ts:92` et
  `src/workflow/executor.ts:153` qui renvoient au test de câblage comme garde de secours.
- **Une justification qui doit disparaître avec son objet** : le test remplacé au lot 3 porte l'aveu cité en
  tête de ce plan. Le supprimer sans reprendre son enseignement quelque part perdrait la leçon ; elle va dans
  `docs/JOURNAL-TECHNIQUE.md`, pas dans le manuel.

## Décisions, et qui les a prises

Toutes tranchées par Julien le 14 septembre 2026, en quatre rounds :

| Décision | Choix |
|---|---|
| Ordre des lots | registre, puis garde, puis consentement |
| Méthode | implémenteur par lot + revue humaine sur le diff |
| Portée du registre | les 48 montages |
| Forme d'une entrée | générique typée, `entree<D>()` |
| Représentation des accès | une union, pas un booléen |
| Essai du lot 1 | diff de la table de routes, avant contre après |
| Sort des deux tests qui relisent le source | remplacés par des tests de comportement |
| Dépendances devenues requises, côté tests | des adaptateurs nommés |
| Déploiement | un par lot, contrôle public entre chaque |
| Nom du paramètre de garde | un seul, `garde` |
| Essai du lot 3 | contact de test désabonné, 4 chemins, en production |
| `optInAllows` | hors lot |
