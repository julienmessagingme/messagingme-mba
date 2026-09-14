# Les assistants conversationnels : METTRE À JOUR, pas seulement construire

> Spec. Écrite le 2026-09-14 après un interrogatoire de frontière (skill `grilling`), 22 décisions prises
> par Julien. Deux surfaces dans un seul document, parce qu'elles partagent un moteur : le **Meta Business
> Agent** et les **agents IA**. Le mode ÉVOLUTION passe en premier, c'est le sujet.

**But :** qu'un client puisse dire « change les horaires du dimanche » ou « ajoute cette FAQ » à un robot
DÉJÀ EN SERVICE, et que ça se fasse, sur le Meta Business Agent comme sur un agent IA.

**Ce qui existe aujourd'hui :** un assistant qui CONSTRUIT un agent IA depuis rien
(`src/agent/setup/`, 1 649 lignes, entretien tenu par le serveur, pièces jointes, couverture déterministe).
Le Meta Business Agent n'a **aucun** assistant : il se règle onglet par onglet, à la main.

**Ce qui manque, et c'est la demande :** l'assistant d'agent IA s'ARRÊTE dès que tout est couvert. La ligne
est `src/agent/setup/conversation.ts:138` :

```ts
if (!ouvert) {
  return 'Tous les points sont couverts : ne pose plus de question, écris les champs et explique en une '
    + 'phrase ce que tu proposes.';
}
```

Un agent fini est un agent qu'on ne parle plus. C'est exactement le compte `+33 5 25 68 02 50` : réglé, en
service, et modifiable seulement au formulaire.

---

## 1. Le modèle mental : l'ÉLÉMENT, pas le MODE

🔴 **Il n'y a pas de « mode construction » et de « mode évolution ».** Cette formulation, proposée en
interrogatoire, a été rejetée par Julien et elle avait tort :

