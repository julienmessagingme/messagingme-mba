# Protéger l'API publique : plan d'exécution

> **Pour un exécutant agentique :** SOUS-SKILL REQUISE : `superpowers:subagent-driven-development`
> ou `superpowers:executing-plans`, tâche par tâche.

**But :** fermer l'amplification entre « une requête » et « beaucoup de travail » sur `/v1` et `/mcp`, avant
de distribuer largement des clés d'API.

**Source :** l'audit Codex du 2026-09-13 (`AUDIT-STRUCTURE-ET-API-PUBLIQUE-2026-09-13.md`), niveau A,
**vérifié affirmation par affirmation le 2026-09-14** : 94 constats mesurés, 76 vrais, 9 faux, 7 partiels,
2 périmés. Ce plan ne retient que ce qui a été MESURÉ dans le code d'aujourd'hui.

## Méthode de livraison

**Retenue : implémenteur par lot, puis revue humaine sur le DIFF, en QUATRE lots livrés séparément.**
Lot 1, la validation (tâches 1 et 2). Lot 2, la protection avant Postgres (tâche 3). Lot 3, le garde
d'usage en OBSERVATION (tâches 4 et 5). Lot 4, l'arrêt d'urgence et le ménage (tâches 6 à 9).

**Pourquoi** : les quatre questions tranchent dans le même sens. **(1) La production emprunte ce chemin** :
`/v1/sends` fait partir de vrais messages chez Meta, `/v1/contacts` écrit dans le mini-CRM de clients.
**(2) Rien n'est réversible** : un message parti ne se rappelle pas, et un champ personnalisé créé par
erreur dans l'espace d'un client y reste. **(3) Les critères sont testables**, mais ce qu'il faut vérifier
n'est pas « le test passe », c'est « a-t-on trouvé TOUTES les formes d'un corps hostile ? ». **(4) Le code
touché porte des invariants invisibles** : l'ordre des gardes dans `makeRequireApiKey`, le fait que le
limiteur est indexé sur `found.id` (donc inatteignable par une fausse clé), et le budget de 8 connexions
partagé entre l'API, l'Inbox et le worker.

**Pourquoi surtout pas feature-loop** : une boucle vérifierait que ses propres tests passent. Or le danger
est précisément ce à quoi on n'a pas pensé : la forme de corps qu'on n'a pas imaginée, la garde posée au
mauvais rang. Ça se relit, ça ne se boucle pas.

🔴 **L'ESSAI RÉEL QUI CLÔT CE PLAN** : depuis un poste extérieur, avec une vraie clé d'API sur un espace de
test, jouer les six gestes hostiles de la tâche 10 et constater **un 4xx déterministe à chaque fois, jamais
un 500, jamais une page Cloudflare**. Puis l'essai qui protège l'usage : un intégrateur normal (un lot de
200 contacts bien formés, un envoi de 50) doit passer sans rien voir de tout cela.

## Contraintes globales

- 🔴 **4xx JAMAIS 5xx** pour un refus attendu. Cloudflare remplace le corps des 5xx par sa page : un client
  d'API qui reçoit 500 ne sait pas quoi corriger, et nous non plus depuis ses journaux.
- 🔴 **AUCUNE CLÉ, AUCUN BEARER EN CLAIR** dans un log, une erreur, un journal d'audit ou un test. Une
  tentative est presque toujours un secret voisin du vrai.
- 🔴 **LE TENANT VIENT DE L'AUTORITÉ AUTHENTIFIÉE**, jamais d'un paramètre. C'est déjà vrai, ça doit le rester.
- 🔴 **OBSERVATION AVANT REFUS.** Aucun seuil de quota n'est inventé dans ce plan. On compte d'abord, on
  regarde ce que font les vrais clients, Julien tranche ensuite. Un seuil deviné qui mord est une panne
  qu'on s'inflige.
- 🔴 **PAS DE REDIS, ET PAS DE `if (redis)` DANS LES ROUTES.** Le contrat est injecté UNE fois au bootstrap.
  L'implémentation mémoire n'est pas jetable : elle exerce le même contrat et sert aux tests.
