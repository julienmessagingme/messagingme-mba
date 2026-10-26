---
description: Construire un agent IA qui répond sur WhatsApp : l’entretien, la base de connaissance, les outils, les règles d’arrêt, l’essai et le crédit.
ecran: agents
source_section: Agent IA (menu « AI Agent » > Other AI agent)
source_empreinte: 6a5ad9
publique: oui
rubrique: parler-aux-clients
rang: 10
captures: non
---
# Construire un agent IA

Un agent IA est un répondeur que vous construisez vous-même et que vous **posez là où vous en avez besoin** :
dans le bloc « Agent IA » d'un scénario, ou **pour répondre au client**, à tout message que personne ne tient,
comme le fait l'agent de Meta. Hors de ces deux places, il ne parle pas.

**L'agent IA qui répond au client.** Il se choisit sur l'Accueil, dans **« Qui répond au client »** (position
« Un agent IA », parmi vos agents actifs), puis **Enregistrer** ; la page des agents y renvoie par un lien. L'agent
choisi répond à tout message que ni un scénario, ni un mot-clé, ni un membre de votre équipe ne tient, sans scénario
à construire, et en tenant compte de ce que le contact vient d'écrire. L'agent de Meta n'est pas éteint pour
autant : allumé, il reste en veille, et ne prend que les contacts qu'un bloc « Envoyer au MBA » lui envoie. Si
c'était lui qui répondait, l'Accueil vous demande confirmation, parce qu'il cesse de répondre aux conversations
qu'il tient.

Sans scénario derrière, une règle d'arrêt ou « Pas de réponse » termine la conversation de l'agent ;
« Transfert à un humain », « Aucune source », « Plafond atteint » et « Échec technique » la passent à votre
équipe, dans « À traiter ». Le panneau Détail de l'Inbox note chaque sortie (« L'agent IA a terminé », avec la
règle), et le prochain message du contact relance l'agent (après un transfert, une fois que votre équipe a rendu
la main). Un pouce levé, ou une autre réaction à un message, ne le fait pas répondre. **Crédit épuisé, chaque
message passe à votre équipe**, sans réponse automatique, et les administrateurs reçoivent une alerte par e-mail,
une par jour au plus. Désactiver ou supprimer l'agent qui répond le retire de ce rôle : les messages vont alors à
votre équipe, l'écran vous le dit avant, et l'Accueil le signale. Il ne répond qu'aux messages WhatsApp.

**Un agent naît en brouillon** et n'apparaît dans le constructeur de scénario, ou dans « Qui répond au client »,
qu'une fois **activé**, quand vous avez relu ce qu'il dira. Ici, « activé » veut dire « proposable », pas « il
répond à tout » : répondre à tout se choisit sur l'Accueil. L'activation refuse un agent incomplet, mais elle vous dit quoi faire : chaque manque est une ligne
cliquable qui ouvre l'onglet où cela se corrige, et l'en-tête de la fiche vous les liste dès l'ouverture,
sans attendre que vous cliquiez sur « activer ».

**L'en-tête de la fiche l'identifie d'un coup d'œil** : le logo du fournisseur de son modèle, son nom et son
modèle, sa pastille Brouillon / Actif / Désactivé, et le nombre de messages échangés sur les 30 derniers
jours dans les conversations qu'il a tenues, une fois que ce nombre est connu. Il compte tout le fil,
entrants et sortants, y compris les envois de campagne et ce que votre équipe a écrit après avoir repris la
main sur l'agent : ce n'est donc pas une mesure de ce que l'agent a lui-même produit, et ce n'est pas non
plus le même périmètre que le « messages échangés » de l'Accueil et du Performance Lab, qui eux écartent les
modèles envoyés. Vos essais depuis l'onglet Tester n'y entrent pas, et tant que ce nombre n'est pas connu,
rien ne s'affiche. Le menu de la fiche se range en colonne à gauche du contenu ; sur un téléphone, il
redevient la barre du haut.

**Vous pouvez aussi le faire construire par Claude.** Une fois Claude connecté à votre espace (Developers >
Serveur MCP), il crée l'agent, lit votre site, le teste et l'active, avec les mêmes contrôles que cet écran. Ses
modifications apparaissent dans l'onglet Historique de l'agent, « par Claude ».