> « y aura jamais de démarrage à zéro, soit y a aucun réglage du tout et forcément ça démarre à zéro, soit le
> user revient sur un élément déjà setuppé (et qu'on voit forcément dans un des onglets PHYSIQUEMENT) et là
> ça redémarre, sinon ça sera forcément un item pas setuppé et il démarre à zéro cet élément là uniquement. »

Le grain est l'**élément** : une FAQ, une compétence, un site, les horaires, le ton d'un agent. Chaque
élément est dans l'un de deux états, et **l'onglet est la preuve visible de cet état** :

| État de l'élément | Ce que l'assistant fait |
|---|---|
| Aucun réglage (l'onglet est vide) | Il questionne, comme aujourd'hui pour un agent neuf |
| Réglé (on le voit dans l'onglet) | Il montre ce qui existe et propose de le changer |

Conséquence directe : **l'assistant n'a aucun mode à deviner**, il a un inventaire à lire. Un MBA qui a
quatre compétences et zéro site fait les deux dans la même phrase : « vos compétences sont en place, aucun
site n'a été ajouté, on en ajoute un ? »

🔴 **Et les onglets ne sont pas décoratifs.** Julien, textuellement : *« c'est aussi pour ça qu'on a créé des
onglets ! les onglets sont là pour rappeler au user (et à toi !) ce qu'on a setuppé ! »* L'assistant lit
**les mêmes routes que les onglets**, jamais une source parallèle. Il ne peut donc pas afficher un état que
l'écran contredit.

---

## 2. Le moteur commun

Cinq temps, identiques sur les deux surfaces. C'est le même code, paramétré par la surface.

```
INVENTAIRE  ->  CONVERSATION  ->  DIFF  ->  APPLICATION  ->  HISTORIQUE
  (lecture)      (le fil)       (à accepter)  (écriture)     (trace)
```

### 2.1 Inventaire

**Lu une fois à l'ouverture de l'onglet, puis RELU de force juste avant d'appliquer un diff.**

Pas à chaque tour : côté MBA, l'inventaire coûte six appels chez Meta (infos, FAQ, compétences, sites,
fichiers, numéros de test), et cette information ne bouge pas au rythme d'une phrase.

🔴 **La relecture avant application n'est pas une optimisation, c'est le contrôle de concurrence.** Le fil
est partagé entre les admins de l'espace, et les onglets restent utilisables pendant la conversation. Si
l'état a bougé depuis la lecture d'ouverture, le diff est **refusé** avec ce qui a changé, et l'assistant
repropose. Sans cette relecture, une modification faite au formulaire serait écrasée sans trace.

🔴 **L'état gagne toujours sur le fil.** Si le fil dit « on a mis les horaires du dimanche » et que
l'inventaire montre qu'ils ont été retirés depuis, l'assistant le dit en une phrase et part de l'état, pas
du souvenir.

Côté MBA, l'inventaire n'est pas à écrire : **`src/mba/completion.ts` le calcule déjà**, et il est plus
strict que l'écran de Meta (une compétence `pending_review` ne compte pas, un site à `pages_crawled: 0` non
plus). Il porte pour chaque tâche une `raison` rédigée.

🔴 **La couverture du MBA est DÉRIVÉE de `completion.ts`, jamais réécrite à côté.** Une seconde liste de
« ce qu'il faut régler » divergerait de la première au premier ajout, et c'est l'écran qui aurait raison
pendant que l'assistant aurait tort. Les tâches `requise: true` dont l'état est `a_faire` sont exactement
les questions ouvertes de l'entretien.

⚠️ **Ce chantier fait tomber deux `inconnue` de `completion.ts`.** Ses clés `connecteurs` et `outils` sont
aujourd'hui `inconnue` avec la raison *« pas encore pilotés depuis Engage Me »*. Elles deviennent
connaissables et doivent rentrer dans le dénominateur, sans quoi le ratio annoncé au client reste faux.

### 2.2 Conversation

**Un fil continu par surface**, qui ne se ferme jamais : un pour le MBA de l'espace, un par agent IA.
Julien : *« toute la conversation avec l'assistant doit perdurer »*.

⚠️ **CONSERVER n'est pas ENVOYER AU MODÈLE, et l'écart est délibéré.** Le fil garde tout ; ce qui part au
modèle reste borné, comme aujourd'hui (`MAX_TOURS_HISTORIQUE = 20` tours, `MAX_CARACTERES_MESSAGE = 4000`
par message, `src/agent/setup/conversation.ts`). Un historique sans fin dans le contexte finirait par
pousser la fiche courante hors de la fenêtre du modèle, donc par dégrader ce qu'on cherche à améliorer. La
mémoire longue des décisions ne vit pas dans le fil, elle vit dans l'**Historique** (§2.5), qui est fait
pour ça et qui se lit d'un coup d'œil.

⚠️ **Le fil est par SURFACE, pas par utilisateur** : deux admins du même espace voient la même
conversation. Chaque message porte donc son auteur, sans quoi « qui a demandé ça ? » n'a pas de réponse.

