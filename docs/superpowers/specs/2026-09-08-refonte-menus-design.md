# Refonte des menus : Console / Inbox / Performance Lab

**Date** : 2026-09-08 · **Demandeur** : Julien · **État** : spec à relire

## Ce qu'on construit, en une phrase

La console passe d'une barre latérale unique à **trois onglets de premier niveau**, l'Inbox devient une
**boîte mail** (dossiers, compteurs, archivage, charge par collaborateur), et un onglet **Performance Lab**
s'ouvre sur une **page de synthèse** qui répond à deux questions : ce que coûte un engagement, et où se
situent les conversations en urgence et en satisfaction.

## Pourquoi maintenant

La barre latérale actuelle met sur le même plan trois métiers qui ne se pratiquent ni au même moment ni par
les mêmes personnes : configurer le produit, traiter les conversations, lire les résultats. Un opérateur qui
passe sa journée dans l'Inbox traverse un menu de quinze entrées dont il n'en utilise qu'une. Les trois
onglets rendent ce découpage visible ; le reste du lot en tire les conséquences.

---

## Découpage en six lots, et leur ordre

| Lot | Contenu | Dépend de |
|---|---|---|
| **A** | Les trois onglets | rien |
| **B** | Sidebar Inbox façon boîte mail, avec compteurs | A |
| **C** | Archivage d'une conversation (migration 0120) | B |
| **D** | Compteurs par collaborateur + non affecté | B |
| **E** | Synthèse quantitative : coût par engagement | A |
| **F** | Urgence et satisfaction dans l'analyse (migration 0121), et le nuage de points | A |

**A d'abord, seul.** C'est le squelette, c'est le seul lot qui touche toutes les pages, et il ne change
aucune fonctionnalité : il se relit comme un déplacement.

**Puis B + C + D ensemble.** C'est un seul écran et une seule idée. Les livrer séparément produirait une
sidebar sans compteurs, puis des compteurs sans archivage : trois états dont aucun n'est utilisable.

**Puis F, puis E.** F d'abord **parce qu'il demande du temps de collecte** : seules les conversations
analysées après son déploiement porteront les deux mesures. Plus tôt il part, plus le nuage aura de points.
E, lui, se calcule sur tout l'historique dès le premier jour.

---

## Lot A : les trois onglets

### Ce que contient chaque onglet

| Onglet | Contenu | Barre latérale |
|---|---|---|
| **Console** | Accueil, mini-CRM, Campagnes, Chaîne, Scénario, Automation, AI Agent, Contenu, Tools, Paramètres, Support, Developers | celle d'aujourd'hui, **moins** Inbox et Analytics |
| **Inbox** | les conversations, rien d'autre | **aucune barre de navigation** : à la place, le menu de dossiers du lot B |
| **Performance Lab** | la synthèse (neuve) + l'arbre Analytics d'aujourd'hui | Synthèse, Quantitatif (Messages & contacts, Coûts, Funnel, Erreurs), Qualitatif, Mes tableaux |

### 🔴 Aucune URL ne change

`/inbox`, `/dashboard`, `/campaigns`, `/agents` restent où elles sont. Les onglets ne sont qu'un **niveau de
regroupement au-dessus** de la nav existante. Une seule route neuve : `/performance`, la page de synthèse.

