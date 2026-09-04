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

## LIVRÉ ET DÉPLOYÉ le 2026-09-03 au soir : le contre-CONTRE-rapport, sur les correctifs du jour

**Rien n'est en cours.** Commits `a191a44`, `39bdb82`, `9ffc19c`, CI verte sur les trois jobs. La migration
**0113 est appliquée** (image construite d'abord, index vérifié en base : l'ancien retiré, le nouveau couvre
le prédicat réel). Le tri des quatre constats, plus les deux angles morts trouvés en propre, est dans
[todo.md](todo.md) ; les généralisations sont dans [documentation.md](documentation.md) et
[CLAUDE.md](CLAUDE.md).

🔴 **Ce que ce lot dit de la veille : quatre des six défauts fermés ce soir avaient été introduits le matin
même.** Le motif commun est écrit dans le CLAUDE.md sous « élargir le domaine d'une réparation sans élargir
ce qu'elle transporte ». Le corollaire de méthode compte autant : pour la troisième fois de la semaine, ce
qui traverse un câblage échappait aux tests.

⚠️ **Ce que ce lot ne corrige PAS, et c'est un arbitrage** : l'escalade humaine garde son ancienne transition.
Poser la marque y dégraderait le cas le plus probable. La raison est écrite dans `src/agent/escalade.ts`.

## LIVRÉ ET DÉPLOYÉ le 2026-09-03 : le contre-rapport de ChatGPT sur les livraisons du jour

