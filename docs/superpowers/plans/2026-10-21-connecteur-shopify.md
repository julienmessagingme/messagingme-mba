# Plan : le connecteur Shopify, branché depuis Claude Code

Mesure du 2026-10-21 sur une boutique de dev de l'organisation YANS MOD (récit et pièges : `~/.claude/brain/LEARNINGS.md`,
entrée « Shopify » du même jour). Un marchand branche sa boutique sans app publique ni validation Shopify : la CLI crée et
publie une app DANS SON organisation, sans aucune question (`app init --no-input`, `app deploy --allow-updates`),
`app env show` rend le secret, le marchand clique une fois « Installer », et le flux `client_credentials` rend un jeton.
Les webhooks arrivent signés avec le secret de l'app. L'offre est « 100 % Claude Code » : le marchand ne tape aucune
commande, il se connecte à Shopify et clique « Installer », c'est tout. L'app publique (revue, facturation par Shopify)
reste pour plus tard.

## Décisions de Julien (grill du 2026-10-21)

1. **Panier abandonné : consentement affirmé par le marchand.** Shopify n'en donne aucun (`buyer_accepts_marketing`
   reste false). Le marchand affirme que ses clients ont consenti, et en porte la responsabilité.
2. **Une fois affirmé, la fiche est consentante PARTOUT** (`opted_in`, source `shopify:<boutique>`), relance de panier
   ET campagnes, comme le webhook entrant.
3. **Un outil MCP associe un événement Shopify à un modèle**, sans scénario visible pour le marchand.
4. **Toutes les offres, Base comprise.**
5. **Les fiches créées par le connecteur COMPTENT dans la limite de contacts de l'offre** (100 en Base).
6. **Limite atteinte : la carte et l'outil d'état comptent les messages non partis, et un e-mail part aux admins de
   l'espace au premier refus du mois civil**, avec le lien vers le Pro.
7. **Le secret passe en argument de l'outil MCP** (il apparaît dans la session du marchand, comme la clé que rend
   `create_api_key`).
8. **Une carte en lecture dans la console**, avec « Couper » ; tout le réglage reste dans Claude Code.
9. **Une seule relance de panier, délai choisi par le marchand** (1 h par défaut, de 15 min à 72 h). Rien ne part si
   le panier devient une commande entre-temps.
10. **« Commande confirmée » part au paiement (`orders/paid`)**, pas à la création.
11. **`shop/redact` efface le branchement, pas les fiches** (secret, paniers, messages branchés) : les fiches sont au
    mini-CRM du marchand. `customers/redact` purge, lui, la fiche du client nommé.
12. **Les messages passent par l'envoi public, une ligne par message dans Campagnes** (après la relecture : le moteur
    de scénario ne convient pas, voir plus bas). Un filtre de la liste pourra venir plus tard.
13. **Les données client protégées se mesurent APRÈS le lot 1**, sur une boutique en production, risque accepté :
    si Shopify masque le téléphone tant qu'un accès n'est pas déclaré à la main, la skill et la connexion changeront.

## Relecture du plan, 2026-10-21 (un relecteur indépendant, contre le code d'`origin/main`)

Cinq rouges, tous vérifiés dans le code, et ce qu'ils ont changé :
- **Le moteur de scénario ne convient pas aux notifications.** Une automation ordinaire ne reprend jamais le fil
  (`automatisme_ordinaire`, `reprise: 'non'`, `src/workflow/lancements.ts`) : une confirmation ne part pas quand
  l'agent de Meta ou un opérateur tient la conversation, et quand elle part, elle clôt le parcours en cours et la
  session d'agent IA (`closeActiveByWaId`, `src/workflow/executor.ts`). S'y ajoutaient le scénario « invisible »
  impossible (visible et supprimable, ou caché et introuvable par le lancement) et l'anti-rebond d'une heure par contact
  qui perdait la confirmation d'une seconde commande. **D'où l'envoi public** (décision 12) : il ne touche pas au fil.
- **`shop/redact` arrive environ 48 h APRÈS la désinstallation** (documentation de Shopify) : une boutique coupée
  refusée en 401 ne l'aurait jamais reçu. **D'où une boutique coupée qui garde son secret** jusqu'à `shop/redact`.
- **`customers/redact` ne retrouvait pas la fiche** : elle naît du téléphone de livraison, la demande nomme le client
  Shopify et ses commandes. **D'où le lien commande, client Shopify et fiche** (`shopify.commandes`).

## Mes choix (à relire)