Le stockage existant (`agent_setup_conversations`, migration 0090) garde **un seul état courant par agent**
et **borne les messages à l'écriture**. Il faut donc :
- délier ce qui est conservé de ce qui est envoyé (garder tous les tours, n'en transmettre que les derniers) ;
- ajouter l'auteur par message ;
- créer l'équivalent pour le MBA, clé sur l'espace et non sur un agent.

### 2.3 Le diff

Rien ne s'écrit sans passer par là. C'est le seul point d'application, et il n'a pas d'exception.

**Forme :** une liste d'opérations en langage clair, une ligne par opération, le contenu avant et après pour
ce qui change, un seul bouton pour tout appliquer.

🔴 **L'acceptation du diff SUFFIT. Pas de seconde confirmation** (décision de Julien : *« oui ça suffit »*).
Une confirmation qui suit une acceptation n'ajoute pas de sécurité, elle apprend à cliquer sans lire.

**Suppressions : une à la fois, nommée en toutes lettres.** Une demande en lot (« nettoie mes FAQ ») produit
une liste et une question, jamais une purge. La raison est que **rien n'est stocké chez nous côté Meta** :
pas de corbeille, pas de retour arrière. Le seul filet est l'Historique (§2.5), qui recopie le contenu
supprimé.

**Un fichier déposé dans la conversation entre dans le diff**, il ne part pas tout seul. Déposer ajoute une
ligne « ajouter le document X », qui part avec le reste à l'acceptation. Autrement, le dépôt serait le seul
geste de la conversation qu'on ne peut pas relire avant qu'il agisse.

### 2.4 Application

**Les opérations partent dans l'ordre. À la première qui échoue, on s'arrête**, et l'assistant rend l'état
exact : ce qui est passé, ce qui a échoué et pourquoi, ce qui n'a pas été tenté.

🔴 **Pas d'annulation, et c'est un constat, pas un choix de confort.** Meta n'offre aucune transaction :
« tout annuler » voudrait dire défaire à la main des opérations déjà passées, ce qui peut échouer à son
tour et produire un état encore moins lisible. Un arrêt net avec un compte rendu exact est la seule chose
qu'on puisse tenir.

⚠️ **Les erreurs de Meta sont reformulées en français**, et le message brut est conservé dans la ligne
d'historique. Une compétence peut revenir `blocked` après relecture par Meta : le client doit comprendre,
nous devons pouvoir diagnostiquer.

🔴 **Le diff PUBLIE, y compris les outils.** Les FAQ, compétences et sites vivent directement chez Meta :
les modifier, c'est déjà fait. Les connecteurs et outils, eux, vivent chez nous et doivent être publiés
chez Meta pour exister. Accepter un diff qui branche un outil le publie dans la foulée. Le client n'a pas à
connaître la différence entre ce qui vit chez Meta et ce qui vit chez nous : c'est notre tuyauterie.

### 2.5 L'Historique

**Un onglet dédié, dans le MBA ET dans chaque agent IA.** Julien : *« ça serait bien d'avoir un log des
décisions, aussi bien en + qu'en -, je pense qu'on peut créer un onglet dédié à ça aussi bien dans l'agent
IA que dans le MBA »*.

Il enregistre **toutes les modifications, quelle qu'en soit l'origine** : l'assistant ET les formulaires.
Un historique qui ignorerait les gestes d'écran mentirait par omission, et on y chercherait une cause qui
ne s'y trouve pas.

Chaque ligne porte : qui, quand, quoi, et **pour une suppression, le contenu effacé, recopié**. C'est notre
seule trace d'une FAQ supprimée par erreur, puisque Meta n'a pas de corbeille.

**Rétention : aucune.** Le volume est de quelques lignes par semaine et par espace. Une expiration
détruirait précisément ce pour quoi on tient l'historique.

🔴 **Ce n'est donc PAS `audit_log`, et la vérification a corrigé mon intention de départ.** Le journal
d'audit existe et conviendrait par sa forme (`action`, `target_kind`, `target_id`, `detail` jsonb,
`actor_email`), mais **il est purgé** : `PgAuditStore.purgeOlderThan` (`src/audit/store.pg.ts:138`), deux
ans par défaut, avec son index de balayage créé en 0097. Y ranger un historique annoncé « sans limite »
serait une promesse démentie par un `delete` écrit ailleurs. Table dédiée, non purgée : **migration 0144**.

⚠️ `audit_log` garde son rôle : il est la preuve d'une purge RGPD et de qui l'a demandée. Les deux
journaux coexistent et ne répondent pas à la même question.

---

## 3. Ce que l'assistant fait à l'ouverture

**Il dit ce qui manque et propose de le combler.** Il lit les onglets, annonce en une phrase ce qui est
réglé et ce qui ne l'est pas, et propose le premier trou. Le client peut l'ignorer et demander autre chose.

C'est le seul moment où quelqu'un apprend qu'un réglage obligatoire est vide. Le cas qui a motivé
`completion.ts` le dit assez : les compétences du MBA sont restées vides pendant que l'agent répondait à
tout le monde, et personne ne l'a vu parce qu'il fallait ouvrir l'onglet pour le découvrir.

**Les sites : l'assistant POSE la question, le client fournit l'adresse.** Décision de Julien :
*« c'est à l'user de dire quels sites il veut rajouter, mais l'assistant peut lui poser la question (doit
lui poser la question à un moment !) »*. L'assistant ne devine jamais une URL.

