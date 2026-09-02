# Plan issu du contre-audit du 2026-09-02

> Source : `AUDIT-REVERIFICATION-POST-CONTRE-AUDIT-2026-09-02.md` (audit externe de l'état `184071b`).
> **Chaque constat de ce plan a été revérifié dans le code courant le 2026-09-02**, pas repris sur parole.
> Ce qui n'y figure pas a été écarté volontairement, avec sa raison, en fin de document.

## POINT DE REPRISE (écrit pour survivre à une compaction de contexte)

**Rien n'est commencé.** Les sept lots sont arbitrés, chiffrés et prêts ; aucun code n'a été écrit pour eux.

**Ce qui EST fait et déployé** (`8943736`, le 2026-09-02 au soir) : le **131008**, hors plan, urgence de
production. Quatre défauts de la même famille, tous nés du lot d'attribution du matin. Détail complet dans
`documentation.md` § Journal des lots livrés. Vérifié en production : deux envois de `actu_cin_ma_2` acceptés
par Meta (`wamid` présents), zéro 131008 depuis. ⚠️ **Ce qui n'est PAS encore prouvé** : l'attribution
elle-même. Aucun clic n'est arrivé depuis les envois réels ; les quatre clics visibles sur `p7bvkkeqjznz`
datent de 16:09 UTC, AVANT les envois de 17:56, ce sont les relecteurs de Meta.

**Ordre recommandé, inchangé** : lot 1 (le bail) d'abord, c'est le seul qui puisse encore envoyer un message en
trop à un client. Puis lot 6 (concurrence), qui conditionne la trajectoire à 25 clients.

**La seule décision qui manque** : le chiffre du plafond de campagne (lot 3). Proposition faite : 5 000.

⚠️ **Une AUTRE session travaille dans le dépôt.** Au moment d'écrire, elle a commité `7073b8b` (badge
« modifications non publiées »), **non poussé et non déployé**. Ne jamais faire `git add src tests` en bloc :
ça ramasse son travail. Vérifier `git status` avant chaque commit, et ne stager que ses propres fichiers.

## Ce que la mesure a tranché avant toute décision

Relevé en base de production le 2026-09-02, et c'est ce qui trie tout le reste :

| Mesure | Valeur |
|---|---|
| Jobs traités sur 7 jours, toutes files | **85** (60 webhook, 13 statut, 5 analyses, 5 push, 2 runs) |
| Durée de TRAITEMENT d'un webhook | moyenne **0,2 s**, pire **3,1 s** |
| Contacts en base, tous espaces | **12** |
| Plus grosse campagne jamais créée | **2 destinataires** |
| Tours d'agent IA joués en production | **0**, depuis toujours |

⚠️ **Mesurer `completed_on - started_on`, pas `completed_on - created_on`.** Le second inclut l'attente en
file et donnait « 3,6 s en moyenne » là où le travail réel prend 0,2 s. Sur des files volontairement lentes
(`webhook-status` sonde à cadence longue), l'écart atteint un facteur 600 et ferait conclure à un problème de
débit là où il n'y a qu'une cadence choisie.

Conséquence directe : **aucun problème de capacité n'existe aujourd'hui.** Les lots ci-dessous corrigent des
défauts de CORRECTION (un message en trop, un écran qui ment), jamais des défauts de débit. Tout ce que
l'audit range sous « préparer le multi-worker » est donc reporté, et la raison est écrite plus bas.

---

## Lot 1 : fermer le bail du tour d'avance

**Le défaut, revérifié.** `BAIL_AVANCE_S = 60` (`src/workflow/executor.ts:22`). Or `withRetry`
(`src/meta/http.ts`) autorise `maxRetries = 4`, donc 5 tentatives à 30 s de plafond, plus le backoff :
**154 secondes au pire pour UN SEUL envoi Meta**, et une avance peut en enchaîner plusieurs. Le bail peut donc
expirer pendant que le premier porteur travaille encore, un second prend le tour, et **les deux envoient**.

Second morceau : `setStateSiEncoreSur` filtre sur `id`, `tenant_id`, `status` et `current_node`, **jamais sur
`avance_token`**. Un porteur de bail périmé peut donc encore écrire l'état.