**Commencez par lui parler.** Le premier onglet n'est pas un formulaire vide mais une conversation :
décrivez votre métier, et l'assistant fait le tour du sujet point par point, une question à la fois (ce que
l'agent est là pour faire, ce dont il ne parle jamais, d'où viennent ses réponses de fond, les moments où il
doit faire autre chose que répondre, quand il lâche un contact silencieux, quand un humain reprend, sous quel
nom il se présente, s'il annonce être une IA, comment il parle). Si vous citez plusieurs moments d'un coup, il
les reprend un par un. Quand vous lui donnez l'adresse de votre site, il en importe les pages tout seul : elles
vous attendent dans l'onglet Base de connaissance. Tant qu'un point n'a pas été tranché, il ne vous montre rien et vous dit combien il en
reste. Il ne change **rien** tout seul : il propose, et l'écran affiche ligne par ligne ce que cela changerait,
avec la valeur d'avant barrée. Chaque règle se garde, se corrige sur place ou se jette séparément. Vous pouvez
lui joindre un document ou une photo (une grille de tarifs, par exemple) : le texte en est extrait et découpé en
fiches de connaissance.

**Un moment où l'agent doit lancer un scénario se règle dans l'entretien.** La question qui suit liste vos
scénarios en ligne par leur nom : nommez celui qu'il faut. La proposition porte alors une ligne « Outil « Lancer un
scénario » », avec la situation où l'appeler, à corriger si besoin, et « Enregistrer » pose l'outil dans l'onglet
Outils, « Inactif ». Il vous reste à cocher « Autoriser l'agent à faire ça seul » (« Modifier » sur sa ligne) et à
cliquer « Activer ». Si le nom que vous donnez ne désigne pas un seul scénario en ligne, rien n'est posé, et la liste « Pour
finir » vous dit comment l'ajouter à la main.

**À la fin de l'entretien, suivez la liste « Pour finir ».** Elle dit, dans l'ordre, ce qu'il reste à faire
pour votre agent : enregistrer la proposition (bouton « Enregistrer »), importer votre site dans Base de
connaissance, brancher le
connecteur qu'un moment demande, activer l'outil du scénario posé, vérifier son modèle dans l'onglet Modèle, le
tester, puis l'activer. Une étape déjà faite n'y figure pas.

**Sa base de connaissance est la seule chose dont il a le droit de se servir.** Sur une question qu'aucune
fiche ne couvre, il n'invente pas : il sort du bloc par « Aucune source ». Une base vide fait donc un agent
qui transfère tout. Vous remplissez cette base de quatre façons : en collant l'adresse d'une page de votre
site, qui est lue une fois et découpée en fiches ; en déposant un document (PDF, Word, texte ou CSV) ; en
écrivant une fiche à la main ; ou en joignant un document à l'assistant. L'adresse de votre domaine fait lire
votre site, jusqu'à cinquante pages proches de l'accueil, et un aperçu vous montre ce qui serait importé avant
que rien ne s'écrive. Un site lent est lu pendant 30 secondes au plus : l'aperçu dit alors qu'il manque des
pages, et un import arrêté faute de temps vous propose d'un clic les pages qu'il n'a pas pu lire. Un CSV, une
grille de tarifs par exemple, est découpé par lignes entières, son en-tête repris dans chaque fiche, et celui
qu'Excel enregistre sous Windows passe aussi. Une fiche fait au plus 2 000 caractères, ce que l'agent en lit :
une section plus longue devient plusieurs fiches « (suite 2) », « (suite 3) », rien n'est coupé. Au-delà de 40
fiches, la suite d'une page ou d'un document n'est pas lue, et l'écran le dit, page par page. La provenance
est écrite sous chaque fiche, et une fiche que personne n'a touchée depuis plus de quatre-vingt-dix jours porte
une pastille « À relire ».