**Setup initial : la dernière question est la mise en service.** Quand tous les points sont couverts,
l'assistant demande « on met en prod ? » et la réponse positive publie.

---

## 4. Ce que l'assistant NE fait pas

| Geste | Pourquoi pas |
|---|---|
| **Retirer un agent du service** | Allumer oui, éteindre non. Julien : *« si tu veux retirer, tu débranches ton agent MBA en première page »*. Couper les réponses aux vrais clients dans la seconde ne se déclenche pas sur une phrase interprétée. |
| **Créer un connecteur ou une source** | Déclarer une source, c'est écrire une adresse réseau et un secret. L'assistant réécrit les MOTS d'un connecteur, il n'en crée jamais. La règle est déjà dans le code (`src/index.ts:1320`). |
| **Purger en lot** | Voir §2.3. |
| **Répondre au mode d'emploi** | La console a déjà un bot d'aide pour ça. Deux robots qui racontent le produit finiraient par en raconter deux versions. Hors périmètre : une phrase et un renvoi. |
| **Surveiller l'aspiration d'un site** | Il ajoute et il se tait. ⚠️ L'information n'est pas perdue : `completion.ts` compte déjà un site à zéro page comme non fait, donc l'annonce d'ouverture suivante le remonte. |
| **Lire les conversations pour suggérer des FAQ** | Reporté, délibérément (§10). |

🔴 **ET LA RÈGLE QUI SURPLOMBE TOUT : la conversation n'est JAMAIS le seul chemin d'édition.** Tout ce que
l'assistant sait faire reste faisable dans un onglet, à la main. C'est la leçon du « Create » d'OpenAI : le
jour où cet onglet a disparu, des GPT construits par la conversation sont devenus non modifiables. La
décision est déjà inscrite dans `src/http/agent-setup.ts:19` et elle ne bouge pas.

---

## 5. Le Meta Business Agent en particulier

**Tout vit chez Meta. Il n'y a aucun brouillon local, aucune copie, aucune corbeille.** Les routes existent
déjà (`src/http/mba.ts`) et couvrent le périmètre : `business-info`, `faq` (+ `preview`, `import`),
`skills`, `websites`, `files`, `allowlist`, `rollout`, `test`, `completion`.

**Les documents déposés dans la conversation partent chez Meta tels quels** (`POST /files`), sans extraction
ni découpage de notre côté. C'est le même objet que si le client l'avait déposé dans l'onglet Fichiers :
un seul endroit où il vit, rien à resynchroniser.

⚠️ **Asymétrie assumée avec l'agent IA**, où un document est au contraire extrait et découpé en fiches
(`src/agent/setup/piece-jointe.ts`). La raison est la destination : là-bas, la base de connaissance est la
nôtre et la recherche est la nôtre, donc le découpage nous appartient et il est obligatoire (un document
entier dans une fiche unique contient tous les mots du métier et rend la garde anti-hallucination
inopérante). Ici, l'index est celui de Meta.

**L'assistant vit dans un onglet** nommé Assistant, à côté des autres. Pas un panneau latéral : les écrans
sont déjà denses, et l'agent IA a déjà son onglet, donc le repère est le même des deux côtés.

**Après une modification, il propose d'essayer**, sans l'imposer : une phrase et un renvoi vers l'onglet
Tester. Il ne teste pas lui-même : cela ferait vraiment parler l'agent à chaque modification, donc
demanderait un numéro autorisé et produirait une dépense et un effet de bord à chaque fois.

---

## 6. Les agents IA en particulier

**Même moteur, périmètre plus large :** tout ce que l'entretien sert à construire (nom, rôle, ton,
consignes, escalade, base de connaissance, régime d'annonce IA, délai d'inactivité) **plus le branchement
des outils**.

Julien : *« il a pas la main pour créer des outils puisqu'il n'a que la liste d'outils déjà setuppés, donc
au pire il en débranche un, c'est pas si grave »*. Brancher ou débrancher agit sur le consentement du couple
(outil, consommateur), table `agent_tool_consommateurs` (migration 0127) : **la définition appartient à
l'espace, le consentement au couple**. L'assistant ne touche jamais à la définition.