**Pourquoi les tests ne l'ont pas vu.** `tests/integration/avance-claim.integration.test.ts` couvre bien « un
bail expiré est repris », mais comme FONCTIONNALITÉ (un worker tué ne doit pas bloquer le parcours à vie).
C'est le même mécanisme qui produit le double envoi quand le porteur n'est pas mort mais seulement lent. Le
test valide le remède et ne voit pas la maladie.

**Le correctif :**
1. **Renouveler le bail tant que l'avance est vivante** (prolongation périodique tant que le jeton est à nous).
   C'est la seule pièce qui distingue « porteur mort » de « porteur lent ». Dimensionner le bail ne suffit
   pas : une avance peut enchaîner un nombre non borné d'envois, aucune constante n'est sûre.
2. **Clôturer l'écriture d'état par le jeton** : ajouter `avance_token = $n` au `where` de
   `setStateSiEncoreSur`, pour qu'un porteur périmé ne puisse plus écrire.
3. **Retirer le commentaire périmé** de `executor.ts:1233` (« CE QUE ÇA NE FERME PAS... c'est un lot à part »),
   qui dit aujourd'hui le contraire du code situé vingt lignes plus haut. Une affirmation périmée devient une
   seconde spécification.
4. **Corriger la formulation du `CLAUDE.md`** : « le tour est RÉSERVÉ avant tout envoi » ferme la course
   courte, pas la course longue. Le dire.

**Preuve exigée :** un test où la première avance dépasse le bail et où la seconde ne produit **aucun effet**,
plus un test où un porteur périmé voit son écriture d'état refusée. Les deux doivent échouer si on retire la
garde.

**Migration :** oui, si le renouvellement demande une colonne. À trancher en construisant. Probablement aucune :
`avance_jusqu_a` se prolonge par un `update` conditionné au jeton.

---

## Lot 2 : le défilement du fil d'inbox

**Le défaut, revérifié, et c'est une régression que j'ai introduite le 2026-09-02.** Dans
`web/app/inbox/page.tsx`, l'effet mesure « suis-je en bas ? » **APRÈS** l'ajout des messages :

```js
const enBas = !fil || fil.scrollHeight - fil.scrollTop - fil.clientHeight < 80;
```

Deux conséquences arithmétiques :
- **À l'ouverture d'une conversation longue**, `scrollTop` vaut 0 et `scrollHeight` est grand, donc `enBas` est
  FAUX : le fil **ne descend pas**, l'opérateur atterrit en haut de l'historique.
- **À l'arrivée d'un message de plus de 80 px**, le fil était en bas AVANT l'ajout mais ne l'est plus après :
  il **ne suit pas** le nouveau message.

Le commentaire qui dit « le premier rendu n'a pas encore de conteneur mesurable » est **faux** : le `div`
porteur (`ref={filRef}`, ligne 754) est rendu inconditionnellement, et un `useEffect` s'exécute après le commit
DOM, donc la ref est toujours posée.

**Le correctif :** mémoriser « était en bas » **avant** la mutation (effet de layout ou instantané en ref), et
traiter le premier chargement comme un cas explicite « descendre ».

**Preuve exigée :** un test DOM sur un fil long (ouverture -> en bas) et sur l'arrivée d'un message haut
(suivi -> en bas), qui échoue sur le code actuel.

---

## Lot 3 : un plafond serveur de taille de campagne

**Le défaut, revérifié.** `idsForFilters` (`src/crm/contact-store.pg.ts:674`) a `cap = 100_000` par défaut,
`contactIdsForTarget` matérialise ces identifiants, et le chemin sans sélection charge tous les contacts sans
plafond. Aucune constante `CAMPAIGN_MAX_RECIPIENTS` n'existe.

Ce n'est pas un chantier 100k : c'est **empêcher le serveur d'accepter par accident** ce que Julien a déjà
décidé de ne pas faire.

**Le correctif :** une constante configurable, un `count` AVANT le chargement, et un refus **422** portant le
nombre demandé et le plafond. Uniforme sur les trois chemins : cible filtrée, identifiants explicites, et
« tous les contacts ».

⚠️ **Bloqué sur une décision produit** : le chiffre. Contexte pour trancher : la base compte **12 contacts**
et la plus grosse campagne jamais créée en portait **2**.

---

## Lot 4 : une panne d'avance cesse d'être invisible

**Le défaut, revérifié.** `processWorkflowAdvance` (`src/webhooks/workflow-advance.ts`) attrape chaque
exception par message, écrit un `console.error`, et le job webhook se termine **en succès**. Une avance qui
échoue après tous les retries Meta est donc perdue : aucun retry, aucune DLQ, aucune trace consultable.

L'isolation elle-même est BONNE (une erreur sur un contact ne doit pas emporter les autres messages du même
webhook). C'est l'acquittement silencieux qui ne va pas.

