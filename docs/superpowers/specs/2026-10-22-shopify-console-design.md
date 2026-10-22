# Conception : brancher Shopify et régler ses messages depuis la console (clients payants)

Cadré avec Julien le 2026-10-22 (rondes de questions, parcours réel sur le tableau de bord développeur de Shopify,
deux maquettes validées). Suite du connecteur Shopify (`docs/superpowers/plans/2026-10-21-connecteur-shopify.md`,
lots 0 à 3, en production à `2bf50c54`).

## Pourquoi

Les clients Pro et Entreprise « sont ceux qui nous font vivre » (Julien). Aujourd'hui, brancher une boutique et régler
ses messages ne se fait QUE depuis Claude Code : la carte Shopify de la console dit « demandez-le à Claude Code », puis
montre l'état et « Couper ». Un client payant qui n'utilise pas Claude Code ne peut ni brancher sa boutique, ni mettre
en place la relance de panier. Il doit pouvoir faire les deux depuis la console, simplement.

Deux clients sont visés :

1. **Le client Free passé en Pro.** Sa boutique est déjà branchée par Claude Code (app créée par la CLI dans son
   organisation). Rien à rebrancher : il lui manque seulement le réglage des messages dans la console.
2. **Le client Pro ou Entreprise qui arrive directement**, sans passer par Free ni Claude Code. Il branche sa boutique
   par un mode opératoire court, puis règle ses messages.

## Objectifs

- La carte Shopify de la console (Paramètres > Intégrations > Shopify) porte un mode opératoire pour créer et installer
  l'app chez Shopify, puis un formulaire (boutique, identifiant, secret) qui branche la boutique.
- Un assistant en trois étapes règle chacun des trois messages : commande payée, commande expédiée, relance de panier
  abandonné.
- La carte porte l'import des clients abonnés (lot 3) : compter, puis importer le nombre choisi.
- Un seul fonctionnement derrière la console et derrière Claude Code : la console appelle la même gestion
  (`src/shopify/gestion.ts`) que les outils MCP.

## Hors périmètre

- **L'app publique Shopify** (App Store, autorisation OAuth, revue de Shopify) : plus tard, si le volume le justifie
  (décision de Julien).
- **Les webhooks RGPD pour les boutiques branchées par la console** : impossible sans la CLI (voir Contraintes). Le
  marchand efface à la main (décision de Julien).
- **L'offre Free** : elle n'a pas de console, elle garde Claude Code.
- Une deuxième relance, une case de consentement WhatsApp au paiement, l'import en continu des clients.

## Ce qui serait un échec, même si tout marche

- Un marchand bloqué en plein mode opératoire sans savoir quoi faire : chaque refus dit le geste qui le règle (la
  gestion le fait déjà pour `connect_shopify`).
