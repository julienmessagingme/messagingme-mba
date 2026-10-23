# Écrire en premier sur un numéro relié par QR code, et Shopify dessus

**Conception du 2026-10-23**, cadrée avec Julien en plusieurs rondes de questions, à la suite de la conception de la
vitrine Shopify (`2026-10-23-vitrine-shopify-design.md`), qui attend ce chantier. Ce qui est marqué *(choix de Claude)*
n'a pas été tranché par Julien : c'est à relire en priorité.

## 1. Intention

La filière application (conception du 2026-10-22, `features.md` § « Relier l'application WhatsApp Business depuis
Claude ») relie un numéro de l'application WhatsApp Business par QR code, sans compte Meta Business. Elle sait recevoir
et répondre, pas encore **écrire en premier**. Julien : « on a développé la capacité de relier un numéro WhatsApp
Business app (non API) à Claude Code pour automatiser, donc il faut qu'on puisse aussi le faire pour Shopify, c'est le
but ».

Le chantier donne donc à cette filière la capacité d'**écrire en premier**, pour tous (Claude, l'API) et d'abord pour
**Shopify** : la relance de panier abandonné, la confirmation de commande payée et l'avis d'expédition partent d'un
numéro relié par QR code, en **texte simple**. Quand le client répond, l'agent IA prend la main, comme aujourd'hui.

C'est ce qui rend vraie la promesse de la page Shopify : **0 €, sans compte Meta Business**, depuis Claude Code.

## 2. Décisions de Julien (2026-10-23)

