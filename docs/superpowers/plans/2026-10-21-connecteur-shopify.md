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

## Mes choix (à relire)

- **La relance de panier n'utilise PAS le bloc Attente du moteur de scénario** (contrairement à la piste de départ),
  parce que les fiches comptent : un run avec attente exige une fiche dès la saisie du téléphone, donc une fiche
  consommée pour chaque panier qui sera payé ensuite. Une table des paniers et un balayage la remplacent : la fiche ne
  naît que si la relance est due, et les `checkouts/update` répétés se dédoublonnent sur le jeton du panier.
- **Le jeton `client_credentials` n'est ni stocké ni renouvelé** : il ne sert qu'à vérifier la connexion (et à lire
  pays et devise de la boutique). Les webhooks portent tout ce qu'un message utilise, aucun appel régulier à l'API
  Admin n'existe, donc rien à renouveler. Le jour où un appel régulier naît, il demande son jeton à la volée.
- **Une fiche n'est écrite que si un message est branché sur l'événement** : un événement sans message ne consomme
  aucune place dans la limite de contacts.
- **Une boutique par espace, un espace par boutique** (domaine unique). La connexion exige un jeton obtenu avec
  l'identifiant et le secret : personne ne peut rattacher la boutique d'un autre.
- **Le panier se ferme dès qu'une commande en naît** (`orders/create` avec son jeton de checkout, ou `completed_at`
  rempli), même non payée : un client qui a commandé par virement ne reçoit pas « vous avez oublié votre panier ».
- **Le modèle doit être approuvé pour être branché**, catégorie UTILITY imposée pour commande et expédition. À
  l'envoi, un modèle que Meta a repassé en MARKETING ne part qu'à une fiche consentante (le chemin du scénario ne
  regarde pas le consentement : `optInAllows` ne sert qu'à la construction d'une liste).
- **Expédition = `fulfillments/create`** (transporteur, numéro et lien de suivi), mesuré au lot 0.
- **`customers/data_request` = un e-mail aux admins de l'espace** avec le lien de la fiche : c'est le marchand qui
  répond à son client.
- **« Couper » laisse l'app installée chez Shopify** (aucune API ne la désinstalle) : la carte donne le lien de la page
  des apps de la boutique ; les webhooks d'une boutique coupée reçoivent 401.
- **L'affirmation du consentement se fait par un outil en OAuth seulement** (une personne nommée signe ; ni listé ni
  appelable avec une clé d'API) et s'inscrit au journal d'audit, avec qui et quand. La retirer n'efface pas les
  consentements déjà écrits : l'outil le dit.

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

