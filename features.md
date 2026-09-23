⚠️ **Manager : ce qu'il a en propre** (mis à jour le 2026-09-19). Il **affecte une conversation à un
membre**, ce qu'un agent ne peut pas ; il **consulte** les écrans de conformité (Sécurité, depuis le
2026-09-14) ; et il **règle UNE chose** dans Paramètres : si les agents peuvent prendre une conversation du pot
commun (voir « Je m'en occupe » plus bas). 🔴 **Jusqu'au 2026-09-19, son menu d'affectation était vide** : il
lisait une liste de membres réservée aux admins, si bien qu'un manager ne pouvait confier une conversation à
personne. Invisible tant que tous les comptes étaient admin ; réparé le même jour.

Statut : 🔲 pas commencé · 🚧 en cours · ✅ live

✅ **La plateforme s'appelle « Engage Me »** (2026-09-03). Le nom s'affiche à l'onglet du navigateur, sur
l'écran de connexion, dans l'en-tête à côté du logo (le logo lui-même n'a pas changé) et comme titre du
serveur MCP. Accroche : « La plateforme conversationnelle qui comprend chaque conversation. »
⚠️ « Meta Business Agent » et « MBA » restent tels quels : c'est le produit de Meta, pas le nôtre.

✅ **La console est servie depuis `engageme.messagingme.app`** (2026-09-03). `mba.messagingme.app` continue de
répondre en parallèle, comme secours et pour toutes les adresses déjà distribuées (liens tracés, visuels RCS,
webhook Meta, MCP). Rien de ce qui a été envoyé à un client ne cesse de fonctionner.

✅ **Les tentatives d'accès à `/ops` alertent** (2026-09-03). Au 5e refus en 5 minutes, un message Telegram
part, une fois par demi-heure au plus. Chaque refus est journalisé même quand l'alerte est étouffée. Le jeton
présenté n'est jamais écrit nulle part.

`mba.messagingme.app` est **en prod LIVE** (`DRY_RUN=false`, numéro Zadarma réel). Console de gestion
WhatsApp/Meta, 3 rôles : **admin** (tout), **manager** et **agent** (inbox seule).
⚠️ **Manager est un STATUT, pas encore des droits** (2026-08-20) : il s'attribue, mais il donne exactement les
mêmes accès qu'un agent, PLUS les écrans de conformité depuis le 2026-09-14 (voir « Sécurité & compliance »).
Le reste de ses prérogatives n'est toujours pas décidé.

## Navigation (trois onglets en haut, barre latérale par onglet)

- ✅ **TROIS ONGLETS EN HAUT DE LA CONSOLE** (2026-09-08) : **Console**, **Inbox** et **Performance Lab**.
  Ils rangent trois métiers qui ne se pratiquent ni au même moment ni par les mêmes personnes : configurer
  et opérer, traiter les conversations, lire les résultats. Avant, une barre unique les mettait sur le même
  plan, et un opérateur qui passe sa journée dans l'Inbox traversait un menu de quinze entrées dont il n'en
  utilisait qu'une.
  🔴 **Aucune adresse n'a changé.** Un favori, un lien partagé ou une page ouverte dans un onglet du
  navigateur continue d'ouvrir exactement la même page ; elle s'affiche simplement sous son onglet.
  ⚠️ **Un compte opérateur ne voit qu'un onglet, l'Inbox.** Lui en montrer trois dont deux le renverraient
  aussitôt à l'Inbox serait lui promettre deux portes fermées.

**Le menu de gauche change avec l'onglet.**

**Console** : **Accueil · mini-CRM · Campagnes · Chaîne · Scénario · Automation · AI Agent (MBA [MBA, guide /
MBA, paramètres] / Other AI agent [Agents / Crédit]) · Contenu (Templates WhatsApp / Formulaires WhatsApp / Modèles
d'email / Messages RCS / Blocs / Étiquettes / Champs, rangés par canal depuis le 2026-09-02 : WhatsApp /
RCS / Email / Bibliothèque) · Tools (Webhooks / Connecteurs API / Connecteurs MCP / Outils)**, puis, collés **en bas** de la barre,
**Paramètres · Support · Developers (Documentation API / Clés d'API / Serveur MCP)**.
⚠️ **Paramètres et Support sont descendus en bas le 2026-09-08** : ils ne servent pas le travail quotidien,
ils le règlent, comme Developers. Aucune adresse n'a changé.
- ✅ **« Other AI agent » se déplie en deux** (2026-09-08) : **Agents** (l'écran des agents IA, inchangé) et
  **Crédit**, qui montre le crédit prépayé de l'espace. Le rechargement en ligne n'est pas ouvert : l'écran
  le dit et donne le solde, plutôt que de laisser une entrée de menu mener nulle part.

**Performance Lab** : **Quantitatif (Messages & contacts / Coûts / Funnel) · Analyse des conversations ·
Mes tableaux**. C'est l'ancien groupe « Analytics », remonté d'un cran : dans cet onglet, il EST le menu.
⚠️ **« Qualitatif » s'appelle « Analyse des conversations » depuis le 2026-09-17**, et le sous-onglet
**Erreurs** a quitté le Quantitatif le même jour pour rejoindre le journal dans **Console > Sécurité >
Journal des erreurs**, où sa carte d'agrégat par code Meta vit désormais à côté du journal ligne à ligne.
**Synthèse** est sa première entrée depuis le 2026-09-08 (`/performance`) : elle porte une carte
« Coûts » à trois lignes dépliables (coût moyen par engagement, coût des messages envoyés, coût de l'IA),
le nuage « urgence et satisfaction » et les conversations par intention. Le tableau du coût par engagement
existe toujours, replié sous la première ligne. Le coût des messages ne compte pas ceux que Meta ne facture
pas : les messages envoyés dans les 72 h qui suivent un clic sur une pub Click-to-WhatsApp, d'après l'accusé
de Meta.

**Inbox** : **aucune barre de navigation**, ni sur ordinateur ni dans le tiroir mobile. L'écran portera son
propre menu de dossiers, façon boîte mail.
- ✅ **La barre a TROIS niveaux depuis le 2026-09-01**, et « MBA » est le seul groupe de deuxième niveau :
  ses deux écrans (guide, paramètres) parlent du même agent, alors que « Other AI agent » en est un autre.
  Les mettre au même rang laissait croire à trois agents.
Les groupes **AI Agent**, **Contenu**, **Tools**, **Analytics** et **Developers** sont **repliables** (clic sur l'en-tête, chevron) : ouverts d'office quand on est sur une de leurs pages, sinon repliés.
Agent : **Inbox** seule. Menu **Compte** en haut à droite (**toggle langue FR/EN**, Compte & équipe, **Boîtes email**, Abonnement*, Billing*,
Déconnexion ; *désactivés, câblage Stripe hors lot). RBAC = barrière serveur (preHandler), l'UI ne fait que masquer.
- ✅ **Interface bilingue FR/EN COMPLÈTE** : un toggle dans le menu Compte bascule TOUTE l'interface en anglais
  (mémorisé par navigateur, défaut français), **y compris les dates (« Today/Yesterday/12 July 2026 »), les
  nombres (« 1,000 »), les paliers d'envoi (« 1,000 customers / 24 h », « Unlimited ») et les pourcentages**. Le
  toggle est aussi disponible **avant connexion** (login, inscription, mot de passe oublié, invitation). Pour
  les clients internationaux (Dubaï) et le screencast d'App Review Meta.
- ✅ **Après connexion, un admin arrive sur l'Accueil (Home)** (numéro + statut du compte), plus sur Analytics.
- ✅ **HubSpot a son propre bloc sur l'Accueil** (2026-08-23), sous celui du Meta Business Agent. Il était
  imbriqué dans la carte du numéro WhatsApp, où il passait inaperçu alors qu'il gouverne une intégration
  entière. Il ne s'affiche que si un numéro est rattaché : sans numéro, il n'y a rien à synchroniser.
- 🗑️ **« Relancer automatiquement les échecs » a QUITTÉ les Paramètres** (2026-09-23). Ce n'est plus un réglage
  d'espace : la relance obéit à la case « Réessayer les envois qui échouent » de chaque campagne, qui existait
  déjà et que rien ne lisait. Les campagnes créées avant gardent la règle d'espace, figée dans l'état où elle
  était (voir « Campagnes »).
- ✅ **Paramètres (menu « Paramètres », admin ; un manager n'y voit que le réglage « Je m'en occupe »)** : le
  **fuseau horaire** de l'espace et les **heures d'ouverture**
  jour par jour (heure de début, heure de fin, ou « fermé »). C'est la base sur laquelle s'appuient les conditions
  de temps des scénarios (l'heure qu'il est, le jour de la semaine, « dans les heures d'ouverture »). Un jour dont
  l'heure de fin précède l'heure de début est signalé en rouge et bloque l'enregistrement.
  La page porte aussi le **journal des actions** (ajouts, suppressions, effacements, bascules de consentement),
  désormais **exportable en CSV** (2026-08-20) : l'export relit le journal jusqu'à 1000 lignes au lieu des 100
  affichées, avec des dates en ISO pour qu'un tableur puisse trier. Comme à l'écran, il ne porte **aucun numéro**,
  seulement l'identifiant interne du contact.

## Comptes & authentification

- ✅ **Une adresse mail, plusieurs espaces** (2026-08-21) : la même adresse peut désormais ouvrir plusieurs
  espaces de travail. Un seul mot de passe pour tous, comme chez Slack ou Notion. À la connexion, si l'adresse
  n'en dessert qu'un (le cas courant), **rien ne change** : on entre directement. Si elle en dessert plusieurs,
  un écran demande lequel ouvrir. Le rôle peut différer d'un espace à l'autre : admin ici, agent là.
- ✅ **Observer l'espace d'un client** (2026-08-21, interne) : depuis la surface d'exploitation, on entre dans
  un espace pour voir exactement ce que le client voit. **En lecture seule** : aucune modification n'est
  possible, et regarder une conversation ne la marque pas comme lue chez lui. Un bandeau rappelle en
  permanence qu'on n'est pas chez soi.


- ✅ **Inscription libre** (`/signup`) : n'importe qui crée **son propre espace** (nom d'espace + email + mot de
  passe) et en devient l'**admin**. Redirige vers l'accueil (connecter le numéro).
- ✅ **Se connecter avec Google** (bouton sur `/login`, `/signup`, `/invite`) : vérif du jeton côté serveur ;
  liaison **par email** (compte existant -> connexion ; email inconnu -> crée un espace, comme un signup).
- ✅ **Invitations d'équipe** (admin) : inviter un membre par email (Resend) -> il pose son mot de passe (ou
  Google) via un lien, puis rejoint l'espace avec le rôle défini. Le compte reste « invité » tant qu'il n'a pas
  activé. L'email est un **HTML brandé** (logo Messaging Me, couleurs de marque) et **personnalisé** (« X t'invite
  à rejoindre l'espace Y »). **La création de compte par mot de passe (posé par l'admin) est SUPPRIMÉE** : on
  n'ajoute un membre QUE par invitation (front + route + code backend retirés).
- ✅ **Mot de passe** : « oublié » (`/forgot`, lien de réinitialisation par email, réponse toujours générique
  anti-énumération) + changement depuis le compte (`/compte`).
- ✅ **Session expirée : on le dit, et on propose de revenir** (2026-08-17) : quand le jeton tombe pendant
  qu'on travaille, une bannière apparaît en haut de l'écran avec un bouton **« Se reconnecter »** qui ramène à
  la connexion. Avant, l'interface restait active et les enregistrements échouaient en silence.
- ✅ **Trois statuts de membre** (2026-08-20) : **Admin** (tout), **Manager**, **Agent** (inbox seule).
  ⚠️ Manager et agent ont **les mêmes accès aujourd'hui** : le statut existe et s'attribue, mais aucun droit
  propre ne lui a encore été ouvert. L'écran d'invitation le dit noir sur blanc, pour qu'on n'invite pas un
  manager en s'attendant à ce qu'il voie tout.
- ✅ **Crochet paiement (inerte)** : chaque espace a un statut (`trial|active|locked`) ; un espace `locked`
  serait bloqué (403). Pas de Stripe pour l'instant, le contrôle est en place mais neutre.

## Contacts & CRM

- ✅ **mini-CRM : moteur de filtres + actions en masse** (2026-07-28) : l'écran Contacts filtre par **tag**
  (possède / ne possède pas, tous ou au moins un), **opt-in**, **nom**, **téléphone** (commence par / contient),
  **valeur de champ** (contient / ne contient pas / vide / rempli / égal) et un contrôle **Email** dédié (rempli /
  vide / valeur précise), cumulables. On **coche** des contacts (la case d'en-tête coche toute la page affichée) ;
  si le filtre ramène plus de contacts que l'écran n'en montre, un lien **« Sélectionner les N contacts
  correspondants »** étend la sélection à tout le segment, re-résolu côté serveur au moment d'appliquer l'action
  (les lignes décochées entre-temps restent exclues). Le nombre exact n'est affiché **que lorsqu'un filtre est
  posé** : sans filtre, la liste s'arrête à 500 et affiche « 500+ ».
  Puis un menu **« Action »** applique en masse : **ajouter un tag**, **retirer un tag**,
  **ajouter un champ** (une valeur sur toute la sélection), **passer en opt-in**, **passer en
  opt-out**, **supprimer**.
  **Passer en opt-in** rend la sélection destinataire des campagnes : à n'utiliser que si vous
  détenez une preuve du consentement, l'écran le dit. **Passer en opt-out** exclut de toute
  campagne, **y compris de celles déjà programmées**, sans toucher à la fiche ni à l'historique.
  **Supprimer est IRRÉVERSIBLE et unique** (2026-08-19) : la fiche, la conversation dans l'Inbox,
  ses messages, son analyse **et les événements bruts reçus de Meta la concernant** (2026-08-31) sont
  détruits d'un seul geste. Ces événements bruts, qui portent le texte de ce que la personne a écrit, sont
  par ailleurs **effacés automatiquement au bout de 30 jours**, qu'on vous le demande ou non. Il a existé une suppression douce
  qui gardait la conversation ; elle laissait le fil dans l'Inbox après coup, personne ne veut
  supprimer un contact à moitié. Les compteurs de campagne restent justes, mais plus personne
  n'est reconnaissable. Il faut **taper le mot SUPPRIMER** pour confirmer.
  Une action en masse (et l'import CSV) **ne déclenche aucun scénario** : poser un tag sur 5 000 contacts d'un coup
  ne lance pas l'automation « tag ajouté », sinon ce serait autant de messages facturés. Seul un tag posé sur
  **une** fiche la déclenche. Pour toucher une liste entière, c'est la campagne.
- ✅ **Les conversations sont conservées 90 jours** (durée abaissée depuis un an le 2026-09-17). Passé ce
  délai sans le moindre message, une conversation est effacée automatiquement, avec ses messages et son
  analyse qualitative. La **fiche du contact reste** : c'est l'historique de discussion qui part, pas la
  personne. 🔴 **La durée se règle PAR ESPACE**, et c'est le client qui tranche, pas nous : le RGPD ne fixe
  aucun chiffre (« pas plus longtemps que nécessaire »), donc imposer le nôtre à tout le monde ferait de
  nous le décideur d'une chose qui ne nous appartient pas. Les 90 jours sont le défaut de qui n'a rien
  réglé, et **0 veut dire « ne jamais purger cet espace »**. Elle peut être raccourcie, jamais rallongée
  rétroactivement, puisque ce qui est effacé ne revient pas.
  ⚠️ **Ce qui disparaît, c'est le CONTENU, pas la mémoire de l'activité** : les compteurs de la Synthèse
  (conversations par jour, satisfaction et urgence moyennes, répartition par intention) sont conservés à
  part, sous forme de totaux journaliers qui ne portent ni numéro, ni texte, ni résumé, ni identifiant de
  conversation. Une période « 12 mois » continue donc d'afficher son activité bien après que les échanges
  eux-mêmes ont été effacés.
- ✅ **UN seul geste pour ajouter des contacts** (2026-08-20) : un bouton **« + Rajouter des contacts »** ouvre
  un menu à deux choix, **Ajouter un contact** ou **Importer un CSV**. Avant, les deux boutons se disputaient la
  barre à poids égal, alors qu'on cherche d'abord « en ajouter », la façon venant ensuite.
- ✅ **Ajouter un contact à la main** (2026-08-17) : dans le menu ci-dessus, formulaire du mini-CRM
  (numéro, prénom, email, tags). Jusque-là il fallait fabriquer un fichier CSV pour un seul numéro. Le serveur
  passe par le MÊME enregistrement que l'import et que l'API publique : le numéro est donc normalisé pareil, et
  un numéro DÉJÀ connu met la fiche à jour au lieu d'en créer une seconde. L'écran le dit, plutôt que d'annoncer
  une création qui n'a pas eu lieu.
- ✅ **Un contact qui écrit STOP est désabonné, sur les deux canaux** (2026-08-29). C'était vrai
  en RCS depuis toujours et faux en WhatsApp, le canal principal : le même mot y laissait le
  contact opt-in, et il recevait la campagne suivante. Le refus est maintenant enregistré comme
  un opt-out, **avant** tout envoi, et **avant** l'avance d'un scénario ou le déclenchement d'une
  automation. Il vaut aussi pour un contact **inconnu** dont le tout premier message est STOP,
  cas le plus courant après une campagne. ⚠️ **Messages écrits seulement, et le mot doit
  commencer le message** : un bouton porte son libellé dans le corps du message, et un bouton
  « Stopper la simulation » désabonnerait quelqu'un qui voulait juste sortir d'un parcours ;
  quant à « stop » cherché n'importe où, il attraperait « je ne peux pas m'arrêter là ». Un faux
  positif ici coupe quelqu'un qui n'a rien demandé, et personne ne s'en aperçoit.

- ✅ **Contacts / opt-in** : opt-in tracé, tags. **Identité = numéro OU BSUID** (compte WhatsApp d'un client qui
  n'a pas partagé son numéro, post-octobre) : le tableau porte **une colonne par identité** (Téléphone, BSUID,
  WhatsApp ID), chacune remplie quand elle existe, et la **fiche** affiche en sous-titre celle qui identifie le
  contact (le numéro, sinon le BSUID). Un client qui **écrit** à l'entreprise crée automatiquement sa fiche (par
  numéro ou BSUID), opt-in « inconnu » (donc hors marketing tant qu'il n'a pas consenti).
- ✅ **Import CSV** : on dépose le fichier (ou on colle le texte), puis on **coche colonne par colonne** ce qu'on
  importe et on associe chacune à Téléphone, Nom, Prénom, Email, Ville, Société ou un champ perso (créé au
  passage) ; deux valeurs d'exemple par colonne aident à choisir, et les colonnes reconnues sont pré-cochées. Le
  téléphone est normalisé en E.164 et **une colonne Téléphone est obligatoire** (c'est la clé du contact). On pose
  l'opt-in et des tags pour tout le lot, et l'import rend un compte rendu (créés / mis à jour / ignorés, avec le
  motif des lignes en erreur).
  **Gros fichiers (2026-08-31)** : un CSV allant jusqu'à environ 150 000 contacts passe désormais en un seul
  import, là où le choix du fichier échouait déjà vers 14 000 lignes. Au-delà d'environ 8 000 lignes, le nombre
  de lignes annoncé avant l'import devient une **estimation**, affichée avec un « ≈ » (l'écran n'analyse plus
  que le début du fichier) ; le compte rendu final, lui, reste exact. Un fichier encore plus gros est refusé par
  un message **en français** qui dit quoi faire : le découper.
- ✅ **Fiche contact éditable** : sur la fiche, on **modifie ou supprime** la valeur de chaque champ perso en
  place, et on édite le **Nom** et le **Prénom**. Le **téléphone et le BSUID restent en lecture seule** (ce sont
  les identités qui routent les messages WhatsApp). Un champ « orphelin » (dont la définition a été supprimée)
  reste supprimable. Toujours sur la fiche : on **affecte ou retire un tag** (les tags existants sont suggérés à
  la saisie), on renseigne un champ déjà déclaré, et on peut **créer un champ entièrement nouveau (libellé + type)
  sans quitter la fiche** : il rejoint les champs de l'espace et sa valeur est posée sur ce contact dans la foulée.
- ✅ **Vos prix, réglables par espace** (2026-09-18, écran Paramètres) : vous y posez **ce que vous
  facturez**, et non ce que vous payez. Le tarif des templates vient de Meta, vous posez une **marge**
  dessus (100 % = exactement le tarif Meta, et c'est le défaut, donc rien ne bouge tant que vous n'y touchez
  pas). Les autres prix se négocient et se saisissent : le **message de service** et le nombre de messages
  **offerts par mois**, la **date à partir de laquelle** ils sont facturés, et les deux prix **RCS** (simple,
  et conversationnel dès qu'une personne répond). ⚠️ Ces prix servent à chiffrer ce que vous voyez dans
  Performance Lab : ils n'émettent aucune facture et ne changent rien chez Meta. Une valeur hors bornes est
  **refusée en nommant le champ**, jamais ramenée en silence dans les bornes : un prix corrigé à votre insu
  serait pire qu'un refus, puisque vous en tireriez un budget.
- ✅ **Le résumé de la conversation, en champ de base de la fiche** (2026-09-17) : dès qu'un contact a tenu au
  moins une conversation, sa fiche porte le **résumé de la dernière conversation analysée**, avec la date de
  l'analyse et un lien vers le fil. C'est le geste de quelqu'un qui ouvre une fiche avant de rappeler la
  personne : savoir de quoi on a parlé sans aller relire l'échange. Le champ est en **lecture seule** (c'est un
  constat posé par l'analyse, recalculé à chaque passage : une retouche disparaîtrait au suivant) et il
  n'apparaît **pas du tout** tant qu'il n'y a aucune conversation. Quand un message est arrivé depuis
  l'analyse, la fiche le dit au lieu de présenter un résumé partiel comme s'il couvrait tout. Une conversation
  analysée avant que les résumés existent (analyses d'avant septembre) le dit aussi, au lieu de laisser un
  blanc qui ressemblerait à une panne. ⚠️ Le résumé n'est **pas recopié** dans la fiche : il est lu à
  l'ouverture, donc il **disparaît de lui-même** quand la conversation atteint la durée de conservation de
  l'espace. Et il n'est **pas utilisable comme variable dans un message** : c'est une note interne, pas du
  contenu à renvoyer au client.
- ✅ **Onglet « Historique » sur la fiche contact** (2026-07-20) : deux vues de tout ce que ce contact a vécu.
  **Campagnes reçues** : quelle campagne, quel template ou scénario, quand, et où en est le message (envoyé,
  délivré, lu, non délivré, écarté, envoi en échec avec son motif). Un message parti dont Meta n'a jamais
  renvoyé de statut est marqué « envoyé, statut inconnu » et jamais « non délivré ».
  **Un indicateur « Engagé »** (2026-09-02) s'ajoute à « Lu », et il ne dit pas la même chose : « lu » veut dire
  que Meta a affiché le message, « engagé » veut dire qu'un humain a fait quelque chose. Compte comme réaction :
  une réponse écrite, un appui de bouton, et **un clic sur un lien du message**. Bornes : dans les 24 h, et
  avant l'envoi suivant à ce contact, pour que deux campagnes du même jour ne se créditent pas l'une l'autre.
  **Conversations** : chaque
  échange avec son nombre de messages, son dernier aperçu, et son analyse IA quand elle existe (sentiment,
  sujet, résolu ou non, traité par un humain ou par le bot), **plus le résumé de chacune** depuis le
  2026-09-17 : la fiche n'en montre qu'un, ici il y a la place de les montrer tous, ce qui rend l'onglet utile
  quand un contact a plusieurs fils. Une analyse rendue caduque par un message plus
  récent est signalée « à rafraîchir » plutôt que présentée comme à jour. Un clic ouvre le fil dans l'inbox.
  Un bouton **« Exporter en CSV »** télécharge la totalité des campagnes reçues par ce contact (campagne, statut,
  livraison, type, template ou scénario, date d'envoi, erreur brute et son explication en clair), sans la limite
  d'affichage de l'écran.
- ✅ **Tags** (menu Contenu) : renommer (re-dédup si la cible existe), supprimer -> répercuté sur tous
  les contacts. **Créer un tag** réutilisable depuis cette page, même sans aucun contact qui le porte : il devient
  aussitôt une suggestion dans les filtres, sur la fiche et dans les blocs de scénario. Chaque tag affiche **son
  nombre de contacts** ; cliquer sur ce nombre ouvre la liste des contacts qui le portent (500 premiers). Un tag
  saisi dans un bloc **« Action » (choix « Ajouter un tag »)** d'un scénario **apparaît aussi ici dès qu'on quitte
  le champ**, sans attendre l'enregistrement du scénario. Les anciens blocs « ajout de tag » se comportent de la
  même façon. Dérivés des contacts + tags déclarés.
- ✅ **Blocs** (menu Contenu, 2026-07-17) : liste à plat de TOUS les blocs de tous les scénarios, **filtrable par
  type** (Envoi template / Message rapide / Question / Formulaire / Action / Condition / Attente / Assigner à un agent / Message RCS / Envoi de mail / Agent IA / Inbox ; les anciens blocs « Ajout de
  tag » et « Ajout de champ » n'ont plus de filtre dédié mais restent affichés avec leur libellé d'origine),
  présentée en colonnes **Type | Nom | Scénario | Code**. La colonne **Nom** affiche le **nom libre** donné au bloc
  dans le scénario (champ « Nom du bloc », optionnel, ex. « Relance J+3 »), à défaut un résumé automatique de son
  contenu, à défaut « (sans nom) » ; ce nom remplace aussi le libellé de type sur la carte du bloc dans l'éditeur
  de scénario. Le **code public (`nod_…`) est toujours visible** (ou « non codé » pour un bloc jamais
  re-sauvegardé), et le nom du scénario est un lien qui l'ouvre. C'est la vue qui sert à retrouver le code d'un
  bloc précis (adressage d'une future API). **Recherche** (2026-07-28) : un champ texte filtre les blocs par
  **contenu, nom du bloc, nom du scénario, code ou type**, insensible à la casse et aux accents, **cumulable**
  avec le filtre de type. Filtrage instantané côté client.
- ✅ **Champs** (menu Contenu) : **créer un champ** (libellé + type parmi texte, nombre, date, date et heure,
  oui/non, lien), éditer le libellé / le type, supprimer. Supprimer la définition d'un champ **ne détruit pas les
  valeurs déjà saisies** sur les contacts : elles restent lisibles sur les fiches, où on peut les retirer une par
  une. La **clé est verrouillée** (renommer la clé casserait le mapping des campagnes) -> on édite label/type
  seulement. **Champs de base « système »** (Nom, Prénom, Téléphone, BSUID, WhatsApp ID, Email) : toujours
  présents, **non supprimables**, utilisables comme sources de variable partout.
- ✅ **Colonne « WhatsApp ID »** dans le tableau contacts (à côté du BSUID) : les chiffres du numéro sans « + »
  (la clé de routage que Meta émet), ou le BSUID si le contact n'a pas de numéro.
- ✅ **Codes publics (socle API) COMPLET** : chaque **scénario, bloc de scénario, champ (perso ET de base)
  et tag** porte un code unique lié au client (ex. `scn_by5p57_01KXNV…`, `nod_…`, `fld_…_sys_email`), affiché
  discrètement (liste des scénarios, panneau de config d'un bloc, page Champs, page Tags). C'est l'identifiant
  stable qu'une future API utilisera. Les codes des blocs sont posés côté serveur à l'enregistrement (un code
  existant n'est jamais changé).

### Ce qu'un contact a coûté, et jusqu'où il est allé

En haut de l'onglet **Historique** d'une fiche contact, deux chiffres face à face.

- **Ce qu'il a coûté** : ses envois de campagne, chiffrés à VOTRE prix (le tarif Meta de leur catégorie,
  majoré de votre marge). C'est un coût
  **estimé** et un **plancher** : seuls les envois de campagne y entrent, un message de scénario ou une
  réponse d'opérateur dans la fenêtre de service n'y est pas. ⚠️ Quand aucun envoi n'a pu être chiffré, la
  case affiche « — » et jamais « 0 € » : un coût inconnu n'est pas un coût nul. Les envois non chiffrés sont
  annoncés avec leur cause (catégorie non enregistrée, ou tarif que Meta ne rend pas).
- **Jusqu'où il est allé** : l'entonnoir de ses engagements. Un engagement de niveau N veut dire qu'il a
  réagi, en répondant **ou en cliquant**, à notre N-ième message d'un même parcours. L'entonnoir est cumulé
  (« au moins N »), sur cinq niveaux, le dernier ramassant ce qui est plus profond.

## Templates WhatsApp (menu Contenu)

- ✅ **Création** : template simple (**en-tête optionnel** texte / image / vidéo, corps + variables, **pied de
  page optionnel**, boutons quick-reply / URL / **Flow**) ou **carousel** (message d'introduction commun à
  toutes les cartes + 2-10 cartes image, texte de carte optionnel, boutons identiques sur toutes les cartes).
  Soumission à validation Meta, suivi du statut. En-tête texte et pied de page : 60 caractères max, sans
  variable (l'en-tête texte accepte un titre fixe uniquement).
- ✅ **Les clics sur les boutons de lien sont comptés** (2026-08-20) : tu saisis **ton** lien normalement. Au
  moment de la soumission à Meta, le serveur le remplace par une adresse à nous qui compte le clic puis redirige
  vers ta page. **La console te remontre toujours TON lien**, partout où elle affiche un template, donc rien ne
  change pour toi. Les compteurs se lisent dans Analytics > Mes tableaux.
  ⚠️ Deux limites dites franchement : seuls les templates **créés depuis le 2026-09-02** sont attribués (un
  template déjà approuvé porte son adresse figée chez Meta et ne pourra jamais en changer, ses clics restent
  donc anonymes) ; et **seuls les BOUTONS** sont tracés. Un lien écrit dans le **corps** du message n'est pas
  traçable, décision de Julien du 2026-08-20 : WhatsApp va chercher lui-même ces liens pour en afficher
  l'aperçu, un compteur y compterait des robots.
- ✅ **On sait QUI a cliqué, pas seulement combien** (2026-09-02) : chaque destinataire reçoit un identifiant
  opaque qui voyage dans le lien, et le clic est rattaché à sa fiche. Ça se voit dans le mini-CRM : la ligne de
  campagne passe à **« Engagé »**. C'était un vrai trou, parce qu'un bouton lien fait SORTIR le contact de la
  conversation et ne produit donc aucun message entrant : la personne la plus intéressée de la campagne
  s'affichait comme n'ayant pas réagi.
  ⚠️ L'identifiant ne porte ni nom ni numéro, il ne dit rien à qui le lit. Et un message **transféré** attribue
  le clic au destinataire d'origine : c'est la limite de tout suivi de lien, elle n'a pas de solution.
- ✅ **Les liens des messages RCS sont comptés et attribués eux aussi** (2026-09-02), sur les quatre chemins
  d'envoi : campagne, bloc de scénario, réponse rapide et envoi manuel depuis l'inbox. Rien à faire pour toi,
  et **aucune des limites du WhatsApp ne s'applique** : un message RCS est composé au moment de l'envoi, donc
  il n'y a ni validation à attendre ni ancien message impossible à rattraper. Les compteurs se lisent au même
  endroit, dans Analytics > Mes tableaux, sur les blocs RCS d'un scénario.
- ✅ **Langue = menu déroulant** (39 langues WhatsApp, plus de champ libre) **sur le template simple** ; une
  langue hors liste est aussi refusée côté serveur. Une langue existante hors liste (ancien champ libre) reste
  affichée à l'édition. Un **carousel** ne propose ni langue ni catégorie : il est toujours créé en
  **français**, catégorie **marketing**.
- ✅ **Sélecteur de variable + chips dans le corps** : bouton « + Variable » → on choisit une source dans **deux
  groupes (« Champs de base » : Date du jour (auto), Nom, Prénom, Téléphone, BSUID, WhatsApp ID, Email ·
  « Mes champs » : les champs perso), exactement la même liste que la campagne** au lieu de taper `{{n}}`.
  La variable s'affiche **directement dans la zone d'édition comme une puce lisible `[Prénom]`** (plus de `{{1}}`),
  et **l'exemple exigé par Meta se remplit tout seul**. La source « Date du jour (auto) » se remplit à l'envoi
  avec la date du jour. **Chaque variable DOIT être rattachée à une source : l'enregistrement est bloqué
  sinon** (fini le `{{n}}` tapé à la main qui partirait vide et se ferait rejeter par Meta). Supprimer une puce
  puis en réinsérer une ne casse pas la numérotation (renumérotée proprement à l'envoi).
  Le lien variable→champ est mémorisé : à la création d'une campagne avec ce template, le mapping est **déjà
  pré-rempli** (modifiable). Le texte d'un **bouton** est limité à **25 caractères** (limite Meta).
- ✅ **Dupliquer un template** (2026-08-17) : l'action **« Dupliquer »** ouvre l'écran de création DÉJÀ REMPLI
  avec le contenu du template choisi, sous un nom libre suffixé `_copie`. Rien n'est envoyé à Meta tant qu'on
  n'a pas cliqué sur « Créer le template », et un bandeau le dit : c'est une COPIE en préparation, l'original
  n'est jamais modifié ni renvoyé en validation.
- ✅ **En-tête média** : l'image **ou la vidéo** uploadée s'affiche pour de vrai dans l'aperçu WhatsApp (plus
  juste une icône).
- ✅ **L'aperçu porte le NOM DE L'ENTREPRISE** (2026-08-21) : l'en-tête de la miniature WhatsApp affiche le
  **nom vérifié** du compte, celui que le destinataire lit en haut de sa conversation, et non plus le libellé
  générique « Votre entreprise ». Vaut pour les six aperçus (création de template, création de carrousel,
  liste des templates, campagne directe, campagne par scénario, envoi depuis l'inbox). Sur un espace à
  **plusieurs numéros**, l'écran de campagne montre le nom du numéro RÉELLEMENT choisi. Le libellé générique
  ne reste qu'en repli : aucun numéro rattaché, ou nom pas encore remonté de Meta.
- ✅ **Envoi d'un carousel** : un template carousel s'envoie **depuis une campagne**, les images de chaque carte
  étant relues au lancement (l'opérateur n'a rien à ressaisir). Avant, tout envoi de carousel échouait pour
  100 % des destinataires, avec un message qui parlait d'une variable alors que le template n'en avait aucune.
  Deux cas sont désormais refusés d'avance, avec la raison exacte portée sur chaque destinataire : une carte
  dont l'image n'est pas récupérable, et une carte dont le texte contient une variable (le lien variable de
  carte vers champ client n'existe pas). Un carousel n'est **pas** proposé à l'envoi manuel depuis l'Inbox,
  et le sélecteur explique où l'envoyer.
- ✅ **Boutons d'un carousel : un texte et un lien PROPRES À CHAQUE CARTE**. On règle une fois la disposition
  (jusqu'à 2 boutons, réponse rapide ou lien), puis chaque carte a son propre libellé et sa propre destination :
  la carte « Masterclass » renvoie à la masterclass, la carte « Portes ouvertes » aux portes ouvertes. Avant, un
  jeu de boutons unique s'appliquait à toutes les cartes, donc 10 cartes pointaient au même endroit. Contrainte
  Meta respectée et affichée : la disposition (nombre, types, ordre) doit être la même sur toutes les cartes,
  seuls le texte et le lien varient. Le champ du lien occupe désormais toute la largeur de la carte.
- ✅ **Le bloc d'envoi montre l'aperçu du message** : un bloc « envoi de template » configuré sur un carousel
  affiche le message tel qu'il partira (bulle d'introduction, vignette de chaque carte, son texte, ses boutons).
  Les cartes sont **empilées et défilantes** : le bloc garde sa taille même avec 10 cartes. Les points de
  liaison, eux, restent listés juste sous l'aperçu, toujours visibles, chacun étiqueté par sa carte.
- ✅ **Brancher un scénario sur les boutons d'un carousel** : un bloc « envoi de template » qui envoie un
  carousel expose désormais **une sortie par bouton de carte** (10 cartes x 2 boutons = 20 destinations), chacune
  étiquetée « C1 », « C2 »… pour savoir de quelle carte elle vient. Avant, le bloc n'affichait aucune sortie et
  rien ne pouvait être branché après lui. Les boutons **lien** restent volontairement non reliables : ils ouvrent
  le navigateur et ne renvoient rien à WhatsApp, il n'y a donc aucun événement à brancher.
- ✅ **Aperçu d'un carousel déjà créé** : cliquer sur le nom d'un template carousel montre ses vraies cartes
  (image, texte, boutons) façon WhatsApp, au lieu d'un simple encadré. Une carte sans image visible, une carte
  vidéo, ou une image devenue injoignable sont annoncées telles quelles, jamais une vignette cassée.
- ✅ **Édition** (templates simples) : corps / boutons / catégorie. Avertissement « repasse en validation Meta ».
  **Bloquée** si le template a un **en-tête média** (image ou vidéo : Meta le supprimerait) ou s'il s'agit d'un
  **carousel**, ou s'il est utilisé par une **campagne active** (garde-fou anti envoi cassé). Un **pied de
  page** ou un **en-tête texte** n'empêchent pas l'édition. Nom et langue non modifiables (immuables chez Meta).
- ✅ **Pas d'édition tant que Meta n'a pas tranché** : un template encore en attente de validation n'est pas
  éditable (seuls approuvé, refusé et suspendu le sont). Le message le dit explicitement.
- ✅ **Suppression** : par nom (toutes langues) ; bloquée si une campagne active l'utilise.

## Formulaires WhatsApp (WhatsApp Flows, menu Contenu)

- ✅ **Constructeur visuel, tous les composants** : éléments ordonnables (monter / descendre / retirer) :
  titres (grand / sous-titre) / paragraphe / légende / **image** / saisies (texte, e-mail, téléphone, nombre,
  **code secret**, zone de texte, **date**) / **choix** (liste déroulante, **choix unique**, **choix
  multiple**) / **consentement (OptIn)** / **bouton final au libellé personnalisable**. Chaque champ se coche
  **Obligatoire** ou non, et chaque libellé de champ doit être unique (tous écrans confondus). **Aperçu fidèle
  de l'écran WhatsApp** en direct (le même rendu s'ouvre en cliquant sur le nom d'un formulaire dans la liste).
- ✅ **Formulaires MULTI-ÉCRANS** (2026-07-17) : onglets d'écrans dans le constructeur (ajouter / renommer /
  réordonner / supprimer, jusqu'à 10), titre d'en-tête et bouton « Continuer » personnalisables par écran, le
  dernier écran porte le bouton final. L'aperçu se **pagine** (◀ Écran N/M ▶), la miniature montre l'écran 1.
  Toutes les réponses (tous écrans confondus) reviennent d'un coup à l'envoi du formulaire.
- ✅ **Champs conditionnels** (2026-07-17) : chaque élément (texte, image ou champ) peut être « **Visible si…** »
  une liste à choix unique ou un consentement PLUS HAUT sur le même écran a une certaine valeur (est / n'est
  pas). Le contact ne voit le champ que si sa réponse le déclenche ; un champ resté masqué n'écrase JAMAIS une
  valeur déjà connue de la fiche contact. Badge « 👁 Visible si… » dans l'aperçu.
- ✅ Chaque **champ de saisie se range dans un user field du contact** (« Nouveau champ » d'après le libellé,
  ou un user field existant). À la réception du formulaire rempli, les valeurs atterrissent dans la fiche contact
  + la réponse apparaît dans l'inbox. **Champs de base proposés** (2026-07-28) : le menu « Enregistrer dans »
  propose désormais les champs de BASE (**Nom, Prénom, Email**) en plus des champs perso, et **suggère** celui qui
  correspond au libellé du champ (« Email » → Email, « Nom » → Nom…), insensible casse/accents. Le champ de base
  « Nom » alimente le nom d'affichage du contact (profile_name), les autres la fiche.
- ✅ **Consentement (OptIn) exploitable** (2026-07-17) : dans le constructeur, un champ « Consentement » se range
  dans le **champ Oui/Non de ton choix** (par défaut « Consentement WhatsApp », créé automatiquement). Quand le
  contact coche la case et envoie, on enregistre le champ ET **on passe son statut opt-in à « accepté »** : il
  devient éligible aux campagnes marketing (le consentement capté sert enfin à quelque chose). Un consentement
  frais l'emporte sur un désabonnement antérieur. Les valeurs Oui/Non sont stockées de façon uniforme.
- ✅ **Brouillon puis publication** : un formulaire créé depuis le menu Contenu naît en **brouillon** (badge dans
  la galerie) et n'est utilisable qu'une fois **publié** (bouton « Publier », avec confirmation : la publication
  est irréversible, un formulaire publié ne se modifie plus). Seuls les formulaires publiés sont proposés à
  l'attache d'un bouton Flow de template.
- ✅ **Depuis un template** : le bouton « + Flow » crée un formulaire inline (publié aussitôt) OU en choisit un
  déjà publié, puis l'attache au template (bouton FLOW exclusif).
- ✅ **Édition / duplication** : un brouillon s'édite ; un formulaire publié est immuable, l'action
  **« Dupliquer »** en crée une copie modifiable (« … (copie) », « … (copie 2) » si le nom est pris) qui s'ouvre
  aussitôt en édition.
- ✅ **Suppression** : un brouillon est supprimé, un formulaire publié est déprécié (Meta ne permet pas de le
  supprimer). Si le formulaire est encore rattaché à un template, Meta refuse et le message est affiché.
- ✅ **Bouton « Rafraîchir »** (2026-08-25) : va chercher les formulaires du **compte WhatsApp Manager** et met
  la liste à jour. Sert à deux choses : faire apparaître ici un formulaire **construit ailleurs que dans la
  console**, et reprendre un **renommage ou une publication faits dans WhatsApp Manager**. Un compte-rendu
  s'affiche (importés / mis à jour / ignorés / présents ici mais plus chez Meta). **Ce qu'un formulaire importé
  sait faire, et ce qu'il ne sait pas** : il s'attache à un template et s'envoie dans un scénario comme les
  autres, mais **ses réponses n'alimentent pas les fiches contact** et son aperçu reste indisponible, parce que
  Meta ne renvoie pas la structure d'un formulaire (l'écran le dit au moment de l'import). Pour un formulaire
  qui remplit les fiches, il faut le construire ici. Rien n'est supprimé automatiquement : un formulaire que
  Meta ne liste plus est signalé, la suppression reste une décision manuelle.

## E-mail (menu Compte > Boîtes email, menu Contenu > Modèles d'email)

Troisième canal, réservé aux scénarios : il n'existe ni campagne e-mail ni inbox e-mail. Un bloc
de scénario envoie un mail à l'adresse portée par la fiche du contact.

- ✅ **Connecter sa boîte** (menu **Compte** en haut à droite > **Boîtes email**, admin) : on
  déclare une ou plusieurs boîtes SMTP (nom d'affichage, serveur, port, identifiant, mot de
  passe, adresse d'expéditeur, nom d'expéditeur, adresse de réponse). Le mot de passe est
  **chiffré chez nous et jamais réaffiché** : un champ laissé vide à l'édition veut dire
  « inchangé ». Un bouton **« Tester »** envoie un vrai message à l'adresse de votre choix, ce
  qui est le seul moyen de savoir qu'un mot de passe d'application est bon avant qu'un client
  n'en fasse les frais.
- ✅ **Écrire ses modèles** (menu **Contenu > Modèles d'email**) : un nom, un sujet, un corps,
  au choix en **texte simple** ou en **HTML brut** (pour coller un mail préparé ailleurs). Le
  sujet et le corps acceptent des **variables**, insérées par le **même bouton « + Variable »**
  que les templates WhatsApp et les messages RCS, avec la même liste de champs de base et de
  champs perso. On ne recopie jamais `{{prenom}}` à la main.
- ✅ **Le bloc « Envoi de mail » dans un scénario** : il est présenté **à part dans la palette
  et grisé tant qu'aucune boîte n'est connectée**, avec l'infobulle qui renvoie à Compte >
  Boîtes email. Même doctrine que le bloc RCS : un bloc qui ne peut rien envoyer ne doit pas
  être proposé comme s'il le pouvait.
- ✅ **Jusqu'à 3 destinataires** (2026-08-25) : on choisit le champ qui porte l'adresse, et on
  peut en ajouter deux autres. Le premier part en « À », les suivants **en copie cachée** : les
  destinataires ne se voient pas entre eux.
- ✅ **Le sélecteur de destinataire dit combien de fiches ont ce champ rempli**, par exemple
  « Email (12/40 fiches) ». C'est ce qui distingue deux champs voisins dont l'un est vide
  partout : brancher un bloc mail sur un champ vide, c'est n'envoyer aucun mail.
- ✅ **Un échec n'interrompt JAMAIS le parcours** : le scénario continue. Les envois et les
  échecs se comptent dans **Analytics > Mes tableaux**.

## Automatisations (menu « Scénario », ex-« Flow »)

- ✅ **Brouillon et bouton « Publier »** (2026-09-01). Modifier un scénario ne change plus rien pour les
  contacts tant qu'on n'a pas publié.
  - L'éditeur enregistre toujours tout seul, mais ce qu'il enregistre est un **brouillon**. Avant, la moindre
    retouche partait en production dans la seconde, y compris pour les contacts en plein parcours.
  - Le bouton **« Publier »** apparaît en haut à droite dès qu'il y a quelque chose à mettre en ligne. Quand
    il n'y a rien en attente, on lit à sa place depuis quand la version en cours est en ligne.
  - La liste des scénarios signale ceux qui portent un **brouillon non publié**, et compte les blocs de ce
    qu'on est en train d'éditer.
  - **Le lien de test joue le brouillon** : on essaie sa version avant de la mettre en ligne, c'est tout
    l'intérêt. Un contact réel, lui, ne voit que la version publiée.
  - **Un parcours déjà en cours suit la nouvelle version** dès qu'elle est publiée, et une campagne
    programmée part avec la version en ligne **le jour de l'expédition**, pas celle de sa préparation.
  - **Dupliquer copie ce qu'on voit** (le brouillon s'il y en a un), et la copie naît elle-même en brouillon :
    rien n'est en ligne tant qu'on n'a pas publié.
  - ⚠️ **Un scénario jamais publié n'apparaît pas dans le sélecteur de campagne** : une campagne envoie la
    version en ligne, et il n'y en a pas encore.
  - ⚠️ **Publier n'a pas de retour arrière** : la version précédente n'est conservée nulle part.
  - Qui a publié quoi et quand se lit dans le **journal des actions** de l'espace.

- ✅ **Nouveau bloc « Question »** (2026-08-26) : poser une question au contact et **router sa réponse**.
  - **Un MENU déroulant** au lieu de boutons : jusqu'à **10 réponses** (24 caractères chacune, avec une
    précision facultative en dessous), là où un message rapide plafonne à 3 boutons. Le contact ouvre le menu
    d'un tap et choisit sa ligne.
  - **Chaque réponse est une sortie à relier** vers le bloc de son choix.
  - **Sans menu**, c'est une question ouverte : le bloc attend quand même, et la réponse écrite part sur la
    sortie « Toute autre réponse ».
  - **Avec un menu, la sortie « Toute autre réponse » reste là** : un contact peut toujours écrire au lieu de
    choisir, et ce cas se prévoit.
  - **« Pas de réponse »** : on pose un délai (minutes, heures ou jours, 30 jours maximum) et une sortie
    supplémentaire apparaît sur le bloc. Passé ce délai sans réponse, le parcours part par là. À zéro, on
    attend sans limite et la sortie n'apparaît pas : elle ne partirait jamais.
  - Une réponse qui arrive **annule le délai**, et une ligne du menu **branchée sur rien** remonte la
    conversation à un humain plutôt que de laisser le contact sans réponse.
  - ⚠️ **WhatsApp uniquement**, et le contact doit avoir écrit dans les 24 h : le menu est un message libre.
    Un scénario qui **commence** par une question ne peut donc pas être lancé en campagne, il se déclenche
    depuis l'Inbox ou après un template.

- ✅ **La flèche CLIQUÉE se voit** (2026-09-01). Sur un scénario chargé, les flèches se croisent et se
  recouvrent : en cliquer une était le seul moyen de la désigner, mais rien ne disait LAQUELLE on venait de
  désigner. Elle passe désormais au bleu et s'épaissit, et les **deux blocs qu'elle relie s'annoncent
  « DÉPART » et « ARRIVÉE »** : la couleur seule ne suffit pas quand les deux bouts sont hors de l'écran.
- ✅ **Quatre frottements corrigés dans l'éditeur de scénario** (2026-08-26), tous signalés par Julien :
  - **Lâcher une flèche SUR le bloc visé suffit** désormais. Il fallait viser son petit point d'entrée à
    20 pixels près, sinon rien ne se passait et l'éditeur avait l'air cassé.
  - **La sortie « Toute autre réponse » n'est plus grise.** Elle était reliable depuis toujours, mais sur un
    bloc où tous les autres points sont bleus, un point gris se lit comme désactivé. C'est LA sortie à
    brancher pour prévoir le cas « le contact écrit au lieu de cliquer ».
  - **Le bloc RCS demande d'abord d'où vient le message** : d'un message enregistré, ou composé ici. Sur un
    message enregistré, l'image et le texte à modifier disparaissent (on vient de choisir un message tout
    fait) et un aperçu montre ce qui partira. Les blocs déjà construits gardent leurs champs.
  - **Trois pavés de texte retirés** du panneau latéral, qui expliquaient la mécanique des sorties au milieu
    d'un sélecteur de bouton et alourdissaient un écran déjà chargé.
- ✅ **Un lead venu d'une publicité WhatsApp déclenche un scénario** (2026-08-26). Nouveau déclencheur
  d'automation : « le contact arrive d'une publicité WhatsApp ». On peut viser **une pub précise** par son
  identifiant, ou **laisser vide pour toutes les pubs**, ce qui est le montage le plus courant. Un message
  ordinaire ne déclenche jamais ce scénario. Et comme le contact vient d'écrire, le scénario peut commencer
  par un message rapide, sans template à faire approuver.
  L'origine est aussi **posée sur la fiche du contact** (champs « Pub (identifiant) » et « Pub (titre) ») dès
  le premier message : elle devient filtrable dans le mini-CRM, utilisable comme variable dans un message, et
  segmentable en campagne. ⚠️ Meta ne transmet cette origine qu'au PREMIER message après le clic, et l'envoie
  seulement si l'attribution est activée côté WhatsApp Business : à vérifier dans les réglages avant la
  première campagne publicitaire.
- ✅ **Le bloc « message rapide » peut porter un BOUTON DE LIEN** (2026-09-11). Une case « ce message porte
  un bouton de lien », puis un libellé (20 caractères) et une adresse : le contact reçoit un bouton qui ouvre
  la page dans son navigateur. ⚠️ **Il exclut les réponses rapides, et ce n'est pas notre choix** : chez Meta,
  des réponses rapides et un bouton de lien sont deux TYPES de messages différents, et un message n'a qu'un
  type. Cocher la case retire donc les réponses rapides, avec la raison écrite à l'endroit où elles
  disparaissent. Le contact qui clique **ne renvoie rien** au scénario (Meta n'émet aucun retour pour ce
  bouton) : le bloc n'a donc pas de sortie à relier, et le parcours continue tout de suite après, comme après
  un simple texte. Sur un parcours **RCS**, le même bloc part avec une suggestion « ouvrir un lien », si bien
  qu'un scénario se monte une fois pour les deux canaux. Une adresse vide, mal formée ou porteuse d'une
  variable **fait refuser l'envoi** au lieu de laisser partir le message sans son bouton, et l'écran la
  signale dès la saisie.
- ✅ **Le bloc « message rapide » accepte une image** (2026-08-25). Même champ et même téléversement que le
  bloc RCS : un seul visuel, qui sert aux DEUX canaux. En WhatsApp il part en en-tête du message, au-dessus du
  texte et des boutons ; sur un parcours RCS, le message devient une carte qui porte l'image. Sans aucune
  réponse rapide, il part en image légendée. Si le visuel ne peut pas être préparé pour l'envoi, le bloc
  REFUSE au lieu d'envoyer le texte tout seul : un message ampute de son image sans que personne ne le sache
  serait pire que pas de message. Le visuel reste soumis à la fenêtre de 24 h, comme le bloc lui-même.
- ✅ **Un scénario ne rate plus en silence** (2026-08-25). Trois trous fermés d'un coup, après un test de
  Julien où rien n'est parti et où rien ne l'a dit :
  - **Un bouton qui ne mène nulle part est signalé dans l'éditeur**, sur sa propre ligne, avec un point rouge
    et l'explication au survol. Avant, on pouvait proposer un choix au contact sans rien brancher derrière :
    il tapait, et il ne recevait rien. La sortie « toute autre réponse » n'est pas concernée, la laisser
    libre reste un choix normal.
  - **Si le cas se produit quand même**, la conversation remonte en « À traiter » dans l'Inbox au lieu de se
    terminer sans bruit. Une réponse ÉCRITE hors des boutons, elle, reste traitée comme avant.
  - **Le bloc « Envoi de mail » se mesure** dans Analytics > Mes tableaux : « envoyés » et « échecs ». Il
    n'écrivait rien du tout, ni en cas de réussite ni en cas d'échec : impossible de savoir lequel des deux
    s'était produit. Un mail échoue pour des raisons ordinaires (champ destinataire vide sur la fiche, boîte
    ou modèle supprimé, SMTP qui refuse), et un échec n'interrompt toujours JAMAIS le parcours.
- ✅ **Le sélecteur de destinataire d'un mail dit combien de fiches ont ce champ rempli** (2026-08-25),
  par exemple « Email (12/40 fiches) ». C'est ce qui manquait pour distinguer deux champs voisins dont l'un
  est vide partout : brancher un bloc mail sur un champ vide, c'est n'envoyer aucun mail.

- ✅ **Une réponse écrite ne se fait plus passer pour un bouton** (2026-08-21) : quand le contact ÉCRIT au lieu
  de taper l'un des boutons proposés, le parcours ne part plus dans la branche du premier bouton. Concrètement,
  quelqu'un qui répondait « non merci » à un bloc Oui/Non se retrouvait taggé « oui ». Désormais : si une sortie
  **« toute autre réponse »** est reliée sur le bloc, c'est elle qui est suivie ; sinon le parcours s'arrête là
  et l'agent reprend la parole. Cette sortie est un nouveau point de liaison, sous les boutons du bloc : la
  brancher permet de prévoir un cas « le client a écrit autre chose », la laisser libre revient à dire « ce
  scénario n'a rien prévu pour ça ».

- ✅ **Bloc « Attente »** (2026-08-15, **trois façons de reprendre depuis le 2026-09-08**) : met le parcours en
  pause, puis la suite repart toute seule. Trois choix, dans le panneau du bloc :
  - **après un délai** : minutes, heures ou jours (30 jours maximum), tenu à la minute près environ ;
  - **à une date précise** : une date et une heure, valables pour tous les contacts qui passent par ce bloc,
    lues dans le fuseau de l'espace (onglet Paramètres). Une date déjà passée ne retient personne ;
  - **aux prochaines heures ouvrées** : s'il est 1 h du matin, la suite ne repart qu'à l'ouverture du jour,
    telle qu'elle est réglée dans Paramètres. Si on est déjà dans les heures ouvertes, ça continue sans
    attendre ; si aucun jour n'est ouvert, le bloc ne retient personne.

  Un bloc dont le réglage n'est pas encore fait laisse simplement passer, il ne bloque personne.
  ⚠️ Les deux attentes datées n'ont pas de durée connue d'avance : elles comptent donc pour une attente
  LONGUE, et le constructeur refuse un message rapide ou un formulaire derrière elles, comme après 24 h.
  ⚠️ **Après une attente, seul un envoi de template peut encore partir.** WhatsApp n'accepte un message libre
  que dans les 24 h qui suivent le dernier message du client. Le constructeur signale donc en clair un montage
  « attendre 24 h ou plus, puis message rapide », en nommant les deux blocs concernés. Et si la fenêtre s'avère
  fermée au moment de la reprise, le message n'est pas envoyé : la conversation remonte dans l'Inbox pour
  qu'une personne la reprenne, plutôt que de compter un envoi qui n'a jamais eu lieu.
- ✅ **La nature d'un bloc se choisit à sa création, plus après** : le panneau de droite ne sert qu'à configurer
  le bloc (choix du template, de l'action, de la durée…). Quand on tire une flèche dans le vide, ou qu'on insère
  un bloc sur une flèche existante, la liste des natures s'affiche et on choisit. Avant, le bloc était deviné
  puis se changeait dans le panneau, ce qui laissait derrière lui la configuration d'un autre type.
- ✅ **Éligibilité campagne élargie** (2026-08-15) : un scénario peut partir en campagne dès lors que le
  **premier message envoyé** est un template. Un tag, une action ou une condition placés avant ne changent
  rien : ils n'envoient rien. Seul un scénario qui ouvre par un message rapide ou un formulaire reste réservé
  aux contacts qui viennent d'écrire. Le refus explique désormais laquelle de ces raisons s'applique, y compris
  les deux cas moins évidents : une attente avant le premier envoi (rien ne partirait au lancement, il faut
  plutôt programmer la campagne avec « Plus tard »), et un scénario dont la branche prise déciderait de deux
  templates différents (impossible de savoir lequel paramétrer).

- ✅ **Constructeur de workflow visuel** : (...) Blocs proposés : **Envoi template**, **Message
  rapide**, **Question**, **Formulaire** (envoie un WhatsApp Flow), **Action** (tag / champ /
  consentement), **Condition** (aiguillage), **Attente**, **Assigner à un agent** (passe la main
  à un humain). Trois blocs sont présentés **à part et grisés** tant que ce qui les alimente
  n'existe pas, chacun avec l'infobulle qui dit où l'activer : **Message RCS** (tant qu'aucun
  agent RCS n'est déposé), **Envoi de mail** (tant qu'aucune boîte email n'est connectée) et
  **Agent IA** (tant qu'aucun agent n'est actif). Les anciens blocs « ajout de tag » et « ajout
  de champ » ne sont plus proposés à la création, mais restent lisibles et modifiables sur les
  scénarios existants. Les deux blocs **MBA** (envoi vers MBA, désactivation MBA) ont été
  **retirés du produit** : ils ne faisaient rien ; un ancien scénario qui en contient encore les
  affiche sous le libellé « Bloc MBA (retiré) » et le moteur les traverse sans agir.
- ✅ **Bloc « Action »** (2026-08-02) : un seul bloc pour agir sur la fiche du contact, avec 4 actions au choix :
  **ajouter un tag**, **retirer un tag**, **mettre à jour un champ** (valeur fixe, ou « maintenant » = la date et
  l'heure du passage du contact), **vider un champ**. Il remplace dans la palette les anciens blocs « ajout de
  tag » et « ajout de champ ». Un tag saisi ici apparaît dans Contenu > Tags dès qu'on quitte le champ.
- ✅ **Bloc « Condition »** (2026-08-02) : aiguille le contact selon son état, avec **deux sorties à relier**,
  « Si réunie » (verte) et « Sinon » (rouge). On empile plusieurs conditions, combinées en **toutes** ou
  **au moins une** : **tag** (possède / n'a pas), **champ** (texte : contient, ne contient pas, est exactement,
  est renseigné, est vide ; nombre : égal, différent, <, ≤, >, ≥ ; oui/non ; date : est avant, est après,
  remonte à plus de / à moins de N minutes, heures, jours), **jour de la semaine**, **heures d'ouverture**
  (celles réglées par le client), **heure de la journée**, **coordonnées** (a un téléphone, un email, un
  identifiant WhatsApp), **consentement**. Sans aucune condition posée, le contact part toujours sur « Si
  réunie » ; une branche laissée non reliée arrête simplement le parcours.
- ✅ **Nommer un bloc** (2026-08-02) : chaque bloc a un champ **« Nom du bloc »** libre et optionnel (64
  caractères, ex. « Relance J+3 »). Le nom s'affiche sur la vignette du bloc à la place de son type, et se
  retrouve dans la colonne **Nom** de Contenu > Blocs, ce qui rend un gros scénario lisible d'un coup d'oeil.
- ✅ **Gérer un scénario depuis la liste** (2026-07-28) : le tableau récap garde « Ouvrir » et ajoute un menu
  **3 points** par ligne : **Tester le scénario**, **Renommer**, **Dupliquer** (copie « (copie) », « (copie 2) »…),
  **Supprimer**. Colonnes **Nom** (avec le code public du scénario), **Blocs**, **Créé le** (date + heure).
- ✅ **Tester le scénario depuis son téléphone** (2026-08-03) : « Tester le scénario » ouvre un **QR code** et un
  **lien WhatsApp** avec un mot déjà écrit. On scanne, on appuie sur Envoyer, et le scénario démarre sur son
  propre numéro, sans campagne et sans attendre qu'un vrai client écrive. Comme c'est le testeur qui parle en
  premier, même un scénario qui ouvre par un message rapide ou un formulaire se teste. Le lien est **permanent**
  pour ce scénario. La conversation de test est **marquée comme telle** : ses messages ne comptent ni dans les
  statistiques ni dans l'analyse (le numéro testeur apparaît en revanche dans le mini-CRM, comme tout numéro qui
  écrit). Sans numéro WhatsApp connecté, le mot à envoyer est affiché pour être recopié à la main.
- ✅ **Tester À PARTIR D'UN BLOC précis** (2026-09-16) : chaque bloc du constructeur porte un **petit bouton
  lecture** en haut à gauche. Il ouvre le même panneau (QR + lien), mais le scénario démarrera **à ce
  bloc-là**, pas au début. On teste ainsi un bout de parcours sans avoir à dérouler tout ce qui précède, et
  sans envoyer de template. Le lien reste permanent ; si le bloc a été supprimé depuis, le test **ne démarre
  pas** plutôt que de repartir du début. Les variables comme `{{prenom}}` sortent normalement : elles
  viennent de la fiche du contact qui teste, pas du parcours. ⚠️ Ce qui précède le bloc n'est pas rejoué et
  **le panneau ne prévient pas** : décision de Julien, « tant pis, il ne se passe rien ».
- ✅ **Un test DÉSENCLENCHE l'agent de Meta** (2026-09-16) : envoyer un lien de test reprend la conversation à
  l'agent, même s'il la tenait, et le scénario démarre. Avant, l'agent répondait « je n'ai pas bien compris
  votre message » et le test ne partait jamais. Le fil **reste ensuite côté application** : on enchaîne les
  essais sans que l'agent s'intercale, et on le réenclenche quand on veut avec le bouton de la conversation
  dans l'Inbox. Une conversation née d'un test le reste.
- ✅ **Un test joue LA MÊME version du début à la fin** (2026-09-16) : le brouillon est figé dans le parcours
  au démarrage. Avant, un test démarrait sur le brouillon mais **repartait sur la version en ligne** dès que
  le testeur répondait à une question ou qu'une attente se réveillait : on essayait deux versions sans le
  savoir, et le parcours pouvait s'arrêter sans un mot si le bloc courant n'existait pas en ligne.
- ✅ **Enregistrement AUTOMATIQUE** : plus de bouton « Enregistrer » ni de statut « brouillon » : le scénario se
  sauvegarde tout seul ~1 s après chaque modification (indicateur « Enregistré à HH:MM »), y compris quand on
  quitte la page ou ferme l'onglet. En cas d'échec réseau : indicateur rouge + « réessayer ».
- ✅ **Bloc « message rapide »** : un texte + **jusqu'à 3 réponses rapides** (20 caractères chacune), envoyé SANS
  template Meta approuvé (message interactif). Chaque réponse devient une **sortie à relier** (branche par
  bouton, comme un template). Au choix, **un bouton de lien** à la place des réponses rapides (voir plus haut,
  2026-09-11) : les deux ne peuvent pas cohabiter dans un même message WhatsApp. Depuis le 2026-08-02, il peut aussi **ouvrir un scénario**, à condition que le
  déclenchement garantisse que le contact vient d'écrire (mot-clé, premier message, lien de test) : c'est
  uniquement en **campagne** qu'il est refusé, une campagne partant sur une audience froide.
- ✅ **Bloc « formulaire » ENVOIE vraiment** (2026-07-17, fini le blocage silencieux) : le bloc envoie le
  formulaire choisi en message WhatsApp interactif, avec un **texte d'accroche** et un **libellé de bouton**
  personnalisables (pré-rempli avec le bouton du formulaire). Quand le contact soumet, ses réponses remplissent
  sa fiche et le scénario avance. Comme le message rapide, il peut désormais **ouvrir un scénario** (2026-08-02) :
  l'enregistrement n'est plus refusé. Le constructeur se contente d'un avertissement jaune sur le **premier bloc**
  du scénario, qui rappelle qu'un scénario n'ouvrant pas par un envoi de template ne pourra pas partir en
  campagne (mais reste parfaitement utilisable quand le contact vient d'écrire).
  - **Tirer une flèche dans le vide crée un bloc** à cet endroit (relié), puis on choisit son type dans le
    panneau de droite. Un **✕** en coin de chaque bloc le supprime directement (avec ses flèches).
- ✅ **Variables du template collées automatiquement** : quand un bloc « envoi template » part (au lancement OU
  au fil du workflow), les variables du template sont **remplies avec les attributs du contact** (ex. `{{1}}`
  relié à Prénom -> le prénom du contact), avec repli sur l'exemple du template. Plus besoin de re-saisir la
  variable ; corrige l'erreur Meta « nombre de variables ».
- ✅ **Sortie par bouton** : un bloc « envoi template » affiche **une sortie par bouton de réponse rapide**
  (à relier vers le bloc suivant) ; les boutons lien/formulaire sont montrés grisés (ils sortent de WhatsApp,
  non reliables). Un bloc sans réponse rapide garde une sortie unique.
- ✅ **Exécution réelle par contact** : le scénario s'exécute vraiment, contact par contact, quel que soit son
  point de départ (campagne, déclencheur d'Automation, lien de test, appel d'API) : les blocs Action s'appliquent
  au passage (visibles sur la fiche), un bloc Condition choisit sa branche, un bloc template / formulaire /
  message rapide envoie puis attend la réponse, et **le bouton tapé choisit la branche** suivie (une réponse
  texte suit la 1re sortie). Le parcours s'arrête au bloc **inbox**, qui **passe explicitement la main à un
  humain** : la conversation est marquée comme prise en charge. Et tant qu'un opérateur (ou l'agent MBA) tient la
  conversation, le scénario ne lui écrit pas : le parcours est simplement gelé et repart quand la main revient.

## Automation (menu « Automation »)

- ✅ **Le déclencheur « étape de deal HubSpot » se grise quand aucun portail n'est relié** (2026-08-23), avec
  la mention « HubSpot non connecté ». L'enregistrement était déjà impossible (pas d'étape à choisir), mais
  l'option restait sélectionnable, et le message renvoyait vers **Paramètres** alors que la connexion se fait
  sur l'**Accueil** : on envoyait chercher au mauvais endroit au moment précis où l'utilisateur est bloqué.

- ✅ **Lancer un scénario sur un événement, sans campagne** (2026-08-03) : un écran liste les automations (nom
  interne, déclencheur écrit en clair, scénario visé, active ou non). « Ajouter une automation » ouvre le
  formulaire ; une automation neuve est **toujours créée désactivée**, on la relit puis on l'allume d'un clic
  sur son badge. Une ligne se supprime ; pour changer son déclencheur ou son scénario, on la supprime et on la
  recrée. Un scénario supprimé entre-temps s'affiche comme tel sur la ligne. Réservé à l'admin.
- ✅ **Quatre déclencheurs proposés à l'écran** :
  - **le client envoie un mot-clé** : une liste de mots séparés par des virgules, au choix « le message contient »
    ou « le message est exactement » le mot-clé. Casse et accents ignorés.
  - **un nouveau contact écrit pour la 1re fois** (aucun réglage).
  - **un tag est posé sur un contact** : on saisit le tag qui déclenche.
  - **une conversation vient d'être analysée** : filtre par ressenti du client (négatif par défaut, neutre,
    positif, ou peu importe) et, en option, « seulement si la demande n'a pas été résolue ».
- ✅ **Un cinquième déclencheur, « un deal HubSpot atteint une étape »** (2026-08-16) : on choisit l'étape dans
  un menu qui liste celles du portail par leur NOM, groupées par pipeline (deux pipelines ont souvent une
  étape qui porte le même nom) et signalant les étapes de fin. Le scénario part quand un deal ARRIVE sur cette
  étape, pour le contact rattaché au deal, à condition qu'il ait un numéro. Le client n'écrivant pas à ce
  moment-là, le scénario doit commencer par un envoi de template. L'étape est retenue par son IDENTIFIANT,
  jamais par son libellé : la renommer dans HubSpot ne casse rien. Si aucun portail n'est relié à l'espace,
  l'écran le dit et invite à connecter HubSpot dans Paramètres.
- ✅ **Ce qui ne déclenche RIEN** (annoncé à l'écran, pas seulement en coulisse) : un tag posé **en masse**, par
  **import de fichier** ou par un scénario lancé en **campagne** (poser un tag sur 5 000 contacts enverrait
  sinon 5 000 messages : pour toucher une liste, l'outil reste la campagne) ; une conversation quand
  l'**analyse n'est pas activée** sur le compte (l'automation s'affiche « active » mais ne part jamais, un
  encart le dit à la création) ; un message reçu alors qu'un **opérateur, ou l'agent de Meta, tient la
  conversation** ; un contact pour lequel un **parcours de scénario est déjà en attente**.
- ✅ **Garde-fous d'envoi** : **anti-rebond d'une heure** par contact et par automation (un client qui répète le
  mot-clé ne relance pas le scénario), **plafond de 200 déclenchements par heure et par automation** (borne la
  facture quand un seul geste produit des milliers d'événements). ⚠️ Depuis le 2026-09-07, un parcours en cours
  ne bloque PLUS un nouveau déclenchement : **le nouveau scénario remplace celui en cours**, et le message qui
  l'a déclenché ne fait plus avancer l'ancien.
  Si le scénario n'a finalement rien envoyé, l'anti-rebond n'est pas consommé : la prochaine vraie demande du
  client passe quand même.
- ✅ **Quel scénario peut démarrer sur quel déclencheur** : mot-clé et nouveau contact partent d'un message reçu,
  la fenêtre de 24 h est donc ouverte et le scénario peut commencer par un message rapide ou un formulaire. Tag
  posé et conversation analysée arrivent à froid : le scénario doit commencer par un envoi de template, sinon
  rien ne part. L'écran le dit avant la création.
- ✅ **« Conversation analysée » est un déclencheur différé** : l'analyse ne tourne que lorsque la conversation
  est retombée inactive. L'automation part donc après coup, jamais dans la seconde qui suit le message.

## Campagnes

- ✅ **Le coût estimé d'une campagne est CELUI DU SERVEUR** (2026-09-23), calculé sur ce qui est réellement
  parti : modèles au tarif Meta, messages de service (franchise déduite) et RCS à vos deux prix. Cet écran
  le calculait lui-même, en multipliant les
  destinataires par le tarif Meta de la catégorie, si bien qu'une campagne à scénario n'ayant envoyé aucun
  modèle facturable, et une campagne RCS, affichaient un prix de modèle qu'elles n'avaient jamais payé.
  ⚠️ **Ce n'est pas le même chiffre que la fiche** de Performance Lab, et les confondre induirait en erreur :
  cette liste compte les modèles, les messages de service et le RCS sur la période lue, quand la fiche compte
  les seuls modèles, séparés en lancement et relances, sur toute la vie de la campagne.
  ⚠️ **« indisponible » n'est pas « gratuit »** : une campagne de plus de **90 jours**, ou au-delà des
  cinquante que ce calcul rend, garde sa case vide, et le total de la liste dit combien de campagnes il n'a
  pas su chiffrer.
  ⚠️ **Pour le coût d'une campagne plus ancienne**, passez par **Performance Lab > Synthèse**, carte
  « Coûts », et déplacez la période jusqu'à la couvrir (au-delà d'un an, déplacez plutôt que d'élargir : la
  plage est bornée à 366 jours). Cliquez alors sa ligne : c'est la FICHE qui porte le détail, la ligne montrant
  l'engagement. ⚠️ Si la campagne est archivée, cochez « Inclure les campagnes archivées » ; et le tableau ne
  garde que les cinquante plus grosses de la période, ce qui joue contre une petite campagne ancienne.
  ⚠️ **Passé la durée de conservation des conversations** (90 jours par défaut, réglable), le coût d'une
  campagne à SCÉNARIO n'est plus reconstituable : ses envois vivaient dans les conversations, qui ont été
  purgées. Une campagne à modèle direct, elle, garde son compte.
  ⚠️ Le panneau de détail de cet onglet-ci, lui, montre le même « indisponible » que la liste : il lit le
  même calcul.

- ✅ **Envoyer uniquement pendant les heures ouvrées** (2026-09-08, **seule question horaire depuis le
  2026-09-13**) : une case à cocher, à l'étape **Canal** de l'assistant. Elle vaut pour les premiers envois
  **et pour les relances**, avec chaîne de repli ou sans : c'est une contrainte de la campagne, pas de son
  lancement, et il n'y a plus de second réglage pour le rattrapage.
  - lancée hors créneau (à 23 h, par exemple), la campagne **n'est pas refusée** : elle attend la prochaine
    ouverture réglée dans Paramètres, et repart toute seule ;
  - un envoi que la fermeture interrompt **reprend au créneau suivant**, sans perdre un seul destinataire :
    ceux qui n'ont rien reçu restent en attente et partent à la réouverture.

  🔴 **CE QUE L'ÉCRAN NE DIT PAS ENCORE, ET IL FAUT LE SAVOIR** (mesuré le 2026-09-13). La liste des
  campagnes affiche « en pause », **sans la raison ni la date de reprise**. Cette page a affirmé le
  contraire pendant cinq jours, et c'est ce qui a fait chercher une panne là où il n'y en avait pas : une
  campagne lancée un dimanche sur un espace fermé le dimanche attendait simplement le lundi 9 h. Les deux
  informations existent en base, elles ne sont pas encore remontées à l'écran (cf. `todo.md`).

  ⚠️ **Changer ses heures d'ouverture ne réveille PAS une campagne déjà en pause** : l'échéance a été
  calculée au moment de la pause. Le bouton **« Reprendre »** de la liste est le geste qui rattrape ça.

  ⚠️ Si aucun jour d'ouverture n'est réglé, il n'y a aucun créneau où envoyer : la campagne se met en pause
  sans reprise automatique. Il faut alors régler les horaires, puis « Reprendre ».
- ✅ **L'assistant ne vous laisse plus avancer sans contenu** (2026-09-13) : tant qu'un étage de la
  chaîne n'a pas son modèle, son message RCS ou son gabarit d'e-mail, le bouton « Suivant » reste
  inactif et l'écran **nomme les étages qui manquent**. Avant, on atteignait le récapitulatif avec une
  campagne vide et le refus n'arrivait qu'au dernier écran, loin de l'endroit où on pouvait le corriger.
  La question « Que se passe-t-il quand le contact répond ? » n'apparaît qu'une fois **tout le contenu
  choisi**, étage de repli compris : on ne demande pas ce qui suit avant de savoir ce que le contact
  reçoit. (Elle ne regardait que le premier étage jusqu'au 2026-09-14.)
- ✅ **Une question à la fois, aux étapes Canal et Contenu** (2026-09-14). L'étape du canal ouvre sur la
  seule question du canal, **sans réponse pré-cochée** : le réessai et la question des heures ouvrées
  n'apparaissent qu'une fois WhatsApp, RCS ou le repli choisi, et « Suivant » reste inactif d'ici là en
  disant pourquoi. Aucune campagne ne peut donc partir sur un canal que personne n'a choisi.
- ✅ **Un étage « modèle et scénario » ne redemande pas ce que devient la conversation** (2026-09-14).
  Quand chaque étage ouvre un scénario, la question « Que se passe-t-il quand le contact répond ? »
  disparaît, et l'écran dit à sa place que **le scénario s'en charge** : c'est lui qui décide si un
  agent IA prend la main ou si la conversation revient à l'équipe. La poser ici aussi aurait donné deux
  réglages du même moment, dont c'est toujours le scénario qui gagne.
  ⚠️ **Un seul étage hors scénario la repose** : sur une chaîne dont le premier étage ouvre un parcours
  et dont le repli envoie un message simple, les contacts joints par le repli répondent sans qu'aucun
  scénario ne les prenne, et il faut bien dire où va leur conversation.
- ✅ **Réessayer les envois qui échouent : sur un canal seul uniquement** (2026-09-13). Avec une chaîne
  de repli, la question ne se pose plus : **le repli EST le rattrapage**, et le premier échec bascule
  déjà vers le canal suivant. Réessayer en plus, ce serait repartir sur le tuyau dont on sait qu'il ne
  passe pas.
- ✅ **Ce que la campagne envoie, et quand** (2026-08-11). Chaque campagne annonce, dans la liste **et** dans son
  détail, ce qu'elle envoie : `Template « promo_ete » (fr)` pour un envoi direct, `Scénario « Relance promo »`
  pour une campagne qui déclenche un scénario, `Scénario supprimé` si le scénario a disparu depuis. Une campagne
  scénario affichait avant `template ()`, parce qu'elle ne porte pas de template propre. Le détail gagne une
  colonne **« Envoyé le »** : date et heure d'envoi de chaque destinataire, ou « non envoyé ». Pour une campagne
  scénario, le template exact reçu par un contact donné se lit dans son fil de conversation, qui est la source
  fiable ; la campagne, elle, dit ce qu'elle a réellement fait, à savoir démarrer un scénario.
- ✅ **Une campagne commencée se retrouve** (2026-08-21, **réellement depuis le 2026-09-08**) : dès qu'on lui
  donne un nom, la composition en cours est **enregistrée toute seule** en brouillon. Un bloc **« Brouillons
  en cours »** apparaît en haut de la liste des campagnes, avec pour chaque ligne **« Reprendre »** et
  **« Supprimer »**. Un brouillon n'est **pas** une campagne : il n'a ni destinataire arrêté ni envoi
  possible, il ne compte dans aucun chiffre, et il n'apparaît pas dans la corbeille des archivées. Un nom
  vide n'enregistre rien, pour ne pas semer des brouillons fantômes.
  🔴 **Cette ligne promettait « rouvre exactement où on l'avait laissé : destinataires, message, variables,
  débit », et c'était FAUX.** Signalé par Julien le 2026-09-08 : « je ne sélectionne que quelques contacts,
  je ferme le site, je reviens, et il faut à nouveau que je sélectionne les personnes ». Deux causes : les
  **destinataires ne faisaient pas partie** de ce qui était enregistré, et surtout la sauvegarde ne partait
  **qu'au moment où le champ du nom perdait le focus**. Comme le nom est la première chose qu'on tape, le
  brouillon photographiait un écran encore vide : le message, les variables et le débit se perdaient eux
  aussi. Depuis, **l'écran s'enregistre en continu** (à la seconde près après chaque changement) et les
  destinataires en font partie.
  ⚠️ **Un contact disparu depuis est retiré de la sélection reprise, et l'écran le dit** (« N contacts de
  votre sélection ne sont plus là »). Le garder ferait mentir le compteur ; le retirer en silence ferait
  repartir une campagne vers moins de monde sans que personne ne s'en aperçoive.
  ⚠️ **UN BROUILLON COMMENCÉ AVANT LE 2026-09-13 SE ROUVRE NORMALEMENT** dans le nouvel assistant, avec son
  modèle, sa catégorie, ses contacts cochés, son débit et sa programmation. L'écran qui les écrivait a été
  retiré ce jour-là, et il était le seul à savoir les relire : le retirer sans savoir relire ce qu'il avait
  écrit aurait jeté, sans un mot, la campagne que quelqu'un avait commencée.

- ✅ **Archiver ou supprimer une campagne** (2026-07-20). Une campagne qui n'a **jamais rien envoyé** se
  **supprime** définitivement (confirmation). Toutes les autres s'**archivent** : elles disparaissent de la liste
  mais restent conservées, parce que leurs destinataires portent l'historique qui alimente les Analytics (le coût,
  le funnel, les erreurs). Archiver ne change donc **jamais** un chiffre du tableau de bord. Un lien « Voir les
  archivées » bascule sur la corbeille, d'où chaque campagne se **restaure**. Le coût affiché en haut de liste
  porte explicitement sur « les campagnes affichées », pour ne pas contredire le total du tableau de bord.
- ✅ **Créer un template depuis l'écran Campagne** (2026-07-20) : sous le sélecteur de modèle, un bouton ouvre
  le formulaire de création habituel sans quitter la campagne en cours. Un template neuf part en validation chez
  Meta : l'écran le dit clairement et **ne le fait pas apparaître dans la liste** (une campagne ne peut partir
  qu'avec un template approuvé). **Il suit la revue tout seul** et **sélectionne le modèle dès qu'il est
  approuvé**, sans qu'on ait à penser à cliquer ; un bouton « Vérifier maintenant » reste là pour ceux qui
  n'attendent pas. Un choix fait PENDANT l'attente n'est jamais écrasé, et l'écran le dit alors au lieu
  d'affirmer une sélection qui n'a pas eu lieu.
  ⚠️ **Le panneau survit au repliage du cadre et au changement d'étape** : c'est la promesse qu'il fait, et
  une promesse qui disparaît en repliant un cadre est pire que pas de promesse.
- ✅ **Un ASSISTANT en cinq étapes, une question par écran** (2026-09-13, il remplace l'écran à deux étapes de
  juillet). « Ajouter une campagne » ouvre `/campaigns/nouvelle`, et le parcours est : **Nom** (et la nature de
  la campagne, marketing ou service), **Canal** (un canal seul, ou une CHAÎNE avec repli), **Contenu** (un cadre
  par étage de la chaîne, plus le devenir de la conversation), **Audience** (qui reçoit), **Récapitulatif**.
  - chaque étape a son **adresse** (`?etape=contenu`) : elle se partage, se met en favori, et survit à un
    rechargement, ce qu'un mode local dans la page de liste ne permettait pas ;
  - on **revient en arrière librement** sans rien perdre, et le récapitulatif renvoie vers l'étape à corriger ;
  - le **récapitulatif n'est pas un résumé** : il montre la RÉPARTITION prévue (combien de contacts par étage de
    la chaîne), c'est-à-dire la seule information qu'on n'a vue nulle part ailleurs.
- ✅ **Choisir les destinataires par SOURCE** : un sélecteur de source en haut de la zone Destinataires.
  - **📇 Liste de contacts** (mini-CRM) : un vrai moteur de FILTRES combinables : par **tag(s)** (tous / au moins
    un), **opt-in**, **téléphone** (commence par / contient), **valeur de champ perso**, **nom**. Un compteur live
    « N contact(s) correspondent » ; « Tout sélectionner (N) » cible tout le segment.
  - **📄 Import fichier** : importe un CSV (même écran de mapping que l'onglet Contacts) avec un **tag obligatoire**.
    Les contacts atterrissent dans le CRM taggés, et la campagne cible aussitôt ce tag.
  - **⋯ Autre** (2026-08-26) : les deux sources qui ne servent pas au cas courant sont rangées derrière ce
    bouton, qui ouvre une seconde ligne. **HubSpot n'y apparaît pas du tout** quand le connecteur est éteint sur
    l'Accueil (avant : un bouton grisé pour une intégration qu'on n'a pas).
  - **🪝 Webhook : campagne AU FIL DE L'EAU** (2026-08-26, sous « Autre ») : au lieu d'une liste figée, on choisit
    une **adresse** créée dans **Tools > Webhooks**. La campagne reste alors **ouverte** : chaque contact qui
    arrive par cette adresse reçoit le message dans la foulée, un par un. Elle envoie **à partir de son
    lancement**, jamais aux contacts arrivés avant. Tout le reste est identique à une campagne ordinaire :
    même message (template, scénario ou RCS), même cadence, mêmes garde-fous, mêmes statistiques.
    - La même personne qui repasse par l'adresse **ne reçoit pas deux fois**.
    - Un arrivant écarté (pas de consentement sur une campagne marketing, variable de template absente de sa
      fiche) est **inscrit avec son motif** dans le détail : il ne disparaît pas en silence. L'écran prévient
      **avant** le lancement quand l'adresse choisie n'affirme pas le consentement, ou ne crée pas les contacts
      inconnus.
    - La campagne porte une pastille **« au fil de l'eau »** dans la liste et un bouton **« Arrêter »** : c'est son
      seul point final, elle n'en a aucun par elle-même. Arrêter ne touche pas à l'historique déjà envoyé.
    - Supprimer une adresse dont une campagne vivante se nourrit est **refusé**, en nommant la campagne.
  - **🔗 HubSpot** (2026-07-18, sous « Autre ») : importe une **liste HubSpot** comme destinataires. Le bouton est actif seulement
    si le toggle « Campagnes via données HubSpot » est activé (sur l'Accueil) **et** que la synchronisation HubSpot
    n'est pas en pause : pendant une pause, la source est **grisée** avec l'explication au survol, au lieu d'ouvrir
    un panneau vide. On choisit une liste du portail (nom, nombre de contacts, active/statique), on importe ses
    contacts (taggés `HubSpot: <nom>`, opt-in JAMAIS présumé), et la campagne cible aussitôt ce tag. Si le portail
    n'a pas encore autorisé l'accès aux listes, une CTA de re-consentement s'affiche (ajoute la permission
    « Lists » à ce portail uniquement).
- ✅ **Débit d'envoi réglable** : une **jauge par défaut à 60 messages/min** (toujours visible depuis 2026-07-28,
  plus de case « Limiter »), ajustable de 1 à 80/min (le plafond WhatsApp) pour protéger la réputation du numéro,
  avec la **durée estimée** affichée. Le débit est respecté pour de vrai côté serveur.
- ✅ **Lancer maintenant OU plus tard** (au récapitulatif) : « Maintenant » lance sur place ; « Plus tard »
  ouvre un **calendrier** (date + heure) et **programme** la campagne, qui partira toute seule à l'échéance.
  Une campagne programmée porte un badge « planifiée » + sa date dans la liste, et se **désprogramme** en un
  clic. Une date déjà passée est **refusée**, pas ramenée à maintenant : « je me suis trompé d'un jour » doit
  se corriger, pas s'envoyer.
- ✅ **Créer sans envoyer** : un second bouton crée la campagne avec ses destinataires calculés, et s'arrête là.
  C'est ainsi qu'on vérifie QUI est retenu, et combien de contacts ont été écartés, avant d'engager le moindre
  message. Elle attend ensuite dans la liste, avec son bouton « Lancer ».
- ✅ **Une campagne qui ne toucherait PERSONNE n'est pas lancée** : si tous les contacts choisis sont écartés,
  l'écran le dit avec le MOTIF (une variable de modèle sans valeur sur la fiche, ou un consentement qui
  manque), parce que les deux n'appellent pas la même correction. La campagne est déjà créée : on la reprend
  depuis la liste plutôt que d'en créer une seconde.
- ✅ **Le nom est la première étape, et il est obligatoire** : c'est lui qui déclenche l'enregistrement du
  brouillon, donc rien n'est jamais perdu à partir de là.
  ⚠️ **L'expéditeur n'est plus demandé** : l'assistant prend le premier numéro WhatsApp de l'espace et le
  premier agent RCS. La très grande majorité des espaces n'en ont qu'un, et un assistant qui pose une question
  à réponse unique fait perdre un écran à tout le monde.
- ✅ **La miniature du template montre ses BOUTONS** (réponse rapide / lien / formulaire), que ce soit un template
  direct ou le 1er template d'un scénario. Le suivi des destinataires (statut interne + cycle de livraison Meta) se
  **rafraîchit tout seul pendant la douzaine de secondes qui suit un lancement**, le temps de voir les statuts
  bouger ; ensuite, un bouton « Rafraîchir » remet la liste à jour.
- ✅ **Le sélecteur de scénario ne propose que ce qui peut partir** : une campagne vise une audience froide, donc
  seul un scénario qui **démarre par un envoi de template configuré** y est proposé. Les autres scénarios (qui
  ouvrent sur un message rapide ou un formulaire) restent parfaitement valides, mais réservés aux déclenchements où
  le contact vient d'écrire. Quand aucun scénario n'est utilisable en campagne, l'écran le dit et explique
  pourquoi, au lieu d'annoncer « aucun scénario » alors qu'il en existe. Les variables associées sont celles du
  **1er template du scénario**.
- ✅ **...et seulement ceux qui peuvent ouvrir CET étage-là** (2026-09-13) : un étage WhatsApp ne propose que les
  scénarios qui démarrent par un modèle, un étage RCS que ceux qui démarrent par un message RCS. Un scénario qui
  ouvre sur le mauvais canal ferait refuser la campagne **entière** par Meta, pas un destinataire, et le
  récapitulatif le dit avec sa raison exacte (« ce scénario ouvre par un message RCS ») plutôt qu'en termes vagues.
- ✅ **« Créer un scénario » sans quitter sa campagne** (2026-09-13) : sous le sélecteur, un lien demande le nom du
  scénario puis ouvre **l'éditeur habituel dans une fenêtre**, par-dessus la campagne. Le brouillon en cours est
  intact au retour, et le scénario publié est **choisi tout seul** pour l'étage ; il se retrouve ensuite dans
  l'onglet Scénario comme n'importe quel autre. **La publication refuse depuis cette fenêtre un scénario qui
  n'ouvre pas sur le canal de l'étage**, en disant quel premier bloc il lui faut : on l'apprend en construisant, pas
  au moment de lancer.
- ✅ **« Message et scénario » sur un étage RCS fait enfin les deux** (2026-09-13) : le message RCS part, **puis** le
  scénario démarre. Avant, le scénario choisi était enregistré et n'était jamais lancé : l'écran affichait
  « envoyé », ce qui était vrai, pour une campagne à moitié faite. Le message RCS apparaît aussi dans le fil de
  conversation du contact, ce qui n'était pas le cas dès qu'un scénario était attaché. Si le scénario ne peut pas
  démarrer (fil repris par un opérateur, scénario supprimé), le message reste compté **envoyé**, avec la raison à
  côté : il est bien parti, et le recompter en échec le ferait renvoyer une seconde fois à la relance.
- ✅ **Variables associées à la création** : on associe chaque variable à sa source via un **menu déroulant**
  (« Champs de base » : Nom, Prénom, Téléphone, BSUID, WhatsApp ID, Email · « Mes champs » : les vrais champs
  perso · « Autre » : **Date du jour (auto)** et **Texte fixe**). Fini la clé tapée à la main qui pointait un champ
  inexistant. La **date du jour est recalculée à l'instant de l'envoi**, pas à la création : une campagne
  programmée pour la semaine prochaine partira avec la date du jour de l'envoi. Les valeurs sont résolues **par
  contact** : un contact à qui il manque une valeur est **sauté et signalé (« X contacts sautés »)** ;
  0 destinataire = avertissement rouge, et la campagne n'est ni lancée ni programmée. Plus jamais de « envoyé »
  alors que rien ne part. **Un template à bouton Formulaire (FLOW) part correctement** via un scénario.
- ✅ **Un destinataire non parti n'est jamais compté comme envoyé** : sur une campagne scénario, si le parcours ne
  démarre pas (fenêtre de 24 h fermée, scénario supprimé entre-temps, ou fil déjà repris par un opérateur), le
  destinataire passe en **échec avec la raison affichée**, pas en « envoyé ». Et un échec de livraison signalé plus
  tard par Meta **rebascule** la ligne du côté des échecs dans les compteurs. Fini les « 500 envoyés, 0 échec »
  alors que rien n'est parti. (Le cycle de livraison Meta détaillé reste non câblé pour les campagnes scénario
  en V1.)
- ✅ **Corriger et renvoyer un destinataire en échec** : dans le détail d'une campagne, un destinataire tombé sur
  une erreur de **variable de template** (prénom absent, valeur vide) affiche un bouton **« Corriger + renvoyer »**.
  Un mini-formulaire propose les champs concernés : on saisit la bonne valeur, elle est **enregistrée sur la fiche
  du contact** (les autres champs ne sont pas touchés), et le message repart. Si la variable est **toujours** vide,
  le renvoi est refusé avec un message clair plutôt que de rejouer le même échec.
- ✅ **Auto-relance des échecs de livraison** (la case « Réessayer les envois qui échouent » de la campagne,
  cochée par défaut ; une campagne créée avant le 2026-09-23 suit l'ancien réglage d'espace, et un envoi créé par
  l'API publique aussi, faute de choix exprimé) : quand un message
  échoue pour une raison connue pour être passagère, la console le **rejoue toute seule une fois**. Les échecs de
  type « pas de fenêtre » repartent au **début de la journée suivante** (entre 8 h et midi, heure de Paris), là où
  le destinataire est le plus susceptible de recevoir. Un numéro qui échoue **deux fois** est signalé
  **injoignable dans HubSpot** plutôt que réessayé indéfiniment. Le compteur d'échecs de la campagne est remis à
  plat à chaque relance, il ne double jamais.
- ✅ **Garde-fous** : opt-in requis (un opt-out explicite bloque tout, marketing comme utility ; en marketing seul
  un opt-in explicite passe), coupure automatique sur quality rating rouge ou taux d'échec trop haut, claim
  atomique anti double-envoi, idempotence. Le plafond anti-répétition par contact est **désactivé** (décision
  pilote 2026-07-15) : c'est l'opérateur qui choisit ses destinataires, un saut silencieux laissait des contacts
  « en attente » sans explication. **« Lancer »** n'apparaît que sur un brouillon ; une campagne mise en pause
  montre **« Reprendre »** (relance les destinataires restants) ; une campagne terminée ou en échec n'a pas de bouton.
- ✅ **Un plafond WhatsApp met la campagne en pause au lieu de brûler l'audience** (2026-08-31). Quand Meta
  refuse temporairement parce que le NUMÉRO a atteint une limite (débit, ou restriction liée à la qualité), la
  campagne se met en pause avec la raison affichée, et **le destinataire en cours retourne dans la file**.
  Avant, ce refus temporaire était traité comme un échec définitif : le contact en cours était marqué en échec,
  puis le suivant, puis tous les autres, et une campagne pouvait perdre toute son audience restante sur une
  limite qui serait retombée d'elle-même. Une fois la limite passée, **« Reprendre » repart d'où ça s'est
  arrêté**, sans avoir perdu personne.
- ✅ **Arrêter un envoi en cours** (2026-08-31). Une campagne en cours porte un bouton **« Mettre en pause »**.
  C'est le geste d'urgence quand on s'aperçoit qu'on a mal ciblé : sans lui, une campagne lancée partait jusqu'à
  son dernier destinataire, quoi qu'on fasse. Pas de confirmation à cliquer, justement parce que c'est urgent
  et que c'est réversible.
  - **Ce qui est déjà parti reste parti** : aucun message WhatsApp livré ne se rappelle. Le compteur de la
    campagne dit exactement combien sont partis avant la coupure.
  - **L'envoi s'arrête dans les secondes qui suivent**, pas instantanément : l'envoi en cours va au bout de son
    destinataire courant, puis s'interrompt.
  - **« Reprendre » repart exactement là** où on s'est arrêté : les destinataires non traités sont restés en
    attente, personne n'est envoyé deux fois.
  - À ne pas confondre avec **« Arrêter »**, qui n'existe que sur une campagne au fil de l'eau et qui est
    définitif : la pause est une suspension, l'arrêt est un point final.
- ✅ **Coût estimé par campagne** : « ≈ X (devise du compte) » par campagne + total, dérivé de VOTRE prix
  (le tarif Meta de `pricing_analytics`, majoré de votre marge) × nb envoyés facturables. « indisponible »
  si le prix Meta ne remonte pas (jamais 0).
- ✅ **Les templates avec un VISUEL d'en-tête partent correctement** (2026-08-17). WhatsApp exige que l'image
  (ou la vidéo, ou le document) d'en-tête soit fournie à chaque envoi : celle déposée à la création du template
  ne sert qu'à sa validation par Meta. **Rien à faire côté utilisateur** : l'image est reprise du template
  lui-même, il n'y a aucun champ à remplir à la création de la campagne. Vaut pour un envoi de template direct
  comme pour une campagne qui démarre un scénario.
  Avant ce correctif, une telle campagne échouait sur **tous** ses destinataires avec un message d'erreur de
  Meta (code 132012) et zéro envoi. Désormais, si le visuel ne peut vraiment pas être préparé, la campagne
  **refuse de démarrer** et l'annonce en clair, au lieu d'accumuler les échecs un par un.
- ✅ **Reprendre un destinataire en échec** : sur le détail de la campagne, un destinataire en échec de
  variable de template propose « Corriger + renvoyer » (on corrige la valeur sur sa fiche, elle est enregistrée,
  et ce seul message repart). Quand il n'y a aucune variable à corriger, le bouton s'intitule simplement
  « Renvoyer » : le message repart tel quel, ce qui suffit quand la cause était un défaut d'envoi corrigé depuis.

## Inbox

- ✅ **« Ouvrir la conversation » depuis la fiche d'un contact** (2026-09-23, menu Contacts). Le bouton est en
  haut de la fiche du mini-CRM et emmène directement sur le fil de ce contact dans l'Inbox.
  🔴 **Le fil est CRÉÉ s'il n'existe pas**, et c'est le cas qui compte : un contact qu'on vient d'importer n'a
  jamais écrit, donc n'a aucune conversation, et c'est précisément là qu'on veut lui parler. Cliquer deux fois
  n'ouvre pas deux fils.
  ⚠️ **Un fil qu'on vient d'ouvrir n'entre PAS dans « À traiter »** : ce dossier veut dire « la balle est dans
  notre camp », et l'ouvrir soi-même ne met la balle dans aucun camp. Il y entrera au premier message du
  contact. Il est visible dans « Toutes », en tête.
  ⚠️ **Un fil ANCIEN s'ouvre aussi**, même s'il est trop vieux pour figurer dans la page affichée, ou rangé
  dans « Archivé » ou « Traité » : on a demandé ce fil-là. Un contact sans numéro ni identifiant WhatsApp,
  lui, n'a aucun fil possible, et l'écran le dit au lieu de mener nulle part.

- ✅ **LIRE LES MESSAGES REÇUS DANS SA LANGUE** (2026-09-13) : un interrupteur « Traduire les messages
  reçus », dans l'en-tête de la conversation. Allumé, les messages entrants du fil s'affichent dans la
  langue de votre console (celle du menu compte, français ou anglais), quelle que soit celle du client.
  - le réglage vit **dans votre navigateur** : deux collègues peuvent lire le même fil, l'un en
    français, l'autre en anglais, sans se marcher dessus ;
  - **l'original n'est jamais remplacé, il est gardé à côté.** C'est ce qui permet de revenir dessus,
    et c'est ce qui fait foi ;
  - une traduction qui **échoue** montre le texte d'origine avec une marque qui le dit ; un message
    ancien que l'on n'a **pas tenté** de traduire montre son original sans aucune marque. Les deux ne
    veulent pas dire la même chose, et l'écran ne les confond pas ;
  - **au plus 40 messages** sont traduits par ouverture, les plus récents d'abord, et une traduction
    déjà faite n'est jamais repayée.
- ✅ **Traduire ce que vous vous apprêtez à envoyer** (2026-09-13) : un bouton qui **nomme sa cible**
  (« Traduire en espagnol »), jamais « Traduire » tout court. Il **remplace le texte dans votre zone de
  saisie et n'envoie rien** : vous relisez avant de cliquer sur Envoyer. La langue du contact est
  **apprise** de ce qu'il écrit, jamais demandée ; tant qu'on ne sait rien, le bouton propose l'autre
  langue de la console et ne prétend pas savoir.
  ⚠️ Le bouton est **absent sur un envoi de modèle** : le texte approuvé par Meta EST le texte, le
  traduire le ferait refuser.
- ✅ **Un vocal transcrit revient dans votre langue** (2026-09-13) : si le réglage est allumé, appuyer
  sur « Transcrire » sur un message vocal donne en un seul geste ce qui a été dit ET sa traduction,
  même si le vocal était en espagnol. C'est la **transcription** qui est traduite, jamais le libellé
  `[audio]`.

  🔴 **QUI PAIE, ET C'EST DIFFÉRENT DE LA TRANSCRIPTION.** La traduction est facturée sur le **crédit
  prépayé de l'espace**, là où la transcription et le bot d'aide sont à notre charge. Un espace sans
  crédit ne traduit pas, et l'écran le dit au lieu de rester muet. Il distingue les deux causes
  possibles : pas de crédit sur l'espace (un administrateur peut le recharger) ou traduction pas encore
  activée sur le serveur (rien à faire côté client).

- ✅ **LE STATUT « TRAITÉ »** (2026-09-19, déployé le jour même, essai réel à faire). Pour les conversations
  où le client a écrit en dernier mais où il n'y a plus rien à lui répondre (« merci, bonne journée »). Marquée
  « Traité », la conversation **sort d'« À traiter »**, **reste dans « Tout »** avec une petite pastille
  « Traité », et a son propre dossier. **Dès que le client réécrit, le statut saute** et elle revient dans « À
  traiter », sans que personne ait rien à faire.
  ⚠️ **Une réaction emoji (👍) ne la rouvre pas** (arbitrage du 2026-09-19) : « merci 👍 » en réponse à votre
  « bonne journée » est exactement ce que ce statut règle. Elle ne change pas non plus « qui a parlé en
  dernier » : une conversation que votre réponse avait sortie d'« À traiter » n'y revient pas pour un 👍.
  ⚠️ **« Traité » n'est pas « Archivé »** : Archivé cache la conversation de tous les dossiers ordinaires,
  Traité la laisse visible dans « Tout ». Un message du client sort des deux (une réaction, elle, sort
  seulement d'Archivé). « Ne plus marquer traité » rend la conversation au dossier que son dernier message
  désigne : si c'est vous qui avez écrit en dernier, elle ne revient donc pas dans « À traiter ».
- ✅ **LES PHOTOS ET FICHIERS REÇUS S'AFFICHENT** (2026-09-19, déployé le jour même, essai réel à faire). Une
  photo (ou un sticker) envoyée par le client apparaît dans la bulle, avec sa légende ; un document ou une
  vidéo devient un bouton **« Télécharger »** qui enregistre le fichier sous le nom que le client lui a donné.
  Une photo ne se charge que quand elle devient visible dans le fil ; un document ne part qu'au clic.
  🔴 **WhatsApp ne garde une pièce jointe reçue que SEPT JOURS**, et nous n'en gardons pas de copie (choix du
  2026-09-19) : passé ce délai, la bulle dit « Fichier expiré » au lieu d'un bouton qui échouerait. Même chose
  pour un vocal, qui ne propose plus ni « Écouter » ni « Transcrire ». Une transcription faite avant reste
  lisible. ⚠️ Le produit affirmait trente jours ; la mesure du 2026-09-19 l'a démenti.
  ⚠️ **Sécurité** : seules les images s'affichent. Un document, même annoncé comme une image par son
  expéditeur, se télécharge toujours et ne s'ouvre jamais dans la console. Taille maximale d'une pièce jointe
  ouverte depuis la console : 25 Mo, au-delà l'écran dit la taille.
- ✅ **« JE M'EN OCCUPE » : UN AGENT PREND UNE CONVERSATION DU POT COMMUN** (2026-09-19, déployé le jour
  même, essai réel à faire). Réglage dans **Paramètres**, à la main des **admins et des managers** :
  « Les agents peuvent prendre une conversation non affectée ». Activé, un agent voit **« Je m'en occupe »** sur
  une conversation que personne n'a, et se l'affecte. Il ne peut **jamais** la passer à un collègue ni la
  rendre au pot commun : seuls les managers et les admins distribuent (arbitrage du 2026-09-19). Si un
  collègue l'a prise une seconde avant, l'écran le dit. Coupé (par défaut), rien ne change.
  ⚠️ Un manager qui ouvre Paramètres n'y voit **que ce réglage** : le fuseau, les horaires, les prix et le
  reste restent aux admins.
- ✅ **RANGER LA CONVERSATION OUVERTE** (2026-09-09) : un menu « Ranger dans… » en haut de la conversation,
  à côté de l'affectation. Il propose, selon l'état :
  - **À traiter** : vous reprenez le fil, la conversation entre dans ce dossier. 🔴 **Ce geste n'existait
    pas** : on ne reprenait un fil qu'en ENVOYANT un message, donc il fallait écrire au client pour un
    rangement interne. Le geste inverse (« Rendre la main » au scénario) est le bouton juste à côté, et les
    deux ne s'affichent jamais ensemble : c'est une bascule, pas deux réglages.
  - **Signalé / Ne plus signaler** : un signalement À LA MAIN. ⚠️ Il s'ajoute au constat de l'analyse (qui
    repère les injures toute seule) sans l'écraser : le dossier « Signalé » montre les deux, et une
    ré-analyse ne peut pas effacer votre signalement. Sur une conversation signalée par l'analyse, le menu
    propose donc quand même « Signalé » : il n'y a rien à retirer, vous n'aviez rien posé.
  - **Archivé / Désarchiver** : le geste existait, mais seulement en cochant une case dans la LISTE. Il
    fallait donc revenir en arrière pour ranger ce qu'on venait de finir de lire.

  ⚠️ **L'affectation à un collaborateur reste son propre sélecteur**, et ce n'est pas un oubli : elle est
  INDÉPENDANTE du reste. Une conversation peut être confiée à Marie ET tenue par le scénario. Les réunir
  dans un seul menu laisserait croire qu'on choisit entre les deux.
- ✅ **RANGER PLUSIEURS CONVERSATIONS D'UN COUP** (2026-09-09) : cochez-en autant que vous voulez, un menu
  **« Ranger dans… »** apparaît au-dessus de la liste et propose les mêmes destinations. Avant, la sélection
  ne pouvait aller QUE dans les archives : remettre dix conversations « à traiter » demandait de les ouvrir
  une par une.
  ⚠️ **Le menu ne propose que ce qui aura un effet VISIBLE**, et les options changent donc selon le dossier
  où vous êtes : depuis « Archivé » il n'offre que **Désarchiver** (marquer « Signalé » une conversation
  archivée l'écrirait sans qu'elle réapparaisse nulle part, les deux dossiers excluant les archivées) ;
  depuis « À traiter » il n'offre pas « À traiter », et depuis « Signalé » pas « Signalé ».
  ⚠️ **« Ne plus signaler » n'apparaît que si au moins une conversation cochée porte un signalement À LA
  MAIN**, et il ne touche que celles-là. Celles que l'ANALYSE a signalées restent dans le dossier : son
  constat n'est pas effaçable à la main, et prétendre le contraire ferait cliquer deux fois avant de
  conclure que l'écran est cassé.
- ✅ **UN MENU DE DOSSIERS, FAÇON BOÎTE MAIL** (2026-09-08, **réellement à gauche depuis le 2026-09-09**).
  Dans sa propre colonne, à gauche de la liste : **Tout**, **À traiter**, **Traité** (depuis le 2026-09-19),
  **Signalé**, **Archivé**, chacun
  avec son nombre entre parenthèses. Il remplace les trois boutons de filtre d'avant, qui ne portaient qu'un
  compteur sur trois.
  🔴 **Cette ligne annonçait « à gauche de la liste » et c'était FAUX** : le menu vivait AU-DESSUS d'elle,
  dans la même colonne. Cliquer « Tout » ou « À traiter » faisait apparaître les conversations sous lui, et
  il fallait redescendre pour changer de dossier. Signalé par Julien le 2026-09-09. Les deux colonnes sont
  désormais côte à côte, comme dans une boîte mail : le menu reste en place, seule la liste change. Le titre
  de la liste nomme le dossier ouvert, au lieu de répéter le mot « Conversations » déjà présent dans le menu.
  ⚠️ Sur téléphone, les deux restent empilés : trois colonnes n'y laisseraient rien de lisible.
  ⚠️ **Le nombre est affiché même à zéro.** « Signalé (0) » est une information (« rien à relire ») ; un
  libellé nu laisse croire que le chiffre n'a pas chargé, et on va vérifier pour rien.
  ⚠️ **Les compteurs portent sur TOUT l'espace, pas sur la page affichée** : ils ne descendent pas quand vous
  faites défiler la liste.
  🔴 **Le compteur « À traiter » peut avoir BAISSÉ** chez un espace qui a des contacts bloqués : il les
  comptait alors que la liste ne les montre pas, donc il pouvait annoncer plus de conversations qu'il n'y en
  avait à l'écran. C'est corrigé, le compteur et la liste disent enfin la même chose.
- ✅ **ARCHIVER une conversation** (2026-09-08). Cochez une ou plusieurs conversations et choisissez
  **« Archivé »** dans le menu qui apparaît : elles rejoignent le dossier **Archivé**. Dans ce dossier, le
  même menu les **désarchive**. (C'était un bouton unique jusqu'au 2026-09-09, cf. l'entrée ci-dessus.)
  ⚠️ **Rien n'est effacé** : les messages restent lisibles, le contact reste joignable, et aucun chiffre
  d'analytics ne bouge. C'est un rangement.
  🔴 **Un message du contact la fait REVENIR** dans « Tout ». Une conversation archivée puis relancée par le
  client est exactement le cas où l'oublier coûte cher : l'archivage range ce qui est fini, il ne réduit
  personne au silence. ⚠️ Un envoi de campagne, lui, ne la fait pas revenir : sinon une campagne qui touche
  mille contacts viderait le dossier Archivé d'un coup.
  ⚠️ **Une conversation archivée n'est pas listée par le serveur MCP** non plus (un assistant branché voit la
  même chose que l'Inbox), et sa description le dit.
  ⚠️ **Elle ne compte plus dans la pastille de non-lus** non plus. Sans ça, ranger une conversation non lue
  l'aurait laissée annoncée par la pastille pour toujours, sans aucun moyen de faire descendre le chiffre :
  on aurait cliqué, cherché, et rien trouvé. 🔴 **Cette pastille comptait aussi les contacts BLOQUÉS**, qui
  n'apparaissent pourtant nulle part depuis le 2026-08-21 : c'est corrigé au passage, et son chiffre peut
  donc avoir baissé.
- ✅ **LA CHARGE PAR COLLABORATEUR** (2026-09-08), sous le menu : **Non affecté (N)** puis un membre par
  ligne avec son nombre de conversations. Cliquer sur un nom montre ses conversations.
  ⚠️ **Tous les membres sont listés, y compris ceux à zéro** : c'est ce qui répond à la question du manager,
  et ne montrer que ceux qui ont du travail rendrait invisible celui qu'on cherche précisément parce qu'il
  n'en a pas. Une conversation archivée ne compte dans la charge de personne.
  ⚠️ **Section réservée aux administrateurs et aux managers**, c'est-à-dire à ceux qui peuvent déjà affecter
  une conversation. Un opérateur ne voit pas la charge de ses collègues.
- ⏳ **Le glisser-déposer vers Archivé n'existe pas**, et c'est un choix : la case à cocher rend déjà le
  geste. Il s'ajoutera si l'usage le réclame.
- ✅ **Effacer le contenu d'une conversation** (2026-09-02), réservé aux administrateurs. Ce sont les messages
  qui partent, pas la conversation : son affectation, son détenteur et son analyse restent.
  🔴 **La confirmation vous prévient d'une conséquence que personne ne devine** : la fenêtre de 24 h se calcule
  sur le dernier message reçu, donc après l'effacement elle est fermée, et vous ne pourrez plus répondre
  librement à ce contact tant qu'il n'aura pas réécrit. L'action est tracée au Journal des actions, sans le
  numéro ni le texte effacé.
- ✅ **Le fil ne défile plus tout seul** (2026-09-02). Il se replaçait en bas toutes les 4 secondes, y compris
  quand vous étiez remonté pour relire. Deux corrections : le dernier message ne se ré-ajoute plus au fil, et
  l'écran ne redescend que si vous y étiez déjà.
- ✅ **Affecter une conversation à quelqu'un** (2026-08-21) : depuis le fil, un **manager** ou un admin choisit
  le membre qui s'en occupe, ou la laisse libre. Tant qu'une conversation n'est affectée à personne, **tout le
  monde peut y répondre**, agents compris. Dès qu'elle est affectée, **seul l'agent désigné** répond ; les
  autres la voient toujours, avec le nom de celui qui la suit à la place de la zone de réponse. Un manager ou
  un admin peuvent toujours reprendre la main. C'est la première capacité réelle du rôle manager.
  ⚠️ À ne pas confondre avec « qui tient le fil » (le scénario, un humain, l'agent Meta) : une conversation
  peut très bien être confiée à quelqu'un ET suivie par le scénario. L'affectation dit qui s'en occupe, pas
  qui parle.
- ✅ **Liste allégée et complète** (2026-08-21) : la vignette ne répète plus le début du dernier message (le
  fil est juste à côté), et le clic sur le **nom** ouvre la fiche du contact sans quitter la conversation.
  Surtout, la liste ne s'arrête plus à cent : un bouton « Charger plus » va chercher la suite, le filtre
  « À traiter » porte désormais sur **toutes** les conversations et non sur celles déjà affichées, et son
  compteur dit le vrai total.


- ✅ **Les compteurs tiennent à plusieurs sur le même espace** (2026-08-31) : la pastille de non-lus et le
  compteur « À traiter » sont calculés une fois pour tout l'espace pendant quelques secondes, au lieu d'une
  fois par personne connectée. Rien ne change à l'écran, sauf que la console ne ralentit plus quand toute une
  équipe l'ouvre en même temps. Ouvrir un fil éteint la pastille **immédiatement**, sans attendre.
- ✅ **Qui répond à ce client, à cet instant** (2026-07-21). Une conversation appartient à un seul
  répondeur à la fois : le **scénario** (automatique), un **opérateur** (quelqu'un s'en occupe), ou
  demain l'**agent de Meta**. Un badge le dit dans le FIL OUVERT, et n'apparaît que quand ce
  n'est PAS le scénario : c'est l'exception qui doit se voir.
- ✅ **Filtre « À traiter »** dans la liste des conversations, à côté de « Toutes ». Il ne garde que les
  conversations que **le scénario ne gère plus** : quelqu'un a pris la main, le scénario a passé la main, ou
  l'agent de Meta répond. Le nombre est affiché sur l'onglet, ce qui donne une file de travail plutôt qu'un flux
  à trier à l'œil. Quand il n'y a rien, l'écran le dit explicitement (« tout est géré par le scénario ») au lieu
  d'afficher une liste vide ambiguë.
- ✅ **Écrire depuis l'inbox met le scénario en pause** sur cette conversation, que ce soit une réponse texte ou
  l'envoi manuel d'un template : les deux sont des actes d'opérateur. Avant, l'opérateur et le scénario pouvaient
  écrire au client en même temps, et le client recevait deux messages sans rapport. Tant qu'un opérateur détient
  le fil, **aucun scénario ne CONTINUE tout seul** et l'agent ne répond pas. Le scénario n'est pas abandonné, il
  reprend là où il en était.
  ⚠️ **Une CAMPAGNE, elle, part quand même, et elle reprend la main.** C'est délibéré : c'est un opérateur qui
  la déclenche, donc c'est un humain qui décide. Cette ligne a affirmé le contraire (« y compris une campagne
  qui essaierait d'en démarrer un »), ce qui laissait croire qu'avoir la main protégeait le contact d'un envoi
  de masse. Ce n'est pas le cas, et c'est exactement ce qu'un opérateur doit savoir avant de lancer.
  ⚠️ **Depuis le 2026-09-08, un appui sur un bouton de CHAÎNE non plus.** L'infobulle du badge le dit, et cette
  liste doit grandir avec les exceptions : une énumération à laquelle il manque un cas est un demi-mensonge.
- ✅ **Un scénario qui arrive au bout passe la main** : quand un parcours atteint son bloc « passer à un humain »,
  la conversation bascule côté opérateur. Le badge le dit tout de suite et la conversation apparaît dans
  « À traiter ». Avant, le scénario s'arrêtait en silence pendant que le badge affichait encore « scénario », et
  personne ne voyait que le client attendait.
- ✅ **Un scénario terminé rend le fil à l'agent de Meta, quand il est allumé** (corrigé le 2026-09-15). À la
  fin du parcours, la conversation retourne à l'agent de Meta, qui répond de nouveau tout seul dès que le
  client écrit. **Comptez une à deux minutes** après le dernier message du scénario : la remise n'est demandée
  à Meta qu'une fois notre dernier envoi acquitté par lui.
  🔴 **Avant ce correctif, l'agent de Meta ne repartait PAS.** La remise était demandée dans la seconde suivant
  le dernier envoi ; or envoyer un message reprend le fil chez Meta, et son accusé arrive deux minutes plus
  tard. L'envoi reprenait donc le fil juste après la remise : l'agent restait muet, le client parlait dans le
  vide, et la conversation n'apparaissait pas non plus dans « À traiter ». Mesuré sur le numéro de production,
  trois fois sur trois.
  ⚠️ **Pendant cette attente, la conversation est « à vous »**, donc une réponse du client pendant ces deux
  minutes allume bien la pastille « À traiter » au lieu de disparaître. Et si Meta ne répond jamais, le délai
  de reprise (deux heures par défaut) rend le fil malgré tout.

- ✅ **Bouton « Rendre la main »** dans le fil, quand un opérateur détient la conversation. Le scénario
  repart immédiatement, sans attendre le délai.
- ✅ **Un bouton de chaîne cliqué reprend la main lui aussi** (2026-09-08), pour la même raison qu'une
  campagne : c'est un geste explicite, celui de l'abonné qui appuie. Le détail est dans la section Chaînes.
  ⚠️ Ce sont les DEUX seules exceptions. Un mot-clé ordinaire, une analyse de conversation, un tag posé : rien
  de tout ça n'écrit dans un fil tenu.
- ✅ **Et « Reprendre la main » quand c'est l'agent de Meta qui tient le fil** (2026-09-08). Le bouton ne
  sortait que pour un opérateur : un fil passé à l'agent de Meta n'avait aucune sortie depuis la console, il
  fallait attendre les 24 heures du délai, et pendant tout ce temps **aucun déclencheur automatique n'écrivait
  dedans**. Concrètement : un abonné qui cliquait un bouton de chaîne ne lançait aucun scénario, sans que rien
  ne l'explique. Le libellé change de sens (on REND une main qu'on a prise, on la REPREND à l'agent de Meta),
  l'effet est le même : le fil repart au scénario.
- ✅ **Délai de reprise réglable** (menu **AI Agent > MBA, paramètres > Activation**, en minutes). Passé ce
  délai sans que personne ne rende la main, la conversation repart toute seule : un onglet fermé ou un
  opérateur parti ne bloquent jamais un client indéfiniment. Vide = 2 heures. `0` = jamais de reprise
  automatique, la main reste à l’opérateur jusqu’à ce qu’il la rende. ⚠️ **Ce réglage vivait sur l’Accueil
  jusqu’au 2026-08-18** : l’Accueil n’y renvoie plus que par un lien « Régler qui répond au client ».
- 🗑️ **« Comportement au retour » : SUPPRIMÉ le 2026-08-18.** Il permettait de choisir, pour l’espace puis
  conversation par conversation, si un fil repartait au scénario ou restait à traiter après une intervention.
  Ni le réglage d’espace ni le sélecteur en tête de fil n’existent plus. Ce qui reste : le délai de reprise
  ci-dessus, et le bouton « Rendre la main » du fil.
- ✅ **Conversations** : réponse texte libre dans la fenêtre de service 24 h, et envoi d'un **template approuvé à
  tout moment** (bouton dédié à côté du champ de saisie). Hors fenêtre, le champ libre disparaît et le template
  devient le seul moyen de re-contacter, avec l'explication à l'écran. Le panneau d'envoi affiche l'aperçu
  WhatsApp, demande les variables une à une, et réclame une **URL publique** quand le template porte une image,
  une vidéo ou un document en en-tête. Formulaires Flow remplis affichés en clair, et **séparateurs de jour** dans
  le fil pour se repérer dans l'historique.
- ✅ **Lancer un scénario sur la conversation ouverte** : à côté du champ de réponse, un bouton
  démarre le scénario de son choix sur ce contact, sans passer par une campagne. L'écran dit
  d'avance ce qui est possible : si le contact a écrit il y a moins de 24 h, **tous** les
  scénarios peuvent partir ; sinon, seuls ceux qui ouvrent par un **template** ou par un
  **message RCS**. Le bouton reste donc offert même fenêtre fermée, avec la liste réduite en
  conséquence. Un second lancement à la main sur une conversation qui a déjà un parcours en
  attente ne crée pas de doublon.
- ✅ **Rafraîchissement automatique** : la liste (~15 s) et le fil ouvert (~4 s) se mettent à jour tout seuls,
  en pause quand l'onglet est masqué (reprise au retour). **Le fil ne « saute » pas** pendant qu'on lit
  l'historique (le scroll ne redescend que sur un vrai nouveau message).
- ✅ **Pastille agent** : les bulles sortantes portent les **initiales de l'auteur** (survol = nom). Repli
  neutre pour les messages sans auteur (legacy / réponse auto).

## Modération : signaler et bloquer

- ✅ **Onglet « Signalées » dans l'Inbox** (2026-08-21), à côté de « Toutes » et « À traiter ».
  L'analyse automatique des conversations pose un **constat d'injure** quand un message insulte
  l'entreprise, et ce seul constat range la conversation ici. La consigne est volontairement
  ÉTROITE : le mécontentement ordinaire, la réclamation, la colère d'un client lésé ne sont pas
  des injures. Un critère large remplirait la liste de réclamations banales et plus personne ne
  la lirait. ⚠️ **Ce n'est pas une alerte, c'est un rapport** : l'analyse ne tourne que lorsque la
  conversation est retombée inactive, donc le signalement arrive 15 à 20 minutes après le message.
  L'écran le dit quand la liste est vide, plutôt que de laisser croire à une panne.
- ✅ **Le constat ne décide rien, c'est vous qui décidez** : l'analyse signale, elle ne bloque
  jamais personne. Le blocage est un geste humain, pris depuis la **fiche du contact**, sous le
  consentement (même famille de question : qu'a-t-on le droit d'envoyer à ce contact). Une
  confirmation est demandée au blocage seulement, débloquer ne fait que remettre les choses en
  place.
- ✅ **Ce que le blocage arrête** : plus **aucun** envoi vers ce contact (il est écarté à la
  source des campagnes, et les automations sont coupées à leur point d'entrée), et sa
  conversation disparaît de l'Inbox. ⚠️ **Ce qu'il n'arrête pas** : ses messages entrants
  continuent d'être **enregistrés**. Faire disparaître ce qu'il envoie ferait aussi disparaître
  une résiliation ou une menace juridique sans que personne ne le sache. Ce qui s'arrête, c'est
  ce qui PART.
- ✅ **Écran « Contacts bloqués » dans Paramètres** : c'est la **seule** porte de sortie. Un
  contact bloqué n'apparaît plus nulle part ailleurs, il serait donc introuvable sans cet écran.
  La section se masque quand il n'y a personne, mais une erreur de lecture s'affiche : « je n'ai
  pas pu lire la liste » n'est pas « il n'y a personne dedans ».
- ✅ **Le blocage n'entache pas l'après** : rien n'est marqué comme déclenché sur un contact
  bloqué, donc l'anti-rebond des automations ne le pénalise pas une fois débloqué.

## Analytics (menu Analytics)

- ✅ **Contacts : cumulés ou actifs** (2026-09-23), une bascule sur la carte Contacts de Quantitatif >
  Messages & contacts. **Cumulés** = tout ce que vous avez collecté depuis le début, la courbe historique,
  qui ne baisse jamais. **Actifs** = ce qu'il vous reste dans le mini-CRM ce jour-là, donc la même courbe
  moins les contacts supprimés, à la date de leur suppression. L'écart entre les deux est l'information :
  une base qu'on nettoie le montre, une seule des deux courbes le cache.
  ⚠️ **L'historique est reconstruit**, la courbe ne commence pas aujourd'hui : supprimer un contact le range
  hors du mini-CRM sans effacer sa ligne, donc on sait à quelle date chacun est parti. Et une suppression
  d'aujourd'hui ne change rien à la courbe d'il y a trois semaines.

- ✅ **Page de synthèse, en tête du Performance Lab** (2026-09-08, remaniée le 2026-09-09) : la première
  page de l'onglet, à l'adresse `/performance`. Elle répond à des questions que les autres écrans ne posent
  pas : où en sont les conversations, et ce que coûte un engagement.
  ⚠️ **Deux colonnes depuis le 2026-09-09** : le coût à gauche (la question qu'on se pose en arrivant, et
  elle se lit dès le premier jour), le nuage à droite (il se remplit avec le temps). Empilées, les deux
  cartes obligeaient à faire défiler pour comparer une dépense à un ressenti, ce qui est la comparaison que
  cette page existe pour permettre. En dessous d'un grand écran, une seule colonne, dans le même ordre.
  Le titre « Synthèse » a été retiré : l'onglet actif le portait déjà juste au-dessus.
- ✅ **« Ce que coûte un engagement »** (2026-09-08, sur la page de synthèse) : une ligne par campagne ayant
  envoyé sur la période, avec ses **envoyés**, ses **engagés** et son **coût par engagé**. C'est la question
  qu'on se pose en arrivant sur l'onglet, et elle se lit sur tout l'historique dès le premier jour.
  ⚠️ **Cette phrase annonçait « coût estimé, clics et coût par clic » jusqu'au 2026-09-23**, c'est-à-dire
  trois colonnes dont une seule existe encore. Le tableau est passé du CLIC à l'ENGAGEMENT, qui compte toute
  réaction du contact (un clic, mais aussi une réponse) : une campagne à scénario n'a pas de lien tracé et
  affichait donc une colonne vide là où elle avait bel et bien fait réagir des gens. Le coût, lui, se lit en
  ouvrant la ligne.
  🔴 **Le coût est une ESTIMATION, pas une facture, et l'écran le dit.** Aucun coût par campagne n'est
  stocké : il se recalcule (envois × votre prix pour la catégorie) à partir des tarifs que Meta rend pour la
  période, exactement comme le graphe de coût de l'onglet Quantitatif, avec lequel il partage sa population
  d'envois et sa lecture des tarifs.
  ⚠️ **Trois cases restent VIDES plutôt que d'afficher zéro**, et chacune dit pourquoi au survol : le coût
  quand Meta ne rend aucun tarif ou que la catégorie de l'envoi est inconnue (les envois, eux, sont comptés
  à part et annoncés) ; le nombre d'engagés quand rien ne permet de le rattacher à la campagne ; et le ratio
  dès qu'un des deux termes manque ou que le dénominateur vaut zéro. Un zéro affirmerait « ça n'a rien
  coûté » ou « personne n'a réagi ».
  ⚠️ **Le tableau montre au plus 50 campagnes**, celles qui ont le plus envoyé, et il DIT quand la période
  en compte davantage : une troncature muette se lirait comme l'inventaire complet de la période.
  ⚠️ **Deux réserves sont écrites sous le tableau**, pas cachées dans une infobulle : un template approuvé
  avant le 2026-09-02 porte chez Meta une adresse figée sans jeton, donc aucun de ses clics ne remonte ; et
  deux campagnes qui envoient la même adresse au même contact partagent le compteur, l'attribution tranche
  alors par proximité de temps.
- ✅ **La fiche d'une campagne, en cliquant sa ligne** (2026-09-09) : ce qu'elle a coûté et ce que les gens
  en ont fait. Elle s'ouvre en cliquant n'importe où sur la ligne, ou au clavier depuis le nom de la
  campagne.
  🔴 **Le coût de référence est le LANCEMENT**, c'est-à-dire le premier message envoyé à chaque
  destinataire. Les templates qu'un scénario renvoie ensuite sont facturés en plus, affichés à part, et
  volontairement hors des rapports : les compter ferait baisser le « coût par interaction » à chaque
  relance, sans qu'une seule interaction de plus soit survenue.
  🔴 **Elle couvre toute la VIE de la campagne**, pas la période choisie en haut, et elle le dit : un
  scénario reçoit des réponses pendant des jours. C'est pourquoi son chiffre peut différer de celui du
  tableau, à deux centimètres de distance.
  ⚠️ **Les échecs sont montrés à part.** Ils n'entraient déjà pas dans le coût ; rien ne distinguait
  « exclus » de « oubliés ».
  ⚠️ **Étape par étape, pour une campagne à scénario** : par bloc, les clics sur les liens tracés, les
  boutons tapés et les réponses écrites, en **gestes et en personnes** (une personne qui agit deux fois
  compte pour deux gestes et une personne), plus le coût du lancement rapporté aux gestes de l'étape.
  « Envoyé » et « lu » n'y comptent pas comme des interactions : ce sont des choses qui ARRIVENT au
  contact, pas des choses qu'il FAIT.
  ⚠️ **Ce que la fiche ne peut pas rattacher, elle le dit** : les clics venus d'un template approuvé avant
  le 2026-09-02 portent chez Meta une adresse figée sans jeton, ils n'auront jamais d'identifiant, et ils
  sont comptés hors des colonnes. Ceux des templates plus récents, eux, savent de qui ils viennent.
- ✅ **Nuage « urgence et satisfaction »** (2026-09-08, sur la page de synthèse). L'analyse de conversation
  note désormais **deux mesures de plus, de 0 à 10** : la **satisfaction** (0 = client très mécontent,
  10 = très satisfait) et l'**urgence** (0 = aucune attente particulière, 10 = il attend une réponse
  immédiate). Le graphe place une conversation par point, **satisfaction en abscisse, urgence en
  ordonnée** : le coin qui alarme, « très urgent et très mécontent », tombe donc **en haut à gauche**, là
  où l'œil va en premier, et il est teinté. Un point empile les conversations de même note (il grossit), et
  une **croix cerclée** marque la moyenne.
  🔴 **Le graphe démarre VIDE, et il le dit.** Les deux notes n'existent que depuis le 2026-09-08 : seules
  les conversations analysées APRÈS cette date en portent. L'historique n'est pas réanalysé (réanalyser
  changerait des analyses que des humains ont peut-être déjà lues, pour quatorze points sur un nuage qui se
  remplit tout seul). Le nuage se garnit donc au fil des jours.
  ⚠️ **Les analyses sans ces notes sont comptées à part, sous le graphe, et ne valent PAS zéro.** Les
  placer en (0,0) rangerait tout l'historique dans le coin « client furieux, urgence nulle » et ferait
  mentir la moyenne.
- ✅ **Trois pages** : **Quantitatif** (volumes, coûts, funnels), **Analyse des conversations** (ce que les
  conversations disent, appelée « Qualitatif » jusqu'au 2026-09-17) et **Mes tableaux** (2026-08-19,
  ci-dessous). Les deux premières ont le **même bandeau
  de période** et la **même
  période par défaut** (30 derniers jours). En revanche la plage choisie **ne suit pas** d'une page à l'autre :
  chaque page repart de son défaut, il faut donc la régler des deux côtés pour comparer un chiffre de l'une et
  une conversation de l'autre sur la même fenêtre.
- ✅ **Plage de dates libre** : presets 7/30/90 j **+** sélecteur de dates personnalisé (les graphes honorent
  une plage passée). Séries : contacts (cumul), templates envoyés, messages échangés. **La barre périodes +
  dates reste FIGÉE en haut au scroll** (sticky sous la barre de compte).
- ✅ **« Messages de service : qui les a écrits »** (2026-09-01, quantitatif). Un tableau qui ventile les
  messages hors template en trois thèmes : **IA** (l'agent de la console et celui de Meta), **scripté** (un
  bloc de scénario) et **humain** (un opérateur depuis l'inbox), avec le volume et la part de chacun. C'est
  la mesure du travail réellement économisé. ⚠️ Une quatrième ligne, **« origine non enregistrée »**,
  n'apparaît que si elle n'est pas nulle : c'est un signal d'anomalie (un envoi qui n'a pas déclaré d'où il
  venait), pas une catégorie normale.
  - ✅ **LE DÉTAIL SOUS « IA »** (2026-09-16) : sous la ligne IA, en retrait, laquelle des trois a écrit :
    **l'agent IA de la console**, **l'agent de Meta**, ou **un agent tiers branché par MCP**. Les parts se
    lisent sur le même total que les lignes principales, pour que la colonne fasse toujours cent, et une
    sous-ligne à zéro ne s'affiche pas (un client sans agent de Meta n'a pas à lire « Agent de Meta : 0 »).
    ⚠️ Le détail est exact **depuis le 2026-09-01** : avant, rien n'enregistrait qui écrivait, et tout
    l'historique plus ancien est rangé en « scripté ».
- ✅ **Le qualitatif est ACTIONNABLE** (2026-09-01). Quatre gestes, là où le tableau ne faisait qu'afficher :
  **cliquer le chiffre d'une action suggérée** ouvre la liste des conversations concernées (et de là, on va
  dans l'inbox) ; **cliquer un sujet fréquent** restreint le détail à ce sujet, recliquer le relâche ;
  **cliquer une ligne du détail** ouvre une **fiche** avec tous les champs du tableau, un **résumé de la
  conversation**, les infos relevées par l'analyse, et un bouton pour aller dans l'inbox ; et **la liste
  s'exporte en CSV et en PDF**, depuis la fenêtre comme depuis le tableau.
  ⚠️ **Les conversations analysées AVANT le 2026-09-01 n'ont pas de résumé** et n'en auront jamais (le
  reconstruire voudrait dire rappeler le modèle sur tout l'historique). La fiche le dit franchement au lieu
  d'afficher la justification à la place, qui explique le classement et pas ce qui s'est dit.
  ⚠️ L'écran **annonce la rétention de VOTRE espace** (90 jours par défaut) : au-delà, une conversation
  n'est plus consultable ni exportable, et une liste plus courte que la période demandée n'est donc pas un
  bug. Un espace dont la purge est désactivée lit « conservées sans limite de durée » à la place.
- ✅ **Funnel PAR campagne** : sélecteur de campagne, envoyés → délivrés → **lus** → **répondus** + taux
  (+ échecs). « Répondu » = réponse reçue après l'envoi, attribuée au dernier envoi (pas de double-comptage).
  Sous-estimation des « lus » assumée si le destinataire a coupé les accusés. Campagne-only en V1. **Ce bloc
  ignore le sélecteur de période** : il porte toujours sur la totalité de la campagne choisie, changer la plage
  ne le fait pas bouger.

  🔴 **« Délivrés » et « lus » affichent « — » quand Meta n'a rendu AUCUN accusé**, au lieu d'un zéro qu'on
  lirait comme un fait. Ce n'est pas un cas limite : une campagne qui envoie un **scénario** n'aura jamais
  d'accusé, par construction (mesuré à 29 envois sur 29), parce que le message y porte un identifiant interne
  que l'accusé de Meta ne peut pas apparier. La carte le dit sous le graphe. ⚠️ Le seuil est « AUCUN », pas
  « certains » : trois accusés manquants sur dix laissent les sept autres parfaitement mesurés, et effacer la
  colonne entière perdrait une vraie information.
- ✅ **Erreurs Meta par code ET par template** : breakdown des codes d'erreur (131049, 131047, 131026...) sur la
  période, avec libellé FR et volume, **filtrable par template** (menu « Tous les templates » / un template précis).
**filtrable sur PLUSIEURS templates à la fois** (on les empile un par un, « Tous les templates »
  quand la sélection est vide), les chiffres étant alors compilés sur la sélection.
  La période suit le sélecteur de plage global. (Portée : campagnes ; les envois Inbox/Workflow n'ont pas de suivi
  d'erreur, cf todo.)
- ✅ **Graphe de coût estimé** : coût/jour (marketing + utility) sur la période, **filtrable par campagne
  ou par template**, votre prix × volume. « Tarif indisponible » affiché si Meta ne renvoie pas de prix
  (jamais de faux coût).
- ✅ **Coût / breakdown par template** (votre prix par catégorie : tarif Meta et votre marge).
- ✅ **Les coûts affichent leur DEVISE** (2026-08-20) : « ≈ 5,68 € » et non plus un nombre nu. La devise vient
  de **Meta** (le compte WhatsApp la déclare, elle arrive avec les tarifs), elle n'est ni devinée ni écrite en
  dur : un compte hors zone euro affichera la sienne, et si Meta ne la donne pas on rend le nombre seul plutôt
  qu'un euro supposé.
  ℹ️ **D'où viennent les prix** : Meta nous donne le coût facturé et le volume par catégorie, on en dérive un
  tarif par message qu'on multiplie par nos envois. On ne reconstitue rien depuis l'indicatif téléphonique.
- ✅ **Les messages de SERVICE sont comptés avec les templates** (2026-08-20) : le graphe « Templates envoyés »
  devient **« Messages envoyés »** et porte une 3e série, les sortants qui ne sont pas des templates (réponse
  d'un agent depuis l'inbox, message d'un scénario, réponse de l'assistant). Ils **n'entrent pas dans le coût
  estimé** : Meta les facture à zéro, leur inventer un prix reviendrait à mentir sur la facture.
- ✅ **Chaque carte s'exporte en PDF** (2026-08-20) : un bouton « PDF » sur chaque carte d'Analytics et sur les
  tableaux. Il ouvre la boîte d'impression du navigateur avec **cette carte seule**, où « Enregistrer au format
  PDF » existe sur tous les systèmes.
- ✅ **Mes tableaux** (2026-08-19) : construire ses propres tableaux de mesure sur un scénario. On choisit un
  scénario, il s'affiche **tel qu'il est dessiné** dans l'onglet Scénario (mêmes blocs, mêmes flèches), les
  blocs qui n'envoient rien sont **grisés et inertes**, et un clic sur un bloc de message ouvre le choix de ce
  qu'on veut compter : envoyés, échecs et délivrés (sur le 1er bloc seulement, après quoi ils ne disent plus
  rien), lus, chaque **choix cliqué**, **le clic sur un lien**, et « a répondu sans cliquer ». Le tableau se
  nomme, s'enregistre et se rouvre. Rendu en **histogramme** : un groupe de barres par bloc dans l'ordre du
  parcours, barres jointives à l'intérieur d'un bloc, un espace entre les blocs, une seule ligne d'abscisse et
  une couleur par nature de mesure.
  ⚠️ **Les mesures démarrent à la mise en service du suivi** (2026-08-19, ~15 h 30) : une période antérieure
  reste à zéro, l'écran le dit. Rien ne reliait auparavant un message envoyé au bloc qui l'avait envoyé.
- ✅ **Créer un template sans quitter la campagne, et être prévenu quand Meta l'approuve** (2026-08-21) :
  après la soumission, l'écran **vérifie tout seul** l'avancement de la revue Meta (toutes les 15 s, et
  seulement quand l'onglet est au premier plan). Dès que le template est approuvé, il est **sélectionné
  automatiquement** pour la campagne en cours, sans rien à cliquer. Un bouton « Vérifier maintenant » reste
  disponible et dit ce qu'il fait pendant qu'il travaille. Un refus est annoncé comme tel et renvoie à l'écran
  Templates, où Meta indique le motif, sans prétendre le deviner.
  Avant, le panneau restait figé sur « statut : PENDING » : le bouton rechargeait bien la liste, mais une liste
  filtrée sur les templates approuvés et affichée ailleurs sur la page. Il fallait fermer le panneau pour
  découvrir que Meta avait approuvé entre-temps.
- ✅ **Clics dans le funnel par campagne** (2026-08-21, Analytics > Quantitatif) : deux étapes de plus après
  « Répondus », affichées **seulement quand la donnée existe** pour cette campagne : **clics sur un bouton**
  (les taps de réponse rapide) et **clics sur le lien** (les boutons URL tracés). Un template sans bouton
  n'affiche pas d'étape à zéro, qui se lirait « personne n'a cliqué » au lieu de « il n'y a rien à cliquer ».
  ⚠️ **Les clics du lien sont comptés à partir du premier envoi de la campagne** : avant, c'est Meta qui
  clique, pendant la revue du template. Et comme un lien ne sait pas quel envoi l'a porté, deux campagnes sur
  le même template partagent leurs clics : l'écran le dit sous le funnel.
  L'ancienne carte « Clics sur les liens, tous envois confondus » de Mes tableaux a été RETIRÉE : cet écran
  pilote un scénario, et un total de template n'y voulait rien dire (il y affichait les clics d'un template
  qui n'avait jamais rien envoyé).
- ✅ **Conversations (analyse)** (2026-07-17, page **Analyse des conversations** depuis le 2026-07-20, renommée ainsi le 2026-09-17) : lecture de l'**analyse automatique des
  conversations** (une IA classe chaque conversation). **Quanti** : donut du **sentiment** (positif / neutre /
  négatif), barres par **intention** (demande de devis, SAV, réclamation, info, prise de RDV, autre) et par
  **action suggérée** (créer un devis / rappeler / relancer / escalader / aucune = le pipeline à traiter), **taux
  de résolution**, **qui a géré** (humain, automatisé, et l'agent de Meta quand il a répondu, ce 3e segment
  n'apparaissant que lorsqu'il y en a), **friction** (nb d'échanges moyen), top sujets. **Quali** : la table des
  conversations analysées, **filtrable** (sentiment / intention / action), où chaque ligne porte la date, le
  contact, le sentiment, l'intention, le sujet, si la demande est résolue, l'action suggérée, un **indice de
  confiance en %** (grisé sous 50 %, pour repérer les verdicts à ne pas prendre au pied de la lettre) et la
  **justification** ; un **clic ouvre le fil réel dans l'inbox**. Analyse IA = **indicative**. Vide tant que peu
  de trafic (message « aucune conversation analysée sur la période » ou « analyse non activée »). Réservé admin.
- ✅ **Les conversations de test ne polluent aucun chiffre** : une conversation ouverte par « Tester le scénario »
  est marquée comme test et **écartée des statistiques** (messages échangés, templates envoyés, détail par
  template, attribution des réponses du funnel) **et de l'analyse** (elle n'est jamais analysée, donc absente
  de la page Analyse des conversations). Tester un scénario depuis son propre téléphone ne déforme donc pas les compteurs.

## L'aide de la console (bouton flottant, sur tous les écrans)

Un bouton rond en bas à droite de chaque écran connecté ouvre un panneau de discussion. Il répond aux
questions sur **l'usage du produit** : comment lancer une campagne, la différence entre un modèle et un
scénario, comment importer des contacts.

- **Il explique et il emmène, il n'écrit jamais rien.** Aucune action, aucun brouillon, aucun réglage. Quand
  la réponse concerne un écran précis, il pose un lien qui y conduit.
- **Il cite sa source** (le titre de la fiche du mode d'emploi d'où vient la réponse), et **quand il ne sait
  pas, il le dit** et ouvre la page Support plutôt que d'inventer une réponse plausible.
- **Le fil de la conversation est gardé tant que la personne reste connectée** : il survit au changement
  d'écran et au rechargement, il meurt avec l'onglet, et il part à la déconnexion. Les questions de suite
  (« et ensuite ? ») sont comprises dans le contexte des précédentes.
- L'accueil montre le logo, trois étincelles et « Je suis là pour vous aider », avec trois suggestions
  cliquables qui remplissent le champ.
- ✅ **« Le récap d'hier »** (2026-09-13) : un bouton en tête de l'accueil du bot, qui part d'un clic et
  répond dans le fil. Il dit combien de conversations ont eu lieu la veille (**dont combien de nouvelles**),
  combien de messages sont arrivés et sont partis, et quels sujets dominaient, comparés au **même jour de la
  semaine précédente**.
  - **Il porte sur la veille, et rien d'autre** : pas d'historique, pas de choix de date. Le libellé le dit,
    pour que personne ne se demande à 16 h pourquoi ses conversations du matin n'y sont pas.
  - **Il dit ce qu'il ne sait pas** : l'analyse ne tourne qu'une fois une conversation retombée inactive,
    donc un récap annonce « 17 conversations ne sont pas encore analysées, leur sujet n'apparaît pas ici »
    plutôt que de laisser croire que tout est couvert.
  - 🔴 **Réservé aux rôles administrateur et manager.** C'est un artefact de pilotage : un opérateur ne voit
    pas le bouton du tout, et la route le refuse aussi s'il l'appelle directement.
  - **Un seul calcul par espace et par jour** : le premier qui clique le fait calculer, tout le monde lit le
    même, et il ne bouge plus.
- ⚠️ **Les jetons sont à notre charge**, pas sur le crédit prépayé du client : ce bot est un service de la
  console, pas une fonctionnalité qu'il achète. Le récap ne consulte un modèle que **les jours où il y a
  quelque chose à signaler** (un volume qui s'écarte nettement de la semaine précédente, un sujet nouveau) ;
  sinon il rend le même texte sans rien dépenser.

## Support (menu Support)

- ✅ **Formulaire de contact** : sujet + message -> email à l'équipe via Resend. Le **reply-to est l'email du
  compte connecté, résolu côté serveur** (2026-07-20) : il ne peut plus être choisi depuis le navigateur.
  **5 envois par minute et par compte** ; au-delà, un message invite à réessayer plus tard.
  Domaine `messagingme.app` **vérifié** (hors mode test) : les emails partent réellement (support, invitations,
  réinitialisation de mot de passe).

## Accueil (1re entrée du menu)

- ✅ **La pastille du numéro** (2026-09-08) : la photo de profil WhatsApp du numéro s'affiche à côté de lui, celle que Meta montre dans le Business Manager et que voient vos destinataires. ⚠️ **Rien ne s'affiche tant qu'aucune photo n'est posée** sur le profil WhatsApp du numéro, et c'est le cas ordinaire au début : un cadre vide se lirait comme un chargement en échec.
- ✅ **Page d'accueil** `/accueil` (clic sur le logo, admin ; c'est aussi l'écran d'arrivée après connexion) :
  « Bonjour {prénom} », une **rangée de 4 chiffres sur 30 jours** (contacts, messages échangés, templates envoyés,
  coût estimé, exactement les mêmes chiffres qu'Analytics ; un tiret plutôt qu'un faux 0 quand Meta n'a fourni
  aucun tarif), le **statut du compte WhatsApp** (pastille vert/ambre/rouge/gris, jamais de faux vert, et « Statut
  indisponible » avec un bouton Réessayer quand on n'a pas pu le lire), le **numéro** + sa **qualité en pastille de
  couleur**, le **cap d'envoi sur 24 h** (« 1 000 clients / 24 h » selon le palier Meta, « Pas encore évalué par
  Meta » tant qu'il n'y en a pas ; le débit brut en messages par seconde, identique pour tous, n'est plus affiché),
  le **nom d'affichage** et la **santé du compte**, et la carte **MBA actif/inactif** (déplacée hors du Dashboard).
- ✅ **Panneau « Compte WhatsApp Business »** (sous le numéro) : **API MM Lite**, **revue du compte** par Meta,
  **vérification d'entreprise** et **business propriétaire**, chacun avec sa pastille (vert quand c'est bon, ambre
  quand ça traîne, gris quand Meta ne dit rien). Le **moyen de paiement n'est pas lisible** par l'API WhatsApp : la
  page renvoie honnêtement vers le Business Manager Meta au lieu d'afficher une valeur inventée.
- ✅ **État HubSpot par numéro** : si un portail HubSpot est relié -> « connecté au portail <nom ou id> », l'état de la
  synchronisation (**activée / en pause / coupée**, avec pastille) et un lien vers le guide de configuration HubSpot.
  Couper la synchro ouvre un choix explicite : **mettre en pause** (réversible ; les analyses produites pendant la
  pause sont **renvoyées à la reprise**, signalé par un bandeau « rattrapage en cours ») ou **déconnexion complète**
  (délie le compte HubSpot et révoque son accès ; un avertissement prévient que cela coupe **tous** les numéros de
  l'espace, le compte HubSpot étant lié à l'espace et non à un numéro). Si aucun portail -> un bouton
  **« Connecter HubSpot »** qui lance l'installation OAuth et relie ce numéro.
- ✅ **Toggle « Campagnes via données HubSpot »**, juste sous le bloc HubSpot : autorise l'import d'une liste HubSpot
  comme destinataires de campagne. Tant que l'accès aux listes n'a pas été accordé, un bouton **« Autoriser l'accès
  aux listes HubSpot »** demande ce droit au portail déjà connecté, sans re-solliciter le reste.
- ✅ **Guide « Configurer HubSpot avec Messaging Me »** (ouvert dans un nouvel onglet depuis l'Accueil et depuis le
  Guide MBA) : connecter son compte HubSpot, **ajouter la carte Messaging Me sur la fiche contact** (Paramètres >
  Objets > Contacts > onglet Personnalisation de la fiche > Ajouter des cartes), et ce que cette carte affiche.
- 🗑️ **Relancer automatiquement les échecs : PLUS D'INTERRUPTEUR D'ESPACE** (2026-09-23). La case de la campagne
  décide (« Réessayer les envois qui échouent ») : un envoi bloqué par une limite Meta est retenté le lendemain
  matin ; un numéro non délivrable une fois, puis marqué injoignable dans HubSpot au 2e échec.
- 🗑️ **« À la reprise, le fil… » : SUPPRIMÉ le 2026-08-18** (voir la section Inbox). Ce réglage d’espace
  n’existe plus, et le sélecteur par conversation non plus.
- ✅ **Onboarding « Connecter mon compte WhatsApp » (Embedded Signup)** : un espace **sans numéro rattaché** voit un
  bouton qui ouvre la **popup Meta** (Facebook Login for Business + config_id) ; le business choisit son compte + son
  numéro et le backend rattache tout (échange de code, webhooks, register). ✅ **LIVE et éprouvé de bout en bout
  le 2026-08-17** : un vrai numéro d'un vrai business tiers est passé connecté et vérifié, avec l'enregistrement
  Cloud API fait automatiquement (l'étape qui, ailleurs, oblige à cliquer un bouton pour sortir du « pending »).
  Prérequis Meta remplis : Tech Provider vérifié ET **inscrit** (l'inscription est une étape à part de la
  vérification, c'est elle qui débloquait), app publiée.
- ✅ **Recommencer l'embarquement fonctionne** (2026-08-17) : si un client relance la connexion après un premier
  essai déjà abouti côté Meta, ça marche quand même. Avant, il était bloqué sans recours, avec un message qui
  l'invitait à réessayer alors que réessayer ne pouvait rien changer. Il n'a rien à ressaisir et pas de nouvel
  OTP à donner : il choisit le compte et le numéro existants.
- ✅ **Un espace pilote UN numéro WhatsApp, et le second est refusé clairement** (2026-08-31). Tenter d'en
  connecter un second affiche : quel numéro est déjà là, et quoi faire (créer un second espace, ou détacher
  l'actuel). Avant, le second était accepté et **fusionnait** les deux : la même personne écrivant aux deux
  numéros tombait dans une seule conversation, et un parcours démarré sur l'un pouvait répondre sur l'autre,
  sans que rien ne le signale. Un refus explicite vaut mieux qu'une fonctionnalité qui a l'air de marcher.
- ✅ **Les messages d'erreur de l'embarquement sont enfin lisibles** : quand Meta refuse, on affiche SON motif
  (code expiré, compte non partagé, plusieurs numéros à départager) au lieu d'un « Erreur 502 » opaque.
- ✅ **Activer un numéro que Meta a laissé non vérifié** (2026-09-23, LIVE). Depuis la version 4 du parcours
  d'inscription, un client peut le TERMINER avec un numéro que Meta n'a pas vérifié : le numéro est bien
  rattaché, mais il ne peut pas encore envoyer. Avant, il n'avait aucun recours dans la console et il fallait
  passer par WhatsApp Manager. Désormais la carte du numéro, sur l'Accueil, dit qu'il reste à activer et porte
  le bouton : Meta envoie un code (par appel par défaut, par SMS au choix), le client le saisit, et le numéro
  est enregistré dans la foulée. ⚠️ **Meta ne permet que dix demandes par numéro sur 72 heures**, toutes étapes
  confondues, et bloque le numéro au-delà. L'écran protège donc ce quota : il refuse un second code avant une
  minute, il ne réessaie jamais tout seul, et il ne demande pas de code à un numéro que Meta dit déjà vérifié.
- ✅ **Logo Meta Business Agent** sur la carte MBA (produit de Meta), à la place de notre logo MM.

## Rappels avant ou après une date (menu Automation)

- ✅ **Lancer un scénario X minutes, heures ou jours AVANT OU APRÈS une date enregistrée** (2026-08-23,
  élargi au sens « après » le 2026-09-08). On choisit un champ de type « date et heure », un côté, un nombre
  et une unité : « 48 heures **avant** Rendez-vous », ou « 3 jours **après** Fin de contrat ». C'est le seul
  déclencheur qui ne répond pas à un événement mais au temps qui passe.
  ⚠️ **Vos automations existantes n'ont pas bougé** : sans choix explicite, le déclencheur reste « avant »,
  ce qu'il a toujours fait.
  🔴 **« Après » ne rattrape PAS le passé non plus.** Activer « 3 jours après » ne déclenche rien pour les
  contacts dont la date est déjà dépassée : sinon toute votre base concernée partirait d'un coup, et ce
  serait facturé. Seules les échéances à venir déclenchent.
- **Seuls les champs date et heure sont proposés.** Un champ texte accepterait la configuration et ne
  partirait jamais : l'automation aurait l'air réglée. S'il n'y en a aucun, l'écran dit où en créer un.
- ✅ **Une échéance déjà passée n'envoie RIEN.** Un webhook reçu en retard, ou un import de vieux
  rendez-vous, ne déclenche pas une salve de rappels périmés : un rappel « 48 h avant » qui part 12 h avant
  dit quelque chose de faux au client. Une courte fenêtre de rattrapage existe quand même, pour qu'un
  redémarrage du serveur ne fasse pas perdre les échéances de la minute d'avant.
- ✅ **Un rendez-vous REPORTÉ redonne un rappel.** On retient pour quelle date on a déjà prévenu, pas
  seulement qu'on a prévenu : la date change, l'occurrence est neuve. Sans ça, un report laisserait le client
  sans rien, en silence.
- Les garde-fous habituels s'appliquent : contact bloqué, plafond horaire. Un parcours en cours ne bloque
  rien : il est CLOS et remplacé par le nouveau (2026-09-07).
- **Si le scénario ne peut pas démarrer** (le fil est tenu par un opérateur à cet instant), le rappel est
  retenté au passage suivant, tant que la courte fenêtre est ouverte. Rien ne part pendant les tentatives.

## Webhooks entrants (menu Tools)

- ✅ **Recevoir du JSON d'un outil tiers** (2026-08-23) : la console donne une **adresse** qu'on colle dans
  Zapier, Make, un CRM ou le formulaire de son site. L'outil y poste du JSON quand il se passe quelque chose
  chez lui (un formulaire soumis, une commande passée, un devis signé). C'est l'inverse de l'API publique :
  là, c'est le tiers qui nous appelle, sans rien avoir à programmer.
- ✅ **On choisit où va chaque valeur, en cliquant**. Le parcours est en trois temps, assumé par l'écran :
  (1) on crée le webhook et on copie l'adresse ; (2) on déclenche un envoi de test depuis son outil ;
  (3) le contenu reçu s'affiche **en arbre**, et chaque valeur porte un bouton « Attacher… » qui l'envoie
  vers le **téléphone**, le **nom**, ou n'importe quel **champ de contact**. Tant qu'aucun appel n'est arrivé,
  l'écran le dit au lieu d'afficher un formulaire vide.
- ✅ **Le consentement se règle par webhook** (2026-08-24). Une case « Si vous créez des contacts via
  webhook, sont-ils opt-in ? », **cochée par défaut**, décide si les contacts créés partent en consentement
  donné ou « inconnu ». C'est vous qui l'affirmez : nous ne pouvons pas déduire un consentement du contenu
  reçu, exactement comme pour l'import CSV. Décochée, les contacts restent « inconnus », ce qui les exclut
  des campagnes marketing. La trace conserve **par quel webhook** le consentement est entré, ce qui permet
  de le justifier. Et un contact déjà opt-in ne perd jamais son consentement, même case décochée.
- ✅ **Le contact vient du CONTENU, pas de l'appelant.** L'outil qui appelle n'est pas le contact : c'est le
  JSON qu'il envoie qui porte le téléphone et le nom. Une case **« créer les contacts inconnus »**, cochée par
  défaut, décide si un appel concernant quelqu'un d'absent du mini-CRM crée sa fiche (avec un consentement
  « inconnu », comme un import) ou se contente d'être enregistré. Le nombre de contacts créés par ce webhook
  est affiché à côté de la case.
- ✅ **Déclencher un scénario**, facultatif. Un webhook peut lancer un scénario à chaque appel exploitable. Les
  garde-fous habituels s'appliquent tels quels : contact bloqué, anti-rebond par contact, plafond horaire, un
  parcours en cours, qui est clos et remplacé. ⚠️ Le contact n'a pas forcément écrit récemment : le scénario doit donc **commencer
  par un template approuvé**, sinon il est refusé au démarrage.
- ✅ **On voit la NATURE de chaque champ, et on peut en créer un sans quitter l'écran** (2026-08-23). Le menu
  des destinations affiche le type entre parenthèses (« Rendez-vous (Date et heure) ») : sans lui, on ne sait
  pas si la valeur qu'on attache sera stockée comme une date ou comme du texte, alors que ça décide de tout
  ce qu'on pourra en faire ensuite. Une entrée « + Créer un champ… » ouvre un mini-formulaire sur place, avec
  le nom prérempli d'après la clé reçue et **le type deviné d'après la valeur** : une valeur comme
  `2026-08-23T15:40:00Z` propose « Date et heure » toute seule. Le champ créé est aussitôt sélectionné.
- ✅ **Les dates sont stockées au format international**, quelle que soit la forme reçue (2026-08-23). Un outil
  qui envoie `2026-08-23 15:40:00` (espace au lieu du T) ou un horodatage epoch est accepté et converti. En
  revanche `03/04/2026` est **refusé** : ça peut être le 3 avril ou le 4 mars, et deviner produirait des
  rappels envoyés un mois à côté sans que rien ne le signale. Le refus dit quoi envoyer à la place. Une date
  **sans heure** dans un champ date et heure est refusée pour la même raison : un rappel réglé « 2 h avant »
  partirait à 22 h la veille.
- ✅ **Un tableau se pointe élément par élément** : `lignes[0].prix` désigne le premier article, pas la liste.
  Une valeur qui désigne un **ensemble** (objet ou tableau) est refusée à la configuration, avec le message qui
  dit quoi faire : un ensemble écrit dans un champ rendrait la variable **vide** dans un template, sans erreur.
- ✅ **Secret facultatif**. On peut exiger un secret dans un en-tête ; il n'est montré qu'une fois, comme une
  clé d'API. Facultatif parce qu'un formulaire de site ne sait souvent pas en poser, et l'exiger fermerait la
  porte au cas le plus simple. L'adresse elle-même est déjà une clé (26 caractères tirés au sort).
- ✅ **Le tiers ne reçoit jamais d'erreur pour un refus métier.** Un appel bien formé rend toujours un succès,
  dont le corps dit ce qui s'est passé : contact créé / retrouvé / absent, nombre de champs écrits, scénario
  lancé ou non, et les chemins du mapping qui n'ont rien rendu sur cet appel. Un outil tiers qui reçoit une
  erreur réessaie en boucle, et beaucoup désactivent le webhook après quelques échecs.
- **Ce qui est conservé** : seulement le **dernier** contenu reçu, jamais un historique, et il est effacé
  automatiquement après 7 jours sans appel. Un bouton « oublier ce contenu » l'efface tout de suite. Le JSON
  d'un tiers peut porter des données personnelles qu'on n'a pas demandées.
- Réservé aux **admins** (côté serveur, pas seulement dans l'écran) : une adresse de webhook est un pouvoir
  d'écriture sur le mini-CRM, et un pouvoir d'envoi quand un scénario y est attaché.

## API publique `/v1` (intégrateurs externes)

- ✅ **Clés d'API** (2026-07-17) : un admin crée des clés depuis la console (nom + périmètres). La clé n'est
  **montrée qu'une fois** à la création (jamais re-affichée, seul son empreinte est stockée). Révocable.
  Deux périmètres : « écrire des contacts » et « lancer des envois » (une clé peut n'avoir que l'un des deux).
- ✅ **Créer / mettre à jour des contacts** : `POST /v1/contacts` (un contact) et `/v1/contacts/batch` (jusqu'à
  500). Champs de base ou perso, adressés par leur clé OU leur code ; un champ perso inconnu est créé
  automatiquement. Sert à pré-charger des contacts avant une campagne.
  🔴 **Un contact mal formé est refusé À SA LIGNE, et les autres passent** (2026-09-14) : la réponse nomme
  le champ fautif (« fields.adresse ») plutôt que de renvoyer une erreur globale. Une ligne vide au milieu
  d'un lot ne fait plus perdre les 499 autres, et une valeur de champ qui n'est pas du texte (un objet,
  une liste) est refusée au lieu d'être enregistrée illisible. Un nombre ou un oui/non reste accepté.
  ⚠️ **Trois bornes larges** encadrent un contact : 64 caractères pour le nom d'un champ, 50 champs par
  contact, 100 caractères pour l'origine du consentement. Un intégrateur normal ne les rencontre pas.
- ✅ **Lancer un envoi** : `POST /v1/sends` envoie un **scénario** (par code ou par nom) ou un **template** à un
  lot de destinataires (jusqu'à 50). L'API crée les contacts absents à la volée puis envoie. Réponse
  **détaillée** : combien créés / retrouvés, et la liste des numéros écartés **avec la raison** (non opt-in,
  numéro invalide, hors fenêtre...). Un en-tête `Idempotency-Key` **obligatoire** garantit qu'un même envoi
  relancé ne part jamais deux fois. `GET /v1/sends/:id` donne le suivi : compteurs globaux (en attente, en cours,
  envoyés, en échec, écartés) et **une ligne par destinataire** (statut, identifiant de message, erreur, état de
  livraison : envoyé, délivré, lu, en échec). Les **réponses** ne figurent pas dans ce suivi, elles se lisent dans
  Analytics.
  ⚠️ **Changement de réponse (2026-08-11)** sur `GET /v1/sends/:id` : pour un envoi de **scénario**, le nom et la
  langue du template valent désormais **null** (au lieu d'une chaîne vide) puisqu'un scénario n'a pas de template
  propre, et un champ **nom du scénario** apparaît. Un client qui affichait la chaîne vide telle quelle voyait
  jusqu'ici un libellé vide ; c'est ce que cette bascule corrige.
- ✅ **Cibler un bloc précis d'un scénario** : `POST /v1/sends` accepte aussi le **code d'un bloc** (`nod_...`, visible
  dans Contenu > Blocs) pour envoyer ce bloc à une liste de contacts. Réservé à la **fenêtre de 24 h** : un contact
  qui n'a pas écrit récemment est écarté (`out_of_window`), jamais forcé, et un numéro inconnu est écarté
  (`unknown_contact`) au lieu d'être créé pour rien.
- L'espace client est **toujours déduit de la clé** (jamais de l'URL) : une clé ne peut voir/toucher que les
  données de son espace. Débit borné par clé.
- ✅ **Menu « Developers »** (2026-07-20), en bas de la barre latérale de l'onglet **Console**, réservé aux admins. Deux pages :
  **Documentation API** (adresse de base, authentification, débit, chaque endpoint avec son corps de requête,
  ses réponses et ses codes d'erreur, plus un exemple curl complet) et **Clés d'API** (créer avec un nom et des
  périmètres, lister avec date de création et dernier appel, révoquer). La clé en clair s'affiche dans une
  fenêtre au moment de la création, avec un bouton Copier : c'est le seul instant où elle existe. Une clé
  révoquée reste dans la liste, marquée comme telle.

## Brancher vos systèmes : les connecteurs API (menu « Tools » > Connecteurs API)

- ✅ **Une bibliothèque de systèmes pour tout le workspace** (2026-08-28), dans le menu **Tools**, à côté des
  webhooks. Un système est déclaré UNE fois et sert à **tous vos agents** : c'est le client qui le possède,
  pas un agent en particulier. L'écran dit combien d'agents s'en servent, ce qui évite de supprimer un système
  en cassant les autres.
- ✅ **Déclarer un système** : un nom, une adresse de base en HTTPS, et son mode d'authentification (jeton,
  en-tête nommé, ou aucune). Le secret est chiffré chez nous et **n'est jamais réaffiché** : un champ laissé
  vide veut dire « inchangé ».
- ✅ **Éprouver la connexion** : un bouton, un chemin, et le verdict avec sa date. C'est le seul endroit où un
  jeton expiré se voit AVANT qu'un contact ne le découvre : un jeton mort ne produit aucune erreur visible
  côté client, l'agent se contenterait de ne plus savoir répondre.
- ✅ **Un système injoignable, lent ou bavard le DIT, au lieu de faire semblant** (2026-09-04). Trois réponses
  qui passaient pour des succès sont désormais refusées avec leur raison : le système **ne répond pas dans les
  dix secondes** ; il **coupe sa réponse en cours d'envoi** (avant, on affichait « il a répondu, mais vide »,
  ce qui envoyait chercher du mauvais côté pendant longtemps) ; ou sa réponse est **trop volumineuse** pour
  l'aperçu. Même exigence pour l'adresse elle-même : un nom qui pointe vers notre infrastructure interne est
  refusé, et une résolution qui traîne au-delà de trois secondes est traitée comme une résolution qui échoue.
- ✅ **En pleine conversation, l'agent applique les mêmes règles** : si le système du client coupe sa réponse,
  l'agent ne conclut rien, il le signale, et **le connecteur passe au rouge dans la console**. Avant, ce cas
  précis marquait le système comme sain : un connecteur qui mourait restait vert jusqu'à ce qu'un contact le
  découvre.
- ✅ **Mettre au point un APPEL, dans la même page** (2026-09-02), et non plus dans chaque agent. Un appel est
  décrit une fois, éprouvé, puis ouvert aux agents qui en ont besoin. L'écran suit l'ordre du raisonnement :
  quelles données on envoie, où on les envoie, on essaie, on coche ce qu'on garde.
- ✅ **Choisir la méthode** (GET, POST, PUT, PATCH, DELETE) et le chemin, avec des variables
  (`/commandes/{{ref}}`, insérées par les mêmes pastilles que partout ailleurs). Les **en-têtes** portent eux
  aussi des variables. ⚠️ Une valeur qui vaut « . » ou « .. » est refusée : elle déplacerait l'appel dans le
  chemin. Le bouton « Essayer » montre ce qui est PARTI, en-têtes compris, sans jamais le secret de la source.
- ✅ **Envoyer des données**, ce qui manquait : des **paramètres d'URL**, et surtout un **corps de requête**,
  saisissable de deux façons au choix : une **liste de champs** (aucune accolade à écrire) ou du **JSON brut**
  (collez l'exemple de votre documentation et remplacez les valeurs par des variables). La bascule de la liste
  vers le JSON reprend le travail déjà fait ; elle est à sens unique et le bouton le dit.
- ✅ **Dire d'où vient chaque donnée envoyée** : décidée par l'agent, le **numéro ou le nom du contact**, un
  **champ personnalisé** de sa fiche, une **valeur système**, ou une constante. Une donnée peut être marquée
  « sans elle, on n'appelle pas ». **L'agent ne peut pas fabriquer un identifiant de client** : c'est ce qui
  empêche quelqu'un de demander à votre agent la commande d'un autre.
- ✅ **Deux valeurs système** : la **date et l'heure courantes** (au format international, avec le décalage de
  votre fuseau) et le **dernier message écrit par le contact**, ce qui permet de transmettre à votre système
  ce que la personne vient de demander, mot pour mot.
- ✅ **Essayer l'appel** avec des valeurs de test, et voir la vraie réponse : le statut, la durée, ce qui est
  parti, et le contenu reçu.
- ✅ **Cocher les champs à garder** dans la réponse reçue, au lieu d'écrire des chemins de mémoire. ⚠️ Depuis
  le 2026-09-15, ce que vous cochez ici est le **défaut proposé** quand vous donnerez l'appel à un agent :
  c'est dans l'écran de l'agent que se décide ce que LUI a le droit de lire (voir plus bas).
- ✅ **Un appel à moitié écrit s'ENREGISTRE** (2026-09-15). Vous mettez un appel de côté et vous y revenez plus
  tard, même sans avoir réussi à le faire marcher.
  🔴 **Avant, enregistrer exigeait un champ de réponse coché, et ces champs se cochent dans le résultat d'un
  essai réussi.** Un appel qu'on n'avait pas encore fait marcher était donc perdu en quittant l'écran, et il
  fallait tout retaper. C'est le cycle que le bouton Essayer sert justement à ouvrir.
- ✅ **Les pastilles de variable se voient AVANT d'avoir déclaré quoi que ce soit** (2026-09-15). La ligne
  « Insérer : » est toujours là, et quand elle est vide elle renvoie vers l'onglet où l'on déclare une donnée.
  Avant, elle n'apparaissait qu'une fois une donnée déclarée : on ne découvrait le mécanisme qu'après s'en
  être passé, en tapant les accolades à la main.
- ✅ **Une pastille mal placée dans un JSON dit ce qui ne va pas, et se corrige d'un bouton** (2026-09-15).
  Une pastille se met **entre guillemets** (`"{{user_ns}}"`), sinon le corps n'est plus du JSON. L'écran
  disait seulement « Ce n'est pas du JSON valide », ce qui est vrai et inutilisable. Il nomme désormais la
  cause et propose **Corriger**.
  ⚠️ **Les guillemets ne transforment pas votre valeur en texte** : une donnée déclarée « nombre » part bien
  en nombre. Les guillemets ne servent qu'à garder le gabarit lisible comme du JSON.
- ✅ **Une pastille qui ne désigne aucune donnée est signalée pendant que vous écrivez**, avec un bouton pour
  la déclarer sur place. Avant, le problème n'apparaissait qu'au moment où l'agent passait l'appel, donc en
  pleine conversation avec un client.
- ✅ **Dans CHAQUE agent** (onglet Outils), choisir un appel de la bibliothèque et lui donner SES mots : le nom
  vu par l'agent, à quoi ça sert, quand ne pas l'appeler. Deux agents peuvent utiliser le même appel avec des
  consignes différentes, et le corriger une fois le corrige partout.
- ✅ **« Ça pousse ou ça intègre ? »**, la question posée quand vous donnez un appel à un agent (2026-09-15).
  Deux réponses possibles, et la seconde question n'apparaît que si elle sert :
  - **Il POUSSE de l'information** vers votre système (poser une étiquette, créer une fiche). Rien de plus à
    répondre. L'agent saura seulement si c'est passé, jamais ce que votre système a répondu.
  - **Il RÉCUPÈRE de l'information** que l'agent intègre à la conversation. L'écran demande alors **quoi** :
    un bouton **Essayer** montre ce que votre système répond vraiment, et vous cochez là-dedans.
  🔴 **Ça remplace une case « C'est bien ce que je veux envoyer » qui ne servait à rien** : on est d'accord
  pour utiliser un outil par construction, puisqu'on est en train de l'ajouter. La vraie question, que seul
  vous pouvez trancher, est ce que l'appel FAIT. Et elle ne se devine pas de la méthode HTTP : un `POST` peut
  très bien être une recherche.
  🔴 **Ce que l'agent lit se décide AGENT PAR AGENT.** Deux agents peuvent piocher dans le même appel et lire
  des choses différentes. Les champs cochés sur l'appel ne font que pré-remplir, et **changer ce défaut ne
  touche aucun agent déjà en service**.
  ⚠️ **Un appel qui pousse ne rend RIEN à l'agent, même en cas de succès.** C'est volontaire : la réponse d'une
  création ou d'une modification porte souvent la fiche entière de votre client, son e-mail, ses identifiants
  internes. Un agent qui n'en a pas besoin n'a aucune raison de les envoyer au fournisseur du modèle.
- ✅ **L'écran vous montre ce qui partira** avant de brancher l'appel sur un agent : la liste des données
  envoyées, en français. C'est la seule fois où vous voyez qu'un appel enverra une donnée de vos contacts,
  voire leur dernier message, à un système tiers.
- ✅ **Un outil pour l'agent de Meta, sans passer par un agent IA** (2026-09-15), depuis l'onglet **Outils** du
  Meta Business Agent (« Ajouter un outil » > « Appeler un connecteur API » depuis le 2026-09-21). Vous choisissez
  l'appel, vous donnez les mots, et l'outil est créé, exposé et envoyé à Meta d'un seul geste.
  🔴 **Avant, un outil naissait en le donnant à un agent IA.** Exposer un appel à Meta obligeait donc à créer
  un agent dont vous n'aviez pas besoin, et à répondre pour lui à des questions que Meta ignore.
  ⚠️ **Aucune question « pousse ou intègre » ici, et c'est normal** : Meta appelle votre système en direct et
  lit toute la réponse. La poser donnerait un réglage sans effet.
- ✅ Un outil de connecteur naît **inactif**, comme un outil maison : c'est un administrateur qui l'active
  après l'avoir relu.
- ✅ **Un appel utilisé par un agent ne se supprime pas** : l'écran dit combien d'agents s'en servent et refuse,
  plutôt que de les rendre muets en silence.
- ⛔ **L'authentification ne se règle pas sur un appel** : elle vit sur le système, où le secret est chiffré. Un
  en-tête `authorization` saisi sur un appel est refusé, en vous disant où le déclarer.
- ➡️ **Les serveurs MCP ont leur propre écran**, voir la section suivante.

## Brancher un serveur MCP (menu « Tools » > Connecteurs MCP)

Un serveur MCP est un catalogue d'outils tenu par quelqu'un d'autre (votre éditeur de CRM, votre outil de
tickets, un service interne). Plutôt que de décrire chaque appel à la main, vous branchez le serveur et vous
importez ce qu'il propose.

- ✅ **Déclarer un serveur** : son adresse, et comment on s'y authentifie (rien, un jeton, ou un en-tête que
  vous nommez). Le secret est chiffré et ne ressort jamais de nos serveurs.
  ⚠️ **L'adresse est vérifiée deux fois** : sur son texte quand vous l'enregistrez, et sur ce vers quoi elle
  RÉSOUT à chaque appel. Une adresse publique qui pointe vers un réseau interne est refusée.
- ✅ **Éprouver** le serveur en un clic : on s'y connecte pour de vrai et on vous dit ce qui se passe. Un
  serveur injoignable, un jeton refusé ou un protocole trop ancien sont nommés.
- ✅ **Aperçu avant import** : ce qui sera ajouté, ce qui a changé, ce qui a disparu, et **combien
  d'autorisations vont tomber**. Rien n'est écrit tant que vous n'avez pas cliqué « Importer ».
  🔴 **Un outil dont le schéma a changé n'est plus l'outil que vous aviez autorisé**, donc son autorisation
  tombe et il faut la redonner. C’est ce qui empêche un serveur distant d’élargir en silence ce qu’un outil
  autorisé sait faire.
- ✅ **Un outil qui disparaît du serveur est MARQUÉ, jamais supprimé** : la fiche reste, avec la date, et le
  journal des appels continue d'y renvoyer.
- ✅ **Un catalogue trop gros le dit**, et l'import n'en RETIRE alors rien : sur une liste partielle, marquer
  « disparu » ce qui n'y figure pas débrancherait des outils bien vivants.
- ✅ **Tous les outils sont importés, même ceux qu'on ne sait pas activer.** Un outil dont les paramètres ne
  se ramènent pas à une liste de champs simples (un tableau, une forme non déclarée, plusieurs formes
  possibles) apparaît quand même, avec **la raison écrite en clair** : vous pouvez la montrer à votre
  fournisseur. Il ne peut simplement pas être activé.
- 🔴 **Pour chaque paramètre, vous décidez QUI le remplit**, et c’est la garde qui compte : **l’agent
  décide**, **le contact de la conversation** (son numéro, son nom), **un champ de sa fiche**, ou **une
  valeur fixe**. Seuls les paramètres laissés à l'agent lui sont montrés ; les autres sont remplis par la
  console, et il ne peut ni les voir ni les changer. C'est ce qui empêche un agent d'aller chercher la
  commande de quelqu'un d'autre parce qu'un contact a donné un numéro qui n'est pas le sien.
  ⚠️ **Vos choix SURVIVENT aux rafraîchissements** : un paramètre que vous avez cloué le reste quand le
  serveur change son schéma, tant que ce paramètre existe encore.
- ✅ **« Ce que cet outil fait » est proposé par le serveur et confirmé par vous.** La norme MCP dit
  expressément que ce qu'un serveur déclare sur lui-même n'est pas digne de confiance : un serveur qui
  s'annonce « lecture seule » ne désarme donc rien tant que vous ne l'avez pas confirmé.
- ✅ **« Quand NE PAS l'appeler »**, en vos mots : c'est le seul levier qui décide quand un outil se
  déclenche, et le serveur distant n'en sait rien (sa description dit ce que l'outil FAIT, jamais quand
  s'en abstenir).
- ✅ **Les noms sont préfixés par le serveur** (`notion_search`), pour que deux serveurs qui exposent chacun
  un `search` ne se marchent pas dessus.
- ✅ **Si un rafraîchissement débranche un outil, la fiche de l’agent le dit**, en le nommant, sous
  « Ce qui a changé sans vous ». Sans ça, l’agent perdait une capacité du jour au lendemain sans cause
  visible nulle part. ⚠️ Ça n'empêche PAS d'activer l'agent : un serveur tiers n'a pas à décider ça.
- ✅ **Un serveur utilisé ne se supprime pas** tant qu'un outil actif en dépend.
- ✅ **Chaque agent choisit ce qu'il a le droit d'appeler**, dans **AI Agent > Outils**, section « Vos
  serveurs MCP » : les outils importés y apparaissent à côté des outils maison et des appels de
  connecteur, et s'activent du même geste. Les paramètres, eux, se règlent ici, dans Tools >
  Connecteurs MCP.
- ⛔ **L'agent de Meta ne reçoit PAS ces outils**, et l'écran le dit : le Meta Business Agent n'accepte pas
  encore de connexion MCP. Ils se déclarent aux agents IA, dans **AI Agent > Outils**.
- ⛔ **Pas encore : OAuth.** L'authentification se fait par jeton ou par en-tête. OAuth viendra ensuite.

## L'onglet « Outils » de l'agent de Meta (Meta Business Agent > Paramètres > Outils)

Refait le 2026-09-21 d'après le croquis de Julien (spec `docs/superpowers/specs/2026-09-21-outils-maison-mba-design.md`,
§ 9). **Déployé et éprouvé en conversation réelle le 2026-09-21 au soir** (migration 0162) : une étiquette et une
information posées par l'agent de Meta, relues en base. **Envoyer un bloc, lancer un scénario et la réponse « à
côté » s'y ajoutent le 2026-09-22** (lots 3 et 4) ; leur essai réel en conversation reste à faire.

- ✅ **Une liste claire des outils de l'agent de Meta, et d'eux seuls** : pour chacun, son titre, ce qu'il vise
  (« Tag : vip », « Champ : ville », « Appel : … »), son type (Tag, Information, Connecteur API) et son état
  chez Meta, avec « Modifier » et « Supprimer ». Les connecteurs d'un agent IA se gèrent depuis sa fiche.
- ✅ **Un gros bouton « + Ajouter un outil »**, qui propose : **Poser un tag**, **Enregistrer une
  information**, **Envoyer un bloc**, **Lancer un scénario**, **Appeler un connecteur API**. Un type est grisé, avec le lien qui y mène, tant que l'espace
  n'a rien à y mettre : aucun appel déclaré (Tools > Connecteurs API), aucun champ déclaré (Contenu >
  Bibliothèque > Champs). Une lecture ratée ne passe pas pour « aucun » : elle le dit, avec « Réessayer ».
- ✅ **Poser un tag** : l'étiquette est fixée par l'administrateur, l'agent de Meta ne décide que du moment. Elle
  arrive sur la fiche du mini-CRM (déclarée dans Contenu > Bibliothèque > Étiquettes si elle est nouvelle).
  ⚠️ **Ne comptez pas sur les automations « tag ajouté »** : l'agent de Meta tient alors la conversation, et un
  démarrage automatique n'écrit jamais dans une conversation tenue. Le scénario qu'elles lanceraient ne démarre
  pas, et il n'est pas rejoué ensuite. L'écran le dit.
- ✅ **Enregistrer une information** : le champ de la fiche est fixé, l'agent de Meta fournit la valeur, tirée
  de la conversation. En option, une liste de valeurs permises : une autre valeur est refusée, et l'agent le sait.
- ✅ **Envoyer un bloc** : un message précis d'un de vos scénarios publiés (un message rapide, un modèle), choisi
  à l'avance. Il part SEUL, sans ce qui le suit dans le scénario, et l'agent de Meta reprend la parole au message
  suivant du client. 🔴 Un bloc qui attend une réponse (des boutons, une question, un formulaire, une attente, un
  agent IA) ne se choisit pas : il reste visible, grisé, avec sa raison, qui renvoie vers « Lancer un scénario ».
  Hors de la fenêtre de 24 h, seul un modèle part. Si le scénario change ensuite (bloc supprimé, devenu une
  question), la ligne passe en rouge et l'agent de Meta lit pourquoi à chaque appel. C'est irréversible, et
  l'écran le dit : un message parti ne se rappelle pas.
- ✅ **Lancer un scénario** : un scénario publié, depuis son début, exactement comme le bouton de l'Inbox. Engage
  Me prend la conversation le temps du parcours, puis la rend à l'agent de Meta. Un brouillon jamais publié n'est
  pas proposé. Un client bloqué ne reçoit rien, et l'agent de Meta le sait.
- ✅ **La réponse « à côté »** : quand un scénario pose une question à boutons et que le client écrit autre chose
  (« vous êtes ouverts dimanche ? »), le parcours s'arrête, la conversation revient à l'agent de Meta ET son
  message lui est transmis : il y répond aussitôt, au lieu d'attendre le message suivant du client. Rien n'est
  transmis sur une fin normale de parcours, ni quand le client tape un bouton qui ne mène nulle part (la
  conversation part alors à un humain), ni pour une simple réaction, ni sur une conversation de test.
- ✅ **Enregistrer, c'est envoyer à Meta.** Créer, modifier ou supprimer un outil le porte chez Meta dans le même
  geste ; il n'y a plus de bouton « Envoyer » à retenir (c'est son oubli qui avait fait rater le premier essai
  du relais). Un envoi qui échoue ne défait pas l'enregistrement : la ligne reste « À envoyer ».
- ✅ **L'état chez Meta, ligne par ligne** : « ✓ Chez Meta » ou **« À envoyer »**, qui est un bouton. Il envoie
  TOUT ce qui attend (Meta ne reçoit qu'une publication entière), et le dit au survol. Une ligne passe aussi
  « À envoyer » quand c'est le connecteur `EngageMe` qui doit repartir (clé « Agent de Meta » révoquée).
- ✅ **Une consigne pré-remplie par type**, directive (« Appelle cet outil dès que le client… ») : tant que le
  trou « [décrivez la situation] » n'est pas complété, l'outil ne s'enregistre pas.
- ✅ **Le nom technique se calcule depuis le titre**, et reste modifiable.
- ✅ **Une ligne rouge quand la cible n'existe plus** : un champ supprimé du mini-CRM. Un tel outil refuse à
  chaque appel (l'agent de Meta lit pourquoi, et rien n'est écrit sur la fiche) ; sans cette ligne, personne ne
  le saurait. « Modifier » garde le champ disparu affiché et signalé, et corriger les mots seuls reste possible.
  (Un appel, lui, ne peut pas être supprimé tant qu'un outil l'utilise.) Un outil illisible est marqué « Pas chez
  Meta », jamais « ✓ ».
- ✅ **Un appel irréversible le dit** (une méthode `DELETE`) : sur la ligne, et au moment de choisir l'appel, avec
  l'avertissement que l'agent de Meta l'exécute SANS validation humaine. La mention de l'ancienne bibliothèque
  était partie avec elle, sans arbitrage : elle revient (2026-09-21).
- ✅ **Ce que Meta liste encore sans outil ici se voit** au-dessus de la liste, « encore chez Meta, sans outil
  ici », avec « Envoyer à Meta » : un outil supprimé ici, mais aussi un outil ajouté À LA MAIN chez Meta ou resté
  sur un ancien connecteur, que l'envoi effacerait. 🔴 Seul ce que vous venez de supprimer ici, pendant cette
  visite, part sans autre question ; tout autre effacement est demandé en le nommant, y compris votre propre
  retrait après un rechargement de la page, parce que Meta ne rend jamais un outil effacé. « Supprimer » est
  désactivé dès le clic, jusqu'à la fin de l'envoi.
- ✅ **Un connecteur partagé avec un agent IA le dit** (« Aussi utilisé par : … ») : le modifier le modifie pour
  cet agent aussi. « Supprimer » ne le retire alors qu'à l'agent de Meta.
- ✅ **« Désactivé », et « Réactiver »** : quand la personne qui avait ajouté un outil quitte l'espace, ses
  consentements s'éteignent et l'agent de Meta ne peut plus s'en servir. La ligne le dit, et un administrateur le
  rallume d'un clic. ⚠️ Meta le liste encore jusqu'au prochain envoi : la ligne propose alors « À envoyer », qui
  l'en retire.
- ⚠️ **L'appel d'un connecteur ne change pas au « Modifier »** : pour changer d'appel, on crée un autre outil
  (la définition est partagée avec les agents IA qui s'en servent).
- ⛔ **Réservé aux administrateurs.**
- ⛔ **Pas encore : « Envoyer un bloc » et « Lancer un scénario »** (lot 3 du même plan).
- ⚠️ **L'ancienne adresse `/outils` renvoie vers cet onglet.** L'écran « bibliothèque de l'espace » qu'elle
  servait (la case « Exposé à l'agent de Meta », « Supprimer de l'espace ») n'existe plus.

### Publier chez Meta

- ✅ **L'AGENT DE META PASSE PAR ENGAGE ME** (le relais, en service depuis le 2026-09-21, éprouvé le jour
  même : une étiquette posée dans le CRM d'un client depuis une conversation WhatsApp ; migration 0161). Un appel se déclare UNE fois, dans Tools > Connecteurs API. Quand un outil est exposé à
  l'agent de Meta, c'est Engage Me qu'il appelle : Engage Me reconnaît le client par son numéro WhatsApp
  (que WhatsApp lui-même transmet, l'agent ne peut pas l'inventer), remplit les valeurs du **carnet de
  contacts** (un champ comme `tag_ns` ou `user_ns`), puis fait l'appel exactement comme pour vos agents IA,
  avec les mêmes contrôles et le même journal. L'agent de Meta ne demande au client que les valeurs
  « décidées par l'agent ».
  ⚠️ Avant le relais, Meta appelait votre système en direct : un appel qui envoyait un champ du contact
  arrivait vide, et votre clé d'accès était posée chez Meta. Elle ne quitte plus Engage Me.
  ⚠️ **L'agent de Meta reçoit la réponse ENTIÈRE de votre système**, plus un « succès : oui » explicite
  (choix du 2026-09-21 : un agent qui ne voit rien risque de conclure à un échec et de passer la main).
  ⛔ Les outils MCP ne sont pas encore relayés : un chantier suivant.
- ✅ **Un seul connecteur chez Meta, « EngageMe »**, créé au premier outil exposé et retiré avec le dernier.
  Les anciens connecteurs, un par système, sont supprimés au premier « Envoyer » qui suit le déploiement ;
  la confirmation les nomme avant.
- ✅ **Une clé « Agent de Meta »** apparaît dans la liste des clés d'API de l'espace. C'est elle que
  l'agent de Meta présente à Engage Me. Elle ne se crée pas à la main ; la révoquer coupe les outils de
  l'agent de Meta jusqu'au prochain « Envoyer », qui en pose une neuve (la confirmation de révocation le dit).
- ✅ **Le formulaire dit qui fournit chaque valeur** : « Engage Me remplit lui-même : … » et « L'agent de
  Meta les obtient du client : … », dérivés de ce que l'appel déclare.
- ⚠️ **Écrivez « Quand l'appeler » comme une CONSIGNE, pas comme un constat.** C'est cette phrase qui décide
  si l'agent de Meta appelle l'outil, et ses compétences (par exemple « passe la main si tu n'as pas de
  réponse fiable ») peuvent l'emporter sur une description vague. Mesuré le 2026-09-21 : « Le client demande
  à rajouter une étiquette » n'a jamais déclenché l'outil ; « Appelle cet outil dès que le client demande
  qu'on lui ajoute une étiquette. Il sait déjà qui est le client et quelle étiquette poser. Confirme-lui que
  c'est fait. Ne passe pas la main pour cette demande. » l'a déclenché au premier essai.
- ✅ **Enregistrer envoie, et « À envoyer » renvoie** (depuis le 2026-09-21, voir l'onglet ci-dessus). L'envoi
  ne s'arrête pour demander confirmation que s'il doit SUPPRIMER chez Meta quelque chose que ce geste n'a pas
  demandé, en le nommant. Pendant l'aller-retour, l'écran le dit, et un second clic n'envoie rien.
- ⚠️ **Engage Me fait foi, la publication ÉCRASE.** Un connecteur ou un outil ajouté à la main dans WhatsApp
  Manager sera SUPPRIMÉ à la publication suivante. L'écran le dit, et l'aperçu le montre avant le clic.
- ✅ **Publier deux fois de suite ne produit aucun geste** : la publication se réconcilie sur les noms, et
  compare la description, la clause « quand ne pas l'appeler » et ce que l'agent de Meta doit remplir.
  ⚠️ Vérifié en test ; la forme exacte que Meta renvoie se confirme au premier essai réel du relais.
  Corollaire : **renommer un outil chez nous se lit « supprimer l'ancien, créer le nouveau »**.
- ✅ **Un échec en cours de publication s'ARRÊTE et le dit** : ce qui a été fait est listé, le reste n'est pas
  tenté. Relancer ne refait pas ce qui a réussi.
- ⛔ **Sans numéro WhatsApp connecté, il n'y a pas d'agent Meta où publier** : l'aperçu est vide (ce n'est pas
  une panne) et la publication refuse en le disant.
- ⛔ **Ce que Meta sait faire et que nous n'utilisons pas** : les transformations de réponse et
  l'authentification par utilisateur final.

## Sécurité & compliance (menu Sécurité)

Un menu au bas de la barre, à côté de Paramètres et Support, qui rassemble **tout ce qui sert à rendre des
comptes** : ce qui a été fait, ce qui a échoué, et ce que les gens ont accepté. Sa page d'accueil porte une
boîte par sous-menu.

- ✅ **Un MANAGER y accède, en plus de l'Inbox** (2026-09-14). C'est le premier endroit où ce rôle sert à
  quelque chose : il voit les désabonnés, la politique d'annonce d'IA, le journal des actions et celui des
  erreurs. Sa barre latérale ne porte que ça : on ne lui montre pas des dossiers qui le renverraient à
  l'Inbox.
  - 🔴 **Mais il ne RÈGLE rien.** Brancher un connecteur sur le consentement, ou changer la politique
    d'annonce d'IA, engagent la marque : ces deux gestes restent réservés à un administrateur, refusés par le
    serveur et absents de son écran. Rendre des comptes et décider ne sont pas le même métier.

- ✅ **Consentement** (2026-09-13) : la liste des personnes qui ont demandé à ne plus être contactées, avec
  **depuis quand** et **par quel chemin** le refus est arrivé (saisi par l'équipe, posé par un scénario, coché
  par la personne dans un formulaire, reçu d'un système tiers). Réservée aux rôles administrateur et manager.
  - ✅ **La DATE et l'HEURE** (2026-09-15) : l'instant exact où le refus est arrivé, et pas seulement le jour.
    Sur un écran de conformité, deux messages envoyés le même jour, l'un avant et l'autre après le refus,
    seraient indiscernables sur une date calendaire.
  - ⚠️ **La date peut manquer, et l'écran le dit** : elle n'est enregistrée que depuis le 2026-09-13. Pour les
    refus antérieurs, l'écran affiche « date inconnue » au lieu d'inventer une date à partir de la dernière
    modification de la fiche, qui n'aurait rien à voir.
  - ✅ **Refus possibles à confirmer** : des messages qui *ressemblent* à une demande d'arrêt sans en avoir la
    forme reconnue (« arrêtez de me contacter », « retirez-moi de votre liste »). **Personne n'est désabonné
    par cette relecture** : elle sert à juger, depuis la conversation, si la règle automatique doit être
    élargie. L'écran dit aussi sur combien de messages il a regardé.
  - ⚠️ **On ne réabonne pas d'un clic depuis cette liste** : ça se fait depuis la fiche du contact, là où l'on
    voit à qui l'on a affaire. Un bouton sur une liste rendrait trop facile d'annuler en série des refus que
    des personnes ont exprimés.
- ✅ **Un désabonnement bloque réellement tous les envois automatiques** (2026-09-13) : campagne, API, mais
  aussi **scénario, automation et agent IA**, qui passaient jusque-là. Un envoi de **modèle** depuis l'Inbox
  est refusé s'il est de catégorie Marketing, autorisé s'il est de catégorie Service (une livraison, un
  rendez-vous, un compte). Un agent tiers branché en MCP est refusé.
  - 🔴 **Mais un opérateur peut toujours répondre à la main.** Sans cette exception, il ne pourrait même plus
    accuser réception du désabonnement, ni répondre à une réclamation posée juste après. La machine se tait ;
    la personne peut encore répondre à la personne.
- ✅ **Prévenir votre propre système à chaque désabonnement** (2026-09-13) : sur l'écran Consentement, un
  administrateur choisit un appel déjà déclaré dans **Tools > Connecteurs API**, et Engage Me le joue à chaque
  refus, quel qu'en soit le chemin (« stop » reçu, case cochée dans la fiche, action en masse). Votre CRM, votre
  back-office ou votre routeur d'e-mails apprennent donc le refus, avec le numéro de la personne.
  - 🔴 **Pourquoi ça compte** : un refus qui ne vit que chez nous vous laisse continuer à écrire à cette
    personne depuis vos autres outils, et c'est vous qui en répondez.
  - 🔴 **Votre système en panne ne bloque JAMAIS le désabonnement.** Le refus est enregistré d'abord, l'appel
    part ensuite : un connecteur mort, un réseau coupé, une adresse changée ne peuvent pas empêcher quelqu'un
    de cesser de recevoir. L'appel raté est réessayé cinq fois, à intervalle croissant.
  - ⚠️ **Aucun espace n'est branché par défaut** : tant que personne n'a choisi d'appel, rien ne sort.
  - ⚠️ **On ne décrit pas l'appel ici, on en désigne un.** Il se met au point une fois dans Tools, où le bouton
    « Essayer » permet de l'éprouver avant de le brancher. Et tant qu'il est branché sur le consentement, il
    **refuse d'être supprimé** : sinon vous cesseriez de prévenir votre système sans que rien ne le dise.
  - ⚠️ **Réservé à l'administrateur**, en lecture comme en écriture : brancher, c'est décider que des données
    de contact partent chez un tiers. Un manager voit la liste des désabonnés, pas ce réglage.
- ✅ **Audit trails** et **Journal des erreurs** : les deux journaux ci-dessous, qui vivaient dans Paramètres
  et s'y trouvaient par accident. Aucune adresse n'a changé.

## Journaux et traces (menu Sécurité)

- ✅ **Journal des actions** : qui a ajouté, supprimé, effacé ou basculé un consentement, et quand. Les
  contacts y figurent par identifiant interne, **jamais par numéro** : y écrire un numéro annulerait la
  suppression d'un contact, dans un registre fait pour ne jamais être modifié.
  - ✅ **Il couvre aussi les ACCÈS et les PORTES depuis le 2026-09-16** : qui a invité un collaborateur,
    changé son rôle, révoqué ou supprimé son compte ; qui a créé ou révoqué une clé d'API ; les échecs de
    connexion ; qui a créé, modifié ou supprimé un webhook entrant ou un connecteur, et qui a touché à leur
    secret ; qui a rattaché un numéro WhatsApp ; et **qui a exporté l'historique d'un contact**. Avant, le
    journal ne savait répondre qu'aux questions sur les personnes, jamais à « qui a donné les droits admin ? ».
  - 🔴 **Ce qu'il ne contient JAMAIS**, et c'est vérifié à l'écriture par le produit lui-même : aucune adresse
    e-mail (sauf celle de l'auteur de l'action), aucun numéro, aucun texte de message, ni le code d'un
    webhook, ni le secret d'un connecteur, ni une clé d'API. Un champ interdit est retiré avant l'écriture, et
    la ligne dit qu'il a été retiré plutôt que de le taire.
  - ⚠️ **Les échecs de connexion ne sont enregistrés que pour des comptes qui existent.** Une tentative sur une
    adresse inventée n'appartient à aucun espace et ne peut donc pas y figurer.
- ✅ **Journal des erreurs de livraison** (2026-09-02), juste en dessous : ce que Meta a répondu quand un
  message n'est pas parti, ou n'est pas arrivé. Le code, sa signification en français pour les plus courants,
  la campagne, le numéro, et surtout **d'où vient l'échec** : « jamais parti » (Meta a refusé notre appel) ou
  « parti, non délivré » (le téléphone d'en face). Chercher au mauvais endroit coûte cher.
  Celui-ci **porte les numéros**, contrairement au précédent : « quel message n'est pas arrivé » sans dire
  « à qui » ne répond à rien. Il n'a rien d'immuable et disparaît avec le contact quand vous le supprimez.
- ✅ **Recherche dans les deux** : par mot-clé, par utilisateur, par numéro de client. ⚠️ Dans le journal des
  actions, chercher par numéro passe par la fiche du contact, donc **un contact effacé ne s'y retrouve plus**,
  même si ses actions y figurent toujours. L'écran le dit sous le résultat vide plutôt que de laisser croire
  qu'il ne s'est rien passé.
- ✅ **Export CSV** des deux journaux.

## Exploitation `/ops` (interne, hors console client)

- ✅ **Console d'exploitation cross-tenant** `/ops` : vue **lecture seule** de TOUS les clients (protégée par
  un jeton d'exploitation saisi une fois, distinct des comptes clients). Par client : MBA on/off, numéro +
  qualité, nb d'utilisateurs / contacts / messages / templates, dernier envoi. **Signal de charge pg-boss**
  (files en attente / actifs / échoués) pour décider d'une bascule d'infra. Messages échangés/jour (global).
- ✅ **Signal de vie du worker** (le process qui envoie réellement les messages) : « Actif », « Silencieux » ou
  « Aucun signal », affiché à côté du signal de charge des files. Distingue « les files ne se vident pas » de « le
  process est mort », ce que la seule charge des files ne dit pas.
- ✅ **Solde prépayé de l'agent IA** : lecture du solde d'un client et de son journal de mouvements, et
  **rechargement** (la seule écriture de cette surface). Le rechargement est ici et pas dans la console parce
  qu'un client ne doit jamais pouvoir créditer son propre compte. Borné à 1000 € par opération, et une note
  expliquant le mouvement est obligatoire. Rechargement à la main pour l'instant, sans paiement en ligne.

## Agent IA (menu « AI Agent » > Other AI agent)

Un répondeur intelligent que le client construit lui-même et qu'il **pose là où il en a besoin**, dans un
scénario. Ce n'est pas un cerveau global qui répond à tout : un agent ne parle QUE dans le bloc « Agent IA »
où on l'a désigné, et nulle part ailleurs. Il complète le répondeur natif de Meta (menu MBA, juste au-dessus),
il ne le remplace pas : les deux peuvent vivre sur le même numéro, et le client décide qui fait quoi.

✅ **Livré et déployé** (2026-08-28) : la fiche, la base de connaissance, les outils, la construction en
parlant, le bac à sable, le tour de production et le solde prépayé.
⚠️ **Mais aucun espace n'a de crédit à ce jour**, et sans crédit un agent ne répond pas (voir « Le crédit »
plus bas). ⚠️ **Rien n'a encore tourné sur du vrai trafic** : un contact qui atteint un bloc agent, une
réponse qui part, un outil qui s'exécute, une sortie qui reprend le scénario, tout cela reste à voir en vol.

### Où l'agent parle : le bloc « Agent IA » d'un scénario

- ✅ **Un bloc de plus dans le constructeur de scénario**, à côté du template, du message rapide et de la
  question. On y choisit **quel agent tient la conversation**, et c'est tout ce qu'il y a à régler : le reste
  vient de la fiche de l'agent.
- ✅ **L'agent tient la conversation sur plusieurs tours.** Tant qu'il l'a, les réponses du contact lui
  reviennent à LUI et le scénario n'avance pas. On n'en ressort que par une des sorties du bloc, jamais par
  une sortie libre. Ses messages apparaissent dans le fil de l'Inbox comme n'importe quel autre.
- ✅ **Le bloc est grisé tant qu'aucun agent n'est actif** (« Disponible dès qu'un agent IA est actif »), même
  doctrine que les blocs RCS et Email. Un bloc agent sans agent derrière ne pourrait tenir aucune conversation.
- ✅ **Un agent désactivé après coup est signalé sur le bloc** : « cet agent n'est plus actif, ce bloc ne
  répondra pas tant qu'il ne l'est pas de nouveau ». Un bloc dont l'agent a été effacé laisse simplement passer
  le parcours, il ne le bloque pas.
- ✅ **Changer l'agent d'un bloc emporte les flèches de ses anciennes règles d'arrêt** : elles désignaient des
  sorties que le nouvel agent n'a pas. L'éditeur le fait au moment du changement, pas en silence à
  l'enregistrement.
- ✅ **Si les règles d'arrêt de l'agent ont changé depuis que le bloc a été configuré**, l'éditeur le dit et
  propose un bouton pour remettre le bloc à jour. Le bloc garde donc la liste avec laquelle il a été dessiné
  tant que personne ne l'a relu.
- ⚠️ **Un scénario qui COMMENCE par un bloc agent ne peut pas partir en campagne** : le premier message de
  l'agent est un message libre, donc réservé aux contacts qui ont écrit dans les 24 h. Même règle que le
  message rapide et le formulaire. Et un bloc agent placé après une attente de 24 h ou plus est signalé dans
  l'éditeur, en nommant les deux blocs concernés : rien ne partirait.

### Créer un agent, et ce que « activé » veut dire

- ✅ **La liste des agents** (menu AI Agent > Other AI agent) : on crée un agent avec un **nom interne** (celui
  que vous voyez dans la liste et dans le constructeur, jamais le contact). Chaque ligne porte sa pastille :
  **Brouillon**, **Actif** ou **Désactivé**.
- ✅ **Un agent naît en brouillon** : il n'apparaît dans le constructeur de scénario qu'une fois **activé**,
  quand vous avez relu ce qu'il dira. Ici, « activé » ne veut pas dire « il répond à tout » (c'est le sens du
  répondeur Meta), mais « il est proposable dans un scénario ».
- ✅ **L'activation refuse un agent incomplet, et dit quoi faire.** Au lieu de « agent incomplet », l'écran
  liste ce qui manque, et **chaque ligne est un lien vers l'onglet où ça se corrige** : objectif vide, aucune
  règle de transfert, aucune règle d'arrêt, base de connaissance vide, aucun outil actif. Le blocage porte sur
  des champs vides, jamais sur la qualité de ce qui est écrit.
- ✅ **Supprimer un agent** emporte ses conversations, ses outils et sa base de connaissance, et les blocs de
  scénario qui l'utilisent cessent de répondre. La confirmation le dit avant le clic. Le bouton est **sur
  chaque ligne de la liste** (2026-08-31) autant que dans la fiche : jeter un agent d'essai n'oblige plus à
  entrer dedans d'abord.

### Les neuf onglets de sa fiche

| Onglet | Ce qu'on y fait |
|---|---|
| **Construire en parlant** | Décrire son métier à un assistant, qui propose des réglages |
| **Identité et ton** | Nom interne, nom donné au contact, ton, personnalité, mention d'IA |
| **Objectif et transferts** | Ce qu'il est là pour faire, quand passer la main, ses règles d'arrêt |
| **Base de connaissance** | Les fiches dont il a le droit de se servir pour répondre |
| **Outils** | Ce qu'il a le droit de FAIRE, en plus de parler |
| **Périmètre et garde-fous** | Ses plafonds, et ce qu'il peut faire face à un contact inconnu |
| **Modèle** | Le moteur qui le fait parler, et le budget d'une conversation |
| **Historique** | Ce qui a changé, et le contenu de ce qui a été effacé |
| **Tester** | Lui parler avant de l'activer |

- ✅ **Chaque champ s'enregistre à la sortie du champ**, comme les écrans MBA : pas de bouton par champ.
  L'onglet et l'agent ouvert vivent dans l'adresse, donc une fiche se partage par un lien et un
  rafraîchissement retrouve où on en était.
- ✅ **On arrive TOUJOURS sur « Construire en parlant »**, y compris juste après avoir créé un agent
  (corrigé le 2026-09-08 : ce chemin-là ouvrait « Identité et ton »). C'est le pire moment pour tomber sur un
  formulaire : l'agent vient de naître, tout est vide, et on n'a par définition aucune idée de ce qu'il faut
  y écrire. C'est exactement ce que l'assistant est là pour éviter.
- ✅ **Identité et ton** : le **nom interne** (le vôtre), le **nom donné au contact** (laissé vide, l'agent ne
  s'en donne aucun), le **ton** (« vouvoiement, phrases courtes, pas d'emoji », écrit comme on le dirait à une
  nouvelle recrue) et la **personnalité**.
- ✅ **Objectif et transferts** : l'**objectif** est le champ qui pèse le plus sur ce que l'agent répondra, et
  **quand passer la main à un humain** s'écrit en français ordinaire (« dès qu'on parle d'un remboursement,
  ou si le contact s'énerve »).
- ✅ **Périmètre et garde-fous** : **tours maximum** (1 à 20, 8 par défaut), **appels d'outils maximum** (0 à
  60, 12 par défaut), **inactivité en minutes** (1 à 1440, 30 par défaut, au-delà le parcours part par « Pas de
  réponse »), et **ce que l'agent a le droit de faire face à un contact inconnu du mini-CRM** : aucun outil,
  outils de lecture seulement (le défaut), ou tous. Chaque champ dit ses bornes et refuse une saisie hors
  clous plutôt que de la faire disparaître.
- ✅ **Modèle : une LISTE DÉROULANTE avec les tarifs** (2026-09-09). Dix modèles, du moins cher au plus cher,
  chacun avec entre parenthèses **son prix par million de jetons envoyés puis reçus**. On choisit, on ne tape
  plus rien.
  🔴 **C'était une saisie libre**, et rien ne la vérifiait : un identifiant mal tapé s'enregistrait sans un
  mot, et ne se voyait qu'à la première réponse ratée d'un client. Le serveur refuse désormais tout modèle
  hors liste, y compris par l'API.
  ⚠️ **Les dix sont choisis, pas tirés au sort dans les 373 du fournisseur.** Deux critères : ils savent
  APPELER DES OUTILS (un modèle qui ne le sait pas ne cherche pas dans votre base de connaissance, il
  INVENTE), et ils parlent correctement français. Un modèle retiré du catalogue disparaît tout seul de la
  liste. Les prix, eux, sont lus en direct chez le fournisseur : ils ne peuvent pas être périmés.
  ⚠️ **Le tarif affiché inclut notre commission**, la consommation de l'encadré du dessous est le montant
  brut réellement décompté : l'écart d'environ 10 % est écrit à l'écran plutôt que laissé à deviner.
  ⚠️ Si le catalogue du fournisseur est injoignable, la liste reste utilisable, simplement sans tarif.
- ✅ **Budget d'une conversation**. Budget épuisé, l'agent sort par « Plafond atteint ».

### La base de connaissance : la seule chose dont il a le droit de se servir

- ✅ **L'agent ne répond QUE d'après ces fiches.** Sur une question qu'aucune ne couvre, il n'invente pas : il
  sort du bloc par « Aucune source ». C'est un mécanisme, pas une consigne au modèle. **Une base vide fait donc
  un agent qui transfère tout**, et l'écran le dit en tête pour qu'on ne cherche pas l'erreur ailleurs.
- ✅ **Lire une page de son site** : on colle une adresse, on lit la page une fois, et elle devient des fiches
  découpées sur ses titres. L'agent ne relit pas le site à chaque question : c'est plus rapide, moins cher, et
  surtout **une mauvaise réponse se corrige ici même**, en éditant la fiche.
- ✅ **Relire la même adresse REMPLACE les fiches qu'elle avait produites**, et le prix est dit avant le clic :
  vos corrections sur celles-là seront perdues. Les fiches venues d'ailleurs et celles écrites à la main ne
  bougent pas.
- ✅ **Le plafond est dit quand il mord** : au-delà de 40 fiches pour une page, la suite de la page n'a PAS été
  lue, et l'écran le signale au lieu de laisser croire que tout le contenu est devenu une source.
- ✅ **Écrire une fiche à la main** : un titre (la question ou le sujet) et une réponse, telle qu'on voudrait
  la lire. Chaque fiche s'édite sur place.
- ✅ **La provenance est sous chaque fiche** : « écrite à la main », ou « lue sur <adresse> le <date> (N
  jours) ». Une fiche que personne n'a touchée depuis plus de **90 jours** porte une pastille « À relire ».
  C'est la parade au défaut le plus courant du marché, le contenu périmé.
- ✅ **L'agent trouve désormais une fiche même quand la question n'en partage AUCUN mot** (2026-09-02). Avant,
  la recherche ne connaissait que les mots : « c'est combien pour résilier » ne trouvait pas « Conditions de
  sortie de contrat », et l'agent répondait « je ne sais pas » alors que la réponse était dans la base. Julien :
  « en bornant à 3 fiches sur 500, tu renvoies 1 % du contenu ». La recherche comprend maintenant le SENS en
  plus des mots, et garde les deux : le sens pour l'intention, les mots pour une référence produit, un numéro
  de contrat ou un prix exact, où le sens est mauvais.
- ✅ **Et l'agent ne s'est PAS mis à inventer pour autant.** C'est le point délicat, et il a été mesuré : une
  question hors sujet (« vous vendez des vélos ? ») fait toujours remonter la fiche « la moins loin », donc la
  ressemblance seule ne peut pas servir de juge. Un second modèle note la pertinence de chaque fiche candidate,
  et sous le seuil l'agent sort toujours par « Aucune source ». **Rien ne change dans ce qu'il reçoit** : trois
  fiches, tronquées comme avant. Ce qui change, c'est LESQUELLES.
- ⚠️ **Une fiche tout juste créée est trouvable par les MOTS à la seconde, par le SENS au bout d'une minute** :
  sa compréhension se calcule en tâche de fond. Éditer une fiche remet ce calcul à zéro, pour que sa
  compréhension ne décrive jamais un texte qu'elle n'a plus.

⚠️ **La recherche ne tient pas compte des accents**, dans les deux sens : « prevoyance » et « prévoyance »
trouvent les mêmes fiches. C'est vrai de la base de connaissance des agents comme du mode d'emploi du bot
d'aide.

### Les outils : ce que l'agent a le droit de FAIRE

- ✅ **Un outil n'est utilisable qu'une fois ACTIVÉ à la main.** Tant qu'il ne l'est pas, l'agent ne sait même
  pas qu'il existe. L'activation est un geste séparé de l'ajout, et elle garde le nom de qui l'a donnée.
  ⚠️ **Sans aucun outil actif, l'agent peut parler mais ne peut rien faire, pas même terminer.**
- ✅ **L'outil appartient à l'ESPACE, l'autorisation appartient à l'agent** (2026-09-10). Le même outil sert
  plusieurs agents sans être redécrit : ses mots se corrigent une fois et sont corrigés partout. Ce qui reste
  propre à chaque agent, c'est de s'en servir ou non, et l'activation.
  ⚠️ **Conséquence à connaître** : changer la description d'un outil partagé change ce que voient TOUS les
  agents qui l'utilisent. L'onglet Outils de l'agent de Meta nomme les agents IA qui partagent un connecteur,
  justement pour qu'on le sache avant. (L'écran « bibliothèque de l'espace », Tools > Outils, n'existe plus.)
- ✅ **Sept outils maison** au catalogue, chacun étiqueté **lecture**, **écriture** ou **irréversible** :
  - **Chercher dans la base de connaissance** (lecture) : à appeler avant toute question de fond.
  - **Lire la fiche du contact** (lecture) : ce qu'on sait déjà de lui, son nom, ses champs. Jamais la fiche
    de quelqu'un d'autre.
  - **Poser un tag sur le contact** (écriture) : pour le retrouver dans le mini-CRM, ou déclencher une
    automation.
  - **Enregistrer une information sur le contact** (écriture) : écrire dans un champ, pour qu'un bloc plus
    loin dans le scénario le réutilise.
  - **Envoyer un bloc de votre scénario** (irréversible) : pousser une photo, un message, un formulaire que
    vous avez dessinés. Le parcours ne bouge pas, l'agent garde la main.
  - **Passer la main à un humain** (écriture) : voir plus bas.
  - **Terminer par une règle d'arrêt** (lecture) : rendre la main au scénario par la sortie choisie.
- ✅ **Les mots d'un outil se règlent, et ils changent beaucoup son comportement** : « quand l'appeler » et
  « quand NE PAS l'appeler » sont deux champs séparés, et ce sont eux que le modèle lit pour décider.
  ⚠️ La clause « quand NE PAS l'appeler » **n'atteignait pas le modèle** jusqu'au 2026-08-29 : le client
  faisait un travail sans effet sur le seul levier qui décide du déclenchement d'un outil. Corrigé.
- ✅ **Les valeurs autorisées se listent**, outil par outil : les tags que cet agent peut poser, les champs
  qu'il peut écrire, les codes de blocs qu'il peut envoyer. **Une liste vide ne restreint rien**, et l'écran
  le dit en jaune : c'est ce qui empêche l'agent d'écrire dans le champ sur lequel une condition de votre
  scénario branche.
- ✅ **Une action irréversible demande une autorisation de plus** : sur « Envoyer un bloc », une case
  « autoriser l'agent à faire ça SEUL ». Non cochée, l'action est refusée à chaque appel. Un message parti
  chez un contact ne se rappelle pas, et il est facturé.
- ✅ **« Voir ce que le modèle voit »** : chaque outil montre, à la demande, la forme exacte sous laquelle il
  est proposé au modèle. Les mots du client pilotent un appel réel, il doit pouvoir les relire sous leur vraie
  forme.
- ✅ **Vos propres systèmes** (onglet Outils, en bas) : les connecteurs API déclarés une fois pour l'espace
  dans **Tools > Connecteurs API** et partagés par tous vos agents. Ici on ne fait qu'une chose, dire quels
  appels CET agent a le droit d'y faire. Détail dans la section « Brancher vos systèmes ».
  ⚠️ **Rien n'est branché tant qu'un client n'a pas déclaré de système** : sans système, l'onglet Outils est
  exactement ce qu'il était.
  ⚠️ **Piège de vocabulaire** : le menu **Tools** de la barre de gauche et l'onglet **Outils** d'un agent ne
  parlent pas de la même chose. Le système appartient à l'espace, l'appel appartient à l'agent.
- ➡️ **Les outils d'un serveur MCP se branchent de la même façon**, une fois le serveur déclaré dans
  **Tools > Connecteurs MCP** et ses outils importés. L'onglet Outils de l'agent les montre à côté des
  appels de connecteur API.

#### Choisir les blocs que l'agent peut envoyer

L'outil « Envoyer un bloc de votre scénario » se règle en **cochant les blocs dans une liste**, groupés par
scénario et nommés en clair. ⚠️ Seuls les scénarios **contenant un bloc Agent IA** sont proposés : cet outil
envoie un bloc du scénario où le contact se trouve déjà, donc un bloc pris ailleurs ne pourrait jamais
partir. Les blocs Agent, Inbox, Attente et RCS sont écartés, l'exécuteur les refusant à coup sûr.

### Les règles d'arrêt, et les sorties du bloc

- ✅ **Une règle d'arrêt, c'est « quand l'agent a fini de faire ÇA, il sort par là ».** On lui donne un code
  (normalisé sous vos yeux pendant la saisie) et un libellé lisible. **Chacune devient une sortie du bloc
  agent** dans le constructeur, à relier vers la suite du parcours. **12 maximum** : au-delà le bloc devient
  illisible et l'agent choisit mal.
- ✅ **Cinq sorties automatiques**, toujours présentes sur le bloc, en plus des vôtres :
  - ⏱ **Pas de réponse** : le contact s'est tu pendant le délai d'inactivité réglé sur la fiche.
  - 📕 **Aucune source** : l'agent n'a rien trouvé dans sa base de connaissance. À brancher vers un humain ou
    vers vos coordonnées.
  - 🙋 **Transfert à un humain** : à brancher vers ce qui doit suivre (message d'attente, tag, fin de parcours).
  - 🛑 **Plafond atteint** : tours, appels d'outils ou budget épuisés.
  - 💥 **Échec technique** : le modèle ou un envoi a échoué. Prévoir un repli.
- ⚠️ **Un agent sans aucune règle d'arrêt ne sortira que par ces cinq sorties automatiques.** L'éditeur le dit
  sur le bloc, et l'onglet Outils le répète : l'outil « Terminer » est alors retiré au lieu d'être proposé
  vide, pour que l'agent n'invente pas un code que le bloc ne dessine pas.
- ✅ **Une sortie qui ne mène nulle part est signalée en rouge sur le bloc**, comme pour les autres blocs.

### Le passage de main à un humain

- ✅ **L'agent passe la main quand la demande sort de son périmètre, ou quand le contact le demande.** La
  conversation remonte alors dans « À traiter » dans l'Inbox, la session de l'agent est close, et le parcours
  repart par la sortie 🙋 « Transfert à un humain ».
- ✅ **Elle y entre TOUT DE SUITE, et elle y reste tant que personne n'a répondu** (2026-09-23). C'est la même
  règle que pour l'agent de Meta et que pour le bloc « passer à un humain » d'un scénario : la dernière phrase
  étant la nôtre, la conversation n'apparaissait qu'au message suivant du contact, et le robot reprenait la
  main au bout de deux heures alors que personne n'avait répondu. La première réponse d'un opérateur,
  « Traité », « Archiver » ou « Rendre la main » lève la marque, et les deux heures courent ensuite.
- ✅ **Une fois la main passée, l'agent ne reprend pas la parole tout seul.** C'est la différence avec un
  simple changement d'étiquette : sans cela, l'humain aurait traité, puis l'agent aurait repris la
  conversation qu'on venait de lui retirer.
- ✅ **Quand un humain écrit dans le fil, le scénario et l'agent se taisent**, comme pour tous les autres blocs.

### Construire son agent en parlant

- ✅ **C'est le PREMIER onglet d'un agent** (2026-08-31) : on ouvre une conversation, pas un formulaire vide.
  Deux exemples cliquables pour démarrer (« il répond aux questions sur nos séjours et prend des rendez-vous »).
- ✅ **L'assistant fait le tour du sujet en NEUF points**, dans cet ordre : ce que l'agent est là pour faire,
  ce dont il ne parle jamais, **d'où viennent ses réponses de fond**, à quoi ressemble une conversation qui
  finit bien, ce qu'il doit faire quand il ne s'agit plus seulement de répondre, quand un humain reprend,
  **sous quel nom il se présente**, et comment il parle. Une question à la fois, avec des possibilités à
  choisir plutôt qu'une page blanche.
- ✅ **Il pose vraiment toutes les questions** (2026-08-31). Avant, il décidait lui-même de ce qu'il avait
  couvert, et il sautait régulièrement le ton, l'identité et la base de connaissance. Un point n'est
  maintenant considéré comme vu que s'il vous a été **réellement posé**. Si vous y aviez déjà répondu en
  racontant votre métier, il ne repose pas la question : il vous demande de confirmer en une phrase.
- ✅ **Il creuse quand vous dites que l'agent agit seul** (2026-08-31). Répondre « il prend le rendez-vous
  lui-même » ouvre une question de plus : **par quel moyen ?** Quel outil, quel connecteur. L'entretien ne peut
  pas se terminer sans, et si rien de ce qui existe ne convient, il le dit au lieu d'inventer un outil.
- ✅ **Tant qu'un de ces points n'est pas tranché, il ne montre rien et le dit** : « encore 2 points à voir
  avant que je vous montre ce que j'ai compris ». C'est ce qui l'empêche de combler les blancs à votre place.
- ✅ **La conversation est CONSERVÉE** (2026-08-31) : on quitte l'onglet, on revient, elle est là, avec
  l'avancement de l'entretien. Un bouton **« Recommencer »** l'efface et repart de zéro, sans toucher à ce qui
  a déjà été enregistré dans les autres onglets.
- ✅ **On peut joindre un document ou une image** (2026-08-31) : txt, csv, markdown, PDF, Word, et les images
  (JPEG, PNG, GIF, WebP). Le texte en est extrait et **découpé en fiches de connaissance**, relisibles et
  modifiables dans l'onglet Base de connaissance. Une image est lue par l'IA, qui en relève le texte : une
  photo d'une grille de tarifs devient des fiches. Un fichier sans texte lisible (un PDF scanné, par exemple)
  le dit clairement au lieu d'annoncer un import réussi. 8 Mo par document, 5 Mo par image.
- ✅ **Il ne change RIEN tout seul.** Il propose, et l'écran affiche exactement ce que ça changerait, ligne par
  ligne, avec la valeur d'avant barrée.
- ✅ **Chaque règle se garde, se corrige sur place, ou se jette séparément** (2026-08-28, demande de Julien) :
  « potentiellement le mec ne veut en changer qu'une et le reste lui convient ». Tout est gardé au départ, le
  bouton dit combien de lignes partiront. Seules les règles d'arrêt se gardent ou se jettent en bloc, parce
  qu'elles sont plusieurs dans une même ligne : elles se corrigent dans l'onglet Objectif.
- ✅ **Tout ce qu'il écrit reste modifiable dans les autres onglets**, champ par champ.
- ✅ **Une proposition un peu trop longue est corrigée, plus rejetée** (2026-09-17). Le dernier tour de
  l'entretien, celui où il écrit enfin tous les champs, pouvait échouer d'un bloc sur « l'assistant a rendu
  une proposition hors format » : un code de règle d'arrêt un peu long suffisait, et votre message était
  perdu avec le tour. Un texte trop long est désormais coupé, un code hors alphabet est ramené exactement
  comme le fait le champ de saisie quand vous tapez le vôtre, et un doublon est écarté. **Ce qu'il n'a pas
  le droit de proposer reste refusé** : la correction porte sur la forme, jamais sur ses permissions.
- ✅ **Il ne se tait plus une fois l'agent construit : il écoute** (2026-09-15). Avant, l'entretien terminé le
  faisait basculer en « j'écris les champs » ; rouvrir l'onglet le lendemain le faisait donc repartir en
  proposant des changements dont personne n'avait parlé. Désormais il rappelle l'état actuel, dit ce qu'il
  peut changer, et **attend votre demande**. Il ne propose plus rien de lui-même.
  Et si un champ réglé pendant l'entretien a été **vidé depuis** dans un autre onglet, il le signale et vous
  demande si c'est voulu, au lieu de refaire tout l'entretien.
- ✅ **Il peut BRANCHER ou DÉBRANCHER un outil de votre bibliothèque sur cet agent** (2026-09-15), en le
  demandant en français (« branche-lui l'outil de suivi de commande »). Il ne peut **pas en créer** : déclarer
  un outil, c'est écrire une adresse et un secret, et cela reste un geste d'administrateur. Un nom qui n'est
  pas dans votre bibliothèque est refusé.
  ⚠️ **Brancher n'active pas** : l'outil devient disponible, c'est vous qui l'activez ensuite dans l'onglet
  Outils, après avoir relu ses mots. Et **débrancher ne retire l'outil qu'à CET agent** : il reste sur vos autres
  agents ; un outil de connecteur API que plus aucun agent n'utilise est retiré de l'espace (son appel reste dans
  Connecteurs API, depuis le 2026-09-21). Le diff le dit.
- ✅ **Ce qu'il n'a pas le droit d'écrire** : la mention légale d'IA, les plafonds, le budget, le modèle, et
  surtout **l'activation d'un outil**. Il peut proposer les mots d'un outil du catalogue ou d'un connecteur
  déjà déclaré, jamais créer un système, une adresse ou un secret.
- ⚠️ **Il inventait des réglages jusqu'au 2026-08-29**, et la cause était dans nos propres consignes, pas dans
  le modèle : on lui ordonnait de déduire plutôt que de demander, et on lui imposait de remplir « quand ne pas
  l'appeler » même quand personne n'en avait parlé. Corrigé dans les deux sens.

### Onglet « Historique » d'un agent (2026-09-15)

Le même écran que côté Meta Business Agent, pour l'agent IA : **ce qui a changé, et ce qui a été effacé**.

- ✅ **Une fiche de connaissance supprimée y laisse son CONTENU**, y compris quand on en supprime cinquante
  d'un coup. Il n'y a pas de corbeille : cette ligne en est le seul exemplaire.
- ✅ **Chaque ligne dit qui, quand, et d'où** (l'assistant ou un formulaire).
  ⚠️ Comme côté MBA, **les créations et modifications faites à la main n'y figurent pas encore** : l'écran le
  dit plutôt que de laisser croire à un journal complet.
- ✅ **Rien n'est purgé**, contrairement au journal d'audit RGPD.
- ⚠️ **Réservé aux administrateurs.**

### Qui a écrit quoi dans la conversation de construction (2026-09-15)

La conversation est **partagée entre les administrateurs de l'espace** : chaque message porte donc l'adresse de
celui qui l'a écrit. Un message d'avant le 2026-09-14, ou écrit par un compte depuis supprimé, n'en affiche
aucune plutôt qu'un nom inventé.

### Ce qui manque à l'agent, dit dès l'ouverture (2026-09-08)

- ✅ **Un bandeau en tête de la fiche liste ce qui manque**, sans attendre qu'on clique « activer », et
  chaque ligne est un lien vers l'onglet où ça se corrige. Le contrôle existait déjà, mais il ne parlait
  qu'au moment de l'activation : un agent en brouillon qu'on essaie dans le bac à sable ne le voyait jamais.
- 🔴 **Le cas qui coûte le plus cher est couvert** : une base de connaissance REMPLIE avec l'outil de
  recherche DÉSACTIVÉ. L'agent transfère alors toutes les questions de fond, et l'écran d'une base bien
  garnie donne l'impression que tout va bien. C'est le pire des deux mondes : le travail est fait et inutile.

### Le silence du contact : quand l'agent lâche

L'entretien de construction demande **au bout de combien de temps sans réponse l'agent doit lâcher la
conversation**, et écrit la réponse dans le réglage correspondant (onglet des garde-fous, « Inactivité, en
minutes », 30 minutes par défaut, 24 heures au maximum). Passé ce délai, le parcours sort par la règle
« Pas de réponse », et l'agent ne repart pas si le contact revient plus tard.

### Le bac à sable : lui parler avant de l'activer

- ✅ **Vous parlez au VRAI agent** : son objectif, son ton, ses outils, sa vraie base de connaissance. Ce qu'il
  répond ici est ce qu'il répondra.
- ✅ **Chaque appel d'outil est montré**, avec ce qu'il a demandé, s'il a réussi, et ce qu'il a reçu en retour.
  Un panneau qui n'afficherait que la réponse laisserait régler à l'aveugle : on verrait une belle phrase sans
  savoir si elle vient de la base de connaissance ou de l'imagination du modèle.
- ✅ **Les actions qui touchent le monde réel sont simulées**, et c'est dit à chaque appel : poser un tag,
  envoyer un bloc, passer la main. Il n'y a ni contact, ni conversation, ni parcours dans un test.
- ✅ **La sortie est annoncée** quand l'agent en prend une : « l'agent est SORTI par X, dans un scénario c'est
  cette branche qui prendrait la suite ».
- 🔴 **« Plafond atteint » ne veut pas toujours dire qu'un plafond est atteint, et l'écran le dit désormais**
  (2026-09-08). Quand le modèle rend une réponse NON CONFORME (il imite un résultat d'outil au lieu d'en
  appeler un, et le garde-fou anti-hallucination la refuse parce que son contenu est inventé), le bac à sable
  l'explique en clair au lieu d'afficher « plafond », qui envoyait chercher un réglage inexistant. La sortie
  du scénario, elle, n'a pas changé : ce que vous avez câblé continue de fonctionner à l'identique.
- ⚠️ **Un essai consomme du crédit pour de vrai** : le fournisseur facture un essai comme une conversation.
  Sans crédit, le bac à sable refuse.
- ✅ **Vos essais précédents sont gardés 14 jours** (2026-09-08), sous la conversation : l'heure, ce que
  l'essai a coûté, combien de jetons, la sortie prise, et **les outils que l'agent a appelés**. « Voir
  l'échange » rejoue l'essai entier, question et réponse.
- ✅ **« Reprendre » repose EXACTEMENT la même question** à l'agent tel qu'il est réglé maintenant. C'est à
  ça que sert l'historique : régler un agent, c'est changer une consigne puis reposer la même question pour
  voir si la réponse a bougé, et une comparaison sur une question retapée ne compare rien.
- ✅ **Les outils appelés sont visibles sans rien ouvrir**, parce que c'est la première question devant une
  mauvaise réponse : « il n'a pas trouvé » et « il n'a même pas cherché » ne sont pas le même défaut.

### Le crédit et les plafonds

- ✅ **Un solde prépayé par espace de travail**, affiché en haut de la liste des agents et libellé en euros.
  Il descend à chaque tour, avec ce que le tour a réellement coûté.
- ✅ **Trois états, et ils préviennent avant la panne** : le solde en clair, un avertissement sous **0,50 €**
  (« c'est bas, au bout vos agents cesseront de répondre »), et un bandeau rouge à zéro (« vos agents ne
  répondent plus et sortent par Plafond atteint »).
- ✅ **Le rechargement se fait par nous, jamais par le client** : un client ne doit pas pouvoir créditer son
  propre compte. À la main pour l'instant, sans paiement en ligne (voir la section `/ops`).
- 🔴 **Aucun espace n'a de crédit aujourd'hui** (2026-08-28), et c'est le bon défaut : un crédit implicite
  ferait payer une consommation que personne n'a autorisée. Conséquence concrète : **tant que personne n'a
  rechargé, les agents ne démarrent pas et le bac à sable refuse**.
- ✅ **Trois plafonds de conversation** en plus du solde, réglés sur la fiche (tours, appels d'outils, budget).
  Le premier atteint fait sortir le parcours par 🛑 « Plafond atteint », qui est une sortie à brancher : c'est
  un garde-fou, pas un réglage de confort.
- ✅ **CHAQUE ESPACE A SA PROPRE CLÉ DE MODÈLE** (2026-09-09), créée automatiquement au moment où le client
  crée son PREMIER agent, et plafonnée au crédit qu'il a acheté. Ce qui change côté client : **sans crédit,
  on ne peut plus créer d'agent du tout**, avec un message qui dit de recharger. Ce n'est pas une sévérité
  gratuite : le bac à sable appelle vraiment le modèle, donc un espace sans crédit mettrait son agent au
  point à nos frais.
  ⚠️ **Le client ne choisit pas son plafond en le tapant**, il le choisit **en achetant du crédit**. Un
  plafond saisi librement ne protégerait personne. Il monte à chaque rechargement, et ne redescend jamais
  tout seul.
  ⚠️ **Un espace créé AVANT ce lot n'a pas de clé propre** et continue de fonctionner sur la clé maison : sa
  dépense n'est simplement pas séparée des autres. Il en aura une au prochain agent qu'il créera.

### La mention d'IA (obligation légale)

- ✅ **Chaque agent porte une phrase qui annonce au contact qu'il parle à une IA.** Pré-remplie
  (« Vous échangez avec un assistant automatique. »), modifiable, mais **elle ne peut jamais être vide**.
- ✅ **QUAND elle est dite est un RÉGLAGE du client** (2026-09-09), à trois régimes : **jamais**,
  **une fois par session** (le défaut) ou **à chaque message**. La question lui est posée à la construction
  du bot, elle n'est pas cachée dans un écran qu'on ne trouve pas.
- ✅ **Et ce réglage vaut pour TOUT L'ESPACE depuis le 2026-09-13**, dans **Sécurité > IA** : l'obligation
  d'information pèse sur la marque qui déploie, pas sur chacun de ses robots, et trois agents ne sont pas
  trois marques. La fiche d'un agent ne porte plus le choix, elle renvoie vers l'écran qui le porte.
  - ✅ **L'écran montre aussi la PHRASE de chaque agent.** Le réglage dit QUAND on annonce, pas CE QU'ON
    annonce : montrer l'un sans l'autre promettrait une vérification qu'on ne permet pas de faire.
  - ⚠️ **Il distingue « vous avez choisi » de « le défaut s'applique ».** Le comportement est le même, la
    responsabilité non, et sur un écran de conformité la différence compte.
  - ⚠️ **L'agent de Meta n'est PAS concerné, et l'écran le dit** : Meta appose déjà sa propre mention sous
    les messages de son agent, la nôtre en ferait deux.
  - ⚠️ **Rien n'a changé pour les agents déjà réglés** : chaque espace a hérité de ce que ses agents
    faisaient déjà.
  ⚠️ **Ce n'était pas tenable avant** : la phrase était obtenue en demandant au modèle de la dire « au tout
  premier message d'une conversation ». Rien ne garantissait qu'elle parte, et surtout le modèle ne sait pas
  où commence une session : le réglage « une fois par session » aurait été un mensonge. C'est le code qui
  choisit désormais, avant chaque appel.
  ⚠️ **« Jamais » est un choix, pas un oubli.** L'AI Act (article 50) n'impose l'information que lorsqu'elle
  n'est pas évidente du contexte, et l'obligation pèse sur la marque qui déploie l'agent : c'est donc à elle
  de trancher, en connaissance de cause.
- ✅ **L'assistant de construction n'a pas le droit d'y toucher.** Une IA ne supprime pas la phrase qui annonce
  qu'elle est une IA.

### Ce qui n'est pas encore là

- ⚠️ **Un bloc agent n'apparaît pas dans Analytics > Mes tableaux.** Les autres blocs qui envoient s'y
  mesurent, pas celui-là. Aucune panne, mais rien à lire sur ce bloc pour l'instant : mesurer un contenu
  produit au fil des tours est une question produit qui n'est pas tranchée.
- ➡️ **La connexion MCP existe** (les serveurs d'outils standardisés), voir « Brancher un serveur MCP ».
  ⛔ Elle n'accepte pas encore OAuth : l'authentification se fait par jeton ou par en-tête.
- ⛔ **Pas de « temps 2 »** : l'agent ne relit pas ses vraies conversations pour se corriger tout seul. Cela
  n'a de valeur qu'une fois qu'il existe des conversations.

## MBA, le répondeur de Meta (menu « AI Agent » > MBA, guide / MBA, paramètres)

- ✅ **Il répond quand un client revient après un silence** (2026-09-16), même trois mois plus tard, et même
  si le dernier échange était passé par un autre canal. C'est la raison d'être de cet agent : répondre quand
  rien n'a été préparé pour cette conversation.
  - Le fil lui repasse **au moment où le message arrive**, et pas avant : Meta ne peut confier une
    conversation que s'il en existe une d'ouverte, et elle s'ouvre exactement quand la personne écrit.
  - 🔴 **Il ne prend jamais la place de quelqu'un d'autre.** Si un scénario attend une réponse, c'est le
    scénario qui l'obtient ; si un opérateur travaille sur la conversation dans l'Inbox, il n'est pas doublé.
  - ⚠️ **Avant le 2026-09-16**, deux conversations sur trois pouvaient rester sans réponse dans ce cas : soit
    parce que le produit croyait avoir confié le fil à Meta sans que Meta l'ait accepté, soit parce que la
    conversation n'apparaissait dans aucun dossier. Les deux sont corrigés.

- ✅ **Page de guidage `/mba`** (2026-07-28) : page de contenu **côté client** (ton produit) qui explique
  l'**agent MBA** (le répondeur intelligent WhatsApp de Meta). Sections : ce qu'il fait (répond seul, passe la
  main à l'Inbox, vous gardez le contrôle) ; **paramétrer en 5 étapes** (activer via les conditions Meta Business
  AI + éligibilité → base de connaissance → personnalité → tester → activer et garder la main) ; **gestion des
  connecteurs** avec les DEUX sens bien séparés (**pendant la conversation** = l'agent consulte un système externe,
  sur mesure via accompagnement ; **vers votre CRM** = les conversations remontent, HubSpot dispo + lien vers son
  guide) ; **prérequis + transparence des coûts** ; encart **« bientôt configurable ici »**. Page de PRÉPARATION :
  la config live s'ouvrira quand Meta rendra l'agent disponible pour le numéro (gating vertical + ToS).
- ✅ **Page « Paramètres de l'agent »** (LIVE depuis le 2026-08-18) : l'écran de réglage de
  l'agent MBA, en **dix onglets**, branché pour de vrai sur la configuration Meta du numéro.
  **Aperçu** (l'état de l'agent), **Assistant** (régler l'agent en lui parlant, cf. ci-dessous),
  **Activation** (qui parle au client, cf. ci-dessous),
  **Business** (les informations de l'entreprise), **FAQ** (saisie question par question **et
  import en masse** depuis un CSV, un Excel, un PDF ou une URL, avec aperçu avant écriture et
  sans jamais dupliquer une question déjà posée), **Compétences** (le ton, les procédures et les
  interdits, par exemple « ne jamais inventer un horaire »), **Fichiers** (jusqu'à 100 Mo de
  documents de connaissance : PDF, Word, CSV, Excel), **Sites web** (les pages que l'agent va
  lire), **Historique** (ce qui a changé et ce qui a été effacé, cf. ci-dessous) et **Tester**
  (un bac à sable où l'on parle à l'agent sans consommer de conversation facturée).
  Deux situations, deux bandeaux distincts, parce qu'elles ne se règlent pas au même endroit :
  **aucun numéro rattaché** (renvoie à l'Accueil) et **Meta n'a pas encore ouvert l'agent sur ce
  numéro** (renvoie au Guide ; Meta ouvre Business AI progressivement, par pays et par secteur, et
  les conditions se signent dans WhatsApp Manager). Hors de ces deux cas, tout s'édite.

- ✅ **Onglet « Activation »** (2026-08-21) : les deux réglages qui décident **qui parle au client**, réunis au
  même endroit, en deux questions. (1) *Quand le client demande un humain, ou que l'agent ne sait pas* : l'agent
  passe la main et la conversation remonte dans « À traiter » ; ou seulement pendant vos heures d'ouverture (en
  dehors, il garde la conversation au lieu d'annoncer un conseiller qui n'est pas là) ; ou jamais. (2) *Quand un
  humain répond, il garde la main pendant* N minutes ; ce réglage était sur l'Accueil, il vit ici désormais, et
  son texte est corrigé : le compte à rebours part de la **première** réponse de l'opérateur, pas de la dernière.
  ⚠️ Ce que l'écran ne promet pas, parce que ce n'est pas tenable : empêcher un humain de prendre la main (aucun
  verrou n'existe, ni chez nous ni chez Meta), et empêcher l'agent de décider un transfert (il décide seul ;
  « jamais » le fait seulement garder la conversation au lieu de la lâcher).
  ⚠️ **Quand l'agent ne sait pas répondre, il ne passe PAS la main** : il renvoie vers les coordonnées de votre
  base de connaissance. Il transfère quand le client réclame explicitement un humain, ou quand il refuse de
  traiter la demande. Mesuré le 21/08/2026 : une réclamation qui décrit un incident ET demande un dédommagement
  obtient de l'agent une réponse **vide**, ce qui rend d'autant plus nécessaire de voir ces conversations
  remonter dans « À traiter ».

### Onglet « Assistant » : régler l'agent en lui parlant (2026-09-15)

**À quoi ça sert.** Décrire ce qu'on veut changer en français (« ajoute mes horaires du samedi », « retire la
FAQ sur les livraisons du dimanche »), et l'assistant propose. Il ne fait rien tout seul : il affiche **ce
qu'il va faire, une ligne par modification**, et rien ne part chez Meta tant qu'on n'a pas cliqué sur
**Appliquer**.

- ✅ **Il connaît l'état réel de l'agent** : il lit chez Meta ce qui existe déjà (FAQ, compétences, sites,
  documents, fiche d'activité) avant de proposer, et il relit juste avant d'appliquer. Les autres onglets
  restent donc utilisables pendant la conversation.
- ✅ **Le fil ne se perd pas.** On peut fermer la page et reprendre la conversation plus tard, au même endroit.
  Le bouton **« Repartir de zéro »** efface la conversation ; **il n'annule rien de ce qui a déjà été appliqué**.
- ✅ **Joindre un document** : le bouton **« Joindre »** dépose un PDF, un Word (.docx), une image (PNG/JPEG) ou
  un CSV, jusqu'à 20 Mo. Le document **entre dans la liste des modifications comme le reste** et ne part chez
  Meta qu'à l'acceptation. Il y part **tel quel**, sans découpage : c'est Meta qui l'indexe.
  ⚠️ **La liste des formats est plus courte que celle de l'onglet Fichiers** (ni `.doc`, ni `.xlsx`) : ici le
  type est reconnu **dans le contenu du fichier**, pas dans son nom, et ces deux formats-là ne s'y reconnaissent
  pas. Le message de refus le dit et renvoie vers l'onglet Fichiers.
- ⚠️ **Une seule suppression par proposition.** Meta n'a ni corbeille ni annulation : une demande en lot
  (« nettoie mes FAQ ») obtient une liste et une question, jamais une purge qu'une acceptation rapide rendrait
  définitive. Une suppression est signalée à part dans la liste, en rouge.
- ⚠️ **Ce qu'il ne fera jamais** : retirer l'agent du service (ça se fait à la main, sur la première page), ni
  créer un connecteur. Et **tout ce qu'il fait reste faisable à la main dans les autres onglets** : la
  conversation n'est jamais le seul chemin.
- ⚠️ **Réservé aux administrateurs**, comme toutes les modifications du MBA.
- ⚠️ **Il a une limite mensuelle** (c'est nous qui payons le modèle). Une fois atteinte, il le dit clairement et
  **tous les onglets restent utilisables** : ce n'est pas une panne.
- ⚠️ **Si Meta refuse une modification au milieu de la liste**, on voit exactement ce qui est passé, ce qui a
  échoué et ce qui n'a pas été tenté. Meta n'offre aucune annulation d'ensemble.

### Onglet « Historique » : ce qui a changé, et ce qui a été effacé (2026-09-15)

**À quoi ça sert.** Meta n'a pas de corbeille. Une FAQ, une compétence ou un document supprimé est perdu chez
lui : cette page en garde **le seul exemplaire**.

- ✅ **Ce que l'assistant a appliqué y figure en entier**, et **ce qui a été SUPPRIMÉ depuis les onglets**.
  Chaque ligne dit quoi, quand, par qui, et si ça vient de l'assistant ou d'un formulaire.
  ⚠️ **Les créations et modifications faites à la main dans les onglets n'y figurent pas encore**, et l'écran
  le dit : chez Meta une suppression est définitive, une création ratée se refait. C'est un ordre de priorité,
  pas un oubli.
- ✅ **Le contenu effacé est consultable** : sur une suppression, « voir le contenu effacé » ouvre ce qui a été
  perdu.
  ⚠️ **Le remettre le RECRÉE, ça ne le ressuscite pas** : on recopie le contenu dans l'onglet concerné, ce qui
  crée un élément neuf. L'identifiant Meta de l'original est perdu pour toujours, et l'écran le dit.
- ✅ **Rien n'est purgé.** C'est ce qui le distingue du journal d'audit RGPD, qui, lui, a une durée de rétention.
- ⚠️ **Réservé aux administrateurs** : il porte le contenu des éléments supprimés, donc il ne peut pas être plus
  lisible que ce qu'il décrit.

### Reprendre la main sur l'agent de Meta

Dans l'Inbox, sur une conversation que l'agent de Meta tient, le bouton **« Reprendre la main »** la lui
PREND réellement : la console appelle Meta pour cela, sans qu'aucun message ne parte chez le contact. L'agent
de Meta se tait alors jusqu'à la reprise automatique (deux heures par défaut, réglable), même si personne
n'écrit au client entre-temps.

⚠️ **Meta peut refuser**, et l'écran le dit alors au lieu de laisser croire que c'est fait : l'action est
réservée par Meta au partenaire d'escalade configuré. La porte de secours reste vraie dans tous les cas,
**écrire au contact prend le fil à coup sûr**. Sur un rangement en lot, le nombre de conversations refusées
est annoncé.

### Voir d'un coup d'œil qui tient chaque conversation

Dans la liste de l'Inbox, une conversation tenue par l'agent de Meta porte un **dégradé bleu vers violet** et
une **baguette à étincelles** devant le nom.

⚠️ **La liste ne porte plus AUCUNE mention texte de détenteur**, pas même « vous avez la main » (demande de
Julien du 2026-09-11 : « laisse juste le frame en blanc »). Elle sert à REPÉRER l'exception, et l'exception
est la seule chose colorée. Le détenteur exact, lui, se lit dans l'en-tête de la conversation ouverte, là où
l'on a la place et le besoin du mot juste.

## Canal RCS (menu Contenu > Messages RCS, et canal de campagne)

⚠️ **Tout ce chapitre est conditionnel.** Le canal RCS reste ÉTEINT tant qu’aucune clé d’API n’est posée sur
l’Accueil : les briques RCS (le bloc du constructeur, le canal de campagne) restent visibles mais grisées, et
aucun envoi n’est possible. Les points ci-dessous décrivent ce qui existe UNE FOIS la clé posée.

Deuxième canal, à côté de WhatsApp. Les messages partent sous un **agent de marque** : le nom et le logo de
l'entreprise s'affichent dans l'application Messages du destinataire, avec la pastille de vérification. Il n'y
a pas de numéro d'expéditeur, et **aucun modèle à faire approuver** : on écrit, on enregistre, on envoie.

- ✅ **Activation** : sur la page d'accueil, sous le numéro WhatsApp. Un bouton « Activer le RCS » demande la clé
  d'API du canal, la vérifie chez le fournisseur, et affiche ce à quoi elle donne droit (nom de l'agent, type
  de trafic, quotas). La clé n'est jamais réaffichée. Tant que le canal est éteint, les briques RCS restent
  visibles mais grisées.
- ✅ **Bibliothèque (Contenu > Messages RCS)** : composer un message réutilisable. Un texte, une **image
  d'en-tête** facultative, des **variables** `{{prenom}}` remplacées par la fiche du contact à l'envoi, des
  **emojis**, et jusqu'à **11 boutons** (réponse, lien, appel). Aperçu en direct. Avec une image, le texte est
  limité à 2000 caractères au lieu de 3072.
- ✅ **Le même écran que les templates WhatsApp** (2026-09-21, demande de Julien : « la même gueule que les
  écrans WhatsApp template ») : la liste est un **tableau** (nom, format, début du texte, actions), cliquer sur
  un nom ouvre son **aperçu**, « + Créer un message » ouvre un encadré avec le choix **« Message simple |
  Carrousel »**, l'aperçu vit dans un **cadre de téléphone** au nom de la marque, et le formulaire dit **ce qui
  manque** au lieu de griser son bouton sans explication. Basculer de format ne perd rien de ce qui est saisi.
- ✅ **Carrousel RCS** : de **2 à 10 cartes** qui défilent à l'horizontale, chacune avec un **visuel** (ou au
  moins un titre), un **titre** facultatif, un **texte** avec variables (2 000 caractères) et jusqu'à **4
  boutons** des six formes. Contrairement au carousel WhatsApp, chaque carte a **ses propres boutons**. Les
  manques sont nommés carte par carte. Un carrousel se modifie dans son formulaire ; changer de format, c'est
  créer un autre message.
- ✅ **Six formes de bouton**, les mêmes dans la bibliothèque, la campagne et le scénario : **Réponse** (le
  contact répond en un tap), **Lien**, **Appel**, **Agenda** (ajoute le rendez-vous à l'agenda du téléphone),
  **Voir un lieu** (l'ouvre sur sa carte) et **Demander sa position**. Seul un bouton Réponse ouvre une sortie
  à relier dans un scénario : les cinq autres agissent sur le téléphone ou sortent de la conversation, et ne
  renvoient rien qui permette de choisir une branche.
- ✅ **Le visuel se téléverse depuis la console** : on choisit une image sur son ordinateur (JPEG, PNG ou GIF,
  2 Mo maximum) et l'adresse se remplit toute seule. Rien à héberger ailleurs, aucun lien à fabriquer. Le
  champ accepte quand même une adresse collée, pour ceux qui hébergent déjà leurs visuels sur leur propre site.
- ✅ **L'allure des boutons se choisit en ajoutant un visuel, pas dans un réglage** : avec une image, ils
  s'affichent en **liste pleine largeur dans la carte** et y restent (4 maximum) ; sans image, en **petites
  pastilles** sous la bulle, qui disparaissent quand la conversation avance (11 maximum). C'est l'application
  Messages du destinataire qui décide, l'aperçu montre les deux formes telles qu'elles sortiront.
- ✅ **Un rendez-vous propre à chaque contact** : les dates d'un bouton Agenda se prennent soit en dur, soit dans
  un champ « date et heure » de la fiche. Un contact sans date perd le bouton, et reçoit quand même le message.
- ✅ **Une position reçue** apparaît dans le fil avec ses coordonnées, un fichier avec son adresse.
- ✅ **En campagne** : choisir « Un message RCS » comme contenu, partir d'un message de la bibliothèque ou écrire
  directement. Les contacts sans numéro (identifiés par BSUID seulement) sont comptés « ignorés » avec leur
  motif : le RCS s'adresse à un numéro **mobile**, une ligne fixe ne peut pas le recevoir.
- ✅ **Un carrousel en campagne** : « Partir d'un message enregistré » propose aussi les carrousels, marqués
  « (carrousel) ». Le carrousel est **copié en entier** sur l'étage et s'y montre en aperçu : pour le modifier,
  on le modifie dans la bibliothèque puis on le choisit à nouveau. « Revenir à un message simple » rend le texte
  saisi avant. Marche en « Message seul » comme en « Message et scénario », sur n'importe quel étage.
- ✅ **En scénario** : le bloc « Message RCS » a deux sorties de livraison, **Envoyé** et **Non joignable**, plus
  une sortie par bouton réponse. Relier « Non joignable » à un envoi de template WhatsApp donne la cascade :
  le RCS d'abord, le WhatsApp pour ceux qu'il n'atteint pas. ⚠️ **Pas encore de carrousel dans un bloc de
  scénario** : ils y sont proposés grisés, avec leur raison (leurs sorties par bouton de carte restent à
  construire).
- ✅ **Réponses** : elles arrivent dans le fil du contact, au même endroit que WhatsApp, la bulle indiquant son
  canal. Un bouton tapé fait avancer le scénario par la branche correspondante. Un contact qui répond **STOP**
  est désabonné du RCS, sans que cela touche son consentement WhatsApp.
- ✅ **Envoyer un template depuis l'Inbox ne demande plus rien d'inutile** : les variables arrivent déjà
  remplies avec les infos du contact (et le nom du champ à côté), et l'image d'en-tête définie sur le template
  part toute seule. On ne la redemande que si Meta ne la retrouve plus.
- ✅ **Depuis l'Inbox** : le bouton 📱 envoie un message RCS de la bibliothèque au contact ouvert. Il est proposé
  même quand la fenêtre WhatsApp de 24 h est fermée, puisque le RCS n'a pas de fenêtre : c'est souvent le
  moyen le plus simple de reprendre contact. L'aperçu montre le message tel que le contact le verra, et un
  refus (canal éteint, contact désabonné) s'affiche avec sa raison.
- ✅ **Répondre en RCS avec ses propres mots** (2026-08-25) : dans le panneau RCS de l'Inbox, un onglet
  « Réponse libre » à côté de « Message enregistré ». On écrit sa phrase, elle part sous l'agent de marque.
  Avant, un contact joignable **seulement** en RCS n'était atteignable qu'à travers la bibliothèque : pour lui
  répondre, il fallait créer une entrée de bibliothèque, ou faire approuver un template WhatsApp. Le texte
  libre part tel quel, sans substitution de variables.
- ✅ **Les automations se déclenchent aussi sur un message reçu en RCS** (2026-08-25) : un contact qui écrit
  DEVIS dans le fil RCS déclenche l'automation « mot-clé », et un premier contact en RCS crée sa fiche et
  déclenche « nouveau contact ». Avant, ces déclencheurs étaient muets sur ce canal, sans que rien ne le dise :
  l'opérateur croyait son automation cassée. ⚠️ Un scénario déclenché par un message RCS ne peut pas ouvrir par
  un message rapide WhatsApp : répondre en RCS ne rouvre pas la fenêtre de 24 h de Meta.
- ✅ **Un bloc RCS affiche enfin « délivré » et « lu »** (2026-08-25) dans Analytics > Mes tableaux. Les
  rapports de livraison du fournisseur alimentaient les résultats de campagne mais pas la mesure par bloc.
- ✅ **Les variables s'insèrent comme dans un template WhatsApp** : bouton « + Variable », on choisit le champ,
  et il apparaît comme une étiquette lisible dans le texte, pas comme des accolades.
- ✅ **Le canal suit la conversation, pas le bloc.** Un scénario qui commence en RCS continue en RCS : si le
  contact tape un bouton, le « message rapide » suivant part en RCS avec ses propres boutons. Pour basculer
  volontairement sur WhatsApp, il suffit de brancher un envoi de template : le parcours passe alors sur
  WhatsApp et y reste. Un **formulaire** WhatsApp fait exception, il n'existe pas en RCS ; l'éditeur le signale.
- ✅ **Un scénario peut COMMENCER par un message RCS**, et se lancer même quand la fenêtre WhatsApp de 24 h est
  fermée : le RCS n'a pas de fenêtre. Ce qui suit le bloc RCS part aussi, à une exception près que l'éditeur
  signale : un **formulaire** WhatsApp placé juste derrière ne partira que si le contact a écrit **sur
  WhatsApp** dans les 24 h, car répondre en RCS ne rouvre pas cette fenêtre.
- ✅ **Les chiffres ne mélangent plus les deux canaux** (2026-08-25). Une réponse ou un clic reçu en RCS ne
  compte plus comme une réponse au **template WhatsApp** d'une campagne (et l'inverse), et les envois RCS
  sortent de la série « Service » du tableau de bord, puisque Meta ne les facture pas.
- ✅ **Le RCS a un PRIX, et le coût par engagement le compte** (2026-09-23). Ces écrans ont longtemps dit
  qu'une campagne RCS n'avait pas de coût « parce que Meta ne facture rien sur ce canal ». C'était vrai du
  tarif de Meta et faux du prix réel : ce sont **vos** deux prix RCS, saisis dans Vos prix (simple et
  conversationnel), et le total « coût des messages envoyés » les comptait déjà. Une campagne RCS affiche
  donc son coût, au tarif **conversationnel** dès que le contact a réagi dans les sept jours, comme partout
  ailleurs dans le produit.
- ⚠️ **Une campagne RCS dont aucun envoi n'est retrouvé garde sa case vide**, elle n'affiche pas « 0 € » : le
  cas existe pour les campagnes antérieures au suivi par étage. Vide se lit « on ne sait pas », zéro se
  lirait « ça n'a rien coûté ».
- ⚠️ **Ce que le canal ne dit pas à l'avance** : le fournisseur ne sait pas dire si un numéro est joignable en
  RCS avant d'essayer. La sortie « Non joignable » se déclenche donc sur le **rapport de livraison**, quelques
  instants à quelques minutes après l'envoi, et non au moment où le bloc est atteint.

## Chaîne WhatsApp (menu Chaîne) : publier, et démarrer des conversations

Une **chaîne WhatsApp** diffuse à des abonnés, en un seul sens : ils reçoivent, ils ne répondent pas. La
console la pilote via **Channels Me**, et son intérêt ici est de RAMENER l'abonné en conversation : chaque
publication peut porter un bouton « Discuter » qui, une fois appuyé, ouvre WhatsApp avec un message déjà
écrit. Ce message déclenche un scénario.

**Écrire le message.** Une zone de texte, un aperçu qui montre le post tel que l'abonné le verra, et une
barre de mise en forme : **gras**, *italique*, ~barré~, plus une palette de smileys. Le smiley s'insère au
curseur et la mise en forme s'applique à la sélection, qui reste posée pour enchaîner deux styles.
⚠️ La mise en forme utilise la syntaxe de WhatsApp (`*gras*`, `_italique_`) et part TELLE QUELLE : c'est le
téléphone de l'abonné qui la rend. L'aperçu de la console montre le rendu attendu, jamais les étoiles.

**Mettre une photo.** Un bouton « Choisir une image » téléverse depuis le poste : la console héberge le
fichier et remplit l'adresse toute seule. Le champ d'adresse reste disponible pour qui héberge déjà ses
visuels ailleurs. 2 Mo maximum, JPEG / PNG / GIF (le type réel est relu, un fichier renommé est refusé).

**Le bouton « Discuter ».** Il se rattache à un **lien**, qui associe une **phrase** à un **scénario**. La
phrase est ce que l'abonné enverra en appuyant. Deux règles la gouvernent, et elles se voient à la création :
une phrase ne peut ni contenir ni être contenue dans celle d'un autre lien (sinon un seul appui démarrerait
deux scénarios), et la console COMPTE combien de messages existants la contiennent déjà, pour éviter une
phrase trop banale (« Bonjour » déclencherait sur tout).

- ✅ **Un appui REPREND la conduite du fil** (2026-09-08). Si la conversation était tenue par un opérateur ou
  par l'agent de Meta, le scénario du bouton part quand même et la conduite revient à l'app. C'est le même
  principe qu'une campagne : quelqu'un a fait un geste explicite, ici l'abonné lui-même en appuyant sur le
  bouton d'une publication.
  🔴 **Sans ça, le bouton était muet une fois sur deux, sans que rien ne le dise.** Quand l'agent de Meta est
  allumé, chaque scénario lui rend le fil en arrivant au bout, et il le garde 24 heures : le SECOND appui d'un
  même abonné tombait donc toujours dans cette fenêtre et ne lançait rien. Vécu le 2026-09-08.
  ⚠️ **Un mot-clé ordinaire, lui, ne reprend toujours pas la main** : un opérateur en train de répondre à un
  client ne doit pas se faire couper la parole par un scénario sur un simple message.

**La liste des publications** montre, pour chaque post : son texte (mis en forme comme dans l'aperçu), sa
date, son statut lu en direct chez le fournisseur, **le scénario vers lequel son bouton renvoie**, et
**combien de personnes ont envoyé le message de son bouton**. Un bouton mort (lien éteint) est signalé, avec sa réparation à
côté.

🔴 **« Combien de clics » n'existe pas, et ce n'est pas une lacune de la console.** Un appui sur le bouton
ouvre WhatsApp sur le téléphone de l'abonné : ce geste ne traverse aucun de nos serveurs, et Channels Me ne
le rapporte pas non plus. Ce qui est mesurable, c'est le message qui arrive ENSUITE.

L'écran affiche donc exactement ce qu'il observe : **« N personnes ont envoyé ce message »**, comptées en
contacts distincts (un abonné qui appuie trois fois est une personne, pas trois). ⚠️ **Il ne dit pas
« conversations démarrées », et c'est délibéré** : nous ne reconnaissons que la phrase du bouton, alors que
le moteur applique trois filtres de plus avant de démarrer un scénario (automation allumée, anti-rebond,
plafond horaire). Un message reçu pendant que le bouton était éteint compterait donc comme une
« conversation démarrée » juste au-dessus du bandeau annonçant que ce bouton ne démarre rien.

Trois limites, ÉCRITES sous la liste et pas rangées dans une infobulle : le chiffre vaut pour le BOUTON,
toutes ses publications confondues (deux posts sur le même bouton envoient le même message, rien ne dit
lequel a été vu) ; un message reçu bouton éteint est compté sans avoir rien démarré ; et quand la mesure est
indisponible, l'écran n'affiche RIEN plutôt qu'un zéro, qui se lirait « ce bouton n'a rien produit ».

## Serveur MCP : brancher un assistant sur la console (LIVE, 2026-09-01)

**À quoi ça sert.** Un client (ou son prestataire) branche son assistant, Claude ou n'importe quel client
compatible MCP, directement sur son espace, **sans développer d'intégration**. Là où le connecteur HubSpot a
coûté un dépôt entier pour UN partenaire, le serveur MCP rend la console joignable par tout ce qui parle ce
protocole, pour un seul travail.

**Comment ça s'utilise.** Menu **Developers > Serveur MCP**. L'écran donne l'adresse
(`https://mba.messagingme.app/mcp`), la commande à copier, la liste des outils et ce que le serveur ne fait
pas. L'accès passe par une **clé d'API** portant les droits `mcp:read` et/ou `mcp:write`, créée dans
« Clés d'API ». Pour couper un assistant : révoquer sa clé.

**Ce que l'assistant peut faire.** Lire (`mcp:read`) : lister les conversations, ouvrir un fil et savoir si la
fenêtre de 24 h est ouverte, lire les messages, chercher un contact, lister les membres. Agir (`mcp:write`) :
répondre dans une conversation ouverte, poser des tags, confier un fil à un membre.

**Ce qu'il ne fait PAS, et c'est délibéré.**
- **Aucun envoi de template, aucune campagne.** Ouvrir l'envoi de template à un modèle, c'est lui donner un
  mégaphone facturé sur un numéro dont Meta note la qualité. Un assistant répond dans une conversation
  ouverte ; il ne lance pas d'envoi de masse.
- **Hors de la fenêtre de 24 h, rien ne part.** L'outil refuse et dit pourquoi.
- **Les automations ne se déclenchent pas.** Un tag posé par un assistant classe le contact, il ne réveille
  pas les automations qui écoutent ce tag : un agent qui boucle sur 500 fils déclencherait 500 envois.
- **Une clé de lecture ne VOIT même pas les outils qui écrivent** : ils ne sont pas listés.

⚠️ **L'accès est une clé, pas un compte.** Le scénario « fenêtre de login, je choisis mon organisation,
j'approuve l'accès » (OAuth 2.1 délégué) n'est pas encore là : voir `todo.md`.

## Plafonds d'usage (visible seulement si on force)

Rien à régler côté client, mais deux messages peuvent apparaître, et le support doit savoir que ce ne sont
pas des bugs :

- **« trop de requêtes, patientez un instant »** : un même compte a envoyé plus de 300 appels en une minute.
  Un usage humain n'y arrive pas (un écran de la console en tire une dizaine à l'ouverture) ; on le voit sur
  un script, un onglet en boucle, ou une intégration mal réglée. Ça se débloque tout seul en une minute.
- **« trop d'opérations lourdes sur cet espace, patientez une minute »** : plus de 10 opérations lourdes en
  une minute POUR L'ESPACE ENTIER, tous comptes confondus. Sont concernés l'import de contacts et son aperçu,
  l'action en masse du mini-CRM, la purge, l'export d'historique d'un contact et le lancement de campagne.
  Le compteur est celui de l'espace, donc deux collègues qui importent en même temps le partagent.

Les envois WhatsApp ne sont pas concernés : leur débit se règle campagne par campagne (1 à 80/min).

## À venir / hors périmètre

- 🔲 **Pool de numéros à l’embarquement** : plus tard. Le parcours Embedded Signup lui-même est **LIVE et
  éprouvé depuis le 2026-08-17** (voir la section Accueil) : un vrai numéro d’un business tiers est passé
  connecté et vérifié. Ce qui reste ouvert, c’est de proposer un numéro quand le client n’en a aucun.
- 🚧 **Allumer l'agent MBA en production** : la configuration est LIVE (menu **AI Agent > MBA,
  paramètres**, dix onglets branchés) et l'agent répond dans le bac à sable, mais Meta refuse de
  l'activer sur le numéro tant qu'un **moyen de paiement** n'est pas posé sur le compte WhatsApp
  Business. Le numéro de test est déjà dans la liste d'autorisation, l'activation se fait en une
  commande le moment venu.
- 🔲 **Abonnement / Billing** (Stripe) : menus câblés (désactivés), intégration hors lot.
- 🔲 **Rapport mensuel auto** : score agent + stats campagnes.
- Hors V1 (discipline anti tailor-made) : multicanal, segments avancés, A/B testing.
