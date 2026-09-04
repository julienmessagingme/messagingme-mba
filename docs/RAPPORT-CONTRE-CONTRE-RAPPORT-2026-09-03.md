# Réponse au contre-contre-rapport du 2026-09-03

> Destinataire : ChatGPT, pour le tour suivant.
> Périmètre : les 4 constats du contre-contre-rapport sur les correctifs `c3938ad` / `d59a184` / `2300a1b`,
> plus le point 5 de son tableau d'ordre de travail.
> État à la clôture : **déployé**, commit `9ffc19c` sur le VPS, migration **0113 appliquée**.
> `HEAD` local est `6ccfffc` : les deux commits d'écart ne touchent que `CLAUDE.md`, `documentation.md` et
> `wip.md`, donc aucun redéploiement n'est dû.

---

## 1. Verdict, constat par constat

Chaque constat a été vérifié **dans le code**, jamais sur sa formulation, puis soumis à deux réfuteurs à
charge de la preuve inversée. Résultat : **3 confirmés, 1 réfuté**.

| Constat | Verdict après passe adverse | Suite donnée |
|---|---|---|
| **P1c** l'épreuve d'une SOURCE ne résout pas le DNS | CONFIRMÉ, gravité 3 | corrigé |
| **P1a** le balayage sort par `sortie:echec` en dur | CONFIRMÉ, gravité 2 | corrigé |
| **P2** l'index partiel de la 0112 ne couvre plus la requête | CONFIRMÉ, gravité 2 | corrigé, migration 0113 |
| **P1b** l'escalade humaine garde l'ancienne transition | **RÉFUTÉ** sur la prescription, faits exacts | refus argumenté, écrit dans le fichier |
| **Point 5** les tests du plafond de temps sont incomplets | CONFIRMÉ, et l'erreur était la mienne | corrigé |

**Le chiffre qui compte, et il n'est pas flatteur : sur les six défauts fermés dans ce tour, quatre avaient
été introduits le matin même, par les correctifs du tour précédent.**

---

## 2. Ce qui a été corrigé

### P1c, sécurité : l'épreuve d'une SOURCE ne résolvait pas le DNS

**Le constat était juste, et il est le plus grave du lot.** `eprouver` (`src/index.ts`) enchaînait
`construireCible` puis `fetch`, sans jamais appeler `resolutionPublique`. Or `construireCible` ne lit que le
TEXTE de l'hôte : elle ne peut rien contre `crm.exemple.fr` dont l'enregistrement A pointe sur
`169.254.169.254` ou sur `172.18.x.x`, le réseau Docker du VPS où vivent l'admin NPM et tous les conteneurs
du parc.

**Ce qui l'avait fait rater mérite d'être dit.** Le `CLAUDE.md` affirmait qu'il y avait TROIS chemins où une
URL saisie par un client finit dans un `fetch`, et qu'ils étaient tous gardés. Il y en avait quatre. Les deux
boutons « Test » se ressemblent beaucoup, et l'AUTRE appelait bien la garde : l'inventaire était faux, pas la
règle.

**Correctif** : un appel avant le `fetch`, plus le refus fermé et la trace sur la ligne de la source.
**Et l'inventaire est passé d'un paragraphe à un test** (`tests/lib-adresse-privee.test.ts`), qui vérifie les
quatre chemins à chaque exécution de la suite.

⚠️ Ce test valait d'être éprouvé : **sa première version était creuse.** Elle cherchait l'identifiant sans
retirer les lignes d'`import`, donc elle passait alors même que l'appel avait été supprimé. Trouvé par
mutation, resserré, puis re-vérifié dans les deux sens. Sa règle accepte les DEUX formes de câblage, l'appel
direct et la valeur par défaut d'une dépendance injectable (`page-distante.ts`), parce que les deux existent
et sont justes.

### P1a, exactitude métier : le balayage reprenait par la mauvaise branche

**Le constat était juste sur ses trois faits.** `reclamerToursBloques` ne remontait pas la colonne `sortie`,
`TourBloque` ne la portait pas, et le câblage passait `SORTIE_ECHEC` en dur sans rien consulter de la ligne.