**L'ossature de lecture existe déjà** : `agentSetup.etatCourant` (`src/index.ts:1294`) assemble label,
régime d'annonce IA, délai d'inactivité, fiche, outils maison, connecteurs déclarés, titres de connaissance
et sources de la bibliothèque. Il ne manque que l'autre moitié : proposer un diff et l'appliquer.

**Ce qu'il faut retirer :** la butée de `conversation.ts:138`. Un entretien complet ne doit plus se taire,
il doit basculer sur l'inventaire et attendre une demande.

---

## 7. Qui peut parler à l'assistant

**Les admins seulement.** Dans Engage Me, les écritures sont déjà réservées aux admins (RBAC). Un
collaborateur qui ne peut pas modifier le MBA au formulaire ne doit pas pouvoir le faire en le demandant
à un robot, sinon la conversation devient un contournement du contrôle d'accès.

⚠️ Corollaire de plomberie : `tenant_id = $1` sur chaque requête des nouvelles tables, comme partout. Le
pooler est en rôle superuser, la RLS est contournée, ce filtrage EST le contrôle.

---

## 8. Qui paie, et jusqu'où

🔴 **C'est NOUS, pour les deux assistants.** Décision de Julien, qui **aligne l'existant** : l'assistant de
construction d'agent IA tourne aujourd'hui sur `gateway`, le résolveur de clé par espace, donc sur le
**crédit prépayé du client** (`src/index.ts:1334`). Il bascule sur notre clé maison, comme le bot d'aide de
la console.

La raison est la même que pour le bot d'aide, et elle est déjà écrite dans le CLAUDE.md du dépôt : facturer
quelqu'un pour apprendre à se servir du produit se retourne contre nous. Un client ne comprendrait pas que
configurer son robot Meta soit offert et configurer son robot maison facturé.

**Plafond : 2 € par espace et par mois** (mois calendaire).

⚠️ **Par ESPACE, tous assistants confondus**, jamais par assistant. Un espace qui porte un MBA et trois
agents IA a un seul budget de 2 €, pas quatre. Un plafond par assistant multiplierait notre exposition par
le nombre d'agents, c'est-à-dire par le chiffre que le client contrôle lui-même.

Repère de calibrage : le modèle d'entretien en production est `zai/glm-4.7` et un tour revient à peu près à
un centime, soit environ 200 tours par mois. Un setup complet en demande une trentaine. 🔴 **Le plafond
d'équipe Vercel (100 $/mois) n'est PAS un garde-fou utilisable** : il couperait d'un coup tous les projets
du Gateway, les bots clients en production compris (Odalys, Hyundai, Gan Prévoyance, les deux Leadgen).
Vingt espaces à 2 € pèsent 40 € dessus, ce qui laisse la marge nécessaire à la traduction, à la
transcription et au bot d'aide.

**Au plafond, l'assistant le dit et les onglets restent utilisables** : « je ne peux plus vous répondre
jusqu'au mois prochain, tout reste modifiable dans les onglets ». Le client n'est jamais bloqué, seule la
conversation s'arrête, et nous apprenons qui tape le plafond. Pas de message d'indisponibilité générique :
faire passer une limite volontaire pour une panne se retourne contre nous le jour où ça se sait.

---

## 9. Ordre de livraison

**Le MBA d'abord, l'agent IA ensuite.**

C'est le manque le plus criant : l'agent IA a déjà son assistant de construction, le MBA n'a rien du tout.
Et c'est le cas le plus dur (tout vit chez Meta, aucun brouillon, aucune corbeille), donc le moteur commun
en sort éprouvé avant d'être réutilisé, plutôt que dessiné sur le cas facile puis repris.

L'onglet Historique se livre avec le MBA, et se réutilise tel quel pour l'agent IA.

---

## 10. Hors périmètre, et pourquoi