**Rien n'est en cours.** Trois commits déployés (`c3938ad`, `d59a184`, `2300a1b`), CI verte sur les trois jobs
(`integration` compris, ce qui comptait : ce lot modifie du SQL brut qui n'avait aucune couverture avant).
**Aucune migration**, vérifié : il change le moment où `tour_commence_le` est effacée, pas le schéma.

Le tri des huit constats est dans [todo.md](todo.md), les gotchas dans
[documentation.md](documentation.md), et les deux règles générales dans [CLAUDE.md](CLAUDE.md).

⚠️ **Un 502 public d'une minute au redéploiement**, et il valait sa leçon : NPM tenait l'ANCIENNE IP du
conteneur recréé. `docker network connect` ne répare pas ça, il faut recharger nginx. Le diagnostic
(comparer l'appel interne et l'appel public) est dans [DEPLOY.md](DEPLOY.md).

⚠️ **Ce qui n'est PAS dans ce lot, et qui est un choix** : les deux réglages de campagne
(`CAMPAIGN_RUN_CONCURRENCY`, `CAMPAIGN_RUN_MAX_MS`) ne sont pas touchés. L'arithmétique dit qu'ils rendent le
SLO 3 intenable au-delà d'une quinzaine de campagnes longues simultanées, mais les deux leviers ont un coût
non mesuré, et la charge réelle d'aujourd'hui est de six jobs sur sept jours. L'enveloppe est écrite dans
`docs/SLO-2026-09-01.md`, le retriage attend le profil de banc `equite`.

## LIVRÉ le 2026-09-03 : le renommage en Engage Me et la bascule du front sur Vercel

**Rien n'est en cours.** L'architecture et les règles vivent dans [documentation.md](documentation.md) et
[CLAUDE.md](CLAUDE.md) ; le journal d'exécution pas à pas est dans
[docs/PLAN-BASCULE-VERCEL-2026-09-03.md](docs/PLAN-BASCULE-VERCEL-2026-09-03.md).

Ce qui a été fait : le produit s'appelle Engage Me ; la console est servie par Vercel sur
`engageme.messagingme.app` ; l'API répond sous son propre nom `api.messagingme.app`, ce qui rendra le
déménagement vers Scaleway gratuit ; `mba.messagingme.app` garde toutes les adresses déjà distribuées.

Trois choses trouvées en chemin et qui valaient le détour :
- l'API était **déjà** joignable depuis Internet (le rewrite Next est un attrape-tout) : le nouveau nom
  n'ouvre rien, il rend les adresses devinables. D'où les durcissements faits avant d'ouvrir ;
- un conteneur de **front** était sur le chemin critique de réception des messages clients ;
- `APP_URL` faisait deux métiers et n'était en fait **posée nulle part**, le code vivait sur son défaut.

**Ce qui reste, et c'est facultatif** : éteindre `mba-web` et faire de `mba.messagingme.app/` une redirection
vers `engageme`. Rien ne presse, le laisser tourner ne coûte presque rien et garde une porte de sortie.

⚠️ **À faire par Julien quand il y pensera** : ajouter `engageme.messagingme.app` aux domaines autorisés de
l'app Meta (Connexion Facebook). Ça ne bloque que l'écran qui connecte un NOUVEAU numéro WhatsApp. Google est
déjà fait.

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

🔴 **Ce qui reste ouvert est dans `todo.md`.** Les DEUX points IA sont faits (A2 puis A1, ci-dessous) ;
reste A3 (les bornes de sécurité des connecteurs HTTP) et A4 (la preuve de capacité).

## LIVRÉ le 2026-09-03 : A4, la preuve de capacité

**Fait** : la photo de `/ops` compte les jobs `active` (elle retombait à zéro sur un job coincé, ce qui rendait
fausse l'affirmation « plus sévère que le p95 » du document de SLO) ; un VRAI p95 par file sur 24 h, calculé
depuis les horodatages que pg-boss écrivait déjà, affiché dans une carte séparée pour qu'on cesse de confondre
la photo et l'historique ; le banc agent a un mode DURÉE avec découpe par minute, parce qu'une rafale plus
courte que la fenêtre d'un plafond tient toujours.

🔴 **La mesure a trouvé un mur que personne n'avait vu** : `webhook-status` se vidait à DEUX jobs par minute,
soit 125 heures pour les 15 000 accusés d'une campagne de 5 000. Corrigé (`burstWhenReadyExceeds`). Et le
premier chiffre réel du SLO entrant : **p95 de 8,7 s** contre 30 s visés.

**Le banc a tourné six minutes** sur le VPS : 1 406 tours, 738 000 tokens/minute, **zéro refus**, et aucune
dérive (la durée moyenne DESCEND, 1 445 ms à la première minute contre 1 217 ms à la sixième). Une rafale de
dix secondes ne pouvait pas le dire : plus courte que la fenêtre d'un plafond, elle tient toujours. La mesure
longue a aussi montré la QUEUE : 113 s pour le tour le plus lent contre 2,4 s de médiane, soit 0,14 % des
tours au-dessus de 30 s, c'est-à-dire exactement ce que l'échéance de production coupe.

**Reste du point 2** : le profil `equite` du banc de charge, seul item encore ouvert (il exige un Postgres
jetable ET un worker en face, sinon il mesure une file morte).

## LIVRÉ le 2026-09-03 : les lots B et C de l'audit externe

Vérifiés un par un DANS LE CODE avec contre-vérification adverse, parce que le lot immédiat de la veille en
avait déjà fermé une partie : **B2, B3 et B5 étaient clos**, et **C4 est refusé** (les mesures ne justifient
pas le découpage, et le dépôt l'avait déjà refusé nommément le 2026-08-31).

- **B4** : le chemin « tous les contacts » résout et FIGE son jeu d'identifiants, borné, au lieu de compter
  puis recharger sans borne. ⚠️ La contre-vérification a trouvé le trou que mon propre correctif laissait :
  le câblage relayait deux paramètres vers un contrat qui en déclare trois, donc la borne était avalée en
  silence. Le compilateur ne peut pas le voir. Gardé par un test qui lit la source.
- **C2** : l'infobulle « vous avez la main » promettait à l'opérateur, **dans le produit**, que les campagnes
  n'enverraient pas. C'est l'inverse du code, qui reprend la main délibérément.
- **C3** : deux textes faux sur l'attribution des clics, dont un dans l'en-tête d'une migration.
- **B1** : le contexte (parcours, run, canal) traverse enfin jusqu'au journal des échecs. Trois autres points
  de B1 restent ouverts par CHOIX, avec la raison écrite dans `todo.md`.
- **C1** : les onze capacités du moteur de campagne voyagent en bloc au lieu d'être recopiées une par une.
  C'est ce désalignement qui avait cassé toutes les campagnes à lien tracé le 2026-09-02.
- Au passage, le seul défaut vivant que C4 recouvrait : deux balayages sur vingt-deux journalisaient leur
  échec sans ALERTER, donc une panne y restait invisible.

## LIVRÉ le 2026-09-03 : A3, les deux bornes de sécurité des appels sortants

Une URL saisie par un client était contrôlée sur son TEXTE seulement : `crm.exemple.fr` dont l'enregistrement
A pointe vers le réseau Docker du VPS passait toutes les gardes. Et le corps de la réponse était chargé
entièrement en mémoire avant d'être mesuré, en unités UTF-16 plutôt qu'en octets.

Les deux bornes sont posées sur les QUATRE chemins qui appellent une adresse client (trois à l'origine,
l'épreuve d'une SOURCE manquait) : le connecteur en
conversation, le bouton « Test » d'une REQUÊTE, le bouton « éprouver » une SOURCE, et la lecture de page
distante à chaque saut de redirection. ⚠️ Seule la borne de RÉSOLUTION vaut pour les quatre : l'épreuve d'une
source ne lit aucun corps, donc la lecture bornée ne concerne que les trois autres.

⚠️ **Le « DNS rebinding » n'est PAS fermé** et c'est écrit noir sur blanc dans `todo.md` : `fetch` refait sa
propre résolution après la nôtre. Le fermer demande un résolveur maison via une dépendance de plus, pour un
scénario qui suppose un administrateur client hostile. Le cas réaliste est fermé.

## LIVRÉ le 2026-09-03 : A1, un tour d'agent tué par un crash ne se perd plus

`prendreLeTour` incrémente `tours` avant le travail (c'est ce qui rend le verrou optimiste atomique). Un
worker qui meurt entre les deux faisait rejouer le job avec l'ancien numéro : la réservation rendait `null`,
le rejeu était classé « doublon », et le tour disparaissait avec la session bloquée en `en_cours` et le run
en attente sans échéance. Le contact n'avait jamais de réponse, et rien au monde ne le réveillait.

Un balayage à la minute réclame et clôt en UNE requête les tours en vol depuis plus de QUINZE minutes (dix à
l'origine, corrigé le 2026-09-03), puis fait
sortir le parcours par la sortie RÉELLEMENT DUE (« branche d'échec en dur » jusqu'au 2026-09-03, ce qui était
juste tant que le balayage ne réclamait que des sessions `en_cours`). **On ne rejoue pas** : le
worker a pu mourir APRÈS l'envoi, et rien en base ne permet de le savoir.

⚠️ **Le piège était le faux positif.** « Session en cours + run en attente + aucune échéance » décrit aussi,
mot pour mot, un tour qui vient d'être enfilé et attend son passage dans la file. Il a donc fallu dater le
début du tour (migration 0112, colonne `tour_commence_le`), et surtout l'EFFACER sur les deux sorties qui
laissent la session vivante, sans quoi le balayage aurait tué des conversations parfaitement saines dix
minutes après une réponse réussie. Les deux sens sont testés.

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