C'est une contrainte dure, pas une commodité : le dépôt distribue des adresses qui ne se reprennent pas
(liens tracés dans des messages livrés, webhook Meta, liens d'e-mail), et il a une règle écrite là-dessus.
Renommer une route de console ne casserait pas ces adresses-là, mais casserait les favoris et les liens que
les clients se sont échangés, sans qu'on puisse le savoir.

### Comment l'onglet est déterminé

`AppShell` reçoit déjà `active`, la clé de la page courante, depuis **33 pages**. L'onglet n'est **pas** une
nouvelle prop : il se **déduit** de `active` en cherchant la page dans les trois arbres de nav.

C'est ce qui garde ce lot petit : sans cette déduction, il faudrait toucher les 33 pages, et chacune serait
une occasion d'écrire le mauvais onglet. `cheminDeNav` (`web/lib/nav.ts`) fait déjà exactement ce calcul
pour les groupes dépliables ; on lui ajoute un cran.

**Une clé inconnue tombe sur Console**, comme `cheminDeNav` rend aujourd'hui une chaîne vide : une page dont
l'onglet n'a pas été déclaré doit s'afficher dans un onglet plausible, pas faire disparaître la barre.

### RBAC

Un compte `agent` n'a accès qu'à l'Inbox (règle actuelle : `adminOnly = active !== 'inbox'`). **La barre
d'onglets ne lui montre donc que l'onglet Inbox**, et `pageDArrivee` continue de l'y envoyer. Montrer trois
onglets dont deux refusent l'entrée serait pire que l'état actuel.

### Ce qui reste à l'identique

Le tiroir mobile, le badge de non-lus, le fil d'Ariane des groupes dépliables, la session expirée.

### Tests

- Unitaire (`web/lib/nav.test.ts`) : chaque clé de page tombe dans **un seul** onglet, et l'ensemble des clés
  des trois arbres couvre exactement le type `Tab`. **C'est le test qui compte** : il rend impossible qu'une
  page ajoutée plus tard n'appartienne à aucun onglet ou à deux.
- E2E : depuis `/campaigns`, l'onglet Console est actif ; depuis `/inbox`, l'onglet Inbox est actif et
  **aucune barre de navigation générale n'est rendue** ; depuis `/dashboard/couts`, l'onglet Performance Lab
  est actif et sa barre montre l'arbre Analytics.
- E2E : un compte `agent` ne voit **qu'un** onglet.
- E2E de non-régression : les URLs des 33 pages répondent toujours (une liste dérivée de la nav, pas écrite
  à la main).

---

## Lot B : l'Inbox devient une boîte mail

### Le menu de gauche

```
Conversations
  Tout            (13)
  À traiter        (2)
  Signalé          (0)
  Archivé          (4)
```

Le compteur est **toujours affiché**, y compris à zéro. C'est la différence avec le bouton actuel, qui cache
le sien quand il vaut zéro : dans une boîte mail, « Signalé (0) » est une information (« rien à relire »),
alors qu'un libellé nu laisse croire que le compteur n'a pas chargé.

⚠️ **Les compteurs portent sur TOUTE la base, pas sur la page affichée.** C'est déjà la règle du compteur
« À traiter » actuel, et elle doit tenir pour les quatre : un compteur qui compterait les lignes chargées
descendrait quand on pagine.

### Une seule route pour tous les compteurs

`GET /tenants/:tenantId/conversations/counts` rend l'objet entier en **une requête groupée** :

```json
{ "tout": 13, "aTraiter": 2, "signalees": 0, "archivees": 4,
  "nonAffectees": 7, "parMembre": [{ "userId": "...", "nom": "Jean", "n": 3 }] }
```

Une route par compteur ferait six allers-retours pour afficher un menu, et six occasions de désaccord entre
deux chiffres lus à deux instants différents.

Elle réutilise le **cache de compteurs existant** (`compteurs.lire`, celui de `todo-count`) : même
invalidation, même durée. Un second mécanisme de cache pour la même donnée dériverait du premier.

⚠️ `unread-count` (le badge de la barre) **reste** : les non-lus ne sont pas les « à traiter », et le badge
vit dans `AppShell`, hors de cet écran. `todo-count` devient redondant **pour cet écran** ; on ne le retire
qu'après avoir vérifié qu'aucun autre appelant ne le lit.

### Tests

- Intégration : les cinq compteurs sur un jeu de conversations construit à la main, dont un cas où une
  conversation est à la fois « à traiter » et affectée (elle compte dans les deux, et ce n'est pas un bug).
- E2E : le menu affiche les compteurs, cliquer sur un dossier filtre la liste, et le dossier actif se voit.

---

## Lot C : archiver une conversation

### Ce que ça fait, et ce que ça ne fait pas

Archiver **sort la conversation des dossiers Tout, À traiter et Signalé** et la range dans **Archivé**. Rien
n'est effacé, aucun chiffre d'analytics ne bouge, la conversation reste consultable et ses messages intacts.

🔴 **Un nouveau message du contact la DÉSARCHIVE.** Décision de Julien. La raison : une conversation archivée
puis relancée par le client est exactement le cas où l'oublier coûte cher. L'archivage range ce qui est
fini ; il ne réduit personne au silence.

### Modèle de données

Migration **0120** : `alter table conversations add column if not exists archived_at timestamptz;`
plus un index partiel `where archived_at is not null` pour le dossier Archivé.

Un horodatage et pas un booléen : « depuis quand » se posera (trier le dossier, purger un jour), et une
colonne `boolean` ne pourra plus répondre.

🔴 **La désarchivation se fait dans l'ÉCRITURE QUI EXISTE DÉJÀ**, celle qui pose `last_message_at` sur un
message entrant, pas dans une seconde écriture qui la suivrait. Deux écritures laisseraient une fenêtre où la
conversation a un message neuf et reste rangée dans Archivé, et c'est précisément l'état que personne ne
regarde. Le dépôt a déjà payé ce motif (§ « une transition terminale faite de deux écritures »).

⚠️ **Ordre de déploiement** : la migration AJOUTE une colonne que le code écrit, elle passe donc **avant** le
déploiement.

### L'écran

Cases à cocher sur les lignes, un bouton **« Archiver »** quand au moins une est cochée, et dans le dossier
Archivé le bouton inverse **« Désarchiver »**.

**Le glisser-déposer est hors périmètre de ce lot, et c'est un choix.** Julien l'a proposé comme une
alternative (« soit drag and drop, soit sélectionner »), donc la sélection suffit à répondre. Le
glisser-déposer coûte la moitié du lot à lui seul (accessibilité au clavier, cible de dépôt, retour visuel,
annulation) pour un geste que la case à cocher rend déjà. À rouvrir quand l'écran aura vécu.

### Tests

- Intégration : archiver retire des trois dossiers et met dans Archivé ; désarchiver fait l'inverse.
- 🔴 Intégration, **dans les deux sens** : un message entrant sur une conversation archivée la fait
  réapparaître dans Tout **et** la retire d'Archivé. Et la preuve inverse : sur une conversation NON
  archivée, le même message ne change rien à `archived_at`.
- E2E : cocher deux conversations, archiver, les voir disparaître de Tout et le compteur d'Archivé monter.

---

## Lot D : la charge par collaborateur

### Le menu, suite

```
Affectation
  Non affecté      (7)
  Jean Test        (3)
  Marie Dupont     (2)
  Paul Martin      (0)
```

**Tous les membres sont listés, y compris à zéro.** C'est ce qui répond à la question du manager : un
collaborateur à zéro est une information, et ne le montrer que lorsqu'il a du travail le rendrait invisible
au moment précis où on le cherche. Six membres au maximum aujourd'hui sur le plus gros espace, donc aucune
question de volume.

Tri : par nombre décroissant, puis par nom, pour que la liste ne saute pas d'un rafraîchissement à l'autre
entre deux membres à égalité.

### RBAC

**Section réservée aux administrateurs.** Un opérateur n'a pas à lire la charge de ses collègues, et ce
n'était pas la demande : Julien la justifie explicitement par le besoin du manager.

### Requête

Un seul `group by assigned_to` joint aux membres de l'espace, dans la même route `counts` que le lot B. Une
requête par membre serait un N+1 sur un menu affiché à chaque chargement.

### Hors périmètre, et pourquoi

Une entrée **« Mes conversations »** pour l'opérateur serait presque gratuite (le filtre par affectation
existe déjà côté serveur). Elle n'a pas été demandée, elle s'ajoutera en une ligne le jour où elle manquera.

---

## Lot E : le coût d'un engagement

### Ce que la page montre

Une liste des dernières campagnes, une ligne par campagne :

| Campagne | Envoyés | Coût estimé | Clics | Coût par clic |
|---|---|---|---|---|

### D'où vient chaque colonne, et ce qu'elle vaut

**Le coût est une ESTIMATION**, et l'écran doit le dire. Aucun coût par campagne n'est stocké : il se calcule
comme le tableau des coûts actuel, `nombre d'envois × tarif Meta de la catégorie de la campagne`. Les tarifs
viennent de `pricing_analytics` de Meta, par WABA et par période, en direct.
⚠️ **Quand Meta ne rend aucun tarif, la colonne est VIDE et le dit** (`hasRates`), elle n'affiche pas zéro.
Le module de coût actuel porte déjà ce cas et le compte des envois « non chiffrables » : on réutilise sa
sémantique plutôt que d'en inventer une seconde.

**Les clics viennent de `clicsLiensCampagne`**, qui existe et sert déjà le funnel d'une campagne.

🔴 **CORRECTION D'UN DOCUMENT DU DÉPÔT.** `todo.md` affirme « une campagne DIRECTE (sans scénario) n'a aucun
compteur de clics ». **C'est l'inverse.** Le code compte les clics quand `template_name is not null`,
c'est-à-dire pour les campagnes **à template**, et rend `null` pour les campagnes **à scénario**. La phrase
de `todo.md` est corrigée dans ce lot : une entrée de backlog fausse envoie chercher un travail qui n'existe
pas, et fait croire absent un compteur qui est là.

Conséquence concrète : la colonne « Clics » est renseignée pour les campagnes à template, et porte
**« non attribuable (scénario) »** pour les autres, plutôt qu'un blanc ou un zéro qui se lirait « personne
n'a cliqué ».

⚠️ **Deux réserves affichées sous le tableau, pas cachées dans une infobulle** : les templates approuvés
avant le 2026-09-02 ont une adresse figée chez Meta qui ne porte aucun jeton, donc leurs clics ne remontent
pas du tout ; et deux campagnes qui envoient la même adresse au même contact dans une fenêtre rapprochée
partagent le compteur, l'attribution tranche alors par proximité de temps.

**Le ratio n'est affiché que si les deux termes existent.** Pas de tarif, pas de clic mesurable, ou zéro
clic : la case reste vide avec sa raison. Un « ∞ » ou un « 0 € » serait une réponse à une question qu'on n'a
pas pu poser.

### Hors périmètre

Rendre l'attribution des clics **exacte** (il faudrait une dimension de plus sur le lien tracé, donc une
porte à sens unique sur des adresses déjà distribuées) et les clics RCS.