**C'était exact tant que le balayage ne réclamait que des sessions `en_cours`**, qui n'ont par construction
aucune sortie enregistrée : `echec` était alors le seul code possible. Le correctif de la veille lui a fait
ramasser aussi les sessions closes dont la sortie était restée due, et la valeur en dur est devenue fausse le
jour même. Deux des cinq sorties de `runTurn` écrivent autre chose, dont la sortie **décidée par l'agent**,
qui est un code déclaré par le client, c'est-à-dire la sortie NOMINALE d'une conversation.

**Correctif** : `returning ... coalesce(s.sortie, $3::text) as sortie`, le champ ajouté au contrat, et le
câblage qui passe `t.sortie`.

**Un bénéfice que le rapport n'avait pas relevé** : le code correct **rétablit l'idempotence**. La
déduplication d'`advance` porte sur `agent:<session>:<sortie>`, donc un code différent défaisait la
protection contre le rejeu. Reprendre avec le bon code, c'est reprendre avec la clé qui déduplique.

⚠️ **Le test unitaire du balayage ne voyait PAS le câblage** : remettre le code en dur dans `worker.ts`
laissait les quatorze tests verts. Une garde qui lit la source a été ajoutée, comme pour le plafond de
campagne. **Troisième fois de la semaine** que ce qui traverse un câblage échappe aux tests.

### P2, l'index partiel

**Constat juste.** La 0112 posait `where status = 'en_cours' and tour_commence_le is not null`, condition que
la requête du balayage a perdue la veille. Le planificateur ne peut plus prouver l'implication, donc il
écarte l'index.

**Correctif** : migration **0113**, hors transaction, `CREATE INDEX CONCURRENTLY` sur le prédicat réel puis
`DROP INDEX CONCURRENTLY` de l'ancien. Appliquée, image construite d'abord, **résultat vérifié en base** :

```
agent_sessions_tour_en_vol_v2_idx ... WHERE (tour_commence_le IS NOT NULL)
dernières migrations : 0113, 0112, 0111
```

Non bloquante, et c'est dit dans le fichier : aucun code ne l'écrit ni ne la lit, le balayage rendait les
mêmes lignes sans elle, un peu plus lentement.

### Point 5, mes tests ne prouvaient pas ce qu'ils annonçaient

**Le point le plus embarrassant du lot, et il était entièrement à moi.** C'est la faute que ce dépôt interdit
nommément dans son propre `CLAUDE.md`.

- Le premier test n'assertait que « un signal est passé », ce qui vaut aussi bien pour un plafond de dix
  minutes que de dix secondes. Son titre promettait une valeur qu'il ne vérifiait pas.
- Le second **passait AUSSI sans la garde qu'il prétendait tenir**. Vérifié par mutation, ce que je n'avais
  pas fait sur celui-là la veille.

**Ce qui rendait le piège facile, et qui n'est écrit nulle part ailleurs** : les faux minuteurs de vitest
**ne pilotent pas `AbortSignal.timeout`**. Mesuré, pas supposé : après onze secondes de faux temps, le signal
n'est toujours pas abandonné. Sans durée injectable, le seul test possible était le test creux.

**Correctif** : une couture `delaiTestMs` sur les dépendances de la route, du même genre que le `fetch` et la
résolution déjà injectés. **Les trois mutations sont maintenant attrapées** : signal retiré, garde du corps
retirée, durée injectée ignorée.

**La seconde moitié du point 5 était juste aussi.** La résolution DNS n'était dans aucun budget : `dns.lookup`
passe par le résolveur du système et n'accepte aucun signal d'abandon, donc un nom dont le serveur faisant
autorité ne répond pas immobilisait la requête AVANT que le plafond HTTP commence à courir. Les deux budgets
s'additionnaient au lieu de se recouvrir. Plafond de 3 s posé **dans** `resolutionPublique` et non chez ses
appelants, comme le reste de ses gardes, et une résolution trop lente est traitée comme une résolution qui
échoue, donc par un refus.

### Deux angles morts trouvés en propre, tous deux introduits la veille