**Le correctif, version minimale :** écrire l'échec dans le **journal des erreurs** livré le 2026-09-02
(`src/ops/erreurs-livraison.pg.ts`), qui existe déjà et qui est déjà à l'écran. Coût faible, l'invisibilité
tombe.

**Ce qu'on ne fait PAS maintenant :** publier l'avance comme unité durable rejouable (la recommandation
complète de l'audit). C'est la bonne cible, c'est un lot à part, et elle ne se justifie qu'avec du trafic réel.

---

## Lot 5 : retirer deux affirmations qui mentent

Aucune ligne de code produit, mais ce sont des « secondes spécifications » qui induiront en erreur la prochaine
lecture, humaine ou automatique.

1. **Le profil `equite` du banc de charge.** `docs/SLO-2026-09-01.md` le mentionne **4 fois**,
   `scripts/banc-charge.mts` le contient **0 fois**. Soit on l'écrit, soit on retire la promesse. Un document
   qui annonce ce qui n'existe pas est pire que le silence.
2. **La contradiction campagne contre contrôle humain.** `src/inbox/repondre.ts:80` écrit « une campagne ne
   l'écrasera pas », pendant que `worker.ts:518`, `worker.ts:525` et `index.ts:511` passent
   `ignoreHumanControl: true`. Le comportement est peut-être le bon (une campagne lancée par un opérateur doit
   sans doute partir), mais **il ne peut pas y avoir deux règles écrites**. Trancher, aligner le texte, et
   poser un test au niveau du câblage réel et non de l'exécuteur nu.

---

## Lot 6 : six files traitent UN job à la fois pour toute la flotte

**Constat NON fait par l'audit externe**, trouvé le 2026-09-02 en répondant à la question de Julien « s'il y a
25 clients, il n'y a qu'un seul worker ? ».

Sur les huit consommateurs du worker, **deux seulement** passent des options de concurrence : `webhook`
(3 simultanés, groupe = le CONTACT) et `campaign-run` (4 simultanés, groupe = le CLIENT). Les six autres
tournent sur le défaut de pg-boss, vérifié dans sa source (`node_modules/pg-boss/dist/manager.js:532`,
`localConcurrency = 1`) : **un seul job à la fois, tous clients confondus.**

Deux conséquences, et c'est la seconde qui compte :

1. **Aucune équité par client sur les entrants.** Le groupe de `webhook` est le contact, ce qui garantit
   l'ORDRE des messages d'une même personne, pas le partage entre clients. Rien n'empêche un client bavard
   d'occuper les 3 places. Mineur au temps de traitement mesuré (0,2 s en moyenne, 3,1 s au pire) ; cesse de
   l'être si un envoi part en retry Meta et tient une place jusqu'à 154 s, ce qui renvoie au lot 1.
2. 🔴 **`agent-turn` traite UN tour à la fois pour la flotte entière**, et un appel au modèle a un plafond de
   120 s (`HTTP_TIMEOUT_MODELE_MS`). À 25 clients, les conversations d'agent font la queue les unes derrière
   les autres, tous espaces mêlés. Au plafond, cela fait **30 tours par heure pour tout le monde**.
   ⚠️ Cette file **n'a jamais tourné en production** (zéro job dans tout l'historique) : la durée d'un tour
   réel n'est donc pas mesurée, et ce chiffre est une borne, pas une prévision.

**Le correctif n'est PAS un second worker.** Une réplique ferait passer `agent-turn` de 1 à 2, ce qui ne
résout rien, tout en dupliquant les 19 balayages et en cassant l'ordre par contact. Le correctif est **une
option par file** : monter la concurrence et poser le **client** comme clé de groupe, ce qui donne le débit
ET l'équité sans réplique ni coordination distribuée.

### Ce qu'on change, file par file (arrêté le 2026-09-02)