- ⚠️ **Une préoccupation par commit.** Aucun refactoring structurel mélangé à une modification fonctionnelle.
- ⚠️ **Ne pas baisser** les lots de 500 contacts ni les envois de 50 destinataires : ce sont des contrats
  publics, et les rétrécir casserait des intégrations pour un gain que les bornes de ce plan apportent mieux.

---

### Tâche 1 : la validation du batch de contacts

**Fichiers**
- Modifier : `src/http/v1-contacts.ts`
- Test : `tests/v1-contacts-hostile.test.ts` (créer)

🔴 **LE CONSTAT LE PLUS SOLIDE DE L'AUDIT : 13 affirmations, 13 vraies.** La route vérifie que `contacts`
est un tableau de 1 à 500 éléments, puis le **caste** en `ApiContactInput[]`. Le `as` est un mensonge au
compilateur : tout le contenu arrive non vérifié dans un service écrit pour des objets bien formés.

Ce qu'un intégrateur maladroit provoque aujourd'hui, mesuré :

| Son geste | Ce qui se passe |
|---|---|
| un `null` dans un lot de 500 | **500 opaque, le lot ENTIER perdu**, message masqué, corps remplacé par Cloudflare |
| `fields` en chaîne | **un champ personnalisé PAR CARACTÈRE** dans son espace (200 caractères = 200 définitions) |
| `fields` imbriqué | stocké `[object Object]`, **donnée irrécupérable**, aucun signal |
| `["+33612345678"]` au lieu de `[{phone:…}]` | 200 avec « numéro vide » ligne par ligne, sans jamais dire que la FORME est fausse |

- [ ] **Étape 1 : les tests d'abord, un par forme hostile** (`null`, chaîne, tableau, `fields` non-objet,
      `fields` imbriqué, clé de champ très longue, trop de champs, `optInSource` très long, et le mélange
      valides/invalides avec l'ORDRE des résultats conservé)
- [ ] **Étape 2 : un schéma Zod `safeParse`**, jamais `parse`, jamais `as`. Le conteneur malformé rend 400 ;
      un ÉLÉMENT malformé rend son erreur À SON INDEX et **les autres lignes passent**. C'est le contrat
      actuel du batch et il ne doit pas changer.
- [ ] **Étape 3 : MUTER** : retirer la validation d'UN élément, constater que seul son test rougit
- [ ] **Étape 4 : commit**

---

### Tâche 2 : borner les champs personnalisés

**Fichiers**
- Modifier : `src/api/contacts-upsert.ts`, `src/crm/field-store.pg.ts`
- Test : `tests/api-champs-bornes.test.ts` (créer)

**Tranché par Julien le 2026-09-14 : « garder, mais borné ».** L'auto-création d'un champ inconnu est un
choix produit utile et ne change pas pour un intégrateur normal. Ce qui change, c'est qu'elle a des bornes.

🔴 **TROIS BORNES, ET AUCUNE N'EXISTE AUJOURD'HUI** (mesuré) : le nombre de champs d'un contact, le nombre
total de définitions d'un espace, et la longueur d'une clé de champ. Une boucle d'appels avec des clés
aléatoires fait grossir `user_fields` **sans limite** pour l'espace visé.

- [ ] **Étape 1 : les tests** (dépassement de chacune des trois bornes, et le témoin : un intégrateur
      normal qui crée trois champs continue de passer)
- [ ] **Étape 2 : implémenter.** ⚠️ Le dépassement du plafond d'espace **ne casse pas les champs
      existants** : il refuse la CRÉATION d'un nouveau, et les valeurs des champs déjà déclarés passent.
- [ ] **Étape 3 : la valeur des bornes est CONFIGURABLE**, avec un défaut large. On ne devine pas un
      plafond serré sur un produit dont on ne connaît pas encore l'usage.
- [ ] **Étape 4 : MUTER, commit**