- Une relance de panier activée sans que le marchand ait affirmé le consentement de ses clients.
- Un modèle envoyé à Meta, refusé, et un marchand qui croit sa relance active.
- Un comportement différent selon qu'on passe par la console ou par Claude Code.
- Une boutique branchée par Claude Code (webhooks déclarés dans l'app) qui reçoit chaque événement en double parce que
  la console aurait aussi abonné les webhooks par l'API.

## Contraintes (mesurées le 2026-10-22)

- **Plus aucune app « personnalisée » ne se crée dans l'admin Shopify** depuis le 2026-01-01 : il reste le tableau de
  bord développeur (dev.shopify.com).
- **Le tableau de bord, sans CLI** (parcours fait avec Julien, app d'essai « Messaging Me essai sans CLI ») :
  - Apps > Create app > **Create app manually** ouvre UN formulaire : nom, version (facultative), adresse de l'app,
    case « Embed app in Shopify admin » (cochée par défaut, à décocher), adresses de redirection, droits (liste séparée
    par des virgules, reconnue par la liste à cocher de Shopify), version des webhooks (2026-10 par défaut).
  - **Create app** ouvre « Release version » ; **Release** publie la première version.
  - L'installation se fait par le menu « ⋯ » de la ligne de l'app > **Install app**, qui ouvre l'admin de la boutique
    dans un nouvel onglet ; le lien `https://admin.shopify.com/store/<boutique>/oauth/install?client_id=<identifiant>`
    y mène aussi. L'écran d'installation affiche « This app hasn't been reviewed » (normal : l'app est celle du
    marchand), les accès demandés, puis **Install**. Shopify ouvre ensuite l'adresse de l'app.
  - Settings montre l'identifiant (« Client ID ») en clair et le secret masqué, avec un bouton de copie.
  - **Aucun écran ne règle les webhooks**, ni ceux des commandes ni ceux du RGPD (création, version, Settings).
- **Le jeton `client_credentials`** marche pour cette app (même organisation que la boutique), comme pour celle de la
  CLI : la vérification et l'import des clients existants servent tels quels.
- **Ce jeton abonne les webhooks par l'API** (`webhookSubscriptionCreate`, abonnement propre à la boutique) et les
  supprime. Mesuré sur la boutique de dev pour les SIX sujets du connecteur, ceux des commandes et des paniers compris :
  tous abonnés ; un sujet rejoué est refusé (« Address for this topic has already been taken »), donc l'abonnement est
  idempotent de lui-même, ce refus valant succès. Les webhooks RGPD, eux, ne s'abonnent pas par l'API (doc de
  Shopify) : une boutique branchée par la console ne nous transmet pas les demandes d'effacement.
- **Les abonnements déclarés dans l'app par la CLI ne se voient pas** dans la liste des abonnements de la boutique
  (mesuré : liste vide pour l'app de la CLI, qui en a six). On ne peut donc pas détecter par l'API qu'une boutique
  reçoit déjà ses webhooks.
- **Un modèle se crée déjà depuis la console et depuis Claude Code** (`src/api/creer-modele.ts`), et Meta nous
  transmet son changement de statut (`src/webhooks/statuts-modeles.ts`, champ `message_template_status_update`, si
  l'app Meta y est abonnée).

## Ce qui est décidé (par Julien)

- **Pas d'app publique pour l'instant** : un mode opératoire court dans la console, le marchand crée l'app dans son
  organisation, puis colle ses clés.
- **La carte de la console**, dans ses deux états (maquette validée) :
  - **sans boutique** : « Étape 1, chez Shopify » (les gestes ci-dessus, chacun avec sa capture, un bouton « Copier »
    pour l'adresse de l'app et pour les droits) ; « Étape 2, ici » (boutique, Client ID, Client secret, « Brancher la
    boutique ») ; en bas, un renvoi vers Claude Code pour qui l'utilise ;
  - **avec une boutique** : la boutique et son dernier événement ; les trois messages, chacun avec son état (actif,
    en validation chez Meta, pas encore réglé) et un bouton (« Modifier », « Voir », « Mettre en place ») qui ouvre
    l'assistant ; une ligne « Importer les clients abonnés à votre marketing » ; les chiffres des paniers sur 7 jours
    et « Couper la boutique ».
- **L'assistant en trois étapes** (maquette validée), une étape à l'écran à la fois :
  1. **Le message** : un texte proposé, modifiable, où les données Shopify (prénom, lien du panier...) apparaissent en
     bleu ; la langue ; pour la relance, la mention « Répondez STOP pour ne plus recevoir ces messages » ajoutée
     d'office en pied du message (voir « Après la relecture du constructeur ») ;
  2. **Le délai** (relance seulement) : 15 min, 1 h (conseillé, par défaut), 3 h, 24 h, ou autre jusqu'à 72 h, compté
     après la dernière modification du panier ;
  3. **Le consentement** : la case « J'affirme que mes clients ont accepté... », obligatoire pour la relance,
     facultative pour les messages de commande ;
  puis **« Envoyer à Meta et activer dès l'approbation »**. Un aperçu WhatsApp montre le message avec des valeurs
  d'exemple. Après l'envoi, la carte suit l'état (envoyé à Meta, en validation, actif) ; l'activation se fait seule à
  l'approbation, et un e-mail prévient quand c'est actif, ou si Meta refuse (avec la raison et un bouton pour reprendre
  le texte).
- **Le même assistant pour les trois messages** ; les messages de commande n'ont pas l'étape du délai.
- **RGPD** : une boutique branchée par la console ne reçoit pas les demandes d'effacement ; le mode opératoire et l'aide
  disent au marchand d'effacer lui-même la fiche dans Messaging Me quand Shopify lui transmet une demande.
- L'éléphant d'abord ; la documentation, l'aide et le site ensuite (un second cadrage).

## Mes choix (à relire)

- **L'adresse de l'app pour ce parcours** est une variante de la page de la vitrine, `/shopify/console/` (et
  `/en/shopify/console/`), qui dit « revenez dans votre console Messaging Me » ; `/shopify/installe/` reste celle de
  Claude Code. Même gabarit, même `noindex`.
- **Seul le branchement par la console abonne les webhooks par l'API**, à la connexion et de façon idempotente (lire
  les abonnements de la boutique, créer ceux qui manquent, vers `https://api.messagingme.app/shopify/webhooks`) : les
  sujets de `shopify.app.toml` moins les sujets RGPD (`orders/create`, `orders/paid`, `fulfillments/create`,
  `checkouts/create`, `checkouts/update`, `app/uninstalled`). `connect_shopify` (Claude Code, app de la CLI) n'abonne
  rien : ses webhooks sont dans l'app, et les doubler ferait tout recevoir deux fois. La gestion reçoit donc l'origine
  du branchement (`console` ou `claude_code`) et la garde sur la boutique, pour savoir aussi quoi dire du RGPD.
- **« Couper » ne supprime pas les abonnements** : une boutique coupée ignore déjà tout sujet hors RGPD, et la
  rebrancher n'a rien à recréer. Désinstaller l'app chez Shopify les supprime.
- **Les routes de la console sont réservées aux admins**, comptent dans le plafond des opérations coûteuses comme
  `connect_shopify`, et laissent une entrée au journal d'audit (qui a branché, qui a affirmé le consentement).
- **L'activation à l'approbation** s'appuie sur le changement de statut que Meta transmet ; comme l'app Meta peut ne pas
  y être abonnée, une relecture périodique des modèles en attente sert de filet. Le branchement en attente garde le
  modèle, ses variables, le délai et l'affirmation du consentement, et ne s'active qu'à l'approbation.
- **Les textes proposés** (français et anglais), un par message, avec les données de `DONNEES_PAR_EVENEMENT` :
  - commande payée (service) : « Bonjour {prénom}, merci pour votre commande {numéro} de {montant}. Suivez-la ici :
    {lien de la commande} » ;
  - commande expédiée (service) : « Bonjour {prénom}, votre commande {numéro} est en route avec {transporteur}. Suivez
    votre colis : {lien de suivi} » ;
  - relance de panier (marketing) : « Bonjour {prénom}, vous avez laissé des articles dans votre panier. Il vous
    attend ici : {lien du panier} ».
- **L'import des clients** dans la carte : « Importer » ouvre l'aperçu (abonnés, déjà là, nouveaux, places libres,
  importables) puis un nombre à choisir, plafonné aux places libres ; mêmes fonctions que les outils du lot 3.

## Après la relecture du constructeur (mes choix, à relire)

- **Le consentement reste UN par boutique**, comme aujourd'hui (`shopify_boutiques.consentement_le`, décision 2 du
  connecteur : une fois affirmé, les fiches sont consentantes partout). La case de l'assistant EST cette affirmation :
  pré-cochée quand elle existe, avec qui et quand ; obligatoire pour la relance ; dans les messages de commande, la
  décocher la retire pour toute la boutique, après une confirmation qui dit que la relance de panier s'arrête alors.
  Aucune migration pour ça.
- **Pas de bouton STOP, une mention en pied du message de relance.** Un clic sur un bouton de réponse rapide ne
  désabonne pas (`processInbound` ne lit le STOP que dans un message texte, et c'est voulu), et un bouton de
  désabonnement pourrait faire reclasser un modèle de service en marketing. La relance porte donc, en pied, « Répondez
  STOP pour ne plus recevoir ces messages » : une RÉPONSE texte « STOP » désabonne déjà. Les messages de commande n'ont
  rien de tel. La maquette validée montrait un bouton : c'est la seule différence avec elle.
- **Claude Code ne change pas dans ce lot.** `set_shopify_message` garde son fonctionnement (un modèle déjà approuvé,
  que la skill attend dans la session) ; les règles d'envoi, de catégorie et de consentement sont les mêmes des deux
  côtés, seule l'attente de l'approbation diffère. Règle de priorité : le DERNIER geste gagne. Un branchement direct
  (outil MCP) efface l'attente du même événement ; une nouvelle attente remplace la précédente.
- **Modifier un message actif ne l'arrête pas.** L'ancien continue de partir pendant la validation du nouveau ; à
  l'approbation, le nouveau le remplace ; au refus de Meta, l'ancien reste et l'e-mail le dit. La carte montre « actif,
  nouvelle version en validation ». Changer seulement le délai ou la case s'applique tout de suite, sans repasser par
  Meta (le texte n'a pas changé).
- **La page `/shopify/console/` fait partie de ce lot**, et elle part AVANT la carte : c'est l'adresse que le mode
  opératoire fait copier, et Shopify l'ouvre après « Install ». Variante de la page « C'est installé » déjà publiée
  (même gabarit, `noindex`, hors du plan du site, jumelle anglaise générée).
- **Une boutique branchée par la console et désinstallée perd son branchement** à `app/uninstalled` (secret,
  messages, paniers), puisque `shop/redact` ne viendra jamais pour elle : le secret ne servait plus qu'à vérifier ce
  sujet. Les fiches restent au mini-CRM, comme après `shop/redact`. Une boutique branchée par Claude Code garde le
  fonctionnement actuel (coupée, puis effacée par `shop/redact`).
- **La mesure sur une boutique en PRODUCTION** (décision 13, toujours ouverte) reste l'essai qui précède l'ouverture du
  parcours aux clients : si le téléphone n'arrive pas sans déclarer l'accès aux données client protégées, le mode
  opératoire gagne cette étape. Les six abonnements, eux, sont mesurés (boutique de dev).

## Ce qui reste au constructeur

- Les routes de la console et leur forme (branchement, assistant, import), les composants de la carte et de
  l'assistant, et le texte exact du mode opératoire avec ses captures (prises sur l'app d'essai « Messaging Me essai
  sans CLI », installée sur la boutique de dev, à supprimer ensuite).
- La forme du branchement en attente d'approbation, et la cadence de son filet.
- L'e-mail « relance active » / « modèle refusé » (catalogue des e-mails produit).
- Les tests, dont : une connexion par la console abonne les six sujets une fois, même rejouée ; une connexion par
  Claude Code n'en abonne aucun ; une relance ne s'active jamais sans consentement affirmé ni avant l'approbation de
  Meta ; un refus de Meta laisse le message inactif et prévient.

## Essai réel qui clôt la feature

Sur la boutique de dev, en Pro, depuis la console seule : Julien suit le mode opératoire avec une nouvelle app (ou
l'app d'essai déjà installée), colle ses clés, voit la boutique branchée ; met en place la relance de panier avec le
texte proposé et le délai de 15 min ; voit « en validation » puis « actif » sans autre geste ; un panier laissé avec
son téléphone reçoit la relance. Puis, dans un espace passé de Free à Pro avec une boutique branchée par Claude Code :
la carte montre la boutique et règle un message, sans aucun événement reçu en double.