🔴 **On ne monte PAS tout, et sur les files de fond le GROUPE compte plus que le nombre.** Monter
`analyze-conversation` de 1 à 3 ne change presque rien au débit ; ce qui change tout, c'est qu'un client qui
importe 10 000 contacts et déclenche 10 000 analyses ne puisse plus bloquer tous les autres pendant des heures.

| File | Aujourd'hui | Décision | Raison |
|---|---|---|---|
| `agent-turn` | 1, aucun groupe | **concurrence 12, groupe = client, plafond 4/client** | le facteur 33 |
| `analyze-conversation` | 1, aucun groupe | **groupe = client**, concurrence légèrement ↑ | équité, pas débit |
| `automation-event` | 1, aucun groupe | **groupe = client** | une rafale d'un client gèle les autres |
| `webhook-status` | 1, groupe contact | **rien** | volontairement lente, 0,1 s par job |
| `push-analysis` | 1 | **rien** | volume faible, sortie vers le connecteur |
| `hubspot-catchup` | 1 | **rien** | rattrapage, pas du temps réel |
| `webhook` | 3, groupe contact | **rien** | 0,2 s par job, largement dimensionné |
| `campaign-run` | 4, groupe client | **rien** | déjà équitable |

**Les chiffres de `agent-turn` (12 en vol, 4 par client) sont un point de départ PRUDENT, pas une mesure.**
Douze fois mieux qu'aujourd'hui, sans risque : ce sont des attentes réseau que la boucle Node tient sans
effort, et un tour ne garde aucune connexion pendant l'appel au modèle. Quatre par client veut dire que trois
clients actifs se partagent équitablement. **Tous ces nombres passent en variables de configuration**, pour
qu'on les ajuste après mesure sans redéployer de code.

⚠️ **Ne pas refaire l'erreur de raisonnement du 2026-09-02** : ce lot avait été présenté comme BLOQUÉ par la
mesure. Il ne l'est pas. N'importe quelle valeur au-dessus de 1 est meilleure que 1, dans tous les scénarios.
On n'a pas besoin de la valeur parfaite pour sortir de la valeur absurde.

### Ce que ce lot doit tenir, chiffré (question de Julien, 2026-09-02)

« À 25 clients il y aura 100 ou 200 conversations IA en même temps. » L'inquiétude est FONDÉE, et le chiffre
qui sert à dimensionner n'est pas le nombre de conversations ouvertes : c'est **le débit d'arrivée multiplié
par la durée d'un tour** (loi de Little). 200 personnes écrivant chacune toutes les 30 s font 6,7 messages/s ;
à 5 s par tour, cela fait **~33 tours en vol**, pas 200.

| | Aujourd'hui | Cible du scénario 25 clients |
|---|---|---|
| Tours en parallèle | **1** | ~33 |
| Tours par minute | **12** | ~400 |

Soit un facteur **33**. Tenir de l'IA conversationnelle multi-clients est impossible en l'état.

### 🔴 UN TOUR N'EST PAS UN APPEL, et c'est ce qui change le dimensionnement

Relevé le 2026-09-02 après une remarque de Julien (« si on envoie à chaque fois tout le contexte, ça bouche les
toilettes plus vite »). Son intuition est juste, et la réalité est pire. Voici ce qui part au modèle :