---

### Tâche 3 : la protection AVANT Postgres

**Fichiers**
- Modifier : `src/auth/api-key.ts`
- Test : `tests/api-key-prefiltre.test.ts` (créer)

🔴 **L'AUDIT AVAIT RAISON, ET LE DÉFAUT EST PIRE QU'IL NE LE DIT.** L'ordre mesuré dans
`makeRequireApiKey` : lire le bearer → tester le préfixe `mba_` → SHA-256 → **`findActiveByHash` en base**
→ consommer le quota. Le limiteur est indexé sur `found.id`, **donc il n'est atteint qu'après un lookup
RÉUSSI** : une rafale de fausses clés `mba_x` n'est comptée par AUCUN plafond, et chacune coûte un
SHA-256 et une requête Postgres indexée.

- [ ] **Étape 1 : les tests** (une clé au bon préfixe mais au mauvais FORMAT est refusée SANS toucher le
      store — le faux store compte ses appels ; et une rafale de fausses clés est freinée)
- [ ] **Étape 2 : deux gardes, dans cet ordre.** D'abord le format exact (`mba_` puis exactement le nombre
      de caractères que la génération produit) ; ensuite un limiteur pré-authentification **indexé sur
      l'empreinte SHA-256 du bearer, JAMAIS sur sa valeur**, et dont la table mémoire est BORNÉE en nombre
      de clés, comme celle des routes d'authentification.
- [ ] **Étape 3 : le limiteur métier par `found.id` RESTE**, après la résolution. Les deux se complètent :
      l'un protège la base, l'autre le travail applicatif.
- [ ] **Étape 4 : MUTER** (retirer le contrôle de format : le test qui compte les appels au store rougit)
- [ ] **Étape 5 : commit**

---

### Tâche 4 : le contrat `ApiUsageGuard`, en mémoire

**Fichiers**
- Créer : `src/api/usage-guard.ts`, `src/api/usage-guard.memoire.ts`
- Modifier : `src/server.ts` (injection unique), `src/http/v1-contacts.ts`, `src/http/v1-sends.ts`, `src/http/mcp.ts`
- Test : `tests/api-usage-guard.test.ts` (créer)

🔴 **UNE REQUÊTE N'EST PAS UNE UNITÉ DE COÛT.** Avec 60 requêtes/minute, une clé fait accepter 30 000
contacts ou 3 000 destinataires. Le garde compte le TRAVAIL, pas les appels.

🔴 **PAS DE REDIS, ET LE CHOIX SE FAIT UNE SEULE FOIS.** L'implémentation mémoire est injectée au
bootstrap. Le jour du multi-replica, on remplace le STOCKAGE, pas les routes. **Interdiction de conception :
aucun `if (redis)` dans une route.**

- [ ] **Étape 1 : les tests du CONTRAT**, écrits sans connaître le stockage : un lot de 500 consomme 500
      unités et pas une ; deux clés du même espace partagent le quota d'espace ; deux espaces ne partagent
      rien ; le quota par clé reste actif EN PLUS du quota d'espace.
- [ ] **Étape 2 : le contrat et l'implémentation mémoire.** Les règles de calcul des unités, les noms
      d'opérations et la politique de refus vivent HORS de l'implémentation de stockage.