- **L'envoi passe par `lancerEnvoiPublic`** (`src/api/envoi-public.ts`), dont le connecteur devient le troisième
  adaptateur après la route HTTP et l'outil MCP. Il ne touche pas au fil ; il lit la catégorie du modèle chez Meta et
  applique `optInAllows` (un modèle UTILITY part sauf STOP, un MARKETING seulement à une fiche consentante, y compris un
  modèle que Meta a recatégorisé), le STOP, la limite des modèles du mois et les gardes du numéro ; il crée la fiche
  (mode `phone`, limite de contacts comprise) et écrit le consentement par `appliquerConsentement` ; il prend des
  variables par destinataire, jamais écrites sur la fiche (ni clé d'accès de `order_status_url` lisible par tous, ni
  course entre deux commandes rapprochées) ; sa clé d'idempotence est la clé métier.
- **Le compteur passé à `lancerEnvoiPublic` ne décompte pas le plafond de l'API publique** : une vente flash ne doit pas
  être refusée par le plafond fait pour les intégrations. La limite des modèles du mois, elle, s'applique.
- **Les liens vont dans le CORPS du modèle** : un bouton de lien ne prend pas de variable (`create_template` refuse
  `{{1}}` dans un bouton URL).
- **Une fiche n'est écrite que si un message est branché sur l'événement** : un événement sans message ne consomme
  aucune place dans la limite de contacts.
- **La relance de panier n'utilise pas le bloc Attente**, parce que le panier se ferme sur la COMMANDE (un autre
  webhook), que la fiche ne doit naître qu'à une relance due, et qu'aucun parcours ne doit attendre des heures. Une
  table des paniers et un balayage la remplacent ; les `checkouts/update` répétés se dédoublonnent sur le jeton.
- **Le jeton `client_credentials` n'est ni stocké ni renouvelé** : il ne sert qu'à vérifier la connexion et à lire
  pays et devise. Les webhooks portent tout ce qu'un message utilise.
- **Deux états : `connectee` et `coupee`.** « Couper » (console, MCP) et `app/uninstalled` mènent à `coupee` : plus
  aucun message, mais le secret RESTE, la signature se vérifie toujours, les trois sujets RGPD sont traités, et tout
  autre webhook bien signé reçoit 200 et est ignoré (pas 401 : pas de réessais en boucle ni d'alertes de Shopify au
  marchand). La ligne disparaît par `shop/redact` ou la suppression de l'espace. Reconnecter = upsert sur l'espace ; un
  autre espace peut prendre une boutique `coupee` (identifiant et secret valides prouvent qu'il la tient), jamais une
  boutique `connectee`.
- **Le panier se ferme dès qu'une commande en naît** (`orders/create` avec son `checkout_token`, ou `completed_at`
  rempli), même non payée : un client qui a commandé par virement ne reçoit pas « vous avez oublié votre panier ».
- **Le modèle doit être approuvé pour être branché**, catégorie UTILITY imposée pour commande et expédition ;
  MARKETING admis pour le panier seulement, après l'affirmation du consentement.
- **`customers/data_request` = un e-mail aux admins de l'espace** qui nomme le client et dit où lire sa fiche (la
  console en Pro et Entreprise, `get_contact` dans Claude Code en Base) : c'est le marchand qui répond à son client.
- **La Base n'a pas de console** (`MODULES_OUVERTS_AU_FREE`, `ECRANS_FREE`) : elle pilote tout par les outils MCP ;
  la carte sert le Pro et l'Entreprise.
- **Les quatre outils exigent une personne nommée** (OAuth, `exigePersonne`, posé par outil) : l'affirmation du
  consentement est signée et journalisée (qui, quand), et une clé `mcp:write` donnée à un agent ne peut ni brancher ni
  débrancher la boutique. `customers_consented: false` la retire (les fiches déjà consentantes le restent, l'outil le
  dit), et TOUTE connexion l'efface : elle vaut pour une boutique et un branchement (rouge de la relecture du lot 1).

## Ce que le code a changé au plan (lot 1, en codant)

- **Le traitement se fait DANS la requête, pas dans un job du worker** : l'envoi public n'existe que dans l'API (ses
  dépendances se construisent dans `src/index.ts`), les recopier dans le worker serait une liste tenue à la main.
  Shopify tient lieu de file : un 503 le fait réessayer, et chaque événement se réserve (`shopify_evenements`, bail de
  2 minutes). Pas de file `shopify-evenement`.
- **Les tables sont dans `public`** (`shopify_boutiques`, `_messages`, `_evenements`, `_commandes`, `_paniers`), pas
  dans un schéma à part : le schéma `salesforce` interdit à tout autre fichier de le nommer, et la purge d'une fiche
  nomme les lignes Shopify.