**Les outils sont ce qu'il a le droit de FAIRE**, en plus de parler. L'onglet Outils a la forme de celui de
l'agent de Meta. En tête, **« Toujours là »** : les gestes propres à l'agent IA
(terminer par une règle d'arrêt, passer la main à un humain, chercher dans sa base de connaissance, lire la
fiche du contact, marquer la conversation urgente), avec les mêmes commandes que vos outils : « Activer » pose
l'outil puis l'active, « Désactiver » le désactive, « Modifier » ouvre ses consignes, et la croix le supprime. Puis **« Ajouter un outil »** ouvre la grille « Quel outil ajouter ? » :
poser un tag, enregistrer une information, envoyer un bloc, lancer un scénario, appeler un connecteur API,
appeler un outil MCP, et deux outils propres à l'agent IA : déclencher une action, et enchaîner des étapes. Enfin, la liste des outils posés, chacun avec son état (« Actif » ou « Inactif »), « Activer » ou
« Désactiver », « Modifier » et la croix qui supprime. Sept choses à retenir :

- **Le tag, l'information, le bloc et le scénario sont choisis par vous**, un par outil : l'agent ne décide que
  du moment, et pour une information, de la valeur (bornée à la liste que vous donnez, si vous en donnez une).
  « Lancer un scénario » fait **prendre la conversation au scénario** : l'agent se retire et n'écrit plus rien ;
  un scénario dépublié ou supprimé est refusé, et l'agent continue. « Envoyer un bloc » envoie le bloc seul,
  sans ce qui le suit, et l'agent garde la main.
- **Un outil n'est utilisable qu'une fois activé**, par vous ou par Claude à votre nom. Tant qu'il ne l'est
  pas, l'agent ne sait même pas qu'il existe. Le cas qui coûte le plus cher est une base bien remplie avec
  l'outil de recherche resté inactif : l'agent transfère alors toutes les questions de fond, et l'écran a
  pourtant l'air en ordre. Un outil posé par la grille naît « Inactif » lui aussi, et s'active depuis sa ligne. Un
  agent ne porte jamais deux outils du même nom : le second est refusé, parce que le modèle refuserait toute la
  liste et que l'agent ne répondrait plus.
- **Ce qui part chez le client demande votre accord** : sur « Envoyer un bloc » et « Lancer un scénario »,
  cochez « autoriser l'agent à faire ça seul », sinon chaque appel est refusé, et la ligne de l'outil le dit.
- **Les mots comptent beaucoup.** « Quand l'appeler » et « quand NE PAS l'appeler » sont deux champs
  séparés, et ce sont eux que le modèle lit pour décider.
