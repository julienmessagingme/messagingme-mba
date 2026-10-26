# Plan : référencement et citations par les IA de la vitrine (app.messagingme.fr)

**Date** : 2026-10-26. **Origine** : le bilan SEO / GEO / sémantique transmis par Julien le même jour.
**Périmètre** : `site/` (vitrine, FR et EN) et ce qui la génère (`scripts/vitrine/`, `docs/aide/fiches/`), plus les
gestes hors dépôt (Search Console, Bing, annuaires). Chaque action est atomique : une page, un élément, l'avant,
l'après, le fichier source à modifier.

## 0. Le bilan confronté au site réel

Le bilan a été écrit en regardant la page d'accueil seule. Une partie de ce qu'il demande existe déjà, une autre
est fausse, et il ne voit pas des défauts réels.

| Recommandation du bilan | État mesuré le 2026-10-26 | Suite |
|---|---|---|
| JSON-LD `Organization` | **Existe** sur l'accueil (adresse, e-mail, 4 réseaux) | Enrichir : description, `alternateName`, `contactPoint` (A1) |
| JSON-LD `SoftwareApplication` | **Existe** sur l'accueil, **sans prix** | Ajouter les offres, sur l'accueil et les tarifs (A2) |
| FAQ + `FAQPage` | **Existe** sur 7 cas d'usage, Développeurs, Tarifs. **Absente** de l'accueil, des 6 fonctionnalités, des 4 secteurs | Lots 2, 3, 4 |
| Pages « cas d'usage » | **Existent** : 7 cas + 5 secteurs. Tous les cas sont orientés développeur (Claude Code) | Fonctionnalités réécrites en problème / solution (lot 3), hub `/solutions/` (N2) |
| Phrase de définition | **Seulement dans `llms.txt`**, aucune page ne dit « Messaging Me est… » | § 1, posée partout à l'identique |
| Étapes « comment ça marche » | Présentes sur 15 pages d'aide et développeurs (`HowTo`), **absentes de l'accueil** | B4 |
| Glossaire | Absent | N1 |
| Comparatifs | Absents | N3, décision D2 |
| Titres H2 littéraux | Confirmé : la plupart des H2 sont des accroches | Lots 2 à 4, page par page |

**Ce que je ne reprends pas du bilan, et pourquoi :**
- « Hébergement en France (Scaleway) » : **faux**. Le pied de page dit « dans l'Union européenne », Scaleway
  Amsterdam. Ne jamais écrire « hébergé en France ».
- `FAQPage` et `HowTo` n'affichent plus d'extrait enrichi chez Google depuis 2023 (réservé aux sites
  gouvernementaux et de santé pour la FAQ, retiré pour HowTo). On les pose pour Bing (donc ChatGPT Search et
  Copilot), Perplexity et les AI Overviews, qui lisent le balisage et le texte, pas pour un affichage Google.
- `SoftwareApplication` ne donne un extrait enrichi Google qu'avec une note (`aggregateRating`). On n'en a pas,
  **on n'en invente jamais** : la note viendra des annuaires (H3).
- Remplacer le H1 slogan de l'accueil : non, il a été choisi. On l'enrichit (D1).
- « Quel est le coût moyen d'une campagne WhatsApp ? » : pas de moyenne inventée, et pas de prix Meta recopié sur
  la vitrine (D3) : on dit qui facture quoi et on renvoie à la grille de Meta.

**Défauts réels que le bilan ne voit pas :**
- **La page « Relance d'un paiement échoué » titre son film « Le welcome message, puis la relance »** (FR et EN),
  recopié de la page d'accueil SaaS (A4).
- **Six descriptions de pages d'aide dépassent 200 caractères** (coupées dans les résultats) (A5).
- **Brevo et Pipedrive** sont affichés comme CRM branchés (accueil, analyse de conversations) alors que
  `features.md` n'en dit rien. Julien l'a précisé (D4) : ils sont reliés par les webhooks ou l'API, pas par un
  connecteur. HubSpot et Salesforce (et Batch) ont un connecteur. Les textes le disent ainsi.
- **Aucune page « hub » des solutions** : le pied de page envoie « Solutions » sur la page SaaS, et `/industries/`
  est une page « en construction » en `noindex` (N2).

## 1. La phrase de définition (une seule, partout, au mot près)

C'est l'action la plus rentable pour les IA : la même phrase déclarative, répétée à l'identique, devient celle
qu'elles restituent à « Qu'est-ce que Messaging Me ? ».

> **FR** : Messaging Me est une plateforme conversationnelle française pour WhatsApp et le RCS. Les entreprises y
> envoient leurs campagnes, y répondent à leurs clients avec leur équipe, un agent IA ou le Meta Business Agent, et
> retrouvent dans leur CRM chaque conversation qualifiée : intention, urgence, satisfaction, risque de départ.
>
> **EN** : Messaging Me is a French conversational platform for WhatsApp and RCS. Businesses use it to send their
> campaigns, answer their customers with their team, an AI agent or the Meta Business Agent, and get every
> qualified conversation in their CRM: intent, urgency, satisfaction, churn risk.

Elle ne contient ni détail d'infrastructure ni réassurance technique (positionnement de la vitrine) : elle porte
la conversation, le choix de qui répond et la qualification. Où elle va :