| Élément | Renvoyé à chaque appel ? | Borné ? |
|---|---|---|
| Prompt système (dont le brief de l'agent du client) | **oui** | non borné |
| Historique de conversation | **oui** | **oui, 30 messages** (`MESSAGES_DE_CONTEXTE`) |
| Définitions des outils exposés | **oui** | selon l'agent |
| Résultats des outils déjà appelés dans le tour | **oui, cumulés** | non |

Et surtout : `MAX_ALLERS_RETOURS = 6` (`src/agent/brain.gateway.ts:44`). Chaque appel d'outil relance une
requête COMPLÈTE avec le contexte **grossi** du résultat précédent. **Un tour peut donc valoir jusqu'à six
appels, chacun plus gros que le précédent.**

🔴 **SUR LE CACHE, LA FORMULATION EXACTE COMPTE** (corrigé le 2026-09-02 après une objection de Julien, « bizarre
qu'on puisse pas cacher, c'est la base »).

Ce qui est vrai : **on n'envoie AUCUNE instruction de cache** (`cache_control` absent de tout le dépôt).
Ce qui serait FAUX de conclure : que rien n'est mis en cache. Certains fournisseurs cachent **automatiquement**
les préfixes longs, sans qu'on demande, et le rapportent dans leur réponse.

Or `src/agent/llm/chat-client.ts` ne lit que `prompt_tokens`, `completion_tokens` et `cost`. Le champ qui
dirait combien de tokens ont été servis depuis un cache (`prompt_tokens_details.cached_tokens` dans le format
OpenAI-compatible du Gateway) **n'est jamais lu**. Donc **on ne sait pas si on cache déjà**, et le prompt
système plus les définitions d'outils, rigoureusement identiques d'un aller-retour à l'autre et d'un tour à
l'autre, sont peut-être déjà servis depuis un cache sans qu'on le voie.

⚠️ Le modèle d'agent en production est `zai/glm-4.7-flash` via le Gateway Vercel. Son comportement de cache
**se mesure, ne se suppose pas**.

**Conséquence de méthode : mesurer les TOKENS PAR MINUTE, pas les requêtes.** Les limites d'un gateway
s'expriment presque toujours en tokens/minute. Compter les requêtes reviendrait à compter les passages sans
regarder ce qui s'y passe.

### L'ordre de ce lot, et il commence par une mesure

1. **Mesurer un tour RÉEL** sur une dizaine de conversations que Julien fait depuis le bac à sable ou son
   numéro de test. ⚠️ **Rien à construire pour ça** : le code compte déjà `tokensIn`, `tokensOut` et le coût en
   micro-euros à chaque appel, et les débite du solde du workspace. Ce qu'on cherche : tokens par tour, nombre
   d'allers-retours réels, durée.
2. **LIRE LE CHAMP DE CACHE QU'ON REÇOIT DÉJÀ.** Une ligne : ajouter `prompt_tokens_details.cached_tokens` à
   ce qu'on parse, et le journaliser. S'il revient non nul, **le cache tourne déjà** et il n'y a rien à
   construire. C'est le premier geste parce que c'est le moins cher et qu'il peut annuler le suivant.
3. **Si et seulement si ce champ est nul** : demander explicitement le cache et vérifier que le Gateway le
   transmet au fournisseur. Si ça marche, la plus grosse part CONSTANTE de chaque appel cesse d'être repayée,
   ce qui change à la fois le débit tenable et le coût.
4. **Alors seulement choisir les chiffres** de concurrence et de plafond par client, exprimés en
   tokens/minute autant qu'en tours simultanés.

### Pourquoi la boucle Node n'est PAS le sujet

Question posée : faut-il plusieurs boucles d'exécution ? Techniquement possible (`worker_threads`, `cluster`,
répliques), mais inutile ici : **tout le travail d'un tour est de l'ATTENTE réseau** (base, Gateway, Meta), et
une socket qui dort ne consomme quasiment aucun CPU. Une seule boucle en tient des milliers.

Vérifié le 2026-09-02, et c'est ce qui rend l'argument solide : **aucun calcul lourd dans notre process.** La
recherche de connaissance tourne DANS Postgres (`to_tsvector` + `pg_trgm`, `src/agent/knowledge.pg.ts`), il n'y
a pas d'embedding local. La boucle ne deviendrait un goulot que si on rapatriait ce calcul chez nous.

### Pourquoi le pool de connexions ne bloque pas ce lot

⚠️ On pourrait croire que 40 tours en parallèle demandent 40 connexions. **Non** : un tour d'agent ne garde
AUCUNE connexion pendant l'appel au modèle (aucun `pool.connect()` ni transaction n'enjambe l'appel, vérifié).
Chaque requête prend et rend sa connexion. La partie longue, l'attente, est donc gratuite en connexions.

Le plafond du pool reste réel mais il est ailleurs : `DB_POOL_MAX = 8` par process, deux process, soit **16
clients simultanés vers le pooler**, chiffre **mesuré le 2026-08-25** (au-delà, la latence double sans qu'aucune
erreur ne remonte). Le relever déplacerait notre file d'attente vers celle de Supavisor, où elle est MUETTE.
Ce plafond est lié au plan Supabase, donc il bougera au passage au plan payant.

### Les quatre plafonds, dans l'ordre où ils tomberont