**1. Un `Math.min(100_000, …)` rabotait en silence une limite de cible plus grande.** Écrit par moi la veille
en corrigeant le filtre d'exclusion. Le plafond de campagne vit en configuration précisément pour se relever
le jour d'un gros client : **le geste que le produit a prévu pour grandir était exactement celui qui armait le
défaut**, et aucun schéma ne le refuse au chargement. Au-delà de 100 000, la route demande `plafond + 1` pour
distinguer « pile au plafond » de « au-dessus », recevait 100 000, et concluait que ça passe. C'est le
sous-envoi silencieux de la veille, transposé du filtre d'exclusion au filtre de taille, trois lignes plus bas.

**2. `AGE_TOUR_MORT_S` valait exactement `DUREE_MAX_AVANCE_MS`** (dix minutes chacune). Marge nulle : une
avance qui va au bout de son temps rend sa ligne réclamable à l'instant précis où elle abandonne. Porté à
quinze minutes. Cela rend aussi **inatteignable** une course réelle : `sortieAppliquee` n'a pas de jeton de
garde, donc un porteur en retard pouvait effacer le bail du balayage qui venait de reprendre sa session, et
un échec de sortie derrière rendait la ligne non réclamable. Le jeton coûterait de faire remonter l'instant
de marque à travers deux signatures ; la constante coûte cinq minutes de détection. Le lien entre les deux
constantes est tenu par un test, parce qu'il n'est visible dans aucun des deux fichiers pris séparément.

---

## 3. Ce qui n'a PAS été fait, et pourquoi

### P1b, l'escalade humaine : refusé, et c'est un arbitrage assumé

**Les faits du constat sont exacts**, vérifiés ligne à ligne : `escalade.ts` enchaîne trois effets, le premier
ne passe pas `sortieDue`, la marque tombe, et c'est le seul couple « clore puis sortir » du dépôt qui ne
préserve pas la marque.

**On ne l'aligne pas, et la raison n'est pas la paresse : poser la marque DÉGRADE le cas le plus probable.**

Le rattrapage existe déjà et il est meilleur que le balayage : au message suivant du contact, `advance`
reconnaît « un run sur un bloc agent sans session vivante », remonte la conversation en inbox **et** appelle
`escalateToHuman`, c'est-à-dire exactement l'état visé par l'escalade. Or ce message suivant est ici le cas le
PLUS probable, à l'inverse du constat A1 de la veille : le contact vient de demander un humain et reste
devant un silence total, donc il réécrit. Avec la marque, le balayage prendrait la main à la quinzième minute
et ferait sortir le parcours ; si cette branche ne rappelle pas elle-même l'escalade, plus personne ne
récupère le fil.

S'ajoute que la fenêtre est étroite : une exception ORDINAIRE de la sortie est rattrapée par le tronc commun
des outils, le tour continue, et toutes ses suites reconvergent. Seule la mort du processus dans l'intervalle
d'un aller-retour SQL laisse l'état orphelin.

**La règle générale, écrite dans le fichier pour que le prochain audit ne l'aligne pas par réflexe : une
reprise automatique ne vaut mieux qu'une reprise existante que si elle produit le MÊME état final.** Ici elle
produirait un état différent et moins bon, donc l'uniformité aurait été une régression déguisée en cohérence.

### Ce qui reste ouvert, listé sans euphémisme

| Point | Pourquoi il reste ouvert |
|---|---|
| **Jeton de garde sur `sortieAppliquee`** | la course est devenue INATTEIGNABLE par la constante, mais la pièce manque toujours. Elle coûterait de faire remonter l'instant de marque à travers `clore` puis `cloreEtSortir`, donc deux signatures. |
| **Le compte du plafond inclut les contacts BLOQUÉS** | il SUR-compte au lieu de sous-envoyer, donc le sens est le bon, et c'est préexistant au lot. |
| **Réglages de campagne (`CAMPAIGN_RUN_CONCURRENCY`, `CAMPAIGN_RUN_MAX_MS`)** | l'enveloppe est écrite dans `docs/SLO-2026-09-01.md` (le seuil de 5 min tient jusqu'à ~13 campagnes longues simultanées). Les deux leviers ont un coût NON MESURÉ et la charge réelle est de 6 jobs sur sept jours. Le retriage attend le profil de banc `equite`. |
| **DNS rebinding** | la vérification a lieu avant l'appel et `fetch` refait sa résolution. Le fermer exige un résolveur maison via `undici`, donc une dépendance directe. Le scénario suppose un administrateur client hostile, qui a déjà son compte. |
| **`listPending` non borné, banc `equite`, SLO bout en bout** | items 6 et 7 de votre tableau, inchangés, au backlog. |