Pas mesuré : une boutique PAYANTE active (l'organisation n'en a pas ; règle d'organisation attendue identique) ; une
vraie demande `customers/redact` (Shopify la diffère après la demande du marchand, selon sa documentation).

## Lot 1 : la connexion et les messages de commande

1. **Migration** (numéro lu par `npm run migrations`) : `shopify.boutiques` (espace en clé, domaine unique,
   identifiant, secret chiffré par `src/crypto/secretbox.ts`, chiffré et non haché parce que le HMAC exige le secret en
   clair, comme `salesforce.orgs` ; nom, pays, devise, état `connectee`/`coupee`, consentement affirmé par qui et quand,
   délai du panier, dernier événement reçu), `shopify.evenements` (clé métier unique par espace, `orders/paid:<id>`,
   sujet, issue, date ; purgée à 30 jours ; sert au dédoublonnage ET aux chiffres de la carte), `shopify.paniers` (dès
   ce lot, parce que la purge d'un client la nomme). Clés étrangères vers l'espace en cascade.
2. **`src/shopify/connexion.ts`**, sur le modèle de `src/salesforce/connexion.ts` : domaine contrôlé par regex
   (`<nom>.myshopify.com`, rien d'autre), jeton `client_credentials` puis `shop.json` par `fetchPublic` et
   `lireCorpsBorne` (le chemin entre dans l'inventaire de `tests/lib-adresse-privee.test.ts`), toujours avec
   `Accept: application/json` (sans lui, une erreur revient en page HTML), chaque échec rendu avec le geste qui le
   règle (`app_not_installed` : « cliquez Installer sur ce lien » ; `shop_not_permitted` : l'app n'est pas dans
   l'organisation de la boutique).
3. **`src/shopify/gestion.ts`**, porte unique de l'outil MCP et de la console : connecter, brancher un message, état,
   couper. Brancher crée une automation POSSÉDÉE (`possede_par = 'shopify'`, déclencheur `shopify`, scénario d'un seul
   bloc « envoyer un modèle ») et pose les `template_param_hints` vers les champs Shopify. Les données Shopify vivent
   dans UNE liste fermée (`src/shopify/donnees.ts`) : commande, montant, lien de la commande, transporteur, numéro et
   lien de suivi, lien du panier ; leurs champs de contact se créent à la connexion.
4. **Le propriétaire `shopify` déclaré dans `permisesParLOffre`** (`src/automation/runner.ts`), permis sur toutes les
   offres, et l'événement `{ kind: 'shopify', waId, evenement }` dans `src/automation/match.ts`. L'émission vient du
   job, chemin unitaire (une commande, un événement) : la règle « le chemin appelant décide » est tenue.
5. **La route `POST /shopify/webhooks`**, module `shopifyWebhooks`, classe `signature-service` (un tiers qui signe,
   comme Stripe). Dans cet ordre : domaine de `X-Shopify-Shop-Domain` contrôlé par regex AVANT la base, boutique et
   secret lus, HMAC SHA-256 base64 du corps brut comparé en temps constant (401 sinon), PUIS `safeParse` du schéma du
   sujet (`X-Shopify-Topic`), mise en file `shopify-evenement` (dans `BASE_QUEUES`), 200. Shopify attend sa réponse en
   5 s : aucun travail avant la file. Frein des domaines inconnus comme le webhook entrant, plafond de corps dédié.
   Entrée `shopifyWebhooks` dans `FAUSSES_AUTORITES` : un magasin qui rend un VRAI secret pour une boutique inventée,
   sinon la comparaison n'est jamais exercée par l'auto-attaque.
6. **Le job `shopify-evenement`** : dédoublonnage sur la clé métier, sans rien supposer de l'ordre d'arrivée des
   sujets ; `orders/paid` et `fulfillments/create`, si un message est branché, écrivent la fiche par le chemin partagé
   (`upsertContactsFromApi`, via le même `ecrireContact` que `src/http/webhook-entrant.ts` : limite de contacts,
   consentement affirmé ou non, source tracée, un STOP qui reste un STOP), puis publient l'événement. Téléphone : pour
   une commande `shipping_address.phone`, puis `billing_address.phone`, `customer.phone`, `phone` ; pour une
   expédition `destination.phone` ; normalisé au pays de l'adresse, à défaut à celui de la boutique. Le numéro de
   commande d'une expédition se lit dans son `name`, suffixe retiré. Issue inscrite (servi,
   sans téléphone, limite de contacts, désabonné). Premier refus du mois pour la limite : l'e-mail aux admins (file
   `emails-produit`). `app/uninstalled` : état `coupee`, automations éteintes.
7. **Les trois webhooks RGPD** : `customers/redact` cherche la fiche du client (téléphone, e-mail) DANS l'espace de la
   boutique et passe par `effacerContacts` (`src/crm/effacement.ts`), paniers du même téléphone compris ; un refus de
   la limite du jour rejoue le job (Shopify laisse 30 jours). `customers/data_request` : l'e-mail aux admins.
   `shop/redact` : boutique, paniers, événements et automations possédées effacés, fiches gardées.
8. **Les outils MCP** (`src/mcp/outils-shopify.ts`, catalogue `web/lib/partage/catalogue-mcp.ts`) : `connect_shopify`
   (boutique, identifiant, secret), `set_shopify_message` (événement parmi `commande_payee`, `commande_expediee`,
   `panier_abandonne` ; modèle ; variables, liste ordonnée prise dans les données Shopify ; actif ; délai du panier ;
   consentement affirmé), `get_shopify_state`, `disconnect_shopify`. Bornes annoncées dans le schéma envoyé (délai,
   énumérations), refus en phrases : modèle non approuvé, mauvaise catégorie, panier sans consentement affirmé.
9. **La carte** `web/app/parametres/shopify/page.tsx`, entrée dans `web/lib/nav.ts` (`npm run aide:carte`) : boutique
   branchée, messages actifs, dernier événement, compteurs des 30 jours (servis, sans téléphone, limite, désabonnés),
   « Couper » (admin), lien vers la page des apps de la boutique. Routes `GET` et `DELETE
   /tenants/:tenantId/integrations/shopify`, classe `tenant`.
10. **La skill du plugin** `plugin/skills/shopify/SKILL.md` (en anglais, comme ses voisines) : Node présent (`npx.cmd`
    sous Windows), connexion Shopify, organisation par `organization list --json` (celle qui a une boutique ; s'il y en
    a plusieurs, le marchand choisit par son nom) et boutique par `store list --json`, `app init` dans un dossier dédié,
    extensions d'exemple retirées, `shopify.app.toml` écrit (ci-dessous), `app deploy`, lien d'installation donné au
    marchand, `app env show`, `connect_shopify`, puis les modèles proposés (`create_template`), leur approbation suivie
    (`get_template_status`) et `set_shopify_message`. Un accès ajouté plus tard ne s'applique qu'après un nouveau clic
    sur le même lien : la skill le redonne. Montée de `plugin.json`.
11. **Doc** : `features.md` (et la fiche d'aide qui en cite la section, empreinte comprise), `documentation.md`.

**Le `shopify.app.toml` écrit par la skill** : `client_id` rendu par `app init` ; `name = "Messaging Me"` ;
`application_url` vers la console, `embedded = false` ; accès `read_customers,read_orders,read_checkouts,read_fulfillments`
(mesurés le 21) ; `[webhooks] api_version = "2026-10"` ; un abonnement
`orders/create`, `orders/paid`, `fulfillments/create`, `checkouts/create`, `checkouts/update`, `app/uninstalled` et un
abonnement `compliance_topics` (`customers/data_request`, `customers/redact`, `shop/redact`), tous deux vers
`https://api.messagingme.app/shopify/webhooks` ; `[auth] redirect_urls` laissé à la valeur par défaut de la CLI.

## Lot 2 : le panier abandonné

1. `checkouts/create` et `checkouts/update` : upsert du panier sur son jeton (téléphone de `shipping_address.phone`,
   lien `abandoned_checkout_url`, nom), aucune fiche écrite ; sans téléphone, rien. `orders/create` portant le jeton de
   checkout (`checkout_token`), ou `completed_at` rempli : panier fermé. La fermeture peut arriver AVANT le panier
   (mesuré) : elle écrit alors un panier déjà fermé, et un panier fermé ne se rouvre jamais.
2. Le balayage (même cadence que `src/automation/date-sweep.ts`) : panier ouvert, échu, jamais relancé, message
   `panier_abandonne` actif et consentement affirmé, alors fiche écrite (consentante), `relance_le` posé dans la même
   écriture que la réclamation (une seule relance même si deux balayages se croisent), événement publié. Paniers de plus
   de 7 jours effacés.
3. La carte et `get_shopify_state` portent le panier (délai, relances parties, paniers fermés à temps).

## Tests attendus

- `tests/shopify-webhook.test.ts` : signature fausse ou absente, 401 sans `safeParse` ni file ; domaine mal formé
  refusé sans toucher la base ; domaine inconnu 401 ; corps valide en file. Comparaison mutée, vérifiée dans les deux
  sens.
- `tests/shopify-evenement.test.ts` : dédoublonnage ; `orders/paid` avant `orders/create` ; ordre des téléphones et
  `destination.phone` ; aucun message branché, aucune fiche ;
  limite atteinte, issue inscrite et UN e-mail par mois ; STOP gardé ; consentement affirmé, `opted_in` et source ;
  modèle repassé MARKETING, rien vers une fiche non consentante ; désinstallation.
- `tests/shopify-rgpd.test.ts` : effacement du client dans SON espace seulement ; `shop/redact` garde les fiches ;
  demande d'accès, e-mail.
- `tests/shopify-connexion.test.ts` : regex du domaine, en-tête `Accept`, chaque échec et son geste ; inventaire de
  `tests/lib-adresse-privee.test.ts` étendu.
- `tests/mcp-shopify.test.ts` : refus (catégorie, approbation, consentement), bornes du schéma, OAuth seulement pour le
  consentement, Base permise.
- Runner : le propriétaire `shopify` tire sur une Base. `tests/queue-names.test.ts`, `tests/scope-tenant.test.ts` et
  l'auto-attaque couvrent la file et les routes (auto-attaque lancée en local avant de pousser).
- `tests/integration/shopify-store.integration.test.ts` (CI) : unicité du domaine, cascade, purge des paniers d'un
  téléphone, réclamation de relance unique.
- Lot 2 : `tests/shopify-paniers.test.ts` : upsert idempotent, fermeture par commande, fermeture reçue avant le
  panier, relance due et unique, rien quand le panier est fermé, fiche écrite seulement à la relance.

## Ordre de déploiement

1. La migration poussée SEULE et appliquée avant le code : la purge d'un client et la suppression d'un espace nomment
   ces tables.
2. API et worker ensemble (`up -d --build`, même `REVISION`), après `gh run list` vert lu job par job.
3. La console APRÈS le `up` : la carte appelle une route neuve.
4. La skill du plugin et la montée de `plugin.json`, puis `gh workflow run plugin.yml --ref main` : ses outils doivent
   exister en production.
5. Lot 2 dans le même ordre (aucune migration), plugin remonté une seconde fois.

## Essai réel qui clôt la feature

Sur la boutique de dev YANS MOD, branchée à un espace de test, depuis une session Claude Code neuve avec le plugin :
« branche ma boutique Shopify à Messaging Me ». Julien ne fait que se connecter à Shopify et cliquer « Installer ».
- **Lot 1** : modèles approuvés et branchés ; une commande payée (passerelle de test) avec le téléphone de Julien
  donne la confirmation WhatsApp (numéro, lien de la commande) ; l'expédition avec un suivi donne son message ; STOP,
  puis une nouvelle commande : rien, la carte compte un désabonné ; l'exemple `customers/redact` envoyé par la CLI est
  refusé en 401 (domaine `shop.myshopify.com`, inconnu : mesuré au lot 0, la CLI ne vise jamais une vraie boutique,
  donc l'effacement d'un client se prouve par test) ; désinstaller l'app met la carte en « coupée » ; « Couper »
  efface le branchement.
- **Lot 2** : délai à 15 min ; un checkout rempli avec le téléphone de Julien et laissé impayé donne la relance, dont
  le lien rouvre le panier ; un second checkout payé avant 15 min ne donne rien.

## Hors périmètre

App publique de l'App Store, plusieurs boutiques par espace, import des clients existants, case de consentement au
checkout, deuxième relance, réglage des messages depuis la console, message à la création d'une commande non payée.