1. **Notre propre concurrence** (1 aujourd'hui). Gratuit à corriger, c'est ce lot.
2. **La limite de débit du Gateway Vercel.** Inconnue, et elle ne PEUT pas être atteinte aujourd'hui : avec un
   seul appel en vol, on ne sature aucune limite. La question « faut-il plusieurs comptes Vercel ? » ne se pose
   donc pas avant d'avoir ouvert notre propre robinet. Le code sait déjà encaisser un 429 avec son
   `Retry-After` (`src/agent/llm/chat-client.ts:152`). ⚠️ Éclater les comptes casserait le solde prépayé par
   workspace : dernier recours, contre des refus MESURÉS.
3. **Le pool de connexions** (16 mesuré, lié au plan Supabase).
4. **L'argent.** 200 conversations simultanées sont une dépense réelle ; vérifier que le solde prépayé par
   workspace tient à ce rythme.

⚠️ **L'analyse de conversation ne passe PAS par le Gateway** : elle tape `api.anthropic.com` en direct avec sa
propre clé (`src/analysis/llm-client.ts:33`). Les deux chemins sont indépendants.

**Condition de déclenchement :** avant d'ouvrir l'agent IA à plusieurs clients actifs. **Mesurer la durée et le
profil de requêtes d'un tour RÉEL avant de choisir les chiffres** : cette file n'a jamais tourné en production,
poser 40 plutôt que 20 sans cette mesure serait deviner. C'est aussi là que le profil d'équité manquant du banc
de charge (lot 5) sert enfin à quelque chose.

---

## Lot 7 : rendre le pool de connexions VISIBLE (et ne rien faire d'autre)

Question de Julien, 2026-09-02 : « les 16 connexions, on fait quoi ? on serre les fesses, on prend une marge,
on autoscale, on met des alertes ? »

### Le calcul qui tranche entre ces quatre options

Le commentaire de `DB_POOL_MAX` porte la mesure : à 11 ms d'aller-retour, **8 connexions tiennent environ
700 requêtes/s par process**. Le scénario à 25 clients demande :

| Consommateur | Requêtes/s |
|---|---|
| 25 clients x 2 opérateurs, inbox sondée toutes les 4 s | ~12 |
| Une campagne de 10 000 à 80/min (~1,3 envoi/s x ~3 requêtes) | ~4 |
| 33 tours d'agent en vol | rafales courtes, aucune connexion tenue pendant l'attente du modèle |

**Quelques pour cent de la capacité.** Le pool n'est PAS ce qui cassera à 25 clients ; la file IA à 1 l'est.
Donc : pas de marge à prendre sur ce qui n'est pas serré.

### Pourquoi l'autoscaling est la MAUVAISE réponse ici

Ajouter des instances **aggrave** le problème au lieu de le résoudre : chaque instance arrive avec **son propre
pool de 8**. Autoscaler l'application multiplie la pression sur la seule ressource qui, elle, ne scale pas avec
elle. La base est précisément ce qu'on ne règle pas en ajoutant des serveurs applicatifs.

### Le vrai défaut n'est pas le chiffre, c'est l'aveuglement

Vérifié : **`/ops` n'expose RIEN du pool.** Or le comportement à saturation est déjà correct : chaque requête
attend, puis échoue proprement au bout de `DB_CONN_TIMEOUT_MS` (8 s) avec une erreur journalisée. On ne meurt
pas en silence. Mais personne ne regarde, donc on l'apprendrait par un client qui appelle.

### Mesurer, et pas échantillonner (objection de Julien, 2026-09-02)

« Il faudrait un outil qui produise une courbe en temps réel, parce qu'il peut y avoir un pic de quelques
secondes puis plus rien. » Exact : une jauge lue au moment où l'on ouvre `/ops` affichera zéro presque toujours
et **ratera le pic**, qui est justement ce qu'on cherche. Et échantillonner à la seconde raterait encore un pic
de 200 ms.

**Il y a mieux, et c'est moins cher : mesurer le temps d'OBTENTION d'une connexion.** Zéro, il n'y a pas eu
d'attente ; non nul, on a attendu et on sait combien. Cette mesure **ne peut rater aucun pic**, puisque chaque
requête est mesurée et non échantillonnée. Elle se branche à **un seul endroit** (`src/db/pool.ts:26`, point
unique de création du pool applicatif) : tous les stores en héritent, aucun autre fichier ne bouge.

🔴 **Le bon indicateur n'est PAS « à combien du plafond on est ».** C'est **« quelqu'un a-t-il attendu, et
combien de temps ». 15 connexions sur 16 sans une seule attente, tout va bien. Des attentes à 8 sur 16, c'est
autre chose qui cloche, et c'est ça qu'il faut voir.

**La courbe** vient ensuite gratuitement : agréger par minute (maximum, p95, nombre d'attentes) dans une petite
table, ~1440 lignes par jour et par process, dessinée avec les graphes SVG qui existent déjà dans Analytics.
Les compteurs bruts du pool `pg` (`totalCount`, `idleCount`, `waitingCount`) restent exposés dans `/ops` comme
photo d'instant, mais ce sont les attentes agrégées qui font foi.

### Où ça s'affiche (arrêté le 2026-09-02)

**Une quatrième carte sur l'écran `/ops` qui existe déjà** (`web/app/ops/page.tsx`, protégé par `OPS_TOKEN`),
juste sous « Files de traitement (pg-boss) ». Même page, même jeton, l'endroit où l'on va déjà quand quelque
chose sent mauvais. Pas d'écran de plus à retenir.

Elle porte deux choses : l'**état instantané par process** (l'API et le worker ont chacun LEUR pool, donc une
ligne chacun, avec le maximum atteint depuis le démarrage), et la **courbe du temps d'attente maximum par
minute** sur les dernières heures, seuil marqué, en rouge dès qu'une attente le dépasse, comme le fait déjà
l'âge du plus vieux job.

🔴 **La table d'agrégats n'est pas seulement de l'historique, c'est le SEUL CANAL par lequel le worker peut se
montrer.** `/ops` est servi par l'API : elle voit son propre pool en mémoire, jamais celui du worker. Sans la
table, la moitié de la mesure serait invisible.

⚠️ **Ce que « temps réel » veut dire ici, honnêtement** : la courbe est par MINUTE, mais **aucun pic n'est
perdu**, parce qu'on y stocke le MAXIMUM de mesures exactes et non un échantillon. Un pic de 200 ms apparaît
dans la barre de sa minute, à sa vraie hauteur. Ce qu'on ne saura pas, c'est la seconde exacte du pic, et ça
n'a pas de valeur pour un phénomène qui se joue sur des minutes.

⚠️ **La marge viendra du plan payant**, et il faudra la **re-mesurer** comme les 16 l'ont été le 2026-08-25,
jamais la supposer : ce nombre venait d'une mesure, pas d'une documentation.

---

## Ce qui est ÉCARTÉ, et pourquoi

**Tout le niveau B de l'audit (préparation multi-worker)** : rendre les groupes et balayages multi-worker,
renforcer la garde des deux URLs de base, refaire le budget de connexions. Les trois constats sont **exacts**
(19 balayages récurrents, plafonds `local*` en mémoire, écouteur `LISTEN` hors budget). Ils ne coûtent
**rien** tant qu'un seul worker tourne, et ils sont conditionnés à une décision qui n'est pas prise. Les
rouvrir le jour où le second worker est décidé, pas avant.

**Les découpages du niveau D** (`CampaignCreateForm` 1716 lignes, `worker.ts` 1323, `ConversationAnalysisCard`
686). Tailles confirmées. Ce sont des items de VÉLOCITÉ, sans effet sur la capacité. Et découper `worker.ts`
ne paie que le jour où l'on choisit qui, du leader ou des répliques, porte chacun des 19 balayages : le faire
avant déplace le risque sans le réduire.

**Mesurer la charge agrégée de `phone_rate_gate`** (C3 de l'audit). Sa propre conclusion est « mesurer avant
d'optimiser » ; à 85 jobs par semaine, il n'y a rien à mesurer.

**Le drill de restauration** (C4). Le plan Supabase est **free**, donc **aucun backup et RPO = perte totale**.
C'est une décision assumée de Julien jusqu'au passage au plan payant, qui accompagnera la mise en production
client. À rouvrir à ce moment-là, et pas avant : chronométrer une restauration qui n'existe pas n'a pas de sens.

**Ce que l'audit n'a pas pu voir** : la 404 sur `/r/:code/:jeton`, trouvée le 2026-09-02 en sondant le chemin
public après déploiement. Un audit qui lit le code ne traverse pas le proxy, exactement comme les tests e2e qui
mockent le backend. À garder en tête pour les prochains audits : cette famille de défaut leur est invisible.