**L'assistant ne lit pas les conversations réelles pour proposer des FAQ.** L'idée est forte (« vos clients
demandent souvent vos horaires du dimanche, j'ajoute la réponse ? ») et elle ferait passer l'assistant
d'utile à indispensable. Elle est reportée : elle touche à de la donnée de contact, relève du centre de
Sécurité, et doublerait la taille d'un chantier qui fait déjà lire, proposer, appliquer et journaliser sur
deux surfaces. Elle aura son propre tour.

**Aucune fusion avec le bot d'aide de la console.** Les deux sont désormais sur notre clé, mais tout le
reste les sépare : **deux budgets distincts** (le bot d'aide n'a pas de plafond par espace, l'assistant en
a un), **deux niveaux d'accès** (le bot d'aide est ouvert à tout utilisateur connecté, l'assistant est
admin-only), **deux durées de vie de conversation**, et **deux périmètres** (l'un explique le produit,
l'autre le modifie). La fusion est un troisième chantier, pas un raccourci.

---

## 11. Table des décisions

| # | Décision | Raison en une ligne |
|---|---|---|
| 1 | Le grain est l'élément, pas le mode | Un élément vide démarre à zéro, un élément réglé se modifie ; l'onglet le montre |
| 2 | Inventaire à l'ouverture + relecture avant application | La relecture est le contrôle de concurrence, pas une optimisation |
| 3 | L'assistant lit les mêmes routes que les onglets | Il ne peut pas afficher un état que l'écran contredit |
| 4 | La couverture MBA dérive de `completion.ts` | Une seconde liste divergerait au premier ajout |
| 5 | Fil continu par surface, partagé entre admins | La conversation doit perdurer ; chaque message porte son auteur |
| 6 | Conservé ≠ envoyé au modèle | Un historique sans fin dans le contexte pousse la fiche courante hors fenêtre |
| 7 | L'acceptation du diff suffit | Une confirmation après acceptation apprend à cliquer sans lire |
| 8 | Suppression une à la fois, nommée | Aucune corbeille chez Meta |
| 9 | Un fichier déposé entre dans le diff | Sinon c'est le seul geste qu'on ne peut pas relire avant qu'il agisse |
| 10 | Arrêt à la première erreur, état exact rendu | Meta n'offre aucune transaction |
| 11 | Le diff publie, outils compris | Le client n'a pas à connaître notre tuyauterie |
| 12 | Onglet Historique, tout, avec le contenu supprimé | Seule trace d'un contenu que Meta ne garde pas |
| 13 | Rétention illimitée, table dédiée | `audit_log` est purgé à deux ans : y ranger ça serait une promesse démentie |
| 14 | Ouverture : il dit ce qui manque | Seul moment où un réglage vide se découvre |
| 15 | Les sites : il pose la question, le client répond | L'assistant ne devine jamais une URL |
| 16 | Setup initial : dernière question « on met en prod ? » | Et la réponse positive publie |
| 17 | Il allume, il n'éteint pas | Le retrait se fait en débranchant l'agent en première page |
| 18 | Documents MBA : chez Meta tels quels | Un seul endroit où le fichier vit |
| 19 | Crawl : il ajoute et se tait | `completion.ts` remonte déjà un site à zéro page |
| 20 | Admins seulement | Sinon la conversation contourne le contrôle d'accès |
| 21 | C'est nous qui payons, 2 €/espace/mois | Facturer l'apprentissage du produit se retourne contre nous |
| 22 | MBA d'abord | Le cas le plus dur éprouve le moteur commun |

---

## 12. Ce qui reste à décider dans le plan (pas dans la spec)

Ces points sont du ressort de l'implémentation et n'appellent pas d'arbitrage produit :

- le schéma exact de la migration 0144 (table d'historique) et de la table de conversation du MBA ;
- le découpage en tâches et l'ordre des tests ;
- le nom exact de la variable d'environnement du plafond et son défaut ;
- la forme du rendu du diff à l'écran (composant, pas décision).

🔴 **Et l'essai réel qui clôt la feature, qui doit être écrit dans le plan** (règle du CLAUDE.md global) :
sur le compte `+33 5 25 68 02 50`, demander à l'assistant une modification qui touche les trois natures
d'élément (un texte chez Meta, une suppression, un outil à publier), vérifier chez Meta que les trois sont
passées, vérifier les trois lignes d'historique, puis remettre l'état d'origine.
