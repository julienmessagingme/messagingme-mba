# Shopify sur la vitrine : la page « Boutiques Shopify », l'aide publique, les intégrations et le film

**Conception du 2026-10-23**, cadrée avec Julien en six rondes de questions. Elle fait suite au connecteur Shopify, qui est en
production (Claude Code et console, `features.md` § « Boutique Shopify »), et à l'essai réel 149 réussi le même jour.
Ce qui est marqué *(choix de Claude)* n'a pas été tranché par Julien : c'est à relire en priorité.

> **Statut : EN ATTENTE du chantier produit « Shopify sur un numéro relié par QR code »** (décision de Julien du
> 2026-10-23, « le produit d'abord »). La page vendra « 0 €, sans compte Meta Business » : les trois messages Shopify
> partiront aussi d'un numéro de la filière application, en texte simple. Elle ne se construit qu'une fois ce produit
> livré et éprouvé ; les passages marqués **[produit]** se relisent alors à sa lumière (plafond d'envoi, prix, risque).

## 1. Intention

Shopify est aujourd'hui invisible sur le site. Seules les deux pages techniques de retour d'installation le nomment
(`site/shopify/installe/`, `site/shopify/console/`, en noindex), et la fiche d'aide reste dans la console. Le but est de
**vendre le connecteur aux marchands Shopify**, et de montrer partout qu'on se branche à leur boutique.

**L'accroche est le prix, et l'histoire est le panier abandonné** (Julien : « pour 0 €, ils règlent leur problème de
paniers abandonnés, et si le client répond, c'est l'agent IA qui prend la main »). Toute la page raconte ce scénario :

1. un client abandonne son panier ;
2. il reçoit la relance sur WhatsApp ;
3. il répond, avec une question (frais de port, taille, délai) ;
4. l'agent IA lui répond avec le contenu de la boutique ;
5. il commande, et la confirmation arrive sur WhatsApp, puis l'avis d'expédition avec le suivi.

Face à l'app WhatsApp gratuite de Meta sur l'App Store Shopify, notre différence est que **la conversation continue** :
quand le client répond, quelqu'un lui répond.

## 2. Décisions de Julien (2026-10-23)

| Sujet | Décision |
|---|---|
| Cible de la page | les **marchands** Shopify |
| Nom et place | « **Boutiques Shopify** », une page de la rubrique **Solutions**, à côté des cinq secteurs |
| Accroche | **le prix : 0 € par Claude Code**. Le produit ne change pas : la console reste en Pro |
| Histoire principale | le **scénario du panier abandonné** (§ 1), sur la page et dans le film |
| Boutons | **deux portes** : « Brancher gratuitement avec Claude Code » (principal, vers le plugin) et « Tout faire depuis la console » (vers l'inscription et le Pro) ; « Nous contacter » en bas de page |
| Rôle de la page | être **trouvée sur Google** et être **la page envoyée à un prospect** |
| Cas d'usage | ce qui marche aujourd'hui, plus les **combinaisons** avec nos briques : « Où est ma commande ? », la campagne aux clients, la pub Click-to-WhatsApp, la bulle WhatsApp sur la boutique |
| Branding | les quatre : **bandeau de logos sur l'accueil**, une **page Intégrations**, Shopify dans les **tarifs**, un **film** |
| Bandeau de l'accueil | une rangée de logos **après « Ils nous font confiance »**, qui mène à la page Intégrations |
| Page Intégrations | Shopify, **HubSpot, Salesforce, Claude Code, Codex**, logos **sans préciser d'offre ni d'état** |
| Aide | la fiche « Brancher ma boutique Shopify » devient **publique** (une page du site, en français et en anglais) |
| Film | le **parcours du client** (le scénario du § 1), pas le marchand dans la console |
| Partner Shopify | **non** : on n'écrit que des mentions de **compatibilité** |
| Numéro WhatsApp | la page vend le chemin **sans compte Meta Business** (numéro relié par QR code, filière application), une fois le chantier produit livré ; le chemin par l'API de Meta reste possible |
| Mesure sur une vraie boutique (décision 13) | **pas un préalable** : la page sort sur les essais en boutique de développement, la mesure se fait avec le premier marchand |
| Codex | la règle du 2026-10-15 (pas de Codex en public avant l'essai 121) est **levée** pour la page Intégrations |
| Ordre | 1. la page et l'aide ; 2. Intégrations, accueil, tarifs ; 3. le film, ajouté à la page quand il est prêt |
| Au todo | une **app publique sur l'App Store** Shopify, un **agent IA qui lit les commandes**, l'**essai de la bulle** sur un vrai thème |

## 3. Objectifs, non-objectifs, anti-objectifs

**Objectifs**
- Un marchand qui cherche « relance panier abandonné WhatsApp Shopify » trouve la page et comprend en une minute ce
  qu'il obtient, ce que ça coûte et comment commencer.
- Shopify est visible depuis l'accueil, la page Intégrations, les tarifs et le menu Solutions.
- Le pas à pas de la console est lisible avant de s'inscrire (fiche publique).

**Non-objectifs**
- Aucun changement du produit, ni des offres : la carte Shopify de la console reste en Pro, la Free reste sans console.
- Pas d'app sur l'App Store Shopify, pas d'outil de commande pour l'agent IA (todo).
- Pas de page « Cas d'usage » dédiée au panier abandonné (Julien a écarté cette option).

**Anti-objectifs** (ce qui ferait échouer le chantier même s'il est livré)
- Une promesse fausse : « tout gratuit » alors que Meta facture les messages et que l'agent consomme un crédit ; un
  agent IA qui « suit votre colis » ; une campagne promise aux clients importés.
- Une affiliation implicite avec Shopify : « partenaire », « officiel », « certifié », « intégration officielle », un
  badge « Works with Shopify », un nom d'offre « Messaging Me for Shopify », un logo Shopify en couleur.
- Une statistique sans source (le « 98 % d'ouverture » qui circule partout n'en a aucune).
- Le nom de l'infrastructure sous-jacente (règle de communication externe du `CLAUDE.md` global), un tiret cadratin ou
  demi-cadratin.

## 4. Ce que la page peut affirmer (établi dans le code, lu le 2026-10-23 sur `origin/main`)

- **Prix.** La Free coûte 0 € et le connecteur Shopify y marche **par Claude Code** (`src/mcp/outils-shopify.ts`,
  `fonction: null`). Elle est plafonnée à **100 contacts créés** (chaque nouveau client Shopify en crée un) et 1 000
  modèles par mois, et n'inclut pas de numéro (`src/offres/offres.ts`, `DROITS.base`). La **console** est en **Pro, 49 €
  HT par mois**, avec **14 jours d'essai**, carte demandée (`PRIX_PRO_HT_CENTIMES`, `ESSAI_PRO_JOURS`).
- **Meta facture les messages directement au marchand** ; Messaging Me n'y touche pas et le connecteur est sans
  supplément. Aucun montant par message ne s'écrit sans relire la grille de Meta du jour (`brain/MESSAGINGME.md`).
- **L'agent IA est ouvert à toutes les offres**, Free comprise (`src/mcp/outils-agent.ts`), et se construit depuis le site
  de la boutique (skill `mise-en-service` du plugin). Il **consomme un crédit IA prépayé**, rechargeable dès 5 € HT
  depuis Claude, facturé avec une commission de 100 % en Free (`features.md` § crédit IA). Donc : **« 0 €
  d'abonnement »**, jamais « gratuit » tout court.
- **La relance** part entre 15 minutes et 72 heures après l'abandon (1 h par défaut), **une fois par panier**, et rien ne
  part si le client a commandé entre-temps. Elle exige que le marchand ait affirmé le consentement de ses clients.
- **Qui répond** : le message Shopify ne change pas qui tient la conversation. Si l'agent IA est le répondeur de
  l'espace, c'est lui. Il répond **avec sa base de connaissance** (délais, transporteurs, retours, produits), il n'a
  **aucun accès aux commandes**, et sans réponse dans sa base il passe la main. En Free, l'équipe n'a pas l'Inbox : le
  marchand répond depuis Claude ou depuis l'application. Formule honnête pour « Où est ma commande ? » : l'agent répond
  sur la livraison d'après vos pages et passe la main pour un colis précis.
- **Campagne aux clients** : l'import ne prend que les abonnés au marketing (e-mail ou SMS) qui ont un téléphone, et les
  fiches arrivent **sans consentement WhatsApp** : une promo ne leur part pas. Un client devient consentant en recevant un
  message de commande ou une relance. Formule : « vos promos partent à ceux qui ont accepté WhatsApp ». Campagnes en Pro.
- **Pub Click-to-WhatsApp** : offre Entreprise, aucun lien avec le catalogue de la boutique.
- **Bulle WhatsApp** : une balise à coller dans le thème, que rien ne bloque côté serveur, **jamais essayée sur un thème
  Shopify**. Elle ne se promet qu'après l'essai réel du § 9.

## 5. La marque Shopify

Messaging Me n'est pas Partner. L'usage de la marque se limite à **signaler la compatibilité** (conditions de l'API
Shopify § 5, https://www.shopify.com/legal/api-terms ; règles de marque, https://www.shopify.com/brand-assets).
- Logo : **noir ou blanc** uniquement (jamais le sac vert), jamais le mot seul sans le sac, ni déformé ni ombré, **au
  moins 80 px de large** avec sa marge, de préférence un lien vers shopify.com. Les fichiers viennent du kit officiel de
  Shopify, aucun n'est dans le dépôt.
- Formulations admises : « se branche à votre boutique Shopify », « pour les marchands Shopify », « compatible avec
  Shopify ». Interdites : la liste des anti-objectifs (§ 3).
- L'adresse `/solutions/shopify/` et le titre descriptif « Boutiques Shopify » sous notre marque sont admis.
- Si on achète un jour des mots-clés Google contenant « Shopify », relire les règles de marque de Google Ads d'abord.

## 6. Les livrables

### Lot 1 : la page « Boutiques Shopify » et l'aide publique

**La page** `/solutions/shopify/` et sa jumelle `/en/solutions/shopify/`, dans le menu Solutions, au plan du site, avec
fil d'Ariane en JSON-LD. L'ordre des sections est une proposition *(choix de Claude)* ; ce qui compte est l'ordre du
récit : le problème, le scénario, le prix, comment commencer.

1. **La une** : surtitre « Boutiques Shopify » ; un titre en deux temps qui porte la relance et l'agent IA ; un chapeau qui
   dit 0 € d'abonnement par Claude Code ; les deux boutons ; le logo Shopify monochrome avec « se branche à votre
   boutique Shopify » ; le visuel d'un téléphone avec la relance et la réponse de l'agent. Proposition de titre, à
   retoucher librement : « Relancez vos paniers sur WhatsApp. Votre agent IA répond, le client commande. »
2. **Le problème** : 70 % des paniers sont abandonnés (Baymard, moyenne de 50 études,
   https://baymard.com/lists/cart-abandonment-rate, chiffre de la page du 2025-09-22), et l'e-mail de relance se perd.
3. **Le scénario** (§ 1) en cinq temps, avec les vraies règles de la relance (§ 4). Le film s'y placera au lot 3.
4. **Ce que vous branchez** : la commande payée, l'expédition avec le suivi, la relance, l'import des clients abonnés.
5. **Et ensuite** : les quatre combinaisons, chacune dans la formule honnête du § 4. Chaque carte qui sort de la Free
   porte une petite étiquette de son offre (« Pro », « Entreprise ») *(choix de Claude : la page vend 0 €, une carte
   sans étiquette laisserait croire que tout y est)*. La carte de la bulle n'apparaît qu'après l'essai réel du § 9.
6. **Commencer avec Claude Code, en quatre étapes** : installer le plugin, autoriser avec Google, **relier son numéro
   WhatsApp** (par QR code depuis l'application WhatsApp Business, sans compte Meta Business, ou par Meta), demander
   « branche ma boutique Shopify » (la skill `shopify` fait le reste). Le bouton principal y mène, puis vers
   l'installation du plugin.
7. **Le prix** : 0 € d'abonnement par Claude Code (Free : 100 contacts) ; la console complète en Pro, 49 € HT par mois,
   14 jours d'essai ; l'agent IA sur un crédit prépayé dès 5 € HT. **[produit]** Sur un numéro relié par QR code, pas de
   facturation de Meta au message, mais le plafond d'envoi du chantier produit ; sur l'API, Meta facture les messages ;
   un numéro que nous fournissons coûte 3,50 € HT par mois. Lien vers les tarifs.
8. **Questions fréquentes** *(choix de Claude, pour le référencement)* : quatre ou cinq questions qui reprennent les
   requêtes des marchands (combien coûte la relance, faut-il une app de l'App Store, qui répond quand le client répond,
   quel numéro WhatsApp, que devient le client qui dit STOP), en `FAQPage` JSON-LD. La réponse « quel numéro » porte la
   phrase de risque de la filière application (ce n'est pas l'API officielle, WhatsApp peut couper un numéro), comme
   l'exige sa conception du 2026-10-22, et ce qu'il faut sinon (un compte Meta Business, Claude Code avec un compte
   Claude) *(choix de Claude)*.
9. **L'appel final** : les deux boutons, et « Nous contacter » (`/contact/#formulaire`).

Aucun client cité, aucune référence ni chiffre de terrain : nous n'avons pas de client Shopify citable *(choix de
Claude)*. Pas de capture d'écran de l'admin Shopify sur cette page *(choix de Claude)*.

**La fiche d'aide publique** `docs/aide/fiches/brancher-ma-boutique-shopify.md` (le chemin de la console, offre Pro) :
- `publique: oui` ;
- réécrite à la grammaire des fiches publiques (étapes `**N. Titre.**`, pas d'accents graves) ;
- sa version anglaise dans `docs/aide/fiches/en/` ;
- ses captures de la carte et de l'assistant de la console par le banc `aide:captures` ;
- la page de la vitrine liée depuis la page Boutiques Shopify (« le pas à pas de la console »).

Rubrique *(choix de Claude)* : « parler aux clients », sauf si le constructeur juge qu'il faut une rubrique « brancher
vos outils ». Pour les écrans de Shopify (Dev Dashboard), pas de capture *(choix de Claude)* : leur interface change
sans prévenir, le texte suffit.

**Une correction** : `features.md` § « Boutique Shopify » annonce « deux messages » alors qu'il y en a trois. La fiche
d'aide porte l'empreinte de cette section : fiche et empreinte changent dans le même commit.

### Lot 2 : la page Intégrations, l'accueil, les tarifs

- **La page** `/integrations/` et `/en/integrations/` : Shopify, HubSpot, Salesforce, Claude Code, Codex, un logo et une
  ligne chacun, **sans offre ni état** (décision de Julien). Shopify mène à `/solutions/shopify/`, Claude Code et Codex à
  `/developpeurs/`. Une dernière case « vos autres outils » (connecteurs API, MCP, API publique) *(choix de Claude)*.
  Elle entre au menu **Ressources** *(choix de Claude)*, au plan du site et dans `llms.txt`.
- **L'accueil** : une rangée de logos après « Ils nous font confiance », dans le style des tuiles clients, titre du type
  « Se branche à vos outils », qui mène à `/integrations/`. Les tuiles « Synchronisé vers vos outils » de la une
  restent telles quelles *(choix de Claude)*.
- **Les tarifs** : Shopify dans la liste de la Free, comme fonction ouverte par Claude Code (relance de panier et messages
  de commande), et la console Shopify dans le Pro (héritée « tout ce que fait la Free, plus »). Shopify n'est pas une
  fonction d'offre du code : la ligne ne porte pas de `data-fonction`.

### Lot 3 : le film

Le scénario du § 1, du point de vue du client, sur un iPhone : la boutique, le panier laissé, la relance sur WhatsApp, la
question, la réponse de l'agent IA, la commande, la confirmation, puis l'avis d'expédition. Il se fabrique dans
`~/engageme-motion` (lire son `CLAUDE.md` : écrans calqués sur de vraies captures, chiffres seulement de Julien, formats
16:9 et 9:16, français et anglais, affiche webp). La boutique montrée est une boutique générique, pas l'admin de
Shopify. Il s'ajoute à la page (section 3, `VideoObject`) et sert d'image de partage.
⚠️ Les films des cas d'usage montrent une fenêtre Claude Code (règle mémorisée le 2026-10-15) : celui-ci s'en écarte
**par décision de Julien du 2026-10-23**, parce que la page vise les marchands.

### Au todo (Julien, 2026-10-23)

- Une **app publique sur l'App Store** Shopify : l'installation en un clic, contre les cinq minutes du Dev Dashboard. C'est
  le vrai levier face à l'app de Meta et à Kanal, et un gros chantier (revue de Shopify, RGPD, facturation).
- Un **outil de lecture des commandes pour l'agent IA**, pour répondre vraiment à « où est mon colis ? ».
- L'**essai de la bulle sur un thème Shopify**, s'il n'est pas fait au lot 1.

## 7. Contraintes de fabrication

- La vitrine se génère. L'en-tête, le pied et les pages anglaises ne se retouchent pas dans les pages
  (`npm run vitrine:entete`, `npm run vitrine:anglais`) ; les pages Solutions sortent de `npm run vitrine:cas` et de
  `scripts/vitrine/secteurs-textes.ts` ; les fiches publiques de `npm run vitrine:aide`, puis `npm run aide:charger` en
  production après le push. Les tests `vitrine-*`, `registre-vitrine`, `aide-*` refusent une page qui diffère de sa
  génération.
- Le modèle des pages Solutions ne colle pas tel quel : ses boutons mènent tous au formulaire de contact, il exige des
  références clients, un cas de terrain et un film. Ici : deux boutons vers le plugin et la console, pas de référence,
  pas de film avant le lot 3. **Le constructeur choisit** entre rendre ces champs optionnels dans le modèle secteur ou
  créer une troisième nature de page.
- Une image ou un film remplacé sous le même nom prend un `?v=` incrémenté (cache d'un jour chez le visiteur).
- Copie : chaque phrase porte le positionnement ou une action ; pas de détail d'infrastructure, pas de réassurance
  technique (« API officielle de Meta » ne nous distingue pas, l'app de Meta l'a aussi) ; pas de promesse d'hébergement
  dans l'Union européenne avant la bascule vers Scaleway ; vouvoiement ; jamais de tiret cadratin ni demi-cadratin.
- **Une page neuve de la face publique attend le oui explicite de Julien** sur son rendu, en bureau et en téléphone,
  avant le push.
- Un push qui touche `site/` lance la CI racine : ne pas pousser pendant la CI d'un pair.

## 8. Ce qui est laissé au constructeur

La rédaction finale (dans le cadre des §§ 3 à 5), la mise en page, l'icône du menu (`i-cart` existe), le visuel de la une
en attendant le film, la forme du modèle de page (§ 7), le libellé exact des boutons, l'adresse exacte du bouton console
(la Free arrive sur l'accueil, qui propose déjà le passage en Pro par `/offre?fonction=console`).

## 9. Les essais réels qui closent

- **Lot 1** (décision de Julien : **dans un espace Free, par Claude Code**, le chemin que la page vend) :
  - le scénario complet sur la boutique de test (Messaging Me Essai), avec un **numéro relié par QR code** : un panier
    abandonné, la relance reçue, une **réponse du client à la relance**, la **réponse de l'agent IA** avec le contenu de
    la boutique, puis une commande, sa confirmation et son **avis d'expédition**. Il solde aussi les essais 144 et 145
    (chemin Claude Code). Tant que ce chemin n'a pas tourné de bout en bout, la page ne l'affirme pas ;
  - la **bulle posée sur le thème** de la boutique de test, visible et cliquable sur un téléphone ;
  - Julien relit la page et la fiche publique en ligne, en français et en anglais, sur ordinateur et sur téléphone.
- **Lot 2** : les logos s'affichent et mènent où il faut, depuis l'accueil, la page Intégrations et les tarifs.
- **Lot 3** : le film se lit sur la page, en 16:9 sur ordinateur et en 9:16 sur téléphone, dans les deux langues.

La recherche sur la concurrence et les requêtes des marchands (app WhatsApp de Meta, Kanal, Zoko, Wati...) est rangée
dans `docs/prive/MARCHE-SHOPIFY-2026-10-23.md`, hors du dépôt public.
