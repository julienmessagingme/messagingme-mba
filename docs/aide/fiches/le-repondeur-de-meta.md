---
ecran: mba-settings
source_section: MBA, le répondeur de Meta (menu « AI Agent » > MBA)
source_empreinte: 0ff6f8
---
# Le répondeur de Meta : à quoi il sert, et comment le régler

Le Meta Business Agent est le répondeur intelligent de WhatsApp, fourni par Meta. Sa raison d'être est
simple : **répondre quand rien n'a été préparé pour cette conversation**. Un client qui revient après un
silence de trois mois, ou qui pose une question hors de tout scénario, obtient une réponse au lieu de rien.

**Il ne prend jamais la place de quelqu'un d'autre.** Si un scénario attend une réponse, c'est le scénario
qui l'obtient. Si quelqu'un de votre équipe travaille sur la conversation dans l'Inbox, il n'est pas doublé.
Et le fil lui repasse au moment où le message arrive, pas avant : Meta ne peut se voir confier une
conversation que s'il en existe une d'ouverte, et elle s'ouvre exactement quand la personne écrit.

**L'agent ne parle qu'aux conversations que Messaging Me lui confie.** Il ne répond qu'aux contacts de sa liste,
et c'est Messaging Me qui la tient : vous n'avez ni audience à choisir, ni numéros à y ajouter. Quand un client
écrit et que personne ne lui répond, la conversation lui est confiée et il répond tout de suite ; quand un
client répond à côté d'un scénario, aussi. Avant chaque modèle (scénario, campagne, Inbox), le contact sort de
la liste, pour que sa réponse revienne au scénario : pendant un scénario, l'agent se tait. « Rendre la main »
lui confie la conversation, et il répond au message suivant du client ; « Reprendre la main » fait sortir le
contact de la liste. Une conversation que l'agent n'a pas pu prendre (un client qui n'a pas partagé son numéro,
par exemple) passe à votre équipe, dans « À traiter ».

**Allumé, il est disponible ; il ne répond que si vous l'avez choisi.** Qui répond au client se règle sur
l'Accueil, dans « Qui répond au client » : l'agent de Meta, un agent IA, un scénario, ou votre équipe. Quand ce
n'est pas lui, l'agent de Meta allumé reste **en veille** : il ne prend que les contacts qu'un bloc « Envoyer au
MBA » d'un scénario lui envoie, et il y répond tout de suite. L'allumer quand c'est votre équipe qui répond en fait
le répondeur ; l'éteindre quand c'est lui qui répond vous est demandé en confirmation, et les messages vont alors à
votre équipe. Les paramètres et l'assistant vous disent, avant de l'allumer, s'il restera en veille.

Sous le menu AI Agent, l'entrée **MBA** ouvre ses **paramètres**, qui le règlent pour de vrai.

**Un en-tête identifie l'agent en haut des paramètres** : le logo de Meta, la mention « Meta Business Agent »
qui dit ce que l'écran règle, le nom d'affichage du numéro, le numéro lui-même, une pastille qui dit l'état du
numéro WhatsApp, les étapes obligatoires qu'il reste à régler
(chacune est un lien direct vers l'onglet où elle se corrige, avec le nombre de réglages obligatoires déjà
faits sur le total), et le nombre de messages échangés sur les 30 derniers jours dans les conversations que
l'agent a tenues, une fois que ce nombre est connu.

**Une catégorie peut être montrée à part, en gris, sous les étapes** : ce que nous n'avons pas pu lire chez
Meta, avec sa raison. Ces lignes ne comptent ni dans les étapes qu'il vous reste, ni dans le total des
réglages obligatoires, puisque personne ne sait où elles en sont. La plupart du temps il n'y en a aucune, et
c'est la situation normale.

Le nombre de messages, lui, compte tout le fil, entrants et sortants, y compris les envois de campagne et ce
que votre équipe a écrit après avoir repris la main : ce n'est donc pas une mesure de ce que l'agent a
lui-même produit, et ce n'est pas non plus le même périmètre que le « messages échangés » de l'Accueil et du
Performance Lab, qui eux écartent les modèles envoyés. Les conversations d'essai n'y entrent pas, et tant que
ce nombre n'est pas connu, rien ne s'affiche. Sur un numéro que Meta n'a pas encore ouvert, ni les étapes, ni
les lignes grises, ni ce nombre ne s'affichent : ils mèneraient vers un écran bloqué.

**Les paramètres, en douze onglets** : Vue d'ensemble (l'état de l'agent), Assistant (le régler en lui parlant),
Activation (qui parle au client), Business (les informations de votre entreprise), FAQ (question par
question, ou en masse depuis un fichier ou une adresse, avec aperçu avant écriture et sans jamais dupliquer
une question existante), Consignes (le ton, les procédures, les interdits, par exemple « ne jamais
inventer un horaire » ; l'onglet s'appelait « Compétences »), Messages interactifs (les boutons, listes, liens,
formulaires et carrousels que l'agent envoie lui-même quand la situation que vous décrivez se présente, en gardant
la conversation), Outils (ce que l'agent a le droit de faire : poser une étiquette, enregistrer une
information, envoyer un bloc, lancer un scénario, appeler un système que vous avez connecté), Fichiers
(jusqu'à 100 Mo de documents de connaissance), Sites web (les pages qu'il va lire), Historique et Tester (un
bac à sable où vous lui parlez sans consommer de conversation facturée).
Ce menu se range en colonne à gauche du contenu ; sur un téléphone, il redevient la barre horizontale du
haut.

