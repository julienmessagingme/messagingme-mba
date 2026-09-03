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

## LIVRÉ ET DÉPLOYÉ le 2026-09-02 au soir : les sept lots du plan post-audit, le chantier IA, la vectorisation

**Rien n'est en cours.** Tout ce qui suit est en production. Le détail technique et les pièges sont dans
[documentation.md](documentation.md) § Journal des lots livrés, le fonctionnel dans
[features.md](features.md), et ce qui reste dans [todo.md](todo.md).

Trois blocs dans la soirée :

1. **Les sept lots du plan post-audit** (bail d'avance renouvelé, défilement de l'inbox, plafond de campagne à
   20 000, panne d'avance visible, deux affirmations retirées, concurrence des files, pool visible).
2. **Le chantier IA** : lecture du champ de cache, mesure d'un tour réel (2 allers-retours, 3 s, ~0,00026 $),
   et mesure de la limite du Gateway (aucun 429 jusqu'à 1,2 M tokens/minute).
3. **La vectorisation de la base de connaissance** (migrations 0110-0111), puis les six corrections du lot
   immédiat de l'audit externe qui a suivi.

🔴 **Ce qui reste ouvert est dans `todo.md`.** Le premier des deux points IA est FAIT (voir ci-dessous) ;
reste **A1**, le tour d'agent tué par un crash, perdu pour toujours avec sa session bloquée en `en_cours`.

## LIVRÉ le 2026-09-03 : A2, les effets s'arrêtent quand le tour d'avance est perdu

Le lot 1 de la veille rendait la perte du tour VISIBLE sans rien ARRÊTER : `perdu()` n'écrivait qu'une ligne
de log, et le porteur déchu finissait sa liste d'envois pendant que le nouveau faisait la sienne. Le jeton
clôture l'écriture d'ÉTAT, il n'a jamais rien pu contre un message déjà remis à Meta.

Trois points de contrôle, parce qu'il y a trois chemins d'effets et pas un seul : `apply` (avant CHAQUE
effet, pas une fois à l'entrée), l'envoi RCS en ligne de `walkResolved` (qui part AVANT que `apply` ne voie
quoi que ce soit), et l'enfilement d'un tour d'agent, qui commande un appel modèle facturé. Plus une durée
totale maximale de dix minutes, pour l'avance PENDUE : un minuteur renouvelle un bail aussi fidèlement pour
une promesse morte que pour un envoi en cours.

Chacune des trois gardes a été vérifiée DANS LES DEUX SENS (neutralisée, test rouge, restaurée, test vert) :
sans elles, trois messages au lieu d'un, un RCS de trop, un tour d'agent de trop.

⚠️ **Volontairement non fait** : l'`AbortSignal` est exposé mais aucun transport ne l'écoute. Détail et raison
dans `todo.md`.

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

## HISTORIQUE : rien d'autre en cours

**Les DEUX programmes sont terminés le 2026-09-01.** Le programme I (sept lots) et le programme II (huit
lots, dont le 8e volontairement incomplet et arbitré item par item). Détail, mesures et pièges de chacun dans
[documentation.md](documentation.md) § Journal des lots livrés ; l'état lot par lot dans [PLAN.md](PLAN.md).

**Les lots des 1er et 2 septembre en sont sortis le 2026-09-02** (connecteur API refondu, quatre items du
contre-audit puis trois de plus, lot UX + serveur MCP) : ils étaient DÉPLOYÉS et leur détail était déjà dans le
journal de `documentation.md`. Les garder ici en doublon, c'était la dérive que ce fichier s'interdit deux fois
en tête.

**Ce qui reste ouvert, et qui n'est pas dans un lot** : le test de charge et de reprise après kill (une
session à lui seul, il validerait les lots 3 à 6 sous charge réelle), les cinq items du niveau B qui attendent
la décision d'un second worker, et les jaunes restants de la §7 de l'audit du 25 août.

🔴 **Ce qui n'est PAS fait et qu'il ne faut pas croire fait** : aucun profil de banc n'a encore TOURNÉ contre
les seuils de SLO (ils sont écrits et instrumentés, pas éprouvés) ; le grant OAuth 2.1 du MCP reste un lot à
part ; un `tools/call` MCP AUTHENTIFIÉ n'est pas prouvé en production (le chemin public l'est jusqu'au 401) ;
le passage à deux workers reste bloqué par la checklist de `todo.md`.

## EN PAUSE : le bloc agent IA (lots L0 et L1)

Le plan, l’état tâche par tâche et le **registre des dettes** vivent dans
[AGENT-IA-PLAN-L0-L1.md](AGENT-IA-PLAN-L0-L1.md). **D1, D2, D3, D4 et D6 sont fermées**. Reste **D5** (les
blocs agent invisibles d’Analytics).