---

## Lot F : urgence et satisfaction

### Deux mesures neuves dans l'analyse

Le modèle rend aujourd'hui `sentiment` (positif / neutre / négatif), `intent`, `resolved`, `abusive`,
`confidence`. **Ni urgence ni satisfaction chiffrée.** On ajoute deux entiers de 0 à 10 :

- **`satisfaction`** : 0 = client très mécontent, 10 = client très satisfait.
- **`urgence`** : 0 = aucune attente particulière, 10 = le client attend une réponse immédiate.

Une échelle de 0 à 10 et non un flottant de 0 à 1 : c'est une note que le modèle rend de façon stable et
qu'un humain lit sans conversion, et le nuage n'a pas besoin de plus de résolution.

### Le schéma

Les deux champs sont **optionnels avec un défaut**, comme `abusive` et `summary` avant eux, et pour la même
raison écrite dans le fichier : un modèle qui les omet ne doit pas invalider **toute** l'analyse. Une analyse
perdue coûte plus cher qu'une mesure manquée.

⚠️ Le défaut du schéma est `undefined`, **pas** `0` : voir la colonne ci-dessous.

### La colonne

Migration **0121** : `satisfaction smallint` et `urgence smallint`, **toutes deux NULL par défaut**.

🔴 **`null` doit rester distinguable de `0`.** Une analyse faite avant ce lot n'a pas de mesure ; la compter
comme zéro placerait **toutes** les conversations historiques dans le coin « client furieux, urgence nulle »
et ferait mentir la moyenne. Le graphe ignore les `null`, et il DIT combien il en a ignorées.