- **Une action fait agir votre application.** « Déclencher une action » : vous la nommez (« Résiliation »), vous
  écrivez sa consigne (quand la déclencher, et ce que l'agent dit ensuite au client) et les informations qu'il
  recueille, jusqu'à dix, toutes facultatives (texte, nombre, date, e-mail ou liste de valeurs). Quand le client
  fait la demande, l'agent lui répond ce que prévoit la consigne et continue, et votre application reçoit
  l'événement « Action de l'agent IA », une fois par jour au plus par contact et par action. Cet événement est
  décoché par défaut : cochez-le sur une adresse dans Developers > Webhooks sortants, sinon rien ne part, et la
  carte de l'action vous le rappelle. Le code d'un champ est la clé que votre application lit : ne le changez plus
  une fois l'application branchée. Une automation peut aussi partir de l'action (menu Automation).
- **Plusieurs actions d'un coup, dans votre ordre.** « Enchaîner des étapes » : une première étape, puis « + Ajouter
  une étape », et les flèches pour ranger. Par exemple : demander le prénom, le nom, le campus et la formation,
  puis lancer le scénario qui passe le contact à votre équipe. S'il manque une réponse, l'agent la demande **une
  seule fois**, puis exécute tout avec ce qu'il a, même si le contact refuse. Deux règles, que l'écran vous
  rappelle : un scénario ou un transfert en « À traiter » se place en dernier (un seul des deux), et aucun bloc ni
  scénario ne vient avant une question (les questions passent toujours en premier). Dès qu'un bloc
  ou un scénario en fait partie, cochez « autoriser l'agent à faire ça seul ». « Enregistrer une information »
  range une seule réponse, dans un champ que l'agent lit en clair et que le titre proposé cite.
- **Qualifier avant de passer la main, ou passer la main tout de suite : il faut choisir.** « Qualifier et
  transférer » n'a ni titre ni nom à choisir, et « Quand l'appeler » est déjà rempli. Il pose vos questions (chacune
  dans un champ choisi dans la liste, « + Ajouter une question »), une seule fois, puis passe la conversation dans « À traiter », même si le contact n'a rien répondu. Comme avec
  « Passer la main à un humain », l'agent ne dit sa dernière phrase que s'il répond seul au numéro ou que l'équipe
  est fermée ; sinon, c'est la suite de la sortie « Transfert à un humain » de votre scénario qui parle. Il ne cohabite ni avec « Passer la main à un humain » ni avec une règle d'arrêt cochée
  « passe à un humain » : activer l'un quand l'autre est là est refusé, et le message dit quoi désactiver d'abord.

**Les règles d'arrêt dessinent les sorties du bloc.** Une règle d'arrêt, c'est « quand l'agent a fini de
faire ça, il sort par là » : vous lui donnez un code et un libellé, et chacune devient une sortie à relier
dans le constructeur, douze au maximum. Cinq sorties sont toujours là en plus des vôtres : **Pas de
réponse** (le contact s'est tu), **Aucune source**, **Transfert à un humain**, **Plafond atteint** et
**Échec technique**. Une sortie qui ne mène nulle part est signalée en rouge.

**Essayez-le avant de l'activer.** L'onglet Tester vous fait parler au vrai agent, avec son objectif, son
ton, ses outils et sa vraie base : ce qu'il répond là est ce qu'il répondra. Chaque appel d'outil est montré
avec ce qu'il a demandé et ce qu'il a reçu, parce que « il n'a pas trouvé » et « il n'a même pas cherché »
ne sont pas le même défaut. Les actions qui touchent le monde réel y sont simulées, sauf un appel de
connecteur API qui ne fait que lire votre système (une requête GET donnée à l'agent en « il récupère de
l'information », sans donnée du contact) : celui-là part pour de vrai, pour que vous voyiez un vrai devis. Vos
essais sont gardés
quatorze jours, et « Reprendre » repose exactement la même question à l'agent tel qu'il est réglé
maintenant : c'est ainsi qu'on voit si une consigne a servi à quelque chose.

**Ce qu'il lit.** À chaque tour, un agent relit les 30 derniers messages échangés avec le contact, sur 30 jours,
quelle que soit la conversation, et son premier tour lit le message qui l'a déclenché.

**Le crédit.** Chaque espace a un solde prépayé, affiché en haut de la liste des agents et libellé en euros.
Le solde descend à chaque tour, au tarif affiché dans la liste des
modèles, recherche dans la base de connaissance comprise, et aussi
à la préparation des fiches de connaissance et à chaque traduction ou transcription de l'Inbox. Un avertissement apparaît quand
il devient bas, et un bandeau rouge à zéro. Un administrateur le recharge dans l'onglet **Crédit IA** de **Paramètres > Offre**
(5, 10, 50 ou 100 € hors taxe, payés sur la page de Stripe), et 1 € est offert au premier numéro WhatsApp de
l'espace, une fois que Meta l'a vérifié. **Sans crédit, on ne peut pas créer d'agent et le
bac à sable refuse** : un essai appelle vraiment le modèle, il se paie comme une conversation.

**Trois plafonds** protègent chaque conversation en plus du solde : le nombre de réponses de l'agent (20 par
défaut), le nombre de ses actions, une recherche dans sa base ou un outil (60 par défaut), et le crédit dépensé (sans
limite par défaut : c'est votre solde qui borne la dépense). Le premier atteint fait sortir le parcours par
« Plafond atteint », qui est une sortie à brancher. Ils se règlent dans l'onglet **Périmètre** de l'agent (le crédit
par une case « Sans limite » et un montant en euros), ou en le demandant à Claude.

**La mention d'IA**, enfin, est obligatoire et ne peut jamais être vide. La phrase appartient à l'agent, le
moment où elle est dite appartient à votre espace et se règle dans Sécurité > IA : jamais, une fois par
session, ou à chaque message. C'est la plateforme qui la place en tête du message de l'agent, pas le modèle :
elle part même quand l'agent consulte sa base avant de répondre, et l'onglet Tester vous la montre telle que le
contact la lira. L'agent de Meta n'est pas concerné, il appose déjà la sienne.
