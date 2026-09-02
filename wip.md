# WIP

> Ce fichier ne porte QUE le travail en cours. Un lot déployé en sort le jour même : son fonctionnel va dans
> [features.md](features.md), sa technique et ses gotchas dans [documentation.md](documentation.md) (section
> « Journal des lots livrés »), ce qui reste à faire dans [todo.md](todo.md).
>
> 🔴 **Vidé le 2026-08-29** : il faisait 1341 lignes et remontait à juillet. Trente-huit sections de lots
> déployés ont été déplacées dans `documentation.md`. Si ce fichier dépasse une centaine de lignes, c’est
> qu’on a recommencé à s’en servir comme d’une archive.
>
> ⚠️ **Re-vidé le 2026-08-31**, et la leçon est la même : le lot du 29 y était resté deux jours, et la moitié
> de ce qu’il affirmait était déjà PÉRIMÉE par la refonte du 31 (« six points à couvrir », « deux verrous »,
> « la conversation n’est pas persistée »). Un lot déployé qui traîne ici ne vieillit pas, il MENT.

## LIVRÉ le 2026-09-02 : le lot UX demandé par Julien (dix items), attribution des clics comprise

Julien a demandé dix choses d'un coup, plus deux questions. **Tout est livré.** Déployé par lots : le
connecteur API refondu (le gros morceau), le bug de défilement de l'inbox, le menu Contenu rangé par canal et
« tag » devenu « étiquette » (`74cd217`) ; la dernière saisie et « maintenant » dans les scénarios (`e9355e0`),
l'effacement d'une conversation tracé (`34f5edd`), « engagé » au mini-CRM (`d697b6f`), les deux journaux avec
leur recherche (`f0c2024`) ; enfin l'attribution des clics, WhatsApp (`8e787e1`) puis RCS (`1180083`,
`0d67cd2`).

Le détail technique, les pièges et la leçon de la clé mal choisie sont dans
[documentation.md](documentation.md) § Journal des lots livrés ; le fonctionnel dans [features.md](features.md).

🔴 **Ce que la 0106 avait mal fait, et qu'il ne faut pas re-tenter** : elle rattachait un lien RCS à la
bibliothèque `rcs_messages`. Or campagne et scénario portent leur message EMBARQUÉ, et seul l'envoi manuel
depuis l'inbox lit la bibliothèque. La 0107 re-clé sur `(tenant_id, destination)` et retire la colonne.

**Deux questions de Julien, répondues** : la relance automatique des échecs fonctionne toujours (elle traite
131049 et 131026, elle est gatée par le toggle ET par `HUBSPOT_SERVICE_URL`, et le verrou de run l'a même
améliorée) ; l'identifiant unique de contact existe déjà (`contacts.id`), il est meilleur que le téléphone
(qui change, et qui peut être absent), et le journal d'audit s'en sert déjà.

## LIVRÉ ET DÉPLOYÉ le 2026-09-02 : le connecteur API digne de ce nom

Constat de Julien : « selon les doc API que le user aura pour setuper ce connecteur tool, il ne pourra pas
faire grand chose avec ce qu'on lui propose là ». Vérifié dans le code, il avait raison sur toute la ligne :
`fetch(url, { method, headers })` **sans corps**, les paramètres ne remplissant qu'un gabarit de chemin, et
les variables limitées à `wa_id` et `nom` alors que dix champs personnalisés sont déclarés en production.

Six commits, migration 0105, 3386 tests + 417 e2e. Le détail technique et les pièges dans
[documentation.md](documentation.md) ; le fonctionnel dans [features.md](features.md).

**Trois défauts trouvés en construisant, dont deux par des tests qui visaient autre chose :**
- `.partial()` de zod ne retire pas les `.default()` : renommer une requête aurait **effacé toutes ses
  variables**, en silence ;
- une réponse mal formée **blanchissait** tout l'onglet Outils d'un agent (un `.map` sur `undefined`), y
  compris la liste des outils maison qui n'a rien à voir ;
- `requis` ne servait à rien : une variable dont la valeur est inconnue partait en `null` sans distinction.

**Et une erreur de méthode à moi** : j'ai poussé `deb71ed` après n'avoir lancé que le spec e2e des
connecteurs, alors que je touchais un onglet partagé. La CI est restée rouge une heure et quart sur huit
tests que la suite complète aurait montrés tout de suite.

## LIVRÉ ET DÉPLOYÉ dans la nuit du 2026-09-01 au 02 : les quatre items du contre-audit, puis trois de plus

Julien a demandé les quatre items retenus du contre-audit d'affilée, puis « le top 3 suivant de ce qui me
semble le plus important », sans m'arrêter. Tout est en production, chaque lot avec sa CI verte et sa
vérification à deux sens.