| Sujet | Décision |
|---|---|
| Ce qui part d'un numéro QR code | **les trois messages Shopify** : relance, confirmation, expédition |
| Portée d'« écrire en premier » | **pour tout** (Claude, l'API), **Shopify d'abord** |
| Limites | **celles de la Free, rien d'autre** : **1 000 messages par mois** (à l'initiative de l'entreprise) et **100 contacts créés**, les limites déjà affichées sur les tarifs. Les messages Shopify en texte y comptent. Pas de plafond par jour, pas de réchauffement |
| Au-delà d'une limite | le message **ne part pas, et c'est compté** (une issue, comme un STOP ou un client sans téléphone) |
| Rafales | en coulisse, les envois sont **espacés d'au moins 30 secondes, avec un aléa** : ils partent un peu plus tard, jamais refusés |
| Relance de panier | **permise**, dans les mêmes limites |
| Consentement | le marchand affirme l'accord de ses clients **pour les trois messages** sur cette filière (la politique de WhatsApp vise tout message d'entreprise), pas seulement pour la relance |
| Quel numéro | **le choix au marchand** : Claude dit le risque en une phrase, puis le marchand choisit le numéro de sa boutique (0 €, mais c'est lui qui serait coupé) ou un numéro que nous fournissons (3,50 € HT par mois) |
| Essai préalable | **non** : on construit, l'essai réel de la fin tranche |
| Ordre | **ce produit d'abord**, la page Shopify ensuite |

Rappels de la conception du 2026-10-22, inchangés : le Pro est refusé sur cette filière (un espace QR code est donc en
Free, sans console : tout passe par Claude Code et l'API) ; bannissement : arrêter et prévenir, jamais de relien
automatique ; le STOP reste la loi ; une phrase de risque dans la doc, sans case à cocher.

## 3. Objectifs, non-objectifs, anti-objectifs

**Objectifs**
- Un espace Free relié par QR code branche sa boutique Shopify depuis Claude Code, règle ses trois messages en texte, et
  ils partent ; le client qui répond tombe sur l'agent IA.
- Claude et l'API peuvent écrire en premier à un numéro sur cette filière, avec les mêmes gardes.
- Un message qui ne part pas dit pourquoi, dans `get_shopify_state` et dans la réponse de l'outil.

**Non-objectifs**
- Toucher à la filière API (modèles Meta, console, Pro) : mêmes tests, mêmes résultats.
- Un plafond par jour, un réchauffement de numéro, un réglage par compte (décision de Julien : simple).
- Les médias, les boutons, les campagnes sur cette filière.
- La montée de Baileys en version 7.

**Anti-objectifs** (ce qui ferait échouer le chantier même s'il marche)
- Un premier message qui reste « En attente de ce message » sur le téléphone du client sans que personne le sache.
- Un message envoyé deux fois (la route d'envoi de la filière n'a pas d'idempotence).
- Une relance perdue parce qu'elle a été réclamée puis refusée par une limite.
- Un envoi qui contourne une garde de la filière API (STOP, contact bloqué, limite d'offre, consentement).
- Un numéro coupé par WhatsApp qui continue d'être sollicité, ou relié de nouveau automatiquement.
- Un marchand qui perd le numéro de sa boutique sans avoir été prévenu du risque.

## 4. Ce qui existe (lu le 2026-10-23 sur `origin/main`)

**L'envoi de la filière** : un seul point de passage, `EnvoiApplication.envoyer` (`src/application/envoi.ts`). Les
réponses y arrivent par `repondreAvec` (`src/inbox/repondre.ts`, qui exige un fil existant) et l'agent IA par
`envoyerTexteAgent` (`src/workflow/wiring.ts`). Puis un client HTTP signé (15 s) vers la route interne
`/interne/application/comptes/:id/envoyer`, la session Baileys, et l'adresse `adresseDeReponse`
(`src/application/transport/session.ts`) : le `@lid` connu du contact, sinon son numéro.
- **Aucun refus « premier message »** : le seul verrou est l'existence du fil. Le transport accepte n'importe quel numéro.
- 🔴 **L'adressage d'un inconnu** : l'essai du 2026-10-22 a montré qu'un envoi au NUMÉRO (et non au `@lid`) reste « En
  attente de ce message » sur le mobile. Pour un client qui n'a jamais écrit, aucun `@lid` n'est connu. `onWhatsApp`
  de Baileys 6.7.23 rend `{ jid, exists, lid }`, mais n'est appelé nulle part et n'a jamais été éprouvé sur une vraie
  connexion.
- **Résultat d'envoi synchrone seulement**, sans accusé de remise ; une exception de Baileys se lit comme une panne
  (`service_injoignable`) ; au-delà de 15 s, l'appelant croit à l'échec même si le message est parti ; la route n'a
  aucune idempotence.
- **Le bannissement** se détecte à la fermeture 403, jamais à l'envoi ; les envois suivants rendent `non_relie` avec une
  phrase fausse pour un numéro banni (« reliez-le de nouveau »).

**Le connecteur Shopify** suppose un modèle Meta partout :
- `shopify_messages.modele` est NOT NULL ; `set_shopify_message` exige `template` et `language` ; `brancherMessage`
  (`src/shopify/gestion.ts`) lit le modèle chez Meta.
- L'envoi (`envoyerShopify`, `src/shopify/envoi.ts`) passe par `lancerEnvoiPublic`, qui n'a pas de cible texte et
  envoie par Meta. Ses gardes : clé d'idempotence, numéro délié ou suspendu, modèles du mois, limite de contacts
  (`resoudreFiche`), consentement, tri STOP et contact bloqué.
- La relance réclame ses paniers (`relance_le`) avant d'envoyer, et une relance réclamée ne repart jamais.
- 🔴 Aujourd'hui, sur un espace QR code, `set_shopify_message` actif rend un 422 qui renvoie vers `get_template_status`,
  un outil refusé sur cette filière.

**Les limites de la Free** (`src/offres/offres.ts`) : `envoisModelesMois: 1000` (« messages à l'initiative de
l'entreprise par mois civil de Paris ; un message dans la fenêtre ne compte pas »), consommé aujourd'hui seulement par
l'envoi de modèles ; `contacts: 100` (fiches actives créées, hors fiches nées d'un message entrant).

**Le risque de bannissement** (recherche du 2026-10-23, rien de mesuré chez nous ni sur wagroups) : la politique de
WhatsApp exige l'accord explicite pour tout message d'entreprise, sur l'application aussi ; Meta teste un plafond mensuel
des messages sans réponse ; les appareils liés qui écrivent à de nouveaux contacts subissent une restriction silencieuse
(erreur 463, « reachout timelock », levée seule après quelques jours), que Baileys 6.7.23 ne reconnaît pas ; un numéro
neuf qui écrit tout de suite est un signal explicite. Sources : https://whatsappbusiness.com/policy/ ,
https://techcrunch.com/2025/10/17/whatsapp-will-curb-the-number-of-messages-people-and-businesses-can-send-without-a-response ,
https://waha.devlike.pro/blog/waha-2026-7/ (fiabilité moyenne pour la dernière).

## 5. Ce qu'il faut construire

### 5.1 Écrire en premier (la filière, pour tous)

- **Résoudre l'adresse avant d'écrire** : une route interne de vérification par `onWhatsApp`, qui dit si le numéro est
  sur WhatsApp et retient son `@lid` (le même `retenir` que la réception), avec un cache par compte et par numéro. Un
  numéro absent de WhatsApp rend une issue `pas_sur_whatsapp`, sans envoi.
- **Une porte d'envoi « premier message »**, distincte de `repondreAvec` (qui exige un fil et prend le fil) : elle crée
  ou retrouve la fiche dans la limite de contacts, applique les gardes (STOP, contact bloqué, consentement selon
  l'appelant, limite de 1 000 messages du mois), réserve l'envoi contre le doublon, envoie, puis trace le message dans
  la conversation **sans prendre le fil** (l'agent IA reste le répondeur).
- **La limite du mois** : un message écrit en premier sur cette filière consomme `envoisModelesMois`, comme un modèle sur
  l'API. Le refus se dit « messages du mois » et non « envois de modèles » sur cette filière *(choix de Claude)*.
- **L'espacement** : par compte, au moins 30 s entre deux messages écrits en premier, plus un aléa *(choix de Claude :
  30 à 60 s)*. Les messages attendent leur créneau dans une file pg-boss dédiée (dans `BASE_QUEUES`), jamais refusés pour
  ça. Une réponse dans une conversation ouverte n'est pas concernée.
- **Ce qui compte comme « écrire en premier »** *(choix de Claude, après la relecture)* : **la même règle que l'API, la
  fenêtre de 24 heures**. Un message envoyé dans les 24 heures qui suivent le dernier message reçu du contact est une
  réponse : libre, sans limite ni espacement, comme aujourd'hui. Tout autre message est écrit en premier : il passe par la
  porte du § 5.1 (limite du mois, espacement, consentement), **y compris s'il entre par une porte de réponse**
  (`reply_in_open_window`, `/v1/messages/whatsapp`, l'Inbox) sur un fil où le contact n'a pas écrit depuis 24 heures.
  Sans ce détour, un premier message Shopify crée le fil, et une promo envoyée ensuite par les portes de réponse
  contournerait tout. « Répondre est toujours possible » (conception du 2026-10-22) reste vrai : hors des 24 heures, la
  réponse part, mais comptée et espacée. Les messages Shopify sont toujours écrits en premier (ils ne répondent à rien),
  même à un client qui a écrit hier.
- **Le consentement quand Claude ou l'API écrit en premier** *(choix de Claude, calqué sur `/v1/sends`)* : le message
  part à une fiche consentante (`opted_in`), ou avec une déclaration de consentement dans l'appel (consentement et sa
  source, écrits sur la fiche avant l'envoi, comme `consent` et `consentSource` de `/v1/sends`) ; sinon il est refusé avec
  une phrase qui le dit. STOP et contact bloqué restent absolus.
- **Des raisons distinctes** à la place de `non_relie` et `service_injoignable` : numéro coupé (banni), en sommeil
  (réveillé puis réessayé), refusé par WhatsApp, panne ; chacune avec sa phrase juste. Un numéro banni ne dit plus
  « reliez-le de nouveau ».
- **Le signal de restriction** *(choix de Claude)* : un refus de WhatsApp sur un premier message (dont l'erreur 463) gèle
  les premiers messages du compte pendant 72 h, prévient les administrateurs par e-mail, et ne relie jamais la session.
  Ce n'est pas une limite au sens de Julien : c'est la règle « arrêter et prévenir » de la filière.
- **Claude et l'API** : un outil MCP et la route `/v1` d'envoi acceptent un numéro sans conversation sur cette filière,
  en texte, avec les mêmes gardes. Le constructeur choisit entre étendre `send_message` et `/v1/messages/whatsapp`, ou
  un outil neuf, en le disant dans le plan.

### 5.2 Shopify en texte

- **Le réglage** : `shopify_messages` reçoit un `texte` (avec ses repères `{{first_name}}`...), `modele` devient
  facultatif, une contrainte exige l'un ou l'autre. Migration AVANT le code (règle du dépôt : « l'ancien code
  survit-il ? »).
- **`set_shopify_message`** accepte `text` à la place de `template` ; sur un espace QR code, le texte est validé (repères
  connus de l'événement, longueur) et **actif tout de suite** : pas de Meta, pas d'attente, pas d'oubli de modèle.
  Sur un espace de l'API, rien ne change.
- **Les textes proposés** sont ceux de `web/lib/partage/shopify-messages.ts` (déjà sans prénom pour la relance), les
  données écrites dans le texte, les liens en clair, sans bouton ; « Répondez STOP pour ne plus recevoir ces messages »
  en dernière ligne de la relance, comme sur l'API *(choix de Claude)* ; le prénom de secours s'applique.
- **Le choix de la voie se fait à l'envoi** : la filière lue au moment d'envoyer (`filiereDe`). QR code et texte : le
  texte part par la porte du § 5.1. API et modèle : le modèle part, comme aujourd'hui. Un réglage qui ne correspond plus à
  la filière (un espace passé de l'une à l'autre) rend une issue dédiée, jamais un envoi.
- **Le consentement** : sur cette filière, aucun des trois messages ne se règle actif sans le consentement affirmé du
  marchand (`customers_consented_at`).
- **La relance** ne réclame que les paniers qu'elle peut envoyer : une limite atteinte laisse les autres paniers en
  attente, sans les consommer (ils expirent normalement à une semaine).
- **Le webhook Shopify** reste traité dans la requête : l'envoi lui-même passe par la file du § 5.1 (l'espacement ne
  s'attend pas dans les 5 s du webhook). L'issue « en file » se distingue de « envoyé ».
- **Issues neuves** dans `get_shopify_state` : la limite du mois atteinte, `pas_sur_whatsapp`, numéro indisponible
  (coupé, en sommeil), refusé par WhatsApp, réglage ne correspondant pas à la filière.

### 5.3 Le plugin et la doc

- La skill `shopify` lit `numero.filiere` dans `get_setup_state` d'abord. Sur un numéro QR code : pas de
  `create_template`, `set_shopify_message` avec `text` ; elle demande l'accord du marchand pour les trois messages ;
  elle dit en une phrase le risque (ce n'est pas l'API officielle, WhatsApp peut couper un numéro qui écrit beaucoup en
  premier).
- **Le choix du numéro se fait quand on le relie** *(choix de Claude, après la relecture)* : la skill `mise-en-service`
  relie le numéro avant que la skill `shopify` ne serve, et rien ne permet aujourd'hui de remplacer un compte relié
  (`deja_relie`). Donc : au moment de relier par QR code, la phrase de risque mentionne l'écriture en premier (Shopify
  compris) et laisse choisir entre le numéro de la boutique et un numéro fourni ; si le numéro est déjà relié quand
  Shopify arrive, la skill `shopify` redit seulement le risque. Un parcours de remplacement d'un numéro relié va au todo.
- La skill `mise-en-service` cesse de dire que la filière application ne fait « ni modèles ni campagnes » sans nuance :
  elle écrit en premier, en texte.
- `features.md` (§ filière application et § Shopify, avec la fiche d'aide qui porte l'empreinte de la section Shopify),
  `documentation.md` (le point d'envoi, la file, l'adressage), la FAQ du plugin (`scripts/plugin/faq.ts`),
  `npm run doc:md` si un outil MCP change, la version du plugin montée et publiée **après** le déploiement de l'API.

## 6. Ordre de construction

*(choix de Claude)* Julien a refusé un essai préalable séparé. Pour ne pas construire tout le reste sur une hypothèse
fausse, **la première tâche est la plus risquée** : la résolution d'adresse (`onWhatsApp`) et un premier message, livrés
seuls et essayés sur un vrai téléphone qui n'a jamais écrit au numéro, avant le reste. Si le message reste « En
attente », on s'arrête et on revient vers Julien avant d'écrire la suite. Ensuite : la porte d'envoi et ses gardes, la
limite du mois et l'espacement, Shopify en texte, Claude et l'API, puis le plugin.

**Les accusés de remise** *(choix de Claude, après la relecture)* : la filière n'en écoute aucun, et le premier
anti-objectif (un message « En attente » que personne ne voit) n'est couvert que par la tâche 1 et l'essai réel. Si la
tâche 1 montre que le message résolu par `onWhatsApp` arrive à coup sûr, l'écoute des accusés va au todo. S'il n'arrive
pas toujours, on s'arrête de toute façon (ci-dessus), et l'écoute des accusés devient une brique du chantier, décidée
avec Julien.

## 7. Ce qui est laissé au constructeur

La forme de la réservation contre le doublon, la forme du cache de `onWhatsApp`, le nom des issues et des raisons, le
découpage en lots, l'outil MCP de Claude (§ 5.1), la façon de reconnaître l'erreur 463 dans Baileys 6.7.23 (ou de la
déduire d'un refus d'envoi), la durée de vie d'un message en file avant abandon.

## 8. L'essai réel qui clôt

Dans un **espace Free**, depuis **Claude Code**, avec un **numéro relié par QR code** :
1. brancher la boutique de test (Messaging Me Essai) par la skill `shopify`, régler les trois messages en texte,
   affirmer le consentement ;
2. un panier abandonné depuis un **téléphone qui n'a jamais écrit au numéro** : la relance arrive, lue sur le mobile
   ET sur l'ordinateur du destinataire (pas « En attente ») ;
3. le client répond, l'agent IA lui répond ;
4. une commande : la confirmation arrive, puis l'avis d'expédition avec le suivi ;
5. Claude écrit en premier à un autre numéro par l'outil du § 5.1 ;
6. un STOP : plus rien ne part à ce client.

Il solde aussi les essais 144 et 145 (chemin Claude Code) et prépare celui de la page Shopify.