- [ ] **Étape 3 : le brancher sur les six routes** (les cinq de l'audit PLUS `GET /mcp`, qui rend 405 et
      qu'il avait manquée).
- [ ] **Étape 4 : MUTER** (remplacer l'implémentation mémoire par un double : aucune route ne doit changer)
- [ ] **Étape 5 : commit**

---

### Tâche 5 : l'observation, et RIEN d'autre

**Fichiers**
- Modifier : `src/api/usage-guard.memoire.ts`, `src/http/ops.ts`
- Test : `tests/api-usage-observation.test.ts` (créer)

🔴 **AUCUN APPEL N'EST REFUSÉ DANS CETTE TÂCHE.** On compte, on expose, on regarde. Les seuils viendront
d'une mesure et d'un arbitrage de Julien, jamais de ce plan.

⚠️ **ET IL N'Y A RIEN AUJOURD'HUI, MESURÉ** : la seule trace d'usage est un `last_used_at` ÉCRASÉ à chaque
appel. Aucun compteur nulle part. L'audit affirmait que `/ops` montrait déjà les erreurs de livraison :
**c'est faux**, `/ops` a sept routes et son `overview` n'en porte aucune.

- [ ] **Étape 1 : les tests** (le mode observation ne bloque RIEN et produit les bons compteurs ; c'est le
      cas qui empêche de livrer un refus par accident)
- [ ] **Étape 2 : agréger par minute** : espace, identifiant de clé (**jamais** la clé ni son hash),
      opération, acceptées/refusées, unités demandées.
- [ ] **Étape 3 : l'exposer dans `/ops`**, la surface qui existe déjà. ⚠️ **PAS une ligne SQL d'audit par
      requête** : sous rafale, la journalisation amplifierait la charge qu'elle observe.
- [ ] **Étape 4 : commit**

---

### Tâche 6 : borner les lourdes en vol

**Fichiers**
- Modifier : `src/api/usage-guard.ts` et son implémentation
- Test : dans `tests/api-usage-guard.test.ts`

🔴 **LE CHIFFRE QUI REND CE PLAN URGENT.** Le pool sert **8 connexions pour TOUT le process API**.
`upsertContactsFromApi` borne à 4 écritures en parallèle *par requête*, mais rien ne compte les autres
requêtes en vol : dix lots simultanés mettent **32 acquisitions en file derrière 8 places**, échouent au
bout de 8 secondes, et pendant ce temps l'Inbox et le worker se disputent les mêmes 8 emplacements.

⚠️ Et le limiteur est une **fenêtre fixe** : les 60 requêtes peuvent tomber dans la même milliseconde. Dix
d'entre elles suffisent à saturer le pool **sans jamais franchir le plafond affiché**.

- [ ] **Étape 1 : le test** : trop de lots concurrents obtiennent un **429 contrôlé avec `Retry-After`**,
      jamais une erreur d'acquisition de connexion, jamais une attente HTTP illimitée.
- [ ] **Étape 2 : implémenter le plafond d'opérations lourdes SIMULTANÉES**, porté par le garde central,
      configurable, et démarré prudemment.
- [ ] **Étape 3 : MUTER, commit**

---

### Tâche 7 : l'arrêt d'urgence

**Fichiers**
- Modifier : `src/auth/api-key.ts`, `src/http/ops.ts`
- Test : `tests/api-arret-urgence.test.ts` (créer)

**Tranché par Julien le 2026-09-14 : étendre le verrou d'espace existant.**

🔴 **DEUX MESURES QUI CHANGENT LA FORME DU TRAVAIL.** Le verrou `tenants.status = 'locked'` est LU dans
`makeRequireAuth` (`src/auth/middleware.ts:138`), donc sur les routes de SESSION. Mais :
1. il n'est **lu nulle part** dans `makeRequireApiKey` : il ne couvre donc ni `/v1` ni `/mcp` ;
2. il n'est **ÉCRIT NULLE PART** : aucune route, aucun script, aucun écran. C'est un crochet inerte, et
   son propre commentaire le dit.

Donc « étendre le verrou » veut dire deux gestes : le faire lire par la garde de clé, et **créer le moyen
de le poser**. `/ops` est le bon endroit : c'est la surface cross-tenant protégée par `OPS_TOKEN`, et elle
porte déjà des écritures (`POST /ops/credits/:tenantId`, `DELETE /ops/cle-modele/:tenantId`).

- [ ] **Étape 1 : les tests** (un espace verrouillé rend 403 sur `/v1` ET sur `/mcp` ; un espace actif
      passe ; le geste `/ops` pose et retire le verrou, et il est tracé)
- [ ] **Étape 2 : implémenter**, en réutilisant `loadState` plutôt qu'en ajoutant une requête au chemin chaud
- [ ] **Étape 3 : le RUNBOOK**, dans `DEPLOY.md` : ⚠️ **verrouiller n'arrête PAS les campagnes déjà
      enfilées** (mesuré). La procédure doit dire comment les identifier et les mettre en pause, sinon on
      croit avoir coupé et les messages continuent de partir.
- [ ] **Étape 4 : MUTER, commit**

---

### Tâche 8 : les deux trous que l'audit avait manqués

**Fichiers**
- Modifier : `src/mcp/outils.ts`, `src/auth/rate-limit.ts`
- Test : dans `tests/mcp-outils.test.ts`

Trouvés à la vérification du 2026-09-14, absents de l'audit :

- 🔴 **`list_members` n'a AUCUNE borne de lecture.** Les trois autres outils MCP bornent leur `limit`
  entre 1 et 100 ou 200 ; celui-ci n'a aucun paramètre et rend `listerMembres(tenantId)` **en entier**.
- ⚠️ **Le commentaire d'en-tête de `rate-limit.ts` annonce « fenêtre glissante ».** C'est une **fenêtre
  fixe ancrée sur le premier appel**. Une justification fausse est pire qu'aucune : elle sera recopiée.

- [ ] Borner `list_members` comme ses voisins, et le tenir par un test
- [ ] Corriger le commentaire, en disant ce que la fenêtre fait VRAIMENT
- [ ] Commit

---

### Tâche 9 : le ménage des symboles morts

**Fichiers**
- Modifier : `src/index.ts`, `src/campaign/run-job.ts`, `src/http/agent-tools.ts`,
  `web/app/contacts/page.tsx`, `web/components/WorkflowBuilder.tsx`, `web/components/WorkflowConfigPanel.tsx`

**34 symboles inutilisés mesurés** (`tsc --noUnusedLocals`), et aucun ne fait échouer un build : ni le
tsconfig racine ni celui de `web/` n'activent le contrôle.

⚠️ **CE N'EST PAS QUE DU RANGEMENT, TROIS D'ENTRE EUX MENTENT** :
- `ContactHistoryPanel` est un **composant importé et jamais rendu** dans la page contacts ;
- `paramConnecteurSchema` porte un long commentaire qui décrit une garde « fermée »… qui **ne s'applique à
  aucun appel**, puisque rien ne parse avec ce schéma ;
- `mbaEnabled` : deux appelants font un **appel réseau** (`getSettings`) pour passer un drapeau à un
  composant qui ne le lit pas.

- [ ] **Étape 1 : une PR de nettoyage SANS aucun changement fonctionnel**
- [ ] **Étape 2 : le contrôle en CI**, ciblé sur le code de production. ⚠️ Ne pas rendre toute la suite
      rouge à cause des scripts et des tests historiques.
- [ ] **Étape 3 : commit**

---

### Tâche 10 : l'essai réel, depuis l'extérieur

🔴 **RIEN DE CE PLAN N'EST ÉPROUVÉ TANT QUE CECI N'A PAS TOURNÉ.** Un mécanisme vert n'est pas un
mécanisme éprouvé, et c'est la leçon que ce dépôt a payée le plus souvent.

Depuis un poste extérieur, avec une vraie clé sur un espace de test :
- [ ] un lot avec un `null` au milieu → **400 déterministe**, les autres lignes traitées, l'ordre conservé
- [ ] `fields` en chaîne → **refusé**, et **aucun champ créé** (vérifier `user_fields` EN BASE)
- [ ] une rafale de fausses clés → freinée, et **le nombre de requêtes Postgres ne suit pas**
- [ ] dix lots de 500 en parallèle → **429 avec `Retry-After`**, et l'Inbox reste réactive pendant ce temps
- [ ] l'espace verrouillé depuis `/ops` → **403 sur `/v1` et sur `/mcp`**
- [ ] 🔴 **le témoin qui protège l'usage** : un intégrateur normal (200 contacts bien formés, un envoi de
      50 destinataires) passe **sans rien voir de tout cela**

---

## Ce qui n'est PAS dans ce plan, et pourquoi

- ⛔ **Redis / Valkey.** Le contrat est prêt à le recevoir ; l'installer aujourd'hui ajouterait un service à
  sécuriser, un secret, une latence et un mode de panne, pour la seule persistance des compteurs au
  redémarrage. À faire **avant** la première seconde instance d'API, pas avant.
- ⛔ **L'extraction du hook de messages de l'Inbox.** Elle est légitime (2110 lignes, 779 pour `Thread`),
  mais ⚠️ **l'audit annonce 23 `useState` et il y en a 54**, dont 19 dans `Thread` : le chiffrage est à
  refaire avant de s'y engager, et ça ne se mélange pas à un chantier de sécurité.
- ⛔ **L'extraction de constructeurs verticaux de `src/index.ts`.** Même raison : du refactoring structurel
  ne se mélange pas à une modification fonctionnelle.
- ⛔ **Trois « replis fournisseurs » que l'audit invente.** Mesuré : la **traduction** a une garde explicite
  et ne traduit pas du tout sans clé d'espace ; l'**e-mail** n'a aucun repli (pas de SMTP global) ;
  **Zadarma** n'est importé par aucun fichier de `src/`. Travailler là-dessus serait travailler pour rien.
- ⛔ **Cloudflare Enterprise.** Le contrôle par clé reste chez nous. Une règle de débit par IP sur
  `/v1/*` et `/mcp` reste souhaitable (geste d'infra, hors de ce plan de code).

## Ce qui attend un arbitrage de Julien

- 🔲 **Le repli RCS sur notre clé smsmode.** 🔴 **MESURÉ LE 2026-09-14 : le risque n'est PAS réalisé.** Il y
  a UN seul agent RCS en production (« Messaging Me (TEST) », espace Demo, statut `testing`) et **il a sa
  propre clé**. **Zéro agent sans clé.** Le repli ne peut donc se déclencher que dans deux cas : un agent
  créé sans qu'on colle de clé, ou une clé devenue **indéchiffrable** (si `ENCRYPTION_KEY` changeait), où
  `src/rcs/store.pg.ts` retombe **en silence** sur la clé serveur. L'intuition de Julien est confirmée :
  « si un client n'a pas RCS, il n'aura pas d'agent ». La décision peut donc attendre, mais deux garde-fous
  sont peu coûteux : **journaliser** le repli au lieu de le faire en silence, et décider si un envoi RCS
  **déclenché par l'API publique** doit exiger une clé d'espace.
- 🔲 **Les seuils de quota**, après la période d'observation de la tâche 5.
- 🔲 **Un plafond du nombre de clés actives par espace.** Mesuré : aucun. Un espace avec N clés dispose de
  **N × 60** requêtes/minute. ⚠️ Une clé ne peut PAS en créer d'autres (vérifié : 401), c'est un geste
  d'admin de la console, donc la défense est secondaire — le vrai levier est le quota par ESPACE (tâche 4).
- 🔲 **Ce qu'on fait des coûts qui sont à notre charge par décision** : transcription, bot d'aide, analyse
  de conversation. ⚠️ Et un quatrième que l'audit n'avait pas vu : la **recherche sémantique** (embeddings
  et rerank) tourne sur la clé maison **sans aucun compteur**.

## Revue

Revue `/revue` systématique, plus le rayon de souffle. Trois questions propres à ce lot :

- **Qui LIT `makeRequireApiKey` ?** Les six routes derrière la clé, et elles seules. Un ordre de gardes
  changé là se paie sur les six.
- **Le budget de connexions.** Toute borne ajoutée se juge contre **8**, pas contre un nombre abstrait :
  l'API, l'Inbox et le worker partagent ce pool.
- **Les textes devenus faux.** Ce lot touche des fichiers très commentés, et le dépôt vient de payer deux
  fois une justification fausse recopiée.
