# Le chiffre d'affaires attribué (Shopify) (design)

Cadré avec Julien le 2026-10-28, en rondes de questions, après la comparaison avec les MCP de Wax et de Kanal. Les deux
répondent à « combien j'ai généré le mois dernier ? » et « quelle campagne a le plus rapporté ? » ; nous non. C'est la
première question d'un e-commerçant, et la preuve de valeur qui fait passer de la Free au Pro.

## Pourquoi

Un marchand Shopify branché sur Messaging Me doit pouvoir demander à son assistant, ou lire dans la console, ce que ses
envois WhatsApp ont rapporté : en tout, par source, et ce que la relance de panier a récupéré. Kanal le vend en offre
Scale (149 €/mois) ; chez nous il est dans toutes les offres.

**Succès** : sur la boutique de dev, une campagne envoyée à un numéro de test, puis une commande payée de ce numéro, et
un panier relancé puis payé, apparaissent avec leur montant, leur source et leur preuve, dans l'outil MCP et dans
Quantitatif > Shopify.

## Ce que Shopify dit, et ce qu'il ne dit pas

- **Qu'un client a acheté : oui.** `orders/paid` (signé, déjà reçu) porte la commande payée, son montant, sa devise, le
  téléphone saisi et le jeton du panier (`checkout_token`).
- **Qu'il est passé par une discussion : non.** Shopify ne sait rien de nos conversations. Le lien, c'est nous qui le
  faisons : le numéro de la commande rapproché du contact à qui on a écrit. C'est une concordance dans le temps, pas une
  causalité, et l'écran le dit.
- **Une vraie preuve existe dans deux cas** : le panier relancé puis payé (même jeton de panier), et la visite que
  Shopify rattache à nos liens par leurs paramètres UTM (`landing_site` de la commande, ou le parcours client de l'API
  GraphQL). En Europe, un visiteur qui refuse les cookies ne laisse pas de parcours : cette preuve est sous-estimée.

## La règle d'attribution (décisions de Julien)

Une commande **payée** dont le numéro correspond à un **contact existant** de l'espace est attribuée à UNE source, dans
cet ordre :

