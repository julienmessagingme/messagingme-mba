---
description: Brancher une boutique Shopify à WhatsApp : confirmation de commande, avis d'expédition, relance des paniers abandonnés. Le plus simple : Claude Code.
ecran: integrations
source_section: Boutique Shopify : les messages de commande sur WhatsApp (Claude Code ou console, 2026-10-21)
source_empreinte: 985b62
publique: oui
rubrique: parler-aux-clients
rang: 6
prerequis: connecter-mon-numero-whatsapp
claude_code: oui
bouton_claude: Brancher Shopify depuis Claude Code, gratuitement
bouton_console: Brancher Shopify dans la console
ancre_console: integration-shopify
---
# Brancher ma boutique Shopify

Vos clients Shopify reçoivent sur WhatsApp la **confirmation de leur commande payée**, l'**avis d'expédition** avec le
transporteur et le lien de suivi, et une **relance s'ils abandonnent leur panier**. Le plus simple : le demander à
**Claude Code**.

## Depuis Claude Code, avec l'offre Free

Installez le plugin Messaging Me dans Claude Code, puis demandez « branche ma boutique Shopify ». Claude crée l'app
dans votre propre organisation Shopify (aucune validation de Shopify n'est nécessaire) ; vous n'avez qu'à vous
connecter à Shopify et à cliquer « Installer ». Il vous propose ensuite le texte de chaque message, le fait approuver
par Meta, et le branche. Il importe aussi vos clients abonnés à votre marketing, si vous le lui demandez : en le
demandant, vous déclarez qu'ils ont accepté vos messages WhatsApp, et leurs fiches arrivent consentantes (un client qui
a dit STOP le reste).

Les autres règles décrites plus bas (la relance, STOP, la limite de contacts) sont les mêmes que depuis la console :
les deux chemins passent par la même gestion.

## Depuis la console, avec l'offre Pro

Sans Claude Code, la carte Shopify de la console vous guide de bout en bout, en sept gestes.

**1. Ouvrir la carte Shopify.** Dans le menu Tools > Intégrations, la carte Shopify dit ce
qu'elle fait et vous guide en deux étapes, la première chez Shopify, la seconde dans la console.

Elle n'apparaît qu'aux administrateurs de l'espace.

**2. Créer votre app chez Shopify.** Sur le tableau de bord développeur de Shopify, connecté avec le compte qui gère
votre boutique, créez l'app à la main (Create app manually) et collez l'adresse et les droits que la carte vous fait
copier d'un clic. Comptez cinq minutes.

Décochez « Embed app in Shopify admin », laissez le reste tel quel, puis Create app et Release. Installez-la ensuite
sur votre boutique : le message « This app hasn't been reviewed » est normal, c'est votre propre app. Dans ses
Settings, copiez enfin son Client ID et son Client secret.

**3. Brancher la boutique.** Revenez dans la carte, collez le nom de la boutique, le Client ID et le Client secret,
puis « Brancher la boutique ». La carte montre alors vos trois messages, chacun avec son état.

**4. Écrire le message.** Pour chaque message, « Mettre en place » ouvre un assistant. Il vous propose un texte, que
vous pouvez modifier : les données de la commande s'y écrivent entre accolades, comme {prénom} ou {lien du panier},
et un aperçu vous montre ce que le client recevra.

Chaque nouveau texte crée un nouveau modèle chez Meta : vous pouvez donc le retoucher autant que vous voulez. L'ancien,
s'il a été créé ici, est supprimé peu après l'approbation du nouveau. Les modèles créés par l'assistant (leur nom
commence par « shopify_ ») servent à la boutique : ne les réutilisez pas dans un scénario ou une campagne.

**5. Régler le délai, puis envoyer.** Pour la relance, choisissez le délai après le panier (1 h par défaut). Enfin,
« Envoyer à Meta et activer dès l'approbation ».

Le message s'active tout seul quand Meta l'approuve, en général en quelques minutes, et un e-mail vous prévient (ou
vous dit pourquoi Meta l'a refusé). Modifier un message actif ne l'arrête pas : l'ancien part jusqu'à l'approbation du
nouveau. Changer seulement le délai de la relance s'applique tout de suite, sans repasser par Meta.

**6. Importer vos clients.** « Importer » ouvre l'import des clients de la boutique abonnés à votre marketing (e-mail
ou SMS) qui ont un téléphone. Ils sont comptés d'abord, avec les places que votre offre laisse ; vous choisissez
combien en importer, les plus récents d'abord.

Les fiches sont étiquetées « Shopify » et arrivent sans consentement WhatsApp : un accord e-mail ou SMS n'en est pas un.

**7. Suivre, ou couper.** La carte montre la boutique branchée, l'état de chaque message, le dernier événement reçu et
les chiffres des 30 derniers jours : messages partis, clients écartés et pourquoi. « Couper » arrête tous les messages.

L'app reste alors installée sur votre boutique : désinstallez-la depuis la page des apps de la boutique, dont le lien
est sur la carte. Vous pourrez la rebrancher depuis la carte ou depuis Claude Code.

**Bon à savoir.** Chaque message de la boutique rend la fiche du client consentante partout, campagnes comprises ; un
client qui a répondu STOP le reste et ne reçoit rien.

## La relance des paniers abandonnés

Un client qui remplit le paiement avec son téléphone sans commander reçoit UNE relance sur WhatsApp, avec le lien qui
rouvre son panier, au délai que vous choisissez après sa dernière modification (de 15 min à 72 h). Rien ne part si une
commande en est née entre-temps, même non payée. C'est un message marketing : elle porte en bas la mention « Répondez
STOP pour ne plus recevoir ces messages ». La carte compte les relances parties, les paniers devenus une commande à
temps, et ceux en attente.

**Bon à savoir.** Le prénom est facultatif chez Shopify : beaucoup de clients ne le donnent pas, surtout avant
d'abandonner leur panier. Un message qui contient le prénom part quand même, avec « à vous » à sa place (« Bonjour à
vous » ; « there » pour un modèle en anglais). C'est pourquoi le texte proposé pour la relance commence simplement par
« Bonjour, ».

## Les règles des envois

Un client qui a répondu STOP ne reçoit rien, et les modèles du mois et la limite de contacts de votre offre comptent :
la fiche d'un nouveau client compte. Si cette limite est atteinte, les nouveaux clients ne reçoivent plus leurs
messages ; la carte les compte, et vous recevez un e-mail au premier refus du mois. Chaque message apparaît dans
Campagnes, une ligne par commande. Le message part même quand l'agent ou votre équipe tient la conversation, sans la
couper.

## Les demandes de vos clients

Une demande d'effacement d'un client transmise par Shopify efface sa fiche ; une demande d'accès vous est signalée par
e-mail, et c'est à vous de lui répondre. Une boutique branchée depuis la console ne nous transmet pas ces demandes :
quand Shopify vous en transmet une, supprimez vous-même la fiche du client dans Contacts.
