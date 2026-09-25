---
ecran: accueil
source_section: Accueil (1re entrée du menu)
source_empreinte: 401cac
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

**Le bloc « Canaux et services »** rassemble une ligne par canal ou service (numéro WhatsApp, canal RCS, chaîne,
compte publicitaire, HubSpot), chacune avec son interrupteur, son état et le lien vers son écran. Rallumer ne
demande rien ; éteindre demande une confirmation qui dit ce qui s'arrête. Éteindre le numéro le **délie** de
l'espace : plus aucun envoi, les campagnes passent en pause et les messages reçus ne sont plus enregistrés, sans
rien toucher chez Meta, et il se relie d'un clic. Éteindre la chaîne oublie ses identifiants, mais les
publications déjà parues restent en ligne. Ces interrupteurs sont réservés aux administrateurs.
