# Le centre d'aide de Messaging Me : conception

Date : 2026-10-20. Cadrage mené avec Julien en trois rondes de questions, puis sur une maquette d'une page (« Lancer
une campagne »), dont il a validé la forme. Ce document dit ce qu'il a décidé, ce que j'ai tranché à sa place (marqué
**mon choix**), et ce qui reste au constructeur.

## Intention

Messaging Me n'a aujourd'hui aucun mode opératoire lisible par un humain hors de la console. Les 31 fiches de
`docs/aide/fiches/` existent, mais seul le bot d'aide de la console les lit. Le guide « Votre compte Meta Business,
pas à pas » (`/developpeurs/compte-meta-business/`) est la seule page de la vitrine qui explique un geste.

Julien veut des modes opératoires et des vidéos qui montrent comment on fait. Deux raisons, dans ses mots
(réponses du cadrage) : **pour vendre** (un prospect voit que c'est simple avant de s'inscrire), et **avant
l'ouverture large** (un nouveau client doit pouvoir démarrer seul, sans nous appeler).

## Pour qui

- **Les clients de la console** : le marketing, le service client, qui travaillent à l'écran.
- **Les développeurs et Claude Code** : ceux qui pilotent Messaging Me depuis leur assistant, par le plugin et le
  serveur MCP.

## Objectifs

1. Un **centre d'aide public** sur la vitrine, à `app.messagingme.fr/aide/`, une page par geste.
2. Un lien **« Comment faire »** sur chaque écran de la console qui a sa page d'aide.
3. Des **pages « Depuis Claude Code »** dans la doc développeurs de la vitrine (`/developpeurs/`), sur le même
   gabarit.
4. Une **vidéo courte** sur les pages qui montrent un geste.
5. **Une seule source** pour le texte : la fiche d'aide. Le bot de la console et la page publique disent la même
   chose, parce qu'ils lisent le même fichier.

## Non-objectifs

- Couvrir les 31 fiches d'un coup. La première vague est bornée ci-dessous.
- Un outil de documentation externe (GitBook, Intercom, Notion). La vitrine reste du HTML statique généré par nos
  scripts.
