---
ecran: accueil
source_section: Accueil (1re entrée du menu)
source_empreinte: c0ff52
---
# Connecter mon numéro WhatsApp, et lire son état

L'Accueil est l'écran sur lequel vous arrivez en vous connectant, et celui que le logo ramène. Il porte une
seule chose : l'état de votre compte WhatsApp.

**Connecter un numéro.** Tant qu'aucun numéro n'est rattaché, un bouton ouvre la fenêtre de Meta. Vous y
choisissez votre compte professionnel et votre numéro, et tout le reste se fait sans vous. Si vous aviez
déjà commencé une première fois, recommencer fonctionne : vous n'avez rien à ressaisir et aucun nouveau code
à redemander, vous retrouvez le compte et le numéro existants. Quand Meta refuse, c'est SON motif qui
s'affiche (code expiré, compte non partagé, plusieurs numéros à départager), pas un message d'erreur opaque.

**Un espace pilote un seul numéro.** En connecter un second est refusé, en vous disant lequel est déjà là et
quoi faire : créer un second espace, ou détacher celui-ci. Accepter les deux mélangerait les conversations
d'une même personne.

**Un numéro rattaché mais pas vérifié.** Il arrive que Meta laisse terminer l'inscription sans vérifier le
numéro : il est bien à vous, mais il ne peut pas encore envoyer. La carte du numéro le dit et porte le
bouton qui règle ça : Meta vous envoie un code (par appel, ou par SMS si vous le préférez), vous le saisissez,
et le numéro est enregistré dans la foulée. Meta ne tolère que dix demandes par numéro sur 72 heures, toutes
étapes confondues, et bloque le numéro au-delà : l'écran refuse donc un second code avant une minute et ne
réessaie jamais tout seul.

**Ce que la carte du numéro affiche** : votre photo de profil WhatsApp, celle que voient vos destinataires
(rien ne s'affiche tant que vous n'en avez pas posé, c'est le cas ordinaire au début), le statut du compte
en pastille de couleur, la qualité du numéro, votre nom d'affichage et le nombre de clients à qui vous
pouvez écrire par tranche de 24 heures (« Pas encore évalué par Meta » tant que Meta n'a pas tranché). Quand
un état ne peut pas être lu, l'écran écrit « Statut indisponible » avec un bouton Réessayer, plutôt qu'un
vert rassurant.

Juste en dessous, un panneau **Compte WhatsApp Business** reprend la revue du compte par Meta, la
vérification de votre entreprise et le business propriétaire, chacun avec sa pastille. Votre moyen de
paiement n'est pas lisible depuis ici : l'écran vous renvoie au Business Manager de Meta au lieu d'afficher
une valeur inventée.

**Quatre chiffres sur 30 jours** ouvrent la page (contacts, messages échangés, modèles envoyés, coût estimé).
Ce sont exactement ceux du Performance Lab, et un tiret remplace le coût quand Meta ne donne aucun tarif.

**HubSpot**, s'il est relié, a son propre bloc : le portail, l'état de la synchronisation et un lien vers le
guide de configuration. La couper vous fait choisir entre une **pause**, réversible (les analyses produites
pendant la pause sont renvoyées à la reprise), et une **déconnexion complète**, qui délie le compte HubSpot
et coupe tous les numéros de l'espace. Un interrupteur juste dessous autorise l'usage de vos listes HubSpot
comme destinataires de campagne.

**Le bloc HubSpot s'allume dans Paramètres > Intégrations**, et c'est là qu'on le demande, numéro WhatsApp ou
pas : un espace tout neuf peut donc connecter HubSpot avant d'avoir un numéro. Éteint, l'Accueil n'affiche
qu'une ligne qui vous y renvoie. Tant qu'un portail est relié, il ne s'éteint pas : faites d'abord la
déconnexion complète depuis le bloc HubSpot (sans numéro, c'est un bouton du bloc, sans l'option de pause).

**Le bloc « Canaux et services »** rassemble une carte par canal ou service (numéro WhatsApp, canal RCS, chaîne,
compte publicitaire, HubSpot), chacune avec son logo, son interrupteur et une pastille d'état ; les cartes Chaîne,
Compte publicitaire et HubSpot portent aussi le lien vers leur écran (le détail du numéro et du canal RCS est plus
bas sur l'Accueil). Les cartes WhatsApp et RCS montrent les messages envoyés et reçus ces 30 derniers jours, envois
de campagne compris ; celle du numéro compte tout le canal WhatsApp de l'espace. La carte Chaîne montre le nombre de
publications. La pastille du numéro est verte quand il est relié, ambre quand Meta signale un problème sur le compte
(la même alerte que la carte du numéro, plus bas). Rallumer ne demande rien ; éteindre demande une confirmation qui
dit ce qui s'arrête. Éteindre le numéro le **délie** de l'espace : plus aucun message WhatsApp ne part, les campagnes
qui ont un étage WhatsApp (repli compris) passent en pause, un scénario s'arrête à son premier envoi WhatsApp, et
les messages reçus ne sont plus enregistrés ; les campagnes uniquement RCS et les scénarios sans WhatsApp (e-mail ou
RCS seuls) continuent. Le numéro se relie d'un clic. Rien ne change chez Meta : si l'agent de Meta est allumé, il
continue de répondre à vos clients. Éteindre la chaîne oublie ses identifiants, mais les publications déjà parues
restent en ligne. Ces interrupteurs sont réservés aux administrateurs.
