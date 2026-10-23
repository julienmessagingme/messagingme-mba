---
ecran: parametres
source_section: Boutique Shopify : les messages de commande sur WhatsApp (Claude Code ou console, 2026-10-21)
source_empreinte: 133fdb
---
# Brancher ma boutique Shopify

Vos clients Shopify peuvent recevoir sur WhatsApp la **confirmation de leur commande payée** et l'**avis
d'expédition**, avec le transporteur et le lien de suivi, et une **relance s'ils abandonnent leur panier**.

**Depuis la console** (offres Pro et Entreprise), la carte Shopify de Paramètres vous guide en deux étapes :

1. **Chez Shopify, cinq minutes** : sur le tableau de bord développeur de Shopify, créez l'app à la main (Create app
   manually), collez l'adresse et les droits que la carte vous fait copier, décochez « Embed app in Shopify admin »,
   puis Create app et Release. Installez-la sur votre boutique (le message « This app hasn't been reviewed » est
   normal : c'est votre propre app), puis copiez son Client ID et son Client secret dans Settings.
2. **Ici** : collez le nom de la boutique, le Client ID et le Client secret, puis « Brancher la boutique ».

Pour chaque message, **« Mettre en place »** ouvre un assistant : le texte proposé, que vous pouvez modifier (les données
de la commande s'écrivent `{prénom}`, `{lien du panier}`... et un aperçu montre ce que le client recevra), le délai
pour la relance, puis votre affirmation du consentement. **« Envoyer à Meta et activer dès l'approbation »** : le
message s'active tout seul quand Meta l'approuve, en général en quelques minutes, et un e-mail vous prévient (ou vous
dit pourquoi Meta l'a refusé). Modifier un message actif ne l'arrête pas : l'ancien part jusqu'à l'approbation du
nouveau. Chaque nouveau texte crée un nouveau modèle chez Meta, que vous pouvez donc retoucher autant que vous voulez ;
l'ancien, s'il a été créé ici, est supprimé peu après l'approbation du nouveau. Changer seulement le délai ou la case
s'applique tout de suite, sans repasser par Meta. Les modèles créés par l'assistant (leur nom commence par
« shopify_ ») servent à la boutique : ne les réutilisez pas dans un scénario ou une campagne.

**Depuis Claude Code**, avec le plugin Messaging Me (toutes les offres, Free comprise) : demandez « branche ma boutique
Shopify ». Claude crée l'app dans votre propre organisation Shopify (aucune validation de Shopify n'est nécessaire) ;
vous n'avez qu'à vous connecter à Shopify et à cliquer « Installer ». Il vous propose ensuite le texte de chaque
message, le fait approuver par Meta, et le branche.

**Les règles des envois s'appliquent** : un client qui a répondu STOP ne reçoit rien, les modèles du mois et la limite
de contacts de votre offre comptent (la fiche d'un nouveau client compte). Chaque message apparaît dans Campagnes, une
ligne par commande. Le message part même quand l'agent ou votre équipe tient la conversation, sans la couper.

**Le consentement** : Shopify ne recueille aucun accord pour WhatsApp. Si vos clients ont accepté vos messages, vous
pouvez l'affirmer à Claude : leurs fiches deviennent consentantes partout, campagnes comprises, sous votre
responsabilité, et l'affirmation est gardée (qui, quand). Elle vaut pour toute la boutique : la retirer met la relance des
paniers en pause.

**Dans Paramètres, la carte Shopify** montre la boutique branchée, ses messages, le dernier événement reçu et les
chiffres des 30 derniers jours (messages partis, clients écartés et pourquoi). Si la limite de contacts de votre offre
est atteinte, les nouveaux clients ne reçoivent plus leurs messages : la carte les compte, et vous recevez un e-mail au
premier refus du mois. **« Couper »** arrête tous les messages ; l'app reste installée sur votre boutique, désinstallez-la
depuis la page des apps de la boutique (le lien est sur la carte). Vous pourrez la rebrancher depuis la carte ou depuis
Claude Code.

Une demande d'effacement d'un client transmise par Shopify efface sa fiche ; une demande d'accès vous est signalée par
e-mail, et c'est à vous de lui répondre. **Une boutique branchée depuis la console ne nous transmet pas ces demandes** :
quand Shopify vous en transmet une, supprimez vous-même la fiche du client dans Contacts.

**La relance des paniers abandonnés** : un client qui remplit le paiement avec son téléphone sans commander reçoit UNE
relance sur WhatsApp, avec le lien qui rouvre son panier, au délai que vous choisissez après sa dernière modification
(1 h par défaut, de 15 min à 72 h). Rien ne part si une commande en est née entre-temps, même non payée. C'est un
message marketing : elle ne s'active qu'une fois que vous avez affirmé le consentement de vos clients, et elle porte en bas
la mention « Répondez STOP pour ne plus recevoir ces messages ». La carte
Shopify compte les relances parties, les paniers devenus une commande à temps, et ceux en attente.

**Le prénom est facultatif chez Shopify** : beaucoup de clients ne le donnent pas, surtout avant d'abandonner leur panier.
Un message qui contient le prénom part quand même, avec « à vous » à sa place (« Bonjour à vous » ; « there » pour un
modèle en anglais). C'est pourquoi le texte
proposé pour la relance commence simplement par « Bonjour, ».

**Importer vos clients** : « Importer » sur la carte, ou demandez-le à Claude. Seuls ceux qui ont accepté votre marketing
(e-mail ou SMS) et ont un téléphone sont concernés. Ils sont comptés d'abord, avec les places que votre offre
laisse ; vous choisissez combien en importer, les plus récents d'abord. Les fiches sont étiquetées « Shopify » et
arrivent sans consentement WhatsApp : un accord e-mail ou SMS n'en est pas un.