**Un message interactif s'écrit avec un contenu fixe** : les libellés des boutons, les lignes d'une liste, les
cartes d'un carrousel sont écrits dans sa fiche. Évitez de le faire remplir par la réponse d'un outil : essayé sur
une liste remplie par les étiquettes d'un client, l'envoi a échoué à chaque fois, et l'agent a répondu « Je ne
peux pas vous aider avec cela », parfois aussi aux messages suivants de la même conversation. Pour une information
propre au client, laissez l'agent répondre en texte : sans message interactif, il cite très bien ce que l'outil
lui a rendu.

Deux situations bloquent l'édition, et l'écran les distingue parce qu'elles ne se règlent pas au même
endroit : **aucun numéro rattaché**, qui renvoie à l'Accueil, et **Meta n'a pas encore ouvert l'agent sur ce
numéro**, dont le bandeau dit l'éligibilité et porte un lien « Vérifier à nouveau ». Meta accepte tous les
secteurs SAUF la finance, le secteur public, la santé, l'alcool, les jeux d'argent, les médicaments sans
ordonnance et les services matrimoniaux ; il demande aussi un pays autorisé, un compte en règle, et qu'aucun
autre agent conversationnel ne tourne déjà sur ce numéro. Les conditions, elles, se signent dans WhatsApp
Manager : une fois signées, « Vérifier à nouveau » relit l'état du numéro.

**L'onglet Activation** porte les deux réglages qui décident qui parle au client. D'abord, ce que fait
l'agent quand le client demande un humain ou qu'il refuse de traiter la demande : il passe la main et la
conversation remonte dans « À traiter » ; ou seulement pendant vos heures d'ouverture, en dehors desquelles
il garde la conversation plutôt que d'annoncer un conseiller absent ; ou jamais. Ensuite, combien de temps
un humain garde la main après avoir répondu, le compte à rebours repartant à **chaque** réponse de l'équipe et à
chaque « Traité » (le délai court depuis le plus récent des deux) : marquer « Traité » ne rend pas la main. Passé
ce délai, un client qui écrit est confié tout de suite à l'agent, qui répond à ce message.

**Le message que lit le client quand l'agent passe la main** se choisit dans l'onglet « Vue d'ensemble » : rédigé par
l'agent, dans la langue du client ; votre propre texte ; ou le texte standard de Meta, qui est en anglais.

**Un plafond pour l'agent**, en bas de l'onglet Activation, sur 1, 7, 14 ou 30 jours glissants. Les deux unités
ne bornent pas la même chose. **En jetons**, c'est un plafond de dépense, partagé par tous les numéros WhatsApp
de votre Business Manager, y compris ceux d'un autre espace : l'écran nomme ce Business Manager. **En réponses
de l'agent**, c'est un plafond par conversation : il ne borne pas la dépense totale. Une estimation au prix
public de Meta accompagne le chiffre, et ce qui s'affiche est ce que Meta applique, relu chez lui. Meta ne donne
la consommation de l'agent par aucune API : sa facture fait foi.

**Dans Performance Lab, la Synthèse porte une carte « Agent de Meta »** sur les 30 derniers jours : les
conversations qu'il a tenues, celles qui attendent votre équipe en ce moment, les messages qu'il a écrits, un
coût estimé au prix public, et les outils qu'il a appelés, avec leur réussite et leur temps moyen.

Deux choses que cet écran ne promet pas, parce qu'elles ne sont pas tenables : empêcher un humain de
reprendre la main (aucun verrou n'existe, ni chez nous ni chez Meta), et empêcher l'agent de décider un
transfert. « Jamais » le fait seulement garder la conversation au lieu de la lâcher. Et quand il **ne sait
pas répondre**, il ne passe pas la main : il renvoie vers les coordonnées de votre base de connaissance.

**L'onglet Assistant** vous laisse décrire en français ce que vous voulez changer (« ajoute mes horaires du
samedi »). Il lit d'abord ce qui existe déjà, propose une ligne par modification, et **rien ne part chez
Meta tant que vous n'avez pas cliqué sur Appliquer**. Une suppression est signalée à part, en rouge, et il
n'en propose qu'une à la fois : Meta n'a ni corbeille ni annulation, donc une demande en lot obtient une
liste et une question, jamais une purge. Il ne retirera jamais l'agent du service et ne créera jamais de
connecteur, et tout ce qu'il fait reste faisable à la main dans les autres onglets. Il n'ajoute pas de
document : un document se dépose par l'onglet Fichiers.

**L'onglet Historique** existe pour la même raison : Meta n'a pas de corbeille. Une FAQ, une consigne, un message interactif ou
un document supprimé est perdu chez lui, et cette page en garde le seul exemplaire. « Voir le contenu
effacé » vous le rouvre. Le remettre le **recrée**, cela ne le ressuscite pas : vous recopiez le contenu et
obtenez un élément neuf. Rien n'y est purgé.

**Reprendre la main.** Dans l'Inbox, sur une conversation que l'agent de Meta tient, le bouton « Reprendre
la main » la lui prend réellement, sans qu'aucun message ne parte chez le contact : le contact sort de la liste
de l'agent, qui se tait pour lui jusqu'à ce qu'une conversation lui soit de nouveau confiée. Meta peut refuser,
et l'écran le dit alors au lieu de laisser croire que c'est fait.
Dans tous les cas, **écrire au contact prend le fil à coup sûr**.

**Pour repérer ces conversations dans la liste de l'Inbox** : un dégradé bleu vers violet et une baguette à
étincelles devant le nom. La liste ne porte aucune mention écrite du détenteur ; elle sert à repérer
l'exception, et le détenteur exact se lit dans l'en-tête de la conversation ouverte.