1. **Elle paie un panier relancé** (même `checkout_token` qu'un panier dont la relance est partie) : à la **relance de
   panier**, même si un autre envoi a suivi (décision de Julien : « montant récupéré » et la ligne « relance de panier »
   sont le même chiffre). Prouvée.
2. **Shopify rattache sa visite à un de nos liens** (UTM, voir plus bas) : au **dernier envoi livré à ce contact du
   modèle que nomme l'UTM**, parmi les envois des sources, sans limite de fenêtre. Prouvée : Shopify prouve que la visite
   vient de notre lien WhatsApp ; la source, elle, se déduit (un lien appartient à un modèle, pas à un envoi). *Mon
   choix* : elle passe devant le dernier envoi, par cohérence avec la règle du panier. Si aucun envoi d'une source ne
   porte ce modèle (une confirmation, un envoi par l'API), la règle 3 s'applique.
3. **Sinon, au dernier envoi LIVRÉ** au contact dans les **5 jours** qui précèdent le paiement (décisions de Julien :
   l'envoi reçu suffit, le clic n'est pas exigé ; fenêtre fixe, la même pour tous ; le dernier envoi prend tout). Non
   prouvée.
4. Sinon : la commande n'est pas attribuée, et rien ne s'enregistre.

**Les sources** (décision de Julien) : les **campagnes** (par campagne), la **relance de panier** Shopify, les
**scénarios** et l'**agent IA**.

*Mes choix, à relire* :
- **L'agent de Meta** (origine `mba`) compte comme l'agent IA (origine `ia`), sur une ligne à lui : « Agent de Meta ».
  C'est aussi un agent qui vend, et un produit que nous configurons.
- **Ne sont jamais une source** : la confirmation de commande et le suivi d'expédition (la commande les déclenche), les
  réponses de l'équipe (`humain`), une réponse dictée à Claude (`mcp`), l'API (`api`), **et les modèles envoyés à un
  contact par l'API ou par Claude** (`POST /v1/sends`, `send_template_to_contact` : lignes `[API] …` de Campagnes,
  `PREFIXE_ENVOI_API`), qui arrivent pourtant en origine `campagne`. La règle du dernier envoi ne regarde que les
  envois des sources.
- **Une campagne qui lance un scénario** est créditée à la **campagne** (c'est elle que le marchand a lancée), bien que
  ses messages soient écrits en origine `scenario` (`src/campaign/engine.ts`).
- 🔴 **L'origine `campagne` ne suffit donc pas** à reconnaître une source : vraies campagnes, messages Shopify (une
  ligne `campaigns` par message, « Shopify · commande payée · #1002 », « Shopify · panier abandonné ») et envois
  `[API]` la partagent. Une campagne se reconnaît par sa ligne `campaigns` et ses destinataires
  (`campaign_recipients`), pas par l'origine du message.
- **« Livré »** = le statut du message sortant est `delivered` ou `read` (`conversation_messages.statut`). Un envoi
  `sent` seulement, ou `failed`, ne compte pas. **Exception** : un numéro relié par l'application (filière
  `application`) ne reçoit jamais d'accusé, donc jamais de statut ; ses envois comptent dès qu'ils sont partis sans
  échec, sinon ces espaces liraient toujours 0.
- **Les commandes de test** (`test: true`, passerelle de test de Shopify) ne comptent pas dans le chiffre ; l'outil
  et l'écran les annoncent à part (« n commandes de test, non comptées »), ce qui permet aussi l'essai réel.
- **Les scénarios comptent en bloc en v1** : `conversation_messages` ne dit pas QUEL scénario a envoyé. Le détail par
  scénario demande d'écrire l'identifiant du scénario sur chaque message sortant ; il part au `todo.md`.

**Le montant** (décision de Julien) : le total payé (TTC, livraison comprise) dans la **devise de la boutique**
(`total_price_set.shop_money`, que le schéma ne lit pas encore : il ne lit que `presentment_money`). Les remboursements
et les annulations **ne sont pas déduits** en v1 : le chiffre s'appelle « brut » partout où il s'affiche.

**À partir du déploiement** (décision de Julien) : aucune relecture de l'historique des commandes.

## La preuve par UTM

- La redirection des liens tracés (`/r/:code` et `/r/:code/:jeton`, `src/http/links.ts`) ajoute à la destination
  `utm_source=whatsapp`, `utm_medium=messagingme` et un `utm_campaign` qui porte le **nom du modèle** : c'est tout ce
  que la redirection connaît (`DestinationLien` : l'espace et la destination ; un lien tracé appartient au bouton d'un
  modèle, partagé par toutes les campagnes qui l'emploient). La source se retrouve à la réception de la commande
  (règle 2). Un lien sans jeton (modèle ancien) marche aussi : la preuve ne dépend pas du jeton, le contact vient du
  numéro de la commande. **Jamais `uchat`** ni aucun nom de l'infra (règle de communication externe).
- *Mon choix* : seulement pour un espace qui a une boutique Shopify branchée, et sans jamais écraser un `utm_*` déjà
  présent dans la destination. Changer les adresses de tous les clients sans raison serait un changement de
  comportement public.
- **Mesuré le 2026-10-28 (lot 0, commande #1003 de la boutique de dev)** : le corps d'`orders/paid` ne porte QUE la
  page d'arrivée de la PREMIÈRE visite (`landing_site`, ici la page du mot de passe de la boutique de dev), et le
  parcours client n'y est pas encore calculé (`ready: false`). Shopify le calcule ensuite, en un quart d'heure environ :
  sa DERNIÈRE visite porte bien nos trois UTM (`customerJourneySummary.lastVisit.utmParameters`, API `2026-10`, lu par
  `gid://shopify/Order/<id du webhook>`, coût 4). Les accusés de livraison des messages, agent de Meta compris, sont
  présents sur tous les messages des trois derniers jours.
- **Décision de Julien (même jour) : une RELECTURE DIFFÉRÉE.** À la réception, une commande d'une fiche existante dont
  le panier relancé n'est pas en cause programme une tâche de fond, 30 minutes plus tard. Elle relit le parcours de la
  commande chez Shopify (le jeton de l'app de la boutique) ; si la dernière visite vient de nos UTM, la vente devient
  PROUVÉE et revient à la dernière touche du modèle nommé (règle 2), qu'elle ait été enregistrée ou non à la réception.
  Un parcours pas encore prêt se relit plus tard, quelques fois. La preuve `panier` ne se remplace jamais. Le chiffre
  d'une commande peut donc changer dans sa première heure, jamais après.
- *Mon choix* : une vente prouvée par UTM qui n'avait pas été enregistrée à la réception (aucune touche dans la
  fenêtre) n'est créée que si la fiche est encore vivante (ni supprimée, ni anonymisée) : une demande d'effacement
  arrivée entre-temps ne doit pas recréer de lien vers la personne.

## Ce qui s'enregistre

- Une ligne par commande attribuée : l'espace, l'identifiant de commande Shopify (idempotence : `orders/paid` peut
  arriver deux fois), le contact, le montant et sa devise (jamais en flottant), la date de paiement, la source et son
  identifiant (la campagne, par exemple), la preuve (`panier`, `utm` ou aucune).
- **L'attribution se calcule à la réception, puis elle est figée** (sauf la preuve par UTM, qui peut la reprendre dans
  sa première heure, voir plus haut). Les chiffres d'un mois passé ne bougent plus quand
  des messages sont purgés ou qu'un contact est supprimé.
- **Une commande d'un inconnu ne crée jamais de fiche** (elle compterait dans la limite de l'offre) et ne laisse aucune
  trace.
- 🔴 **L'enregistrement ne dépend PAS du message de confirmation.** Aujourd'hui `servir` (`src/shopify/traitement.ts`)
  s'arrête avant tout si la confirmation n'est pas active, et `shopify_commandes` ne s'écrit que pour un envoi.
  L'attribution passe avant ce retour, ou à côté.
- 🔴 **Les envois Shopify sont rangés en `campagne`** : ils partent par l'envoi public (`lancerEnvoiPublic`), donc par
  le moteur de campagne, qui crée une ligne `campaigns` par message. L'attribution reconnaît la relance (source) et
  écarte la confirmation et l'expédition (jamais source), sans se fier à l'origine seule.
- **Effacer une personne n'efface pas le fait** (doctrine des clics, migration 0106) : à la suppression d'un contact ou
  sur `customers/redact`, l'identifiant de commande et le lien vers la personne disparaissent, le montant, la devise, la
  date et la source restent. Un chiffre déjà lu ne change pas rétroactivement.
- **La boutique qui disparaît** (`shop/redact`, désinstallation d'une boutique de la console, branchement d'une autre
  boutique) : `effacerBranchement` efface aujourd'hui toutes les tables `shopify_*` de l'espace. Les commandes
  attribuées y perdent leurs identifiants de commande et leurs contacts, et restent anonymes : l'historique survit.
  *Mon choix* : la table n'entre donc pas dans l'effacement en bloc, elle y est ANONYMISÉE. Les totaux se font
  toujours **par devise**, jamais en mélangeant deux devises (une autre boutique peut en avoir une autre).
- **Les paniers ne sont gardés que 7 jours** (`purgerPaniers(7)`, `src/worker.ts`, ils portent un téléphone) et un
  rebranchement les efface (`connecter`). *Mon choix* : la rétention ne bouge pas. Un **compteur anonyme** des relances
  parties (espace, jour, nombre) se tient à part ; la commande attribuée à une relance garde la date de cette relance.
  « Relancés », « récupérés » et « montant récupéré » se comptent alors tous **par date de relance**, sur n'importe
  quelle période, et ne se contredisent pas. La règle 1 tient dans ces 7 jours : la relance part une heure environ après
  le panier, et la fenêtre fait 5 jours.
- 🔴 La purge RGPD nommera cette table : migration bloquante, poussée SEULE et appliquée avant que son code n'arrive
  sur `main` (règle du dépôt). Elle part en `migration=avant` : le chemin du webhook l'écrit.

## Où le chiffre se lit

Toutes les offres y ont droit (décision de Julien). La Free n'a pas de console : elle l'a par l'outil MCP.

1. **Un outil MCP de lecture** (*nom proposé* : `get_revenue_stats`, comme ses voisins `get_campaign_stats`,
   `get_message_stats`, `get_ai_stats`), sans fonction d'offre : sur une période (défaut 30 jours), le chiffre brut,
   dont prouvé, le nombre de commandes, la répartition par source (chaque campagne par son nom), et les paniers :
   relancés, récupérés, montant récupéré. Il dit sa règle en clair, pour que l'assistant ne présente pas une
   concordance comme une causalité.
2. **Quantitatif > Shopify** dans la console (Pro et Entreprise, fonction `statistiques` comme ses voisines), **visible
   seulement quand une boutique est branchée** (décision de Julien : « dans la section des KPI quanti »). Les mêmes
   chiffres, avec le sélecteur de période des pages voisines, et la règle en une phrase sous le chiffre principal
   (« commandes payées dans les 5 jours après un message reçu, remboursements non déduits »).
3. **La page Shopify** (`ReglageShopify`) : sa ligne des paniers sur 7 jours gagne « récupérés » et « montant
   récupéré ».

*Ma lecture* : « Tableau de bord », coché par Julien, désigne cette section de Quantitatif ; aucun autre écran n'est
touché. La liste des campagnes n'a pas de colonne de chiffre d'affaires en v1 (non retenue).

## Hors du chantier

- Déduire les remboursements et les annulations.
- Relire l'historique des commandes d'une boutique.
- Les boutiques hors Shopify (une route d'API « déclarer une commande » reste une piste).
- Une fenêtre réglable par espace, un partage entre plusieurs envois.
- Le ROAS (chiffre sur coût Meta), une colonne dans la liste des campagnes, le détail par scénario : au `todo.md`.

**Anti-buts** : deux chiffres qui se contredisent sur le même écran ; une confirmation de commande créditée de la vente
qu'elle confirme ; une fiche créée par une commande ; une concordance présentée comme une preuve.

## Ce qui reste à l'implémenteur

Le nom et la forme exacte de la table, la façon de reconnaître une relance parmi les campagnes Shopify, la requête du
dernier envoi livré (et l'index qui la sert, sur `conversation_messages` dominée par les entrants), le format exact du
`utm_campaign`, le découpage des routes de l'API pour la console.

## Méthode de livraison

**Implémenteur par lot + revue humaine du DIFF** : le chantier touche un webhook de production, une migration que la
purge RGPD nomme, la redirection de tous les liens tracés et un chiffre affiché aux clients.

Lots, dans l'ordre de déploiement :
- **Lot 0, mesure** : sur la boutique de dev, une commande venue d'un lien UTM ; relever `landing_site`, le parcours
  client, `shop_money` et `test` dans le corps reçu. Décide de la preuve par UTM. Et vérifier que les messages de
  l'agent de Meta (origine `mba`, écrits depuis ses échos) reçoivent bien un statut de livraison : sinon la ligne
  « Agent de Meta » resterait vide, et ses envois suivraient l'exception de la filière `application`.
- **Lot 1** : la migration (seule, `avant`), puis l'enregistrement et l'attribution à la réception, et les UTM de la
  redirection.
- **Lot 2** : la route de lecture de l'API et l'outil MCP (catalogue MCP régénéré ; publication du plugin après l'API,
  version montée).
- **Lot 3** : Quantitatif > Shopify et la page Shopify, poussés APRÈS le déploiement de l'API qui porte leur route
  (`npm run aide:carte` pour la barre).

**Essai réel qui clôt le chantier** : sur la boutique de dev branchée à un espace de test, une campagne avec lien tracé
vers un numéro de Julien, un clic, une commande payée par la passerelle de test ; puis un panier abandonné, relancé et
payé. Les deux commandes apparaissent avec leur montant, leur source et leur preuve, dans l'outil MCP et dans
Quantitatif > Shopify. Une commande payée sans envoi préalable n'apparaît nulle part.