- **L'effacement demandé par Shopify passe HORS limite du jour** (une obligation légale ne bute pas sur une limite
  commerciale) au lieu d'être réenfilé au lendemain ; il retrouve la fiche par les commandes, le client Shopify et le
  téléphone (la fiche n'a pas d'e-mail).
- **L'e-mail d'une demande d'accès ne cite pas le client** (règle du catalogue des e-mails) : il renvoie à la demande,
  dans l'administration de la boutique.
- **Un envoi où personne ne part ne laisse aucune ligne dans Campagnes** (option `sansCampagneVide` de l'envoi public).
- **`set_shopify_message` n'expose que `order_paid` et `order_fulfilled`** ; le panier et son délai arrivent au lot 2.
- **La carte est une section de Paramètres** (`web/components/ReglageShopify.tsx`), comme Salesforce et HubSpot, sans page
  ni entrée de navigation à part ; elle ne s'affiche pas tant que l'API n'a pas sa route. Sa fiche d'aide :
  `docs/aide/fiches/brancher-ma-boutique-shopify.md`.
- **La purge des événements à 30 jours** est une minuterie du worker (`shopify-evenements`).

Lot 2 (2026-10-22) :
- **Le balayage des relances tourne dans l'API**, dans sa minuterie d'une minute (l'envoi public n'existe qu'ici), et
  non au rythme de `date-sweep.ts` dans le worker ; chaque copie balaie, la réclamation en base départage.
- **Un panier ne se garde que si le message `checkout_abandoned` est actif** (pas de téléphone stocké sans raison), et
  une commande PAYÉE le ferme aussi, en plus de `orders/create` et de `completed_at`.
- **Le délai court depuis la DERNIÈRE modification du panier** : un client qui le remplit encore ne l'a pas abandonné.
- **Brancher la relance exige le consentement affirmé**, dans l'appel ou avant (409 sinon) ; un modèle marketing ou
  utility est admis.
- **Après la relecture du lot 2** (un rouge) : une commande ferme TOUJOURS le panier qui existe, relance éteinte comprise
  (éteinte puis rallumée, elle relançait le client qui avait commandé pendant la pause), et les autres paniers ouverts de
  son numéro ; un panier ne se garde qu'avec le consentement DÉJÀ affirmé ; toute connexion efface les paniers, comme
  elle efface l'affirmation ; l'envoi relit le panier juste avant de partir ; le numéro de l'acheteur passe avant celui
  de la livraison ; la carte et l'outil comptent les paniers sur leurs sept jours de vie.

## Méthode de livraison

**Implémenteur par lot (moi) puis une relecture indépendante du diff par lot, et Julien qui juge l'essai réel.**
Raison : chaque lot touche des chemins que la production emprunte (un webhook entrant public, un envoi WhatsApp, un
secret chiffré, la purge RGPD, l'écriture du consentement) et porte des invariants invisibles qu'aucun écran ne montre
(signature vérifiée avant le corps, dédoublonnage par événement, un STOP qui reste un STOP, la limite de contacts, la
catégorie du modèle à l'envoi). Pas feature-loop, parce que le bon comportement face à une vraie boutique et un vrai
téléphone ne se prouve pas par un test : l'essai réel décrit plus bas clôt chaque lot.

## Lot 0 : mesures avant le code (FAIT le 2026-10-21, boutique `messaging-me-essai`, app d'essai n° 2, CLI 4.9.4)

Vrais webhooks reçus par un tunnel, signature vérifiée sur chacun :
- **Aucun ordre entre sujets** : une commande payée a livré `orders/paid` AVANT `orders/create` (et un
  `checkouts/update` portant `completed_at`). Dédoublonnage et fermeture du panier ne supposent donc aucun ordre.
- **`orders/paid`** : téléphone dans `shipping_address.phone` (`customer` absent sur une commande sans client),
  `order_status_url`, `name` (« #1002 »), `checkout_token` égal au `token` du checkout, `currency` et
  `presentment_currency`. En-têtes : `X-Shopify-Order-Id`, `X-Shopify-Event-Id`, `X-Shopify-Webhook-Id`,
  `X-Shopify-Triggered-At`, `X-Shopify-Test`.
- **`fulfillments/create`** : téléphone dans `destination.phone`, `tracking_company`, `tracking_number`,
  `tracking_url`, `order_id`, `name` (« #1002.1 », la commande suivie d'un suffixe). NI `order_status_url` NI client :
  le message d'expédition porte le lien de suivi, pas celui de la commande. **Il exige `read_fulfillments`** (ou
  `read_marketplace_orders`) : sans lui, `app deploy` refuse la version.
- **`compliance_topics`** passent dans le `shopify.app.toml` d'une app de l'organisation : `app deploy` les accepte.
- **`app webhook trigger`** signe avec le vrai secret de l'app sans qu'on le lui donne, MAIS il envoie l'exemple de
  Shopify sur le domaine `shop.myshopify.com` (corps `shop_id`, `shop_domain`, `customer {id, email, phone}`,
  `orders_to_redact`, en-tête `X-Shopify-Test: true`). Il ne vise jamais une vraie boutique.
- **`app/uninstalled`** arrive tout de suite, corps = la fiche de la boutique. Ensuite, la demande de jeton rend
  `400 {"error": "app_not_installed"}` **à condition d'envoyer `Accept: application/json`** ; sans cet en-tête, elle
  rend une page HTML.
- **Le marchand n'a rien à copier** : `shopify organization list --json` rend chaque organisation (identifiant, nom,
  nombre de boutiques) et `shopify store list --organization-id <id> --json` rend le domaine `*.myshopify.com` de
  chacune de ses boutiques.

Pas mesuré : une boutique en production (l'organisation n'en a pas ; c'est la décision 13) ; une vraie demande
`customers/redact` (Shopify la diffère après la demande du marchand, selon sa documentation).

## Lot 1 : la connexion et les messages de commande

1. **Migration** (numéro lu par `npm run migrations`), schéma `shopify`, clés étrangères vers l'espace en cascade
   (c'est la cascade qui couvre la suppression d'un espace), `revoke` des rôles Supabase comme 0183 :
   - `boutiques` : espace en clé, domaine unique, identifiant, secret chiffré (`src/crypto/secretbox.ts`, chiffré et
     non haché parce que le HMAC exige le secret en clair), nom, pays, devise, état `connectee`/`coupee`, consentement
     affirmé par qui et quand, délai du panier, dernier événement reçu ;
   - `messages` : un par événement et par espace (clé espace + événement : brancher REMPLACE, jamais deux envois),
     modèle, langue, variables (liste ordonnée de données Shopify), actif, qui et quand ;
   - `evenements` : clé métier unique par espace (`orders/paid:<id>`, `fulfillments/create:<id>`), sujet, issue, date ;
     dédoublonnage ET chiffres de la carte ; purgée à 30 jours ;
   - `commandes` : commande Shopify, client Shopify, fiche ; vit autant que la fiche, pour `customers/redact` ;
   - `paniers` (dès ce lot, parce que la purge d'une fiche la nomme).
2. **`src/shopify/connexion.ts`**, sur le modèle de `src/salesforce/connexion.ts` : domaine contrôlé par regex
   (`<nom>.myshopify.com`, rien d'autre), jeton `client_credentials` puis `shop.json` par `fetchPublic` et
   `lireCorpsBorne` (les deux listes de `tests/lib-adresse-privee.test.ts` s'allongent), toujours avec
   `Accept: application/json`, chaque échec rendu avec le geste qui le règle (`app_not_installed` : « cliquez
   Installer sur ce lien » ; `shop_not_permitted` : l'app n'est pas dans l'organisation de la boutique).
3. **`src/shopify/gestion.ts`**, porte unique des outils MCP et de la console : connecter (upsert, règles de reprise
   ci-dessus), brancher un message, état, couper. Les données Shopify vivent dans UNE liste fermée
   (`src/shopify/donnees.ts`), clés en anglais : `first_name`, `order_number`, `order_total` (montant payé par le
   client, `total_price_set.presentment_money`, avec sa devise), `order_status_url`, `carrier`, `tracking_number`,
   `tracking_url`, `checkout_url` ; chacune dit de quel sujet elle se lit.
4. **`src/shopify/envoi.ts`**, l'adaptateur de `lancerEnvoiPublic` : un destinataire (téléphone E.164, consentement
   `opted_in` et source `shopify:<boutique>` si l'affirmation existe, variables), paramètres tous de source
   `variable`, clé d'idempotence = clé métier, compteur hors plafond de l'API publique, et un nom de ligne posé par
   l'adaptateur (« Shopify · commande payée · #1002 » ; aujourd'hui `[API] ` est posé DANS `lancerEnvoiPublic` et relu
   par `nomDuMessageRcs` : l'option ne change rien pour les deux autres appelants). Le rapport donne l'issue : acceptée,
   ou le motif d'écart (`opted_out`, `no_consent`, `blocked_contact`, `no_phone`, limite de contacts), ou le refus du
   mois (limite des modèles). La fiche résolue s'inscrit dans `shopify.commandes`.
5. **La route `POST /shopify/webhooks`**, module `shopifyWebhooks`, classe `signature-service` (précédent du secret
   par numéro de 360dialog). Dans cet ordre : domaine de `X-Shopify-Shop-Domain` contrôlé par regex AVANT la base (401
   s'il manque ou est mal formé), secret lu par un cache mémoire court par domaine (absence comprise : un flot de
   requêtes forgées ne coûte pas une lecture et un déchiffrement chacune), HMAC SHA-256 base64 du corps brut (`rawBody`)
   comparé en temps constant (401 sinon), PUIS `safeParse` du schéma du sujet (`X-Shopify-Topic`) : un corps bien
   signé qui ne passe pas reçoit 200 et une ligne de journal, jamais un 4xx (Shopify réessaierait, puis retirerait
   l'abonnement). Mise en file `shopify-evenement` (`BASE_QUEUES`, avec `QUEUE_POLLING_SECONDS` et `FILES_NOTIFIEES`),
   200 ; Shopify attend sa réponse en 5 s. AUCUN plafond de débit avant la vérification (un tiers ferait refuser en 429
   les vrais webhooks d'un marchand) ; le plafond de corps global (1 Mo) est gardé. `FAUSSES_AUTORITES` reçoit un
   magasin qui rend un VRAI secret pour une boutique inventée, et la sonde 12 de l'auto-attaque apprend les en-têtes de
   Shopify, sinon la comparaison n'est jamais exercée.
6. **Le job `shopify-evenement`**, sans rien supposer de l'ordre d'arrivée : clé métier déjà servie, rien ; sinon, si un
   message actif est branché sur l'événement d'une boutique `connectee`, l'envoi (tâche 4), puis l'issue inscrite. Un
   job rejoué après l'envoi relit le rapport par la clé d'idempotence au lieu de renvoyer. Téléphone : commande
   `shipping_address.phone`, puis `billing_address.phone`, `customer.phone`, `phone` ; expédition `destination.phone` ;
   normalisé au pays de l'adresse, à défaut à celui de la boutique ; numéro de commande d'une expédition lu dans son
   `name`, suffixe retiré. Premier refus du mois pour la limite de contacts : l'e-mail aux admins (`emails-produit`,
   occasion `AAAA-MM`). `app/uninstalled` : `coupee`.
7. **Les trois webhooks RGPD**, traités aussi pour une boutique `coupee` : `customers/redact` réunit les fiches de
   `orders_to_redact` et du client Shopify (par `shopify.commandes`) et celles de son téléphone et de son e-mail, DANS
   l'espace de la boutique, et passe par `effacerContacts` (`src/crm/effacement.ts`) ; un refus de la limite du jour
   réenfile le job pour le lendemain (`startAfter`), pas les réessais par défaut qui finiraient en DLQ en quelques
   minutes. `customers/data_request` : l'e-mail aux admins. `shop/redact` : boutique, messages, paniers, événements et
   commandes effacés, fiches gardées.
8. **La purge d'une fiche** (`purgeMany` : purge du mini-CRM, `DELETE /v1/contacts`, `effacerContacts`) efface ses
   lignes de `shopify.commandes` et les paniers de son téléphone ; le balayage efface les événements de plus de 30 jours.
9. **Les outils MCP** (`src/mcp/outils-shopify.ts`), `fonction: null`, `exigePersonne` sur les quatre :
   `connect_shopify` (boutique, identifiant, secret ; décompté du plafond des opérations lourdes, comme
   `create_template`), `set_shopify_message` (événement parmi `order_paid`, `order_fulfilled`, `checkout_abandoned` ;
   modèle ; variables ; actif ; délai du panier ; consentement affirmé), `get_shopify_state`, `disconnect_shopify`.
   Bornes annoncées dans le schéma envoyé, refus en phrases (modèle non approuvé, mauvaise catégorie, panier sans
   consentement affirmé). Catalogue `web/lib/partage/catalogue-mcp.ts`, page développeurs bilingue
   `web/lib/mcp-outils.ts` (`tests/mcp-doc-parite.test.ts`), chaque outil dans UNE famille de
   `scripts/plugin/familles-outils.ts`, puis `npm run plugin:generer` (bloc des outils de `plugin/README.md`).
10. **La carte** `web/app/parametres/shopify/page.tsx` (Pro et Entreprise), entrée dans `web/lib/nav.ts`
    (`npm run aide:carte`), hors `ECRANS_FREE` : boutique, état, messages actifs, dernier événement, compteurs des 30
    jours (servis, sans téléphone, limite de contacts, limite des modèles, désabonnés, sans consentement), « Couper »
    (admin), lien vers la page des apps de la boutique. Routes `GET` et `DELETE /tenants/:tenantId/integrations/shopify`,
    classe `tenant`.
11. **La skill du plugin** `plugin/skills/shopify/SKILL.md` (en anglais, comme ses voisines) : Node présent (`npx.cmd`
    sous Windows), connexion Shopify, organisation par `organization list --json` (celle qui a une boutique ; s'il y en
    a plusieurs, le marchand choisit par son nom), boutique par `store list --json`, `app init` dans un dossier dédié,
    extensions d'exemple retirées, `shopify.app.toml` écrit (ci-dessous, dans un bloc de code : `tests/plugin.test.ts`
    refuse un nom en snake_case entre accents graves qui n'est pas un outil connu), `app deploy`, lien d'installation
    donné au marchand, `app env show`, `connect_shopify`, puis les modèles proposés (`create_template`, liens dans le
    corps), leur approbation suivie (`get_template_status`) et `set_shopify_message`. Un accès ajouté plus tard ne
    s'applique qu'après un nouveau clic sur le même lien : la skill le redonne. La skill entre dans la liste de
    `tests/plugin.test.ts` et dans la ligne « skills » du bloc `contenu` de `scripts/plugin/generer.ts` ;
    `plugin.json` monte au-dessus de 0.2.1.
12. **Doc** : `features.md` (et la fiche d'aide qui en cite la section, empreinte comprise), `documentation.md`.

**Le `shopify.app.toml` écrit par la skill** : `client_id` rendu par `app init` ; `name = "Messaging Me"` ;
`application_url` vers la console, `embedded = false` ; accès `read_customers,read_orders,read_checkouts,read_fulfillments`
(mesurés le 21) ; `[webhooks] api_version = "2026-10"` ; un abonnement
`orders/create`, `orders/paid`, `fulfillments/create`, `checkouts/create`, `checkouts/update`, `app/uninstalled` et un
abonnement `compliance_topics` (`customers/data_request`, `customers/redact`, `shop/redact`), tous deux vers
`https://api.messagingme.app/shopify/webhooks` ; `[auth] redirect_urls` laissé à la valeur par défaut de la CLI.

## Lot 2 : le panier abandonné

1. `checkouts/create` et `checkouts/update` : upsert du panier sur son jeton (téléphone de `shipping_address.phone`,
   lien `abandoned_checkout_url`, nom), aucune fiche écrite ; sans téléphone, rien. `orders/create` portant le
   `checkout_token`, ou `completed_at` rempli : panier fermé. La fermeture peut arriver AVANT le panier (mesuré) : elle
   écrit alors un panier déjà fermé, et un panier fermé ne se rouvre jamais.
2. Le balayage (même cadence que `src/automation/date-sweep.ts`), borné par passage avec le reste journalisé : panier
   ouvert, échu, jamais relancé, message `checkout_abandoned` actif et consentement affirmé, alors `relance_le` posé
   dans la même écriture que la réclamation (une seule relance même si deux balayages se croisent), puis l'envoi par
   l'adaptateur (le destinataire porte le consentement affirmé). Un envoi qui échoue après la réclamation perd la
   relance : accepté pour un message marketing, et écrit. Paniers de plus de 7 jours effacés.
3. La carte et `get_shopify_state` portent le panier (délai, relances parties, paniers fermés à temps).

## Lot 3 : l'import des clients abonnés (cadré avec Julien le 2026-10-22)

Décisions de Julien (rondes de questions du 2026-10-22), qui retirent l'import des clients du hors-périmètre :
- **Qui** : les clients ABONNÉS au marketing dans Shopify (e-mail ou SMS), avec un téléphone valable ; les autres
  sont comptés, jamais importés.
- **Consentement** : JAMAIS, même si le marchand a affirmé celui de ses clients. Un accord e-mail ou SMS n'est pas un
  accord WhatsApp. Une fiche déjà consentante le reste, un STOP reste un STOP (autorité `import`).
- **Limite** : Claude compte d'abord, le marchand choisit (jusqu'à la limite, les plus récents d'abord, ou l'offre
  supérieure). Rien ne s'écrit sans ce choix. C'est au marchand de gérer sa limite.
- **Rythme** : une fois, à la demande, relançable sans doublon ; les nouveaux clients entrent déjà par leurs commandes.

Mesuré le 2026-10-22 (boutique `messaging-me-essai`, API 2026-10, jeton `client_credentials` de l'app du marchand) :
- le téléphone du client est dans `defaultPhoneNumber.phoneNumber` (E.164), et c'est le SEUL retenu (relecture du lot :
  celui d'une adresse peut être celui d'un destinataire, et `customers/redact` ne porte que celui du client) ; l'abonnement dans `defaultEmailAddress.marketingState` et `defaultPhoneNumber.marketingState`
  (`SUBSCRIBED`, `NOT_SUBSCRIBED`...) ;
- 🔴 **`customersCount(query:)` IGNORE le filtre** (4 pour chaque filtre essayé), et un filtre de recherche inconnu est
  ignoré en silence (`email_subscription_status:SUBSCRIBED` rendait tout le monde). Compter, c'est donc parcourir, et
  l'abonnement se REVÉRIFIE sur chaque client lu, quel que soit le filtre envoyé : un filtre ignoré importerait sinon
  toute la boutique, sans consentement de personne ;
- une page de 250 clients coûte 35 points demandés sur un seau de 2 000 rechargé de 100 par seconde.
- **Mesuré ensuite le même jour**, Julien ayant abonné deux clients (l'un par e-mail, l'autre par SMS) :
  `email_marketing_state:SUBSCRIBED OR sms_marketing_state:SUBSCRIBED` rend exactement ces deux-là, et le vrai code
  (`lireClientsAbonnes`) aussi, avec leur téléphone ; les deux non abonnés sont écartés, comme le dit la lecture de
  tous les clients sans filtre. Le filtre ne sert qu'à lire moins de pages : la revérification reste la règle.

1. `src/shopify/clients.ts` : la lecture paginée des abonnés (du plus récent au plus ancien), chaque page passée à
   `safeParse`, l'abonnement revérifié, le téléphone normalisé par `telephoneE164`, le nom fait du prénom et du nom ;
   plafond de clients lus par appel, dit dans la réponse ; attente quand le seau de Shopify est vide.
2. `apercuImport` et `importerClients` (dans `src/shopify/gestion.ts`) : abonnés lus, avec téléphone, déjà dans
   l'espace, nouveaux, places libres de l'offre (`null` sans limite) ; l'import prend les nouveaux jusqu'au maximum
   choisi et aux places libres, et passe par `importContacts` (`optIn: false`, autorité `import`, étiquette `Shopify`),
   le chemin de l'import HubSpot : limite vérifiée sur tout le lot avant d'écrire, lots de 500, AUCUN événement
   d'automation (chemin de masse).
3. Deux outils MCP, sur le modèle `preview_site` / `import_site` : `preview_shopify_customers` (lecture seule) et
   `import_shopify_customers` (`max_contacts`), personne nommée exigée, toutes offres, plafond des opérations coûteuses
   pour l'import. La skill : compter, dire le choix, importer seulement après la réponse du marchand.
4. Doc : `features.md` et sa fiche (empreinte), skill et plugin remonté, `mcp-outils.ts` et `doc:md`, familles d'outils.

Tests : `tests/shopify-clients.test.ts` (un client non abonné rendu par Shopify n'est PAS importé, filtre ignoré
compris ; téléphone d'adresse et pays ; pagination et plafond ; seau vide), `tests/shopify-gestion.test.ts` (aperçu,
maximum et places libres, aucun consentement écrit, STOP gardé, étiquette, offre pleine), les tests MCP qui suivent les
outils (`mcp-agent` pour le plafond coûteux, `mcp-doc-parite`, `plugin`). Aucune migration. Ordre : l'API d'abord
(les outils), la skill et le plugin ensuite. Méthode : celle du plan, implémenteur puis UNE relecture du diff.
Essai réel : sur la boutique de dev, deux clients abonnés avec téléphone et un non abonné ; Claude annonce deux
clients importables ; l'import crée deux fiches étiquetées `Shopify`, sans consentement, et laisse le troisième.

## Tests attendus

- `tests/shopify-webhook.test.ts` : domaine absent ou mal formé, 401 sans toucher la base ; signature fausse ou
  absente, 401 sans `safeParse` ni file ; boutique `coupee` : sujet ordinaire 200 ignoré, sujet RGPD en file ; corps
  signé mais illisible, 200 et journal ; cache du secret. Comparaison mutée, vérifiée dans les deux sens.
- `tests/shopify-evenement.test.ts` : dédoublonnage ; `orders/paid` avant `orders/create` ; ordre des téléphones et
  `destination.phone` ; aucun message branché, aucune fiche ; rejeu après envoi sans second envoi ; chaque motif
  d'écart devient son issue ; UN e-mail par mois pour la limite de contacts ; consentement affirmé, `opted_in` et
  source ; boutique `coupee`, rien.
- `tests/shopify-envoi.test.ts` : le corps donné à `lancerEnvoiPublic` (variables, clé, nom de ligne, compteur hors
  plafond) ; un MARKETING ne part pas à une fiche non consentante ; un destinataire porteur du consentement affirmé
  passe `optInAllows` dans le même envoi ; les deux autres appelants gardent `[API] `.
- `tests/shopify-rgpd.test.ts` : effacement par commandes, client, téléphone et e-mail, dans SON espace seulement ;
  quota du jour, réenfilé au lendemain ; `shop/redact` garde les fiches ; demande d'accès, e-mail.
- `tests/shopify-connexion.test.ts` : regex du domaine, en-tête `Accept`, chaque échec et son geste, reprise d'une
  boutique `coupee` par un autre espace, refus d'une `connectee`.
- `tests/mcp-shopify.test.ts` : refus (catégorie, approbation, consentement), bornes du schéma, brancher remplace,
  personne nommée exigée sur les quatre, Base permise.
- Existants qui suivent : `tests/lib-adresse-privee.test.ts`, `tests/queue-names.test.ts`, `tests/scope-tenant.test.ts`,
  `tests/optout-chemins.test.ts` (l'adaptateur passe par l'envoi public, pas un cinquième chemin), `tests/plugin.test.ts`,
  `tests/plugin-readme.test.ts`, `tests/mcp-doc-parite.test.ts`, `tests/mcp-repertoire.test.ts`, l'auto-attaque (lancée
  en local avant de pousser).
- `tests/integration/shopify-store.integration.test.ts` (CI) : unicité du domaine, upsert de reconnexion, cascade, purge
  d'une fiche (commandes et paniers), réclamation de relance unique ; `tests/integration/suppression-espace.integration.test.ts`
  étendu au schéma `shopify`.
- Lot 2 : `tests/shopify-paniers.test.ts` : upsert idempotent, fermeture par commande, fermeture reçue avant le
  panier, relance due et unique, rien quand le panier est fermé, fiche écrite seulement à la relance, balayage borné.

## Ordre de déploiement

1. La migration poussée SEULE et appliquée avant le code : la purge d'une fiche nomme ces tables.
2. API et worker ensemble (`up -d --build`, même `REVISION`), après `gh run list` vert lu job par job. Les fichiers
   de `web/lib/partage/` et `web/lib/mcp-outils.ts` partent avec l'API (le serveur les importe) ; tout lot qui touche
   `web/` lance la suite racine entière avant de pousser.
3. La carte et `nav.ts` APRÈS le `up` : la carte appelle une route neuve.
4. La skill, `npm run plugin:generer` et la montée de `plugin.json`, puis `gh workflow run plugin.yml --ref main` :
   ses outils doivent exister en production. Annoncer le push à la session du plugin, qui travaille dans `plugin/`.
5. Lot 2 dans le même ordre (aucune migration), plugin remonté une seconde fois.

## Essai réel qui clôt la feature

Sur la boutique de dev YANS MOD, branchée à un espace de test, depuis une session Claude Code neuve avec le plugin :
« branche ma boutique Shopify à Messaging Me ». Julien ne fait que se connecter à Shopify et cliquer « Installer ».
- **Lot 1** : modèles approuvés et branchés ; une commande payée avec le téléphone de Julien donne la confirmation
  WhatsApp (numéro, lien de la commande), y compris pendant que l'agent de Meta tient la conversation, et sans la
  couper ; Campagnes montre sa ligne ; l'expédition avec un suivi donne son message ; STOP, puis une nouvelle commande :
  rien, la carte compte un désabonné ; l'exemple `customers/redact` de la CLI est refusé en 401 (domaine
  `shop.myshopify.com`, inconnu : l'effacement d'un client se prouve par test) ; « Couper » met la carte en
  « coupée », une nouvelle commande ne donne rien et Shopify reçoit 200 ; désinstaller l'app, même état.
- **Puis, sur une boutique en production** (décision 13), avant d'ouvrir le connecteur aux marchands : le téléphone
  arrive-t-il dans les webhooks sans geste manuel ? Sinon, la skill guide ce geste.
- **Lot 2** : délai à 15 min ; un checkout rempli avec le téléphone de Julien et laissé impayé donne la relance, dont
  le lien rouvre le panier ; un second checkout payé avant 15 min ne donne rien.

## Hors périmètre

App publique de l'App Store, plusieurs boutiques par espace, case de consentement au checkout, deuxième relance,
réglage des messages depuis la console, message à la création d'une commande non payée, filtre des envois Shopify dans
Campagnes, import des clients NON abonnés et import en continu (lot 3 : une fois, à la demande, abonnés seulement).