- Refaire le bot d'aide de la console. Il continue de lire les fiches en base ; seul change le morceau qu'il en
  reçoit (voir « Le bot d'aide »).

## Anti-objectifs (ce qui ferait échouer le projet même s'il marche)

- **Deux textes qui divergent.** Une page publique qui dit autre chose que le bot, ou que la console. C'est la raison
  de la source unique.
- **Une page qui ment sur l'écran.** Une capture ou une étape qui ne correspond plus à la console après une refonte.
- **Une donnée réelle à l'écran.** Un vrai client, un vrai numéro, une vraie conversation dans une capture ou une
  vidéo.
- **Une page qui vend au lieu d'expliquer.** Le ton est celui du mode d'emploi : ce qu'on fait, dans quel ordre, ce
  qui peut bloquer. La vitrine vend ailleurs.

## Ce que Julien a décidé

| Question | Sa réponse |
|---|---|
| Pour qui | Les clients de la console, et les développeurs avec Claude Code |
| Pourquoi | Pour vendre, et avant l'ouverture large |
| Où | Dans la console (un « Comment faire » par écran) et dans un centre d'aide public |
| Source | Une seule : les fiches d'aide existantes |
| Adresse | Sur la vitrine, `/aide/` |
| Première vague | Démarrer, Parler aux clients, et Depuis Claude Code |
| Les pages du centre | Console seulement ; « Depuis Claude Code » va dans la doc développeurs, à part |
| Vidéos | Un mélange : une introduction animée courte, puis la vraie console |
| Son | « sous titre seul, pas de musique » |
| Tournage | Sur un espace de démo propre (marque fictive, faux contacts) |
| Gabarit | Celui de la maquette « Lancer une campagne », validé tel quel |
| Anglais | Dès la première vague : une version anglaise de chaque fiche publique, captures et films compris |
| Bot d'aide | Corrigé dans ce chantier : les fiches découpées par étape au chargement |
| Accès depuis la vitrine | « Aide » dans le menu du haut, plus un lien en pied de page |
| Bas de page | « Une question sans réponse ? Écrivez-nous » à la place du vote Oui / Non |

## Le gabarit d'une page (validé sur maquette)

La maquette est dans le scratchpad de la session (`maquette-aide/main.html`). Elle reprend l'en-tête, le pied et la
feuille de style de la vitrine. De haut en bas :

1. **Le fil d'Ariane** (Aide › rubrique › page) et le **titre**, avec la mention « Aide » en surtitre.
2. **Le chapeau** : ce que fait ce geste, en deux phrases.
3. **Deux boutons** : l'un ouvre l'écran concerné dans la console, l'autre mène au prérequis (par exemple « Faire
   approuver un modèle d'abord »).
4. **À gauche, le menu du centre d'aide**, par rubrique, avec la page courante en surbrillance, et une recherche en
   tête. Au téléphone, le menu passe au-dessus du contenu.
5. **La vidéo**, 16:9, avec son affiche. Sous elle, une légende qui dit sa durée et qu'elle est sans son.
6. **Les étapes**, numérotées, chacune avec sa capture d'écran à côté (en dessous au téléphone). Une étape montre
   d'abord ce qu'on fait, en deux ou trois lignes comme dans la maquette ; le reste de ce que la fiche en dit est
   juste dessous, replié sous « En détail » (voir « Une seule source »).
7. **Un encadré « Bon à savoir »** quand la fiche en porte un.
8. **La page précédente et la suivante** dans la rubrique.

Une page sans vidéo (concept, ou vidéo pas encore tournée) s'affiche sans le bloc vidéo, sans trou.

À la place du « Cette page vous a aidé ? Oui / Non » de la maquette, le bas de page porte « Une question sans
réponse ? Écrivez-nous », qui mène au formulaire de contact de la vitrine (`/contact/`) avec le nom de la page.
Rien à construire côté serveur.

## La première vague

**Le centre d'aide s'adresse aux clients du Pro.** L'offre Free n'ouvre pas la console : elle se pilote par l'API et
le MCP (`src/offres/offres.ts`, fonction `console`). Chaque page de la console dit donc l'offre qu'elle demande, et
« Choisir mon offre » (l'essai Pro de 14 jours compris) entre dans « Démarrer » (**mon choix**). Les pages Claude
Code, elles, valent pour toutes les offres.

**Centre d'aide, rubrique « Démarrer »** :
- Choisir mon offre (`choisir-mon-offre`)
- Ce qu'il faut chez Meta (`ce-qu-il-faut-chez-meta`)
- Connecter mon numéro WhatsApp (`connecter-mon-numero-whatsapp`)
- Me repérer dans la console (`me-reperer-dans-la-console`)

**Centre d'aide, rubrique « Parler aux clients »** :
- Répondre dans l'Inbox (`repondre-dans-l-inbox`)
- La fenêtre de 24 heures (`la-fenetre-de-24-heures`)
- Faire approuver un modèle (`faire-approuver-un-modele`)
- Importer mes contacts (`importer-mes-contacts`), **mon choix** : l'étape 4 d'une campagne suppose des contacts, la
  rubrique serait bancale sans elle.
- Lancer une campagne (`lancer-une-campagne`)

**Doc développeurs, « Depuis Claude Code »**, **mon choix** pour la liste (Julien a choisi la rubrique, pas les
pages) :
- Installer le plugin et relier son espace
- Connecter son numéro WhatsApp depuis Claude
- Répondre à une conversation
- Préparer et lancer une campagne (le récapitulatif, puis le code de confirmation)

Les rubriques suivantes (Automatiser, Mesurer, Gérer son équipe) viennent en vagues suivantes, sur le même gabarit.
La première vague doit rendre leur ajout mécanique : une fiche marquée publique, ses captures, et la génération.

## Une seule source : la fiche

**La page publique est générée depuis la fiche**, comme le guide Meta est généré depuis
`web/lib/partage/etapes-meta.ts`. On ne réécrit pas le texte dans la page : un générateur de `scripts/vitrine/` lit
la fiche et écrit la page entre des marques, et un test exige que chaque page soit égale à sa génération (même
mécanisme que `tests/vitrine-guide-meta.test.ts`).

Ce que la fiche doit porter en plus, dans son en-tête (**mon choix** pour la forme, le constructeur peut la changer
si `tests/aide-fiches-format.test.ts` l'impose autrement) : qu'elle est publique, sa rubrique, son rang dans la
rubrique, ses captures (une par étape), sa vidéo s'il y en a une, et si elle est la page « Comment faire » de son
écran.

**Les fiches de la première vague sont relues pour être lisibles par un humain**, et c'est le gros du travail. Elles
ont été écrites pour le bot : denses, exhaustives, sans respiration. La relecture les met en étapes numérotées quand
c'est un geste, sort les mises en garde en paragraphes « Bon à savoir », et resserre. Elle ne retire rien dont le bot
a besoin pour répondre juste : ce qui est vrai et utile reste, ce qui est redit disparaît.

**Deux niveaux par étape, tirés de la même fiche** (**mon choix**, pour tenir à la fois la source unique et la
maquette validée). Chaque étape de la fiche commence par ce qu'on fait, en deux ou trois lignes : c'est ce que la page
affiche à côté de la capture. La suite de l'étape, dans la fiche, est ce que la page replie sous « En détail ». Rien
n'est écrit deux fois, et la page reste courte à l'œil.

**Une fiche trop large se scinde.** « Connecter mon numéro WhatsApp » mêle le geste (relier le numéro) et de la
référence (HubSpot, canaux et services, abonnement au numéro, déconnexion). La première vague garde le geste dans sa
fiche ; la référence part dans des fiches à elle, que les vagues suivantes publieront. Le bot y gagne aussi : des
fiches plus courtes.

Trois contraintes qui viennent de l'existant :
- Une fiche porte l'empreinte de la section de `features.md` qu'elle résume. Toute retouche passe par
  `tests/aide-proposer.test.ts`, la fiche et son empreinte dans le même commit (règle du `CLAUDE.md` du dépôt).
- Une fiche modifiée ne parvient au bot qu'après `npm run aide:charger` sur la production (`DEPLOY.md`). Sans ce
  chargement, la page publique et le bot divergent : c'est exactement l'anti-objectif n° 1.
- Le dépôt est public : une fiche ne doit rien contenir qui ne puisse pas être lu de tous. Elle devient en plus une
  page indexée.

## Les pages « Depuis Claude Code »

Même gabarit, sous `/developpeurs/` (et leur jumelle sous `/en/developers/`). Le menu de gauche liste les pages
développeurs (le guide Meta compris), pas le centre d'aide.

**Leur source** : un fichier bilingue de `scripts/`, sur le modèle de la FAQ du plugin (`scripts/plugin/faq.ts`),
qui donne chaque texte en `{ fr, en }`. Chaque étape nomme les outils MCP qu'elle fait appeler, et un test vérifie
que ces noms existent dans le catalogue des outils (`src/mcp/`), comme le fait déjà `tests/vitrine-developpeurs.test.ts`
pour les outils cités sur la vitrine. Une étape montre ce qu'on dit à Claude et ce qu'il répond, jamais une
commande inventée.

Leur vidéo suit la règle des films de cas d'usage : une vraie fenêtre Claude Code, avec les outils et les réponses
relevés dans `src/mcp/`, le téléphone WhatsApp à côté. Le film du démarrage (`cas-onboarding`) sert déjà la
première page.

## Dans la console : « Comment faire »

Sur chaque écran qui a une page d'aide publiée, un lien **« Comment faire »** dans l'en-tête de l'écran, à côté du
titre. Il ouvre la page publique dans un nouvel onglet, dans la langue de la console.

- **Un écran, un lien.** Plusieurs fiches peuvent parler du même écran (`templates` en a deux, `inbox` deux) : une
  seule est marquée comme la page de l'écran. Un test refuse deux pages pour un même écran.
- **La correspondance écran vers page est générée**, pas écrite à la main dans `web/` : le générateur du centre
  d'aide écrit un petit fichier que la console importe, et un test vérifie que chaque page visée existe dans `site/`.
- **Un écran sans page n'a pas de lien.** Pas de lien vers une page qui n'existe pas encore.
- Le lien suit les règles de la console : icône de la famille commune (`tests/web-icones.test.ts`), vouvoiement
  (`tests/web-vouvoiement.test.ts`).
- **Ordre de publication** : la page publique part avant ou avec le lien qui la vise, jamais après.

## Le bot d'aide : il lit enfin la bonne étape

Aujourd'hui le bot ne reçoit que les 2 000 premiers caractères de chaque fiche (`CORPS_MAX`, `src/aide/repondre.ts`)
alors que la recherche les lit entières : sur « Lancer une campagne », il ne voit que les étapes 1 et 2. La promesse
« le bot et la page disent la même chose » serait fausse dès la première page. Décision de Julien : on le corrige ici,
en **découpant les fiches par étape au chargement** (`db/charger-aide.ts`).

- Chaque étape d'une fiche, et chaque « Bon à savoir », devient un morceau que la recherche retrouve seul. Le bot
  reçoit les morceaux qui répondent à la question, chacun entier. Une fiche sans étapes (les vagues suivantes) se
  découpe par paragraphes, sous la même borne de taille.
- Le bot cite toujours le titre de la fiche, comme aujourd'hui.
- Le coût d'une réponse ne monte pas : on envoie des morceaux justes au lieu de débuts tronqués. Le bot reste sur
  notre clé, sous son plafond actuel.
- **C'est un chemin de production.** Si le découpage demande une migration, elle passe avant le code qui la lit,
  puis `npm run aide:charger` recharge les fiches sur la production après le déploiement.
- Le bot garde les fiches françaises ; la version anglaise d'une fiche ne sert qu'à la page anglaise.
- **Mon choix** : il ne renvoie pas encore vers les pages publiques ; ce sera un petit lot à part une fois le centre
  en place.

## Les vidéos

- **Où elles naissent** : dans l'atelier `~/engageme-motion`, un dossier par film, avec son `SCRIPT.md`, comme les
  films existants (lire son `CLAUDE.md` avant).
- **Leur forme** : environ 5 secondes d'introduction animée (le titre du geste, dans la charte des films Messaging Me),
  puis la vraie console, geste par geste. **Mon choix** : la console est filmée à partir de vraies captures de
  l'espace de démo, animées dans l'atelier (curseur, zoom sur la zone utile), plutôt qu'un enregistrement d'écran en
  direct : elle se refait à l'identique quand l'écran change, et elle garde la qualité des films actuels.
- **Sous-titres incrustés, aucune piste son.** La chaîne de l'atelier ajoute d'ordinaire une bande-son synthétisée :
  pas ici.
- **Durée** : autour d'une minute, une minute trente au plus.
- **Formats** : 16:9 seulement (**mon choix** : une page d'aide se lit au bureau ; au téléphone le 16:9 se lit en
  largeur), une version française et une version anglaise, comme tous les films de la vitrine.
- **Quelles pages en ont une** (**mon choix**) : celles qui montrent un geste dans la console (Connecter mon numéro,
  Me repérer, Répondre dans l'Inbox, Faire approuver un modèle, Importer mes contacts, Lancer une campagne) et les
  quatre pages Claude Code. Pas les deux pages de notion (la fenêtre de 24 heures, ce qu'il faut chez Meta, qui a
  déjà son guide).
- Elles vivent dans `site/films/`, avec leur affiche `.webp`. Un film remplacé sous le même nom prend un `?v=`
  incrémenté dans chaque page qui le cite (règle du cache de la vitrine).

## L'espace de démo et les captures

- **Une marque fictive**, la même que dans les films existants (« Votre marque », Léa, la collection d'automne,
  `AUTOMNE20`), des contacts inventés, aucune donnée d'un client.
- **L'espace de démo est simulé, la console est la vraie** (**mon choix**). Les captures se font sur la console
  construite en local, le même code que la production, servie avec des données inventées par les mécanismes des
  tests de bout en bout (`web/e2e/`, réponses de l'API simulées). Un espace réel ne conviendrait pas : « Messaging
  Me demo » sert déjà l'annuaire de Claude et porte une autre marque, et aucun espace réel ne sait montrer à la fois
  un Accueil sans numéro, une Inbox pleine de faux contacts et une campagne prête à partir. En simulé : aucune
  session à ouvrir, aucun mot de passe, aucun écrit chez Meta, aucun vrai numéro à l'écran, et tous les états
  voulus.
- **Les captures** sont en français et en anglais (la console est bilingue), au format `.webp`, rangées par page
  sous `site/img/aide/`. Un script du dépôt les refait toutes : une refonte de la console se rattrape en une
  commande.
- **La fenêtre de Meta** (celle qui s'ouvre pour relier le numéro) n'est pas la nôtre et ne se simule pas : la page
  et le film la montrent sous une forme générique en trois étapes, comme le film du démarrage (`cas-onboarding`), et
  renvoient au guide Meta pour le détail.
- **Aucun envoi réel** pendant la fabrication des captures ou des films.

## Anglais

Toute page française de la vitrine a sa jumelle anglaise, et un test l'exige (`tests/vitrine-langues.test.ts`).
Décision de Julien : **l'anglais dès la première vague**, sans exempter le centre d'aide de ce test.

- Les pages Claude Code sont bilingues par leur source.
- **Chaque fiche publique a sa version anglaise** à côté d'elle (un fichier par fiche), qui porte l'empreinte du
  texte français qu'elle traduit. Un test échoue quand le français a changé sans l'anglais, sur le modèle de
  l'empreinte de `features.md` dans les fiches. La page anglaise se génère depuis cette version, sous `/en/help/`,
  avec des adresses en anglais. On ne passe pas par les dictionnaires de `scripts/vitrine/anglais.ts` : ce serait un
  second texte, découpé en fragments, que rien ne relierait à la fiche.
- Les captures et les films existent dans les deux langues. La console en anglais mène à la page anglaise.

## Référencement

Chaque page publiée entre dans `site/sitemap.xml` et dans `site/llms.txt`, porte un fil d'Ariane et un bloc JSON-LD
(sur le modèle du guide Meta, avec la vidéo quand elle existe), et le centre d'aide a sa page d'accueil `/aide/`
qui liste les rubriques. Les règles de la vitrine s'appliquent : pas de tiret cadratin ni demi-cadratin, jamais
« UChat ».

**L'accès** (décision de Julien) : une entrée « Aide » dans le menu du haut de la vitrine (« Help » en anglais), à côté
de Tarifs et Développeurs, et un lien en pied de page. L'en-tête et le pied se génèrent par `scripts/vitrine/entete.ts`.
C'est un changement de la face publique : il se montre à Julien avant d'être poussé.

## La recherche

**Mon choix** : un filtre dans la page, qui réduit le menu aux pages dont le titre ou le chapeau contient les mots
tapés. Aucun service extérieur, aucun appel à l'API. Il suffit tant que le centre compte quelques dizaines de pages.

## Ce qui est laissé au constructeur

- La forme exacte de l'en-tête de fiche et du fichier généré pour la console.
- Le découpage en lots et l'ordre de livraison, dans la limite de la règle « la page avant le lien ».
- Le script de captures (outil, cadrage, attente des écrans), tant qu'il respecte les contraintes de l'espace de
  démo.
- Le détail du JSON-LD.
- Les textes des quatre pages Claude Code, à partir des outils réels.
- La forme du découpage des fiches pour le bot (table, clés, borne de taille), dans les contraintes de « Le bot
  d'aide ».
- L'emplacement exact des versions anglaises des fiches.

## L'essai réel qui clôt la première vague

Julien crée un espace neuf (il naît en Free), passe à l'essai Pro, suit « Comment faire » depuis l'Accueil, et va
jusqu'à sa première campagne programmée **en ne lisant que le centre d'aide**. Puis il refait le chemin depuis
Claude Code avec les pages développeurs. Chaque endroit où il a dû deviner est un défaut de la page.

Pour le bot : sur la production, après le rechargement des fiches, une question qui porte sur la dernière étape de
« Lancer une campagne » (la programmation) reçoit une réponse juste, qui cite la fiche.