### Le nuage de points

**Abscisse : la satisfaction. Ordonnée : l'urgence.** Julien hésitait entre les deux ; je tranche et voici
pourquoi : l'abscisse se lit de gauche à droite comme un progrès (mécontent → satisfait), l'ordonnée de bas
en haut comme une montée en tension. Le coin qui alarme, « très urgent et très mécontent », tombe alors en
**haut à gauche**, là où l'œil va en premier.

Un point par conversation analysée sur la période, plus un **point moyen** bien distinct.

🔴 **Le graphe démarrera VIDE**, et il doit le dire : seules les conversations analysées après le déploiement
portent les deux mesures, et il n'y a que **14 analyses dans toute la base de production** aujourd'hui. Sans
message explicite, un graphe vide se lit comme un graphe cassé. Le texte annonce ce qui se passe (« les
mesures se remplissent au fil des analyses ») plutôt que de laisser deviner.

### Hors périmètre

**Réanalyser les conversations existantes.** Julien a choisi de ne pas le faire : le coût LLM serait
négligeable sur 14 conversations, mais réanalyser change des analyses que des humains ont peut-être déjà
lues, et le bénéfice est de 14 points sur un nuage qui se remplira tout seul.

---

## Ce qui ne change pas, dans tous les lots

- Aucune URL existante.
- L'isolation par espace : `tenant_id = $1` sur chaque requête neuve, sans exception.
- Les compteurs et les agrégats passent par le cache existant, pas par un second.
- Le détail Analytics reste tel quel : ce lot le **déplace** sous un onglet, il ne le réécrit pas.

## Risques, et ce qui les couvre

| Risque | Ce qui le couvre |
|---|---|
| Une page n'appartient à aucun onglet, ou à deux | Le test unitaire de couverture de `Tab` (lot A) |
| Une conversation archivée reste muette après un message du client | Le test d'intégration dans les deux sens (lot C) |
| Le nuage de points affiche les analyses anciennes à (0,0) | `null` distinct de `0`, et le graphe dit ce qu'il ignore (lot F) |
| Le coût affiché est pris pour un coût facturé | Le mot « estimé » dans l'en-tête, et la colonne vide quand Meta ne rend aucun tarif (lot E) |
| Le ratio est lu comme exact | Les deux réserves affichées sous le tableau (lot E) |