| # | Emplacement | Fichier source |
|---|---|---|
| 1.1 | Pied de page de **toutes** les pages, sous « Simplement conversationnel. », en `<p class="pied-definition">` | `scripts/vitrine/pied.fr.html`, `pied.en.html`, puis `npm run vitrine:entete` |
| 1.2 | `Organization.description` et `SoftwareApplication.description` | `site/index.html` (EN : dictionnaire `accueil.json`) |
| 1.3 | Bloc de citation de tête de `llms.txt` (remplace l'actuel) | `site/llms.txt` |
| 1.4 | Réponse à la première question de la FAQ de l'accueil (B5) | `site/index.html` |
| 1.5 | Première ligne du README du plugin (GitHub est lu par les modèles) | `plugin/README.md` |
| 1.6 | « À propos » de LinkedIn, YouTube, et de la chaîne WhatsApp | hors dépôt, Julien |

## 2. Règles de fabrication (valables pour chaque action)

- **Pages écrites à la main** (accueil, 6 fonctionnalités, tarifs, contact, développeurs) : on modifie la page
  française ; chaque phrase française changée ou ajoutée entre dans le dictionnaire `scripts/vitrine/anglais/<page>.json`
  (l'ancienne entrée en sort, `tests/vitrine-anglais.test.ts` refuse une entrée morte), puis `npm run vitrine:anglais`.
  Exception : `en/developers/` s'écrit à la main.
- **Cas d'usage et secteurs** : textes FR et EN dans `scripts/vitrine/cas-textes.ts` et `secteurs-textes.ts`, puis
  `npm run vitrine:cas`. Jamais la page à la main (`tests/vitrine-cas.test.ts`).
- **Aide** : la fiche `docs/aide/fiches/*.md` est la source, puis `npm run vitrine:aide`, version `en/` retraduite,
  `aide:charger` en production après le push.
- **En-tête et pied** : gabarits `scripts/vitrine/entete.*.html`, `pied.*.html`, puis `npm run vitrine:entete`.
- **Toute page indexable ajoutée** entre dans `site/sitemap.xml` (`tests/vitrine-langues.test.ts` l'exige) et dans
  `site/llms.txt`.
- **FAQ** : toujours le composant existant (`<section class="f-bloc cas-faq" id="faq">`, `<div class="dev-faq">`,
  `<details><summary>`), et un `FAQPage` dont les questions sont **mot pour mot** celles affichées.
- Aucun tiret cadratin ni demi-cadratin (`tests/vitrine-langues.test.ts`).

## Lot 1 : corrections sans décision (environ une demi-journée)

**A1. `Organization` enrichie** (`site/index.html`, bloc `@graph`). Ajouter :
```json
"alternateName": "MessagingMe",
"description": "<phrase du § 1>",
"contactPoint": { "@type": "ContactPoint", "contactType": "sales", "email": "contact@messagingme.fr",
                  "url": "https://app.messagingme.fr/contact/", "availableLanguage": ["fr", "en"] },
"knowsAbout": ["WhatsApp Business Platform", "RCS Business Messaging", "Marketing conversationnel",
               "Agents IA conversationnels", "Meta Business Agent", "Publicités Click-to-WhatsApp"]
```
et dans `sameAs` la chaîne WhatsApp du pied de page (`https://www.whatsapp.com/channel/0029Va8axlL7NoZvgFgns21j`).
⚠️ L'`@id` est `https://www.messagingme.fr/#organisation` : vérifier que le site WordPress déclare le même `@id`
(H2), sinon la référence pointe dans le vide.

**A2. `SoftwareApplication` avec ses offres** (`site/index.html` et `site/tarifs/index.html`, même `@id`
`https://app.messagingme.fr/#application`). Ajouter `offers` (Free : `price` 0 ; Pro : 49 EUR hors taxes par mois,
`UnitPriceSpecification`, `billingDuration` P1M, `valueAddedTaxIncluded` false ; Pro annuel : 490 EUR, P1Y),
`featureList` (les six fonctionnalités, mêmes libellés que le menu), `screenshot`
(`/img/partage/accueil.jpg`), `softwareHelp` (`/aide/`). Les prix viennent de `PRIX_PRO_HT_CENTIMES`
(`src/offres/offres.ts`) et sont gardés par G6.

**A3. Retirée.** Les « 30 secondes » des titres de film restent partout, quelle que soit la durée exacte du film :
c'est une promesse (« ça va vite »), pas une mesure (Julien, 2026-10-26). Aucune action, aucun test ne les
corrige.

**A4. Titre du film de la relance de paiement** (`cas-textes.ts` l. 657, et son jumeau anglais « The welcome, then
the recovery ») : « Le welcome message, puis la relance : 30 secondes. » → « La carte refusée, puis le paiement
réussi : 30 secondes. » La page parle de la relance, son film ne s'annonce plus par le welcome message.

**A5. Descriptions des pages d'aide** : `aide.ts` (l. 252) lit `s.description ?? s.chapeau` ; un champ
`description:` (155 caractères au plus) entre dans l'en-tête des fiches publiques trop longues :

| Fiche | Longueur | Description proposée |
|---|---|---|
| ce-qu-il-faut-chez-meta | 223 | Ce qu'il faut chez Meta pour brancher WhatsApp : un compte Meta Business, un portefeuille, un numéro libre, puis une carte après la connexion. |
| connecter-mon-numero-whatsapp | 219 | Connecter un numéro WhatsApp à Messaging Me depuis la fenêtre de Meta, en obtenir un si besoin, puis lire l'état du numéro. |
| choisir-mon-offre | 203 | Free, Pro ou Entreprise : ce que chaque offre de Messaging Me ouvre, ses limites, et comment passer en Pro ou gérer l'abonnement. |
| me-reperer-dans-la-console | 229 | Console, Inbox et Performance Lab : les trois onglets de la console Messaging Me, ce que chacun range, et où sont le compte et les paramètres. |
| lancer-une-campagne | 234 | Lancer une campagne WhatsApp ou RCS en cinq étapes : le nom, le canal, le contenu, l'audience, puis le récapitulatif et l'envoi. |
| la-fenetre-de-24-heures | 98, sans mot-clé | La fenêtre de 24 heures de WhatsApp : quand un message libre est permis, quand il faut un modèle approuvé, et pourquoi un envoi est refusé. |

Fait au lot 1 (2026-10-26) : les sept fiches publiques au-delà de 160 caractères, en FR et en EN (les cinq ci-dessus
moins la fenêtre de 24 heures, qui tient, plus `faire-approuver-un-modele` et `brancher-ma-boutique-shopify` publiées
depuis), et la page `solutions/shopify/` (`boutique-textes.ts`). `tests/vitrine-seo.test.ts` refuse désormais toute
description de plus de 160 caractères sur une page indexable.

**A6. Ordre des titres de l'aide** : la colonne de navigation porte deux `<h3>` (« Démarrer », « Parler aux
clients ») AVANT le premier `<h2>` du contenu. Les passer en `<p class="aide-nav-titre">` dans `aide.ts`
(gabarit de la navigation). Vaut pour les 20 pages d'aide et les 4 pages « Depuis Claude Code ».

**A7. Reportée.** `lastmod` du plan du site : les entrées de l'aide n'en ont pas, les autres sont écrites à la main.
Tirer la date du dernier commit ne tient pas : la CI clone sans historique, et `sitemapAvecAide` doit rendre la même
chose partout. Une date écrite à la main dérive. À reprendre seulement si la Search Console montre un besoin.

**A8. Deux images de tête sans texte** (`fonctionnalites/whatsapp-et-rcs`, `canaux-tel-whatsapp.webp` et
`canaux-tel-rcs.webp`, `alt=""`) : « Une campagne reçue sur WhatsApp » et « La même campagne reçue en RCS ». Les
autres `alt=""` des fonctionnalités sont des doublons décoratifs, corrects.

**G. La garde mécanique : `tests/vitrine-seo.test.ts`** (posée dans ce lot, elle tient tous les suivants) :
- G1 chaque bloc JSON-LD de chaque page se lit en JSON ;
- G2 les questions d'un `FAQPage` sont exactement les `<summary>` de la page, ni plus ni moins ;
- G4 la phrase du § 1 est identique dans `pied.fr.html`, `Organization.description` et `llms.txt` (et EN) ;
- G5 aucune `meta description` au-delà de 160 caractères ;
- G6 les prix du JSON-LD valent `PRIX_PRO_HT_CENTIMES`.
Chaque cas vérifié dans les deux sens (défaut remis, échec vu, restauré).

## Lot 2 : l'accueil (`site/index.html`, EN par `accueil.json`)

**B1. H1** (D1) : `<h1>Transformez chaque conversation en levier de performance.</h1>` →
`<h1><span class="f-surtitre">Plateforme WhatsApp et RCS</span> Transformez chaque conversation en levier de
performance.</h1>`. Le slogan reste le même à l'écran, le H1 porte enfin les deux mots-clés, comme sur toutes les
autres pages.

**B2. H2**

| Actuel | Proposé |
|---|---|
| Deux canaux, une seule conversation. | WhatsApp et RCS : deux canaux, une seule conversation. |
| Tout ce que vous pilotez depuis Messaging Me. | Six fonctionnalités WhatsApp et RCS dans une seule console. |
| Branchez Messaging Me sur votre système. | API et serveur MCP : branchez Messaging Me sur votre système. |
| Ils nous font confiance | inchangé |

**B3. Logos clients reliés à leur secteur** (maillage interne) : Odalys → `/solutions/voyage-et-tourisme/` ;
Groupama, Gan, Mieux Assuré → `/solutions/assurance/` ; Groupe EDH, NEOMA → `/solutions/enseignement-superieur/`.
DPD et Picoty restent sans lien. Option : ajouter Keolis (cas publié sur la page transport), si le logo est autorisé.

**B4. Section « Démarrer en trois étapes »**, entre « Fonctionnalités » et « API », en `<ol>` :
1. **Créez votre espace** : gratuitement, avec votre compte Google, sans formulaire.
2. **Connectez votre numéro WhatsApp** depuis la fenêtre de Meta ; pas de numéro, nous en fournissons un.
3. **Choisissez qui répond, puis lancez votre première campagne** : votre équipe dans l'Inbox, un agent IA ou le
   Meta Business Agent.
Liens : `/aide/ce-qu-il-faut-chez-meta/`, `/aide/connecter-mon-numero-whatsapp/`, `/aide/lancer-une-campagne/`.

**B5. Section « Questions fréquentes »** en bas de page (avant le pied), avec `FAQPage` :

| Question | Réponse (à relire par Julien) |
|---|---|
| Qu'est-ce que Messaging Me ? | La phrase du § 1. |
| Quelle différence entre WhatsApp et le RCS ? | WhatsApp est une application ; le RCS est la messagerie enrichie de l'application de messages du téléphone, sans rien à installer : logo vérifié, images, carrousels, boutons. Messaging Me envoie sur l'un, l'autre, ou les deux avec repli. |
| Qu'est-ce que le fallback entre WhatsApp et le RCS ? | À la création d'une campagne, l'option « WhatsApp et RCS, avec repli » envoie d'abord sur le canal choisi ; si l'envoi échoue, le message repart aussitôt sur l'autre. Personne ne reçoit deux fois le même message. |
| Qui répond à mes clients ? | Vous choisissez : votre équipe dans une Inbox partagée, un agent IA avec vos règles et vos connaissances, ou le Meta Business Agent (sur WhatsApp). Chacun peut passer la main à l'autre. |
| Comment relier WhatsApp à HubSpot ou à mon CRM ? | Le connecteur HubSpot synchronise les contacts, permet de cibler une liste HubSpot dans une campagne, de déclencher un scénario sur une étape de deal, et renvoie l'analyse de chaque conversation dans HubSpot. Salesforce a aussi son connecteur ; Brevo, Pipedrive et les autres CRM se relient par les webhooks ou l'API de Messaging Me. |
| Combien coûte Messaging Me ? | La Free est gratuite (1 000 messages envoyés par mois, l'API et le serveur MCP compris) ; le Pro coûte 49 € HT par mois pour une équipe dans la console ; l'Entreprise est sur devis. Meta facture ses messages directement à votre entreprise, selon sa grille (lien), et Messaging Me ne prend aucune commission dessus. |
| Où sont hébergées les données ? | Dans l'Union européenne, chez Scaleway. ⚠️ À publier une fois la bascule Scaleway faite. |

Fait au lot 2 (2026-10-26), avec trois écarts :
- le titre des fonctionnalités est « Les fonctionnalités WhatsApp et RCS que vous pilotez depuis Messaging Me. » : la
  proposition « … dans une seule console » répétait le sous-titre « Six briques dans une seule console » ;
- l'étape 1 dit « avec votre compte Google ou une adresse e-mail » : l'inscription de la console offre les deux ;
- la question sur l'hébergement attend la bascule Scaleway, la FAQ en a donc six.
Les chiffres de la réponse sur le prix portent `data-offre` comme la page des tarifs, et `tests/vitrine-seo.test.ts`
les compare au code, ainsi que chaque réponse affichée à sa réponse balisée.

## Lot 3 : les six fonctionnalités, page par page

Pour chaque page : un titre de page qui porte le mot-clé, des H2 littéraux, une FAQ de 4 questions (la première
est la définition, donc citable telle quelle), des liens « Pour aller plus loin ». Les pages passent de 216 à 510
mots à environ 600 à 900.

### `fonctionnalites/campagnes-et-scenarios/`
- **Title** : « Campagnes push et scénarios conversationnels · Messaging Me » → « Campagnes WhatsApp et RCS et scénarios · Messaging Me ».
- **H2** : « Tout le scénario en 30 secondes. » → « Le film : une campagne WhatsApp et son scénario, en 30 secondes. » ;
  « De la campagne à la conversation. » → « Créer une campagne WhatsApp ou RCS, puis répondre dans l'Inbox. » ;
  « Des scénarios qui répondent pour vous. » → « Quatre exemples de scénarios : panier abandonné, retour en stock, arrivée anticipée, déclaration de sinistre. » ;
  « Sans une ligne de code. » → « Un constructeur de scénarios sans code. »
- **FAQ** : Qu'est-ce qu'un scénario conversationnel ? · Faut-il un modèle approuvé par Meta pour lancer une campagne WhatsApp ? · Peut-on cibler une liste HubSpot ? · Que se passe-t-il quand un client répond STOP ?
- **Liens** : `/aide/lancer-une-campagne/`, `/aide/faire-approuver-un-modele/`, glossaire `#modele`, `#scenario`.

### `fonctionnalites/publicites-click-to-whatsapp/`
- **Title** : « Publicités Click-to-WhatsApp · Messaging Me » → « Publicités Click-to-WhatsApp et coût par lead · Messaging Me ».
- **H2** : « Avant, une pub Click-to-WhatsApp, c'était sans fin. » → « Pourquoi une pub Click-to-WhatsApp demandait deux outils. » ;
  « Fini les pubs qui atterrissent sur une landing page. » → « Click-to-WhatsApp plutôt qu'une landing page. » ;
  « Tout le parcours en 30 secondes. » → « Le film : de la publicité au prospect sur WhatsApp, en 30 secondes. » ;
  « Trois étapes, sans changer d'outil. » → « Créer une publicité Click-to-WhatsApp en trois étapes. » ;
  « Chaque euro suivi jusqu'à la conversation qualifiée. » → « Coût par clic, coût par lead (CPL) et coût par conversation qualifiée. »
- **FAQ** : Qu'est-ce qu'une publicité Click-to-WhatsApp ? · Les messages sont-ils gratuits après le clic ? (oui, 72 heures, déjà dit sur la page) · Faut-il un compte publicitaire Meta ? · Comment se calcule le coût par lead ?
- **Liens** : `/fonctionnalites/pilotage-des-couts/`, fiche « Lancer une publicité » si publiée (C6), glossaire `#click-to-whatsapp`, `#cpl`.

### `fonctionnalites/chaines-whatsapp/`
- **Title** : « Chaînes WhatsApp · Messaging Me » → « Chaînes WhatsApp pour les entreprises · Messaging Me ».
- **H2** : « Tout le parcours en 30 secondes. » → « Le film : de la publication à la conversation, en 30 secondes. » ;
  « De la publication à la conversation. » → « Publier sur une chaîne WhatsApp, puis ouvrir une conversation. » ;
  « Sachez ce que chaque publication déclenche. » → « Mesurer les conversations ouvertes par chaque publication. »
- **FAQ** : Qu'est-ce qu'une chaîne WhatsApp ? · Publier sur une chaîne est-il payant ? (non, dit sur la page) · Comment parler en privé à un abonné ? · Qui répond quand l'abonné écrit ?
- **Liens** : fiche « Publier sur ma chaîne » si publiée (C6), `/solutions/transport-et-mobilites/` (cas Keolis, chaînes), glossaire `#chaine`.

### `fonctionnalites/conversations-en-actions/` (la plus mince : 216 mots)
- **Title** : « Analyse de conversations · Messaging Me » → « Analyse IA des conversations WhatsApp et RCS · Messaging Me ».
- **H2** : « Vos commerciaux détestent remplir le CRM. » → « Le problème : un CRM que personne ne remplit. » ;
  « Tout le parcours en 30 secondes. » → « Le film : de la conversation à la tâche dans le CRM, en 30 secondes. » ;
  « Analysée, puis transformée en action. » → « Intention, urgence, satisfaction, risque de départ : ce que mesure l'analyse. » ;
  le bandeau des logos reçoit un H2 « Les CRM reliés : HubSpot, Salesforce, Brevo, Pipedrive. »
- **FAQ** : Qu'est-ce que l'analyse de conversation ? · Quels critères sont mesurés ? · Dans quels CRM arrive l'analyse ? (HubSpot et Salesforce par leur connecteur, Brevo, Pipedrive et les autres par les webhooks ou l'API) · Que devient une conversation analysée ? (une tâche confiée à la bonne personne)
- **Liens** : glossaire `#analyse`, `/fonctionnalites/campagnes-et-scenarios/`, secteur Assurance (relais réseau).

### `fonctionnalites/whatsapp-et-rcs/` (228 mots)
- **Title** : « WhatsApp et RCS, avec fallback · Messaging Me » → « Campagnes WhatsApp et RCS avec fallback · Messaging Me ».
- **H2** : « Choisir un canal, c'est perdre une partie de vos clients. » → « Pourquoi envoyer sur WhatsApp et le RCS. » ;
  « Tout le parcours en 30 secondes. » → « Le film : du choix du canal à la réponse, en 30 secondes. » ;
  « Dans le sens que vous voulez. » → « Régler le fallback WhatsApp vers RCS, ou RCS vers WhatsApp. »
- **Ajout** : un bloc « Qu'est-ce que le RCS ? » de trois phrases, repris du film RCS (logo vérifié, images et
  carrousels, boutons d'un appui, opt-in du client).
- **FAQ** : Qu'est-ce que le RCS ? · Qu'est-ce que le fallback ? · Un client peut-il recevoir deux fois le message ? (non) · Où arrivent les réponses ?
- **Liens** : film RCS de l'accueil, glossaire `#rcs`, `#fallback`.

### `fonctionnalites/pilotage-des-couts/`
- **Title** : « Pilotage des coûts · Messaging Me » → « Coût par lead et coût des campagnes WhatsApp · Messaging Me ».
- **H2** : « Tout le pilotage en 30 secondes. » → « Le film : le coût de chaque campagne et de chaque pub, en 30 secondes. » ;
  « Et le reste, au même endroit. » → « Le coût de l'IA, par jour et par modèle. »
- **FAQ** : Qu'est-ce que le coût par engagement ? · Comment se calcule le coût par lead (CPL) ? · Le coût affiché est-il la facture de Meta ? (non, une estimation, dit sur la page) · Qui facture les messages WhatsApp ? (Meta, selon sa grille, par pays et par catégorie de message ; lien vers la grille, aucun chiffre recopié, D3)
- **Liens** : `/tarifs/`, `/fonctionnalites/publicites-click-to-whatsapp/`, glossaire `#cout-par-engagement`, `#cpl`.

Fait au lot 3 (2026-10-26), avec ces écarts :
- les liens vers le glossaire attendent le glossaire (lot 5) : chaque page en a trois vers des pages qui existent
  (aide, intégrations, secteurs, tarifs), en `p.cas-voisins` dans l'appel final, comme les pages de cas ;
- le bloc « Qu'est-ce que le RCS ? » de `whatsapp-et-rcs` est devenu la première question de sa FAQ ;
- le H2 des logos CRM de `conversations-en-actions` n'est pas posé : le bandeau n'a pas de titre aujourd'hui, en
  ajouter un est un changement de mise en page, pas de texte ;
- sur `pilotage-des-couts`, « Qui facture les messages WhatsApp ? » est couvert par « Le coût affiché est-il la facture
  de Meta ? », et la quatrième question devient « Le coût de l'IA est-il compté à part ? » ;
- sur quatre pages (chaînes, analyse, WhatsApp et RCS, publicités), le titre du film prend le nom de la
  fonctionnalité (« Le film : les chaînes WhatsApp, en 30 secondes. ») : le titre proposé répétait le sous-titre.
Toutes les réponses viennent du texte déjà publié sur leur page (ou, pour les CRM, de la décision D4).
`tests/vitrine-seo.test.ts` compare désormais chaque réponse affichée à sa réponse balisée sur TOUTES les pages à FAQ,
sauf les deux pages développeurs (adresse affichée sans `https://`, voulu).

## Lot 4 : cas d'usage, secteurs, tarifs, aide

**C1. Les quatre titres communs des 7 cas d'usage** (`cas-textes.ts`, `schema.titre` et titres de `cas.ts`). Le
titre du film garde sa fin « : 30 secondes. » :

| Cas | Film (+ « : 30 secondes. ») | Schéma (« Comment ça circule. ») | Prix (« Ce que vous payez. ») |
|---|---|---|---|
| prise-de-rendez-vous | Le film : une prise de rendez-vous sur WhatsApp | Comment fonctionne la prise de rendez-vous sur WhatsApp. | Combien coûte la prise de rendez-vous sur WhatsApp. |
| rappels-rendez-vous | Le film : un rappel de rendez-vous WhatsApp | Comment fonctionne un rappel de rendez-vous WhatsApp. | Combien coûte un rappel de rendez-vous WhatsApp. |
| support-ia-relais-humain | Le film : un agent IA de support qui passe la main | Comment l'agent IA répond, puis passe la main à l'équipe. | Combien coûte un agent IA de support sur WhatsApp. |
| bulle-whatsapp-site-lovable | Le film : une bulle WhatsApp sur un site Lovable | Comment fonctionnent la bulle et l'agent IA. | Combien coûte une bulle WhatsApp avec agent IA. |
| accueil-activation-saas | Le film : le welcome message WhatsApp d'un SaaS | Comment part le welcome message à l'inscription. | Combien coûte un welcome message WhatsApp. |
| relance-paiement-echoue | Le film : la relance d'un paiement échoué | Comment fonctionne la relance d'un paiement échoué. | Combien coûte une relance de paiement sur WhatsApp. |
| notifications-de-commande | Le film : une notification de commande WhatsApp | Comment part la notification de commande. | Combien coûte une notification de commande WhatsApp. |

« Pas à pas, avec le vrai. » → « Mettre en place, étape par étape. » ; « Questions fréquentes. » → « Questions
fréquentes sur » + le sujet du cas.

**C2. FAQ des quatre secteurs** : nouveau champ optionnel `faq` dans `TexteSecteur` (`secteurs-textes.ts`), rendu
par `cas.ts` comme pour les cas, avec `FAQPage`. Trois questions par secteur, réponses tirées des chiffres déjà
publiés sur la page :
- **Assurance** : Comment une compagnie d'assurance utilise-t-elle WhatsApp ? · Peut-on déclarer un sinistre sur WhatsApp ? · Comment passer la main à un conseiller du réseau ? (cas Gan, Groupama, Mieux Assuré)
- **Enseignement supérieur** : Comment une école recrute-t-elle sur WhatsApp ? · Comment répondre à des candidats internationaux ? · Comment répartir les messages entre les équipes ? (cas NEOMA, EDH, EDHEC)
- **Transport et mobilités** : Comment informer les voyageurs avec une chaîne WhatsApp ? · Peut-on répondre aux voyageurs avec une IA ? · Quels résultats ? (cas Keolis : 3 500 abonnés en 3 mois)
- **Voyage et tourisme** : Comment préparer l'arrivée des clients sur WhatsApp ? · Comment proposer des services pendant le séjour ? · Quels résultats ? (cas Odalys : 80 % de lecture des messages de check-in)

**C3. Tarifs** (`site/tarifs/index.html`, EN `tarifs.json`) :
- H2 « Ce que Meta facture. » → « Ce que Meta facture pour chaque message WhatsApp. » Aucun chiffre Meta sur la
  page (D3) : le texte actuel, qui renvoie à la grille, reste.
- Deux questions de plus dans la FAQ : « Qui facture les messages WhatsApp ? » (Meta, directement, sur le moyen de
  paiement du Business Manager, selon sa grille par pays et par catégorie) · « Messaging Me prend-il une commission
  sur les messages facturés par Meta ? » (non, déjà dit sur la page).
- JSON-LD : A2.

**C4. Contact** : ajouter `"@type": "ContactPage"` au JSON-LD de la page (il n'y a que le fil d'Ariane).

**C5. Développeurs** : rien à faire, page la plus solide du site (2 324 mots, FAQ, étapes).

**C6. Publier des fiches d'aide qui existent déjà** : 27 fiches de `docs/aide/fiches/` sont privées, et
plusieurs répondent exactement à des questions qu'on pose aux IA. Candidates :

| Fiche | Requête visée |
|---|---|
| `creer-une-publicite.md` | créer une publicité Click-to-WhatsApp |
| `construire-un-agent-ia.md` | agent IA WhatsApp |
| `le-repondeur-de-meta.md` | Meta Business Agent |
| `publier-sur-ma-chaine-whatsapp.md` | publier sur une chaîne WhatsApp |
| `envoyer-un-message-rcs.md` | envoyer un message RCS |
| `hubspot-sur-l-accueil.md` | intégrer WhatsApp à HubSpot |
| `poser-une-bulle-whatsapp-sur-mon-site.md` | bouton WhatsApp sur un site |

Par fiche : en-tête `publique: oui`, `rubrique`, `rang`, version anglaise, captures (`npm run aide:captures`),
`npm run vitrine:aide`, sitemap, puis `aide:charger` après le push. Une fiche qui cite une section de
`features.md` garde son empreinte (`tests/aide-proposer.test.ts` avant le push). Julien choisit lesquelles.

Fait au lot 4 (2026-10-26), avec ces écarts :
- C1 : le titre « La mise en place, étape par étape. » était déjà littéral, il reste ; les titres de film prennent la
  forme « Le film : <sujet>, en 30 secondes. » (le support IA passe de 38 à 30, la règle des 30 secondes) ; le prix et
  la FAQ se titrent par un champ `titres` de `TexteCas`, que `cas.ts` exige ;
- C2 : trois questions par secteur (champ `faq` de `TexteSecteur`), réponses tirées des cas publiés sur la page,
  chiffres compris, balisées `FAQPage` ;
- C3 : la question « Messaging Me prend-il une commission… » n'est pas posée : `tests/vitrine-pages.test.ts` refuse le
  mot « commission » sur les tarifs (décision du 2026-10-19 sur le crédit IA), et la page dit déjà que Messaging Me ne
  touche pas aux frais de Meta ;
- C6 attend le choix des fiches par Julien (D5), et `aide:charger` en production après la bascule.

## Lot 5 : pages nouvelles

**N1. Glossaire** `/glossaire/` et `/en/glossary/`, JSON-LD `DefinedTermSet` (un `DefinedTerm` par entrée, avec
son ancre). Entrée au menu « Ressources » (que la session voisine est en train d'ajouter) et au pied de page.
Définitions de départ, à relire par Julien :

| Ancre | Terme | Définition | Lien |
|---|---|---|---|
| `#api-whatsapp` | API WhatsApp Business | L'interface officielle de Meta qui permet à une entreprise d'envoyer et de recevoir des messages WhatsApp depuis un logiciel, sur un numéro dédié. | /developpeurs/ |
| `#rcs` | RCS | La messagerie enrichie de l'application de messages du téléphone : logo de marque vérifié, images, carrousels et boutons, sans application à installer. | /fonctionnalites/whatsapp-et-rcs/ |
| `#fallback` | Fallback (repli) | L'envoi de secours : si un message ne peut pas partir sur le premier canal, il repart sur l'autre, sans double envoi. | idem |
| `#modele` | Modèle de message (template) | Un message validé par Meta avant envoi, obligatoire pour écrire hors de la fenêtre de 24 heures. Trois catégories : marketing, utilitaire, authentification. | /aide/faire-approuver-un-modele/ |
| `#fenetre-24-heures` | Fenêtre de 24 heures | La période qui suit le dernier message du client, pendant laquelle l'entreprise peut lui répondre librement. Au-delà, seul un modèle approuvé peut partir. | /aide/la-fenetre-de-24-heures/ |
| `#opt-in` | Opt-in (consentement) | L'accord du client pour recevoir les messages d'une entreprise. Un client qui répond STOP ne reçoit plus rien. | /aide/importer-mes-contacts/ |
| `#click-to-whatsapp` | Publicité Click-to-WhatsApp | Une publicité Facebook ou Instagram dont le bouton ouvre une conversation WhatsApp au lieu d'un site. Son équivalent RCS : Click-to-RCS. | /fonctionnalites/publicites-click-to-whatsapp/ |
| `#chaine` | Chaîne WhatsApp | Un fil de diffusion où une marque publie gratuitement pour tous ses abonnés ; un bouton sous la publication ouvre une conversation privée. | /fonctionnalites/chaines-whatsapp/ |
| `#meta-business-agent` | Meta Business Agent | L'agent IA de Meta, qui répond aux clients sur WhatsApp au nom de l'entreprise. Messaging Me le configure depuis sa console ; Meta le facture à part. | / |
| `#agent-ia` | Agent IA | Un assistant qui répond aux clients avec les connaissances, les règles et les outils de l'entreprise, et passe la main à l'équipe quand il le faut. | /cas-d-usage/support-ia-relais-humain/ |
| `#scenario` | Scénario conversationnel | Une suite de blocs (message, question, formulaire, condition, action) déclenchée par un mot-clé, une campagne, une publicité ou un webhook. | /fonctionnalites/campagnes-et-scenarios/ |
| `#inbox` | Inbox partagée | La boîte de réception commune où l'équipe lit les conversations WhatsApp et RCS et y répond. | /aide/repondre-dans-l-inbox/ |
| `#analyse` | Analyse de conversation | La lecture automatique de chaque conversation (intention, urgence, satisfaction, risque de départ), qui devient une action dans le CRM. | /fonctionnalites/conversations-en-actions/ |
| `#cout-par-engagement` | Coût par engagement | Le coût d'une campagne divisé par le nombre de clients qui ont cliqué ou répondu. | /fonctionnalites/pilotage-des-couts/ |
| `#cpl` | Coût par lead (CPL) | La dépense publicitaire divisée par le nombre de prospects qui ont écrit depuis la publicité. | idem |
| `#mcp` | Serveur MCP | Le point d'entrée qui permet à un assistant IA (Claude, ChatGPT…) d'utiliser les fonctions d'un logiciel : avec celui de Messaging Me, il répond aux clients ou prépare une campagne. | /developpeurs/ |
| `#compte-meta-business` | Compte Meta Business | L'espace Meta de l'entreprise, qui porte son compte WhatsApp, son numéro et la facturation des messages. | /developpeurs/compte-meta-business/ |

**N2. Hub `/solutions/`** et `/en/solutions/` : les 5 secteurs et les 7 cas, une ligne chacun, JSON-LD
`ItemList`. Générée par `cas.ts` (qui construit déjà le carrefour). `/industries/` (et `/en/industries/`)
redirigée en 301 vers lui dans `site/vercel.json` ; le lien « Solutions » du pied de page pointe sur le hub.

**N3. Une page par concurrent** (D2), sous un hub `/comparatif/` (et `/en/comparison/`), JSON-LD `ItemList` sur le
hub, `FAQPage` sur chaque page. Adresse : `/comparatif/alternative-a-<marque>/`. Ordre proposé, du plus cherché au
plus niche, que Julien élague :

| Page | Pourquoi elle |
|---|---|
| `alternative-a-twilio` | la référence CPaaS mondiale, la requête « alternative à Twilio WhatsApp » existe en français |
| `alternative-a-bird` (ex-MessageBird) | cité par le bilan ; l'ancien nom reste dans le texte, c'est lui qu'on cherche |
| `alternative-a-respond-io` | plateforme conversationnelle multicanal, la plus proche de nous en usage |
| `alternative-a-wati` | WhatsApp seul, cible PME, très présent dans les réponses des IA |
| `alternative-a-superchat` | messagerie unifiée, active en France |
| `alternative-a-alcmeon` | l'acteur français du service client conversationnel |

🔴 **Exclues** : **Brevo** (partenaire, voir `docs/prive/PARTENARIAT-BREVO-2026-09.md` : une page « alternative à
Brevo » abîmerait le partenariat) et **360dialog** (notre fournisseur pour une partie des numéros).

**Une seule anatomie pour toutes**, générée depuis un fichier de textes (`scripts/vitrine/comparatifs-textes.ts`,
FR et EN, sur le modèle de `cas-textes.ts`) par `cas.ts` ou un générateur voisin, pour qu'aucune ne dérive :
1. H1 « Alternative à <marque> pour WhatsApp et le RCS : Messaging Me » ; un chapeau de deux phrases.
2. « <Marque> en bref » : ce que l'outil fait, en trois lignes neutres, avec la date du relevé.
3. Un tableau de critères identique d'une page à l'autre : console marketing et Inbox, agents IA, Meta Business
   Agent, analyse des conversations, publicités Click-to-WhatsApp, RCS et repli, modèle de prix, offre gratuite,
   support en français, données dans l'UE, plugin Claude Code et serveur MCP.
4. « Quand choisir <marque> » (dit honnêtement : volumes SMS ou voix mondiaux, équipe de développeurs dédiée…)
   puis « Quand choisir Messaging Me ».
5. FAQ de trois questions (« Messaging Me remplace-t-il <marque> ? », « Peut-on migrer son numéro WhatsApp ? »,
   « Quelle différence de prix ? »), puis l'appel à l'action.

**Règles** : chaque case du tableau sur un concurrent se source sur SA page publique (lien en note) et porte la
date du relevé ; jamais de chiffre de part de marché ni de note inventée ; ton factuel, aucun dénigrement. Une
publicité comparative n'est licite que si elle est objective, vérifiable et porte sur des caractéristiques
essentielles (art. L122-1 du Code de la consommation). Relevé à refaire tous les six mois (date de la page dans le
JSON-LD et le plan du site). Julien relit chaque page avant le push : c'est la face publique la plus exposée.

**N4. Page Intégrations** `/integrations/` : HubSpot et Salesforce (connecteurs), Brevo, Pipedrive et tout CRM par
webhooks ou API (dit ainsi, D4), Shopify, Stripe et Lovable (déjà des cas), Claude Code, API et MCP.

**N5. Plus tard** : un cas d'usage Shopify (« relance de panier abandonné sur WhatsApp », la requête commerciale la
plus forte qui manque), sur le gabarit des cas, film compris.

## Lot 6 : hors du dépôt (Julien)

- **H1. Search Console et Bing Webmaster Tools** : aucune balise de vérification dans les pages ; si la
  propriété n'existe pas (ou pas par DNS), la créer et soumettre `sitemap.xml` aux deux. Bing compte double :
  ChatGPT Search et Copilot s'appuient sur son index.
- **H2. Le site WordPress `www.messagingme.fr`** : qu'il déclare la même `Organization` avec le même `@id`
  (`https://www.messagingme.fr/#organisation`) et la phrase du § 1, et qu'il lie la vitrine avec une ancre
  descriptive (« la plateforme WhatsApp et RCS »), pas « cliquez ici ».
- **H3. Annuaires de logiciels** : fiches Capterra (et GetApp, même groupe), G2, Appvizer, avec la phrase du § 1 et
  quelques avis de vrais clients. Les moteurs IA citent ces pages pour « meilleure plateforme WhatsApp », et c'est
  la seule source honnête d'une note.
- **H4. Profils** : LinkedIn, YouTube, chaîne WhatsApp, README du plugin (§ 1, ligne 1.5 et 1.6).

## Mesure

- **Point de départ, avant le lot 1** : relevé Search Console (impressions et requêtes sur 3 mois) et réponses
  actuelles des IA aux dix questions ci-dessous, copiées dans `docs/prive/`.
- **Les dix questions**, posées à ChatGPT, Perplexity et Gemini, à J+30 puis chaque mois : « Qu'est-ce que
  Messaging Me ? » ; « Quelle plateforme pour envoyer des campagnes WhatsApp et RCS en France ? » ; « Comment faire
  une publicité Click-to-WhatsApp ? » ; « Qu'est-ce que le fallback WhatsApp RCS ? » ; « Comment relier WhatsApp à
  HubSpot ? » ; « Combien coûte un message WhatsApp en France ? » ; « Alternative française à Twilio pour
  WhatsApp » ; « Comment une école peut recruter sur WhatsApp ? » ; « Qu'est-ce que la fenêtre de 24 heures de
  WhatsApp ? » ; « Comment brancher WhatsApp à mon app avec Claude Code ? ». On note : cité ou non, quelle page.
- Le compte HubSpot de Julien propose un suivi des réponses des IA (AEO) : à brancher sur ces dix questions s'il
  est compris dans l'abonnement.

## Décisions de Julien (2026-10-26)

- **D1** : surtitre « Plateforme WhatsApp et RCS » DANS le H1 de l'accueil, slogan inchangé à l'écran (B1).
- **D2** : une page par concurrent (N3), Brevo et 360dialog exclus.
- **D3** : aucun prix Meta recopié sur la vitrine ; les FAQ disent qui facture et renvoient à la grille de Meta.
- **D4** : Brevo et Pipedrive sont reliés par les webhooks ou l'API ; HubSpot et Salesforce par un connecteur. Les
  logos restent, les textes le disent ainsi.
- **D5, encore ouverte** : quelles fiches d'aide publier (C6).

## Ordre et rayon de souffle

- 🔴 **Une session voisine a 87 fichiers non commités dans `site/`, `scripts/vitrine/` et `docs/aide/`** au
  2026-10-26 (menu « Ressources » dans l'en-tête, notamment). Le § 1.1 réécrit le pied de TOUTES les pages par
  `vitrine:entete` : il attend que ce travail soit poussé, sinon les deux se marchent dessus.
- Ordre : lot 1 (corrections, garde) → lot 2 (accueil) → lot 3 (fonctionnalités) → lot 4 → lot 5. Le lot 6 se fait
  en parallèle par Julien ; H1 dès maintenant, parce que la mesure en dépend.
- Un push de `site/` lance la CI de la racine (`tests/vitrine-developpeurs.test.ts` lit la vitrine) : suite racine
  entière avant chaque push, et pas de push pendant la CI d'un pair.
- Qui lit ce qu'on change : `tests/vitrine-*.test.ts` (génération, langues, plan du site, tirets),
  `tests/aide-proposer.test.ts` (fiches), `llms.txt` (à tenir aligné à la main, G4 en garde une partie).

## Méthode de livraison

**En direct**, lot par lot, sans agent, parce que chaque lot est réversible (un revert et Vercel republie la
vitrine), ne touche aucun chemin que la production emprunte (ni envoi, ni webhook, ni migration), et se vérifie
par les tests de génération déjà en place plus la garde `tests/vitrine-seo.test.ts` posée au lot 1. Les deux
invariants invisibles (dictionnaires anglais, gabarits d'en-tête et de pied) sont tenus par leurs propres tests.
Le texte, lui, demande un œil : la raison pour laquelle chaque lot qui change la face publique (accueil,
fonctionnalités, pages nouvelles) est montré à Julien en captures, bureau et téléphone, dans les deux langues,
avant le push. Une relecture indépendante en fin de lot 3, le plus gros.

**Essai réel qui clôt chaque lot** : l'adresse publiée passée au validateur de schema.org et au test des
résultats enrichis de Google (zéro erreur), la page vue en ligne sur téléphone ; et pour l'ensemble, à J+30, les
dix questions de la mesure posées en vrai à ChatGPT, Perplexity et Gemini, comparées au point de départ.