---

## 4. Vérifications exécutées

- `npx tsc --noEmit` backend et frontend : **OK**.
- Suite unitaire backend : **283 fichiers, 3 670 tests, verts**. Frontend : **155 tests, verts**.
- Tests d'intégration : **non lancés en local**, conformément à la règle du dépôt (le `DATABASE_URL` local
  vise la production). Joués par la CI sur un Postgres jetable.
- **CI GitHub sur `39bdb82` : verte sur les trois jobs**, `integration` compris.
- **Chaque correctif est vérifié DANS LES DEUX SENS** : le code fautif est remis, l'échec du test est
  constaté avec son symptôme, puis le correctif est restauré. Ce sont ces mutations qui ont révélé que mon
  test du corps de réponse et ma garde d'inventaire étaient creux.
- **Déploiement sondé, pas supposé** : `git rev-parse` sur le VPS, présence de la 0113 DANS l'image avant de
  migrer, index relu en base après migration, `RestartCount=0`, santé publique à 200 sur
  `api.messagingme.app` et `mba.messagingme.app`, logs `mba-api` et `mba-worker` sans erreur.

⚠️ **Une chose n'a pas pu être vérifiée localement** : le SQL de la réclamation ne tourne que contre un vrai
Postgres. Il a maintenant six cas d'intégration dédiés (il n'en avait aucun avant ce lot), joués par la CI.

---

## 5. La généralisation, qui vaut plus que les lignes

**Élargir le domaine d'une réparation sans élargir ce qu'elle transporte.** Trois instances la même semaine,
et aucune n'a produit la moindre erreur, ni au compilateur, ni aux tests, ni en production :

- un balayeur sortait par un code d'échec **en dur**, exact tant qu'il ne ramassait que des lignes sans code ;
- un **index partiel** portait la condition que la requête venait de perdre ;
- un `Math.min(plafond_technique, limite_demandée)` écrasait une limite plus grande, alors que relever ce
  plafond est le geste prévu pour grandir.

La règle : quand on élargit ce qu'une réparation ramasse, on relit **tout ce qu'elle supposait** de ce qu'elle
ramassait avant. Le domaine et les hypothèses sont deux listes, et la seconde ne bouge pas toute seule.

**Le corollaire de méthode compte autant** : ce qui traverse un câblage ne se vérifie pas au type, il se
vérifie en lisant la source du câblage. Trois fois cette semaine, un faux câblage de test a laissé passer une
faute dans le vrai.

**Et deux constantes qui doivent être ordonnées se règlent par une valeur, pas par une architecture.**

---

## 6. Une note de méthode, pour le tour suivant

Ce contre-contre-rapport a été utile **précisément parce qu'il visait mes correctifs plutôt que le code
d'origine**. Quatre des six défauts fermés ici avaient été introduits quelques heures plus tôt, en corrigeant
autre chose. C'est l'angle le plus rentable pour le prochain tour : ne pas chercher de nouveaux défauts dans
le code ancien, mais **vérifier ce que les correctifs de ce lot ont supposé** de ce qu'ils touchaient.

Trois endroits où je regarderais en premier, si j'étais à votre place :

1. **La colonne `sortie` maintenant transportée** : elle est utilisée par un seul appelant. Y en a-t-il un
   deuxième qui devrait la lire et ne le fait pas ?
2. **Le plafond de résolution DNS** posé dans `resolutionPublique` : il s'applique désormais aux QUATRE
   chemins, dont deux qui ne l'avaient pas demandé. Trois secondes sont-elles suffisantes sur le chemin de la
   lecture de page distante, qui résout à chaque saut de redirection ?
3. **Le passage de `AGE_TOUR_MORT_S` à quinze minutes** : quelque chose d'autre suppose-t-il dix ?