**Les quatre du contre-audit :** la cible de campagne en INTENTION (et le trou pré-existant de la liste vide,
qui envoyait à tout l'espace), la reprise après un plafond Meta (avec la qualité qui ne repart JAMAIS seule),
les SLO écrits AVANT toute mesure plus l'âge du plus vieux job, et la liste des scénarios qui ne transporte
plus les graphes.

**Les trois que j'ai choisis ensuite, par ordre de gravité réelle :**
1. **Le tour d'avance réservé AVANT les envois** (migration 0104). Le trou le plus cher du produit : deux
   avances concurrentes envoyaient toutes les deux, et un client recevait un message qu'il ne devait jamais
   voir. Documenté dans le code depuis des semaines, fermé maintenant.
2. **L'équité RENDUE VISIBLE** dans `/ops`. C'était l'angle mort que mon propre document de SLO signalait sur
   lui-même la veille : une dette qu'on vient d'écrire se paie tout de suite.
3. **Voir et rejouer les jobs MORTS.** Un `webhook` mort est un message de client jamais traité, et c'est
   silencieux. On alertait, on ne pouvait rien reprendre.

🔴 **Ce qui n'est PAS fait et qu'il ne faut pas croire fait** : aucun profil de banc n'a encore TOURNÉ contre
les seuils de SLO (ils sont écrits et instrumentés, pas éprouvés) ; le grant OAuth 2.1 du MCP reste un lot à
part ; le passage à deux workers reste bloqué par la checklist de `todo.md`.

## LIVRÉ ET DÉPLOYÉ le 2026-09-01 : le lot UX + le serveur MCP

Les six points de la liste de Julien ([docs/LOT-UX-ET-MCP-2026-09-01.md](docs/LOT-UX-ET-MCP-2026-09-01.md))
sont livrés en quatre briques. Le fonctionnel est dans [features.md](features.md), la technique dans
[documentation.md](documentation.md), ce qui reste dans [todo.md](todo.md).

**Ce qu'il faut retenir avant de toucher à ces zones :**

- La reconnaissance a invalidé DEUX suppositions du cadrage, et c'est le vrai enseignement du lot. (1) Le
  groupe « AI Agent » existait déjà mais PLAT, la période du quali existait déjà : lire le code avant de
  chiffrer a évité de refaire ce qui était fait. (2) L'origine d'un message de service n'était PAS
  dérivable, contrairement à ce que le document affirmait, parce que scénario et agent IA écrivent la même
  ligne. Une supposition écrite dans un cadrage n'est pas un constat.
- `/v1` ne compte que quatre endpoints et AUCUNE lecture. « MCP = façade mince sur /v1 » était donc faux :
  la règle retenue est qu'un outil MCP appelle la fonction que la route de console appelle, ce qui a fait
  extraire `src/inbox/repondre.ts`, partagé par les deux.
- ⚠️ **Ce qui n'est PAS prouvé en production** : un `tools/call` authentifié. Le chemin public est vérifié
  jusqu'au 401 (donc rewrite Next, route et preHandler sont vivants) ; exécuter un outil demande une vraie
  clé d'API, à créer depuis la console.
- **Le grant OAuth 2.1 délégué n'est PAS fait** : l'accès MCP passe par une clé d'API à scopes. Le scénario
  `claude mcp add` + fenêtre de login + choix d'espace + révocation par utilisateur est un lot à lui seul,
  décrit dans [todo.md](todo.md).

## HISTORIQUE : rien d'autre en cours

**Les DEUX programmes sont terminés le 2026-09-01.** Le programme I (sept lots) et le programme II (huit
lots, dont le 8e volontairement incomplet et arbitré item par item). Détail, mesures et pièges de chacun dans
[documentation.md](documentation.md) § Journal des lots livrés ; l'état lot par lot dans [PLAN.md](PLAN.md).

**Ce qui reste ouvert, et qui n'est pas dans un lot** : le test de charge et de reprise après kill (une
session à lui seul, il validerait les lots 3 à 6 sous charge réelle), les cinq items du niveau B qui attendent
la décision d'un second worker, et les jaunes restants de la §7 de l'audit du 25 août.

## EN PAUSE : le bloc agent IA (lots L0 et L1)

Le plan, l’état tâche par tâche et le **registre des dettes** vivent dans
[AGENT-IA-PLAN-L0-L1.md](AGENT-IA-PLAN-L0-L1.md). **D1, D2, D3, D4 et D6 sont fermées**. Reste **D5** (les
blocs agent invisibles d’Analytics).
