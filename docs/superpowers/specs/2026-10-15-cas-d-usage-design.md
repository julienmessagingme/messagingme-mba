# Les cas d'usage, les tarifs et la rubrique « Solutions » de la vitrine (lot 6, spec du 2026-10-15)

> Point 6 des décisions du 2026-10-13 (`docs/prive/2026-10-02-engageme-claude-code.md`) : montrer à un développeur et à
> un vibe codeur ce qu'ils peuvent COMBINER avec nos outils, de bout en bout, sur la vitrine et dans la doc
> développeurs, pour les campagnes de publicité à venir et pour les robots (moteurs et IA). Il dépendait du point 7,
> l'audit SEO, fait le 2026-10-15 (`docs/prive/2026-10-15-audit-seo-vitrine.md`). Plan :
> [docs/superpowers/plans/2026-10-15-cas-d-usage.md](../plans/2026-10-15-cas-d-usage.md), à réécrire.
>
> **Rangement revu le 2026-10-16** (troisième ronde, [spec 6 bis](2026-10-16-cas-d-usage-par-profil-design.md)) :
> « Industries » devient « Solutions » (secteurs et métiers), quatre cas ne deviennent pas des pages. Ce document porte
> TOUTES les adresses de la vitrine ; la spec 6 bis porte les profils, les cas ajoutés, le registre et les dépôts.

## Les décisions de Julien (2026-10-15, trois rondes)

| Sujet | Décision |
|---|---|
| Tarifs | La page des tarifs, aujourd'hui « en construction » et fermée aux moteurs, entre dans ce lot |
| Langues | Français et anglais, chaque page en paire, comme la page développeurs |
| Solutions | Une vraie rubrique, **« Solutions »** (2026-10-16), à la place d'« Industries » : trois secteurs et deux métiers (ci-dessous). « Claude Code et Codex » n'est pas une industrie : son contenu va dans « SaaS et app builders » |
| Cas de la première vague | Les sept proposés, réduits le 2026-10-16 à quatre d'entre eux plus trois de la spec 6 bis (ci-dessous) |
| Découpage | Trois livraisons, chacune en ligne dès qu'elle est relue (le découpage se refait au plan réécrit) |
| Format d'une page | Texte, schéma des étapes, vrais extraits de code, ce que l'on paie, courte FAQ, **et un court film** (une page Solutions montre ceux des cas qui la concernent) |
| Langue des films | Une version par langue, depuis la même source |

## Le menu et les pages

Le menu (2026-10-16) : **quatre entrées et un bouton**, le modèle de Twilio et de Brevo.

| Français | Anglais | Ce qu'il contient |
|---|---|---|
| Fonctionnalités | (absent : ces pages n'existent qu'en français) | les six pages actuelles |
| Solutions | Solutions | trois colonnes : **Par secteur** (Assurance, Tourisme, Enseignement supérieur), **Par métier** (SaaS et app builders, Agences), **Par cas d'usage** (les sept cas, puis « Tous les cas d'usage ») |
| Développeurs | Developers | Démarrer avec Claude Code (`/developpeurs/`), Documentation de l'API, Serveur MCP, le plugin et le SDK sur GitHub |
| Tarifs | Pricing | lien direct |
| Se connecter | Sign in | bouton |

Les quatre profils de la spec 6 bis ne sont pas des pages : ce sont les filtres de « Tous les cas d'usage ».

| Page | Français | Anglais |
|---|---|---|
| Carrefour des solutions | `/solutions/` | `/en/solutions/` |
| Secteur : assurance | `/solutions/assurance/` | `/en/solutions/insurance/` |
| Secteur : tourisme | `/solutions/tourisme/` | `/en/solutions/tourism/` |
| Secteur : enseignement supérieur | `/solutions/enseignement-superieur/` | `/en/solutions/higher-education/` |
| Métier : SaaS et app builders | `/solutions/saas-et-app-builders/` | `/en/solutions/saas-and-app-builders/` |
| Métier : agences (porte le cas « dix clients d'un coup ») | `/solutions/agences/` | `/en/solutions/agencies/` |
| Carrefour des cas d'usage, filtré par profil | `/cas-d-usage/` | `/en/use-cases/` |
| Prendre des rendez-vous sur WhatsApp | `/cas-d-usage/prise-de-rendez-vous/` | `/en/use-cases/appointment-booking/` |
| Les rappels de rendez-vous qui évitent les absences | `/cas-d-usage/rappels-rendez-vous/` | `/en/use-cases/appointment-reminders/` |
| Le support client par un agent IA, avec relais à l'équipe | `/cas-d-usage/support-ia-relais-humain/` | `/en/use-cases/ai-support-human-handover/` |
| La bulle WhatsApp et son agent sur un site fait avec Lovable ou v0 | `/cas-d-usage/bulle-whatsapp-site-lovable/` | `/en/use-cases/whatsapp-bubble-lovable-site/` |
| Accueillir et activer les utilisateurs d'un SaaS | `/cas-d-usage/accueil-activation-saas/` | `/en/use-cases/saas-onboarding-activation/` |
| Relancer un paiement échoué | `/cas-d-usage/relance-paiement-echoue/` | `/en/use-cases/failed-payment-recovery/` |
| Les notifications de commande, envoyées par votre application | `/cas-d-usage/notifications-de-commande/` | `/en/use-cases/order-notifications/` |
| Tarifs | `/tarifs/` | `/en/pricing/` |

Quatre cas de la première liste ne deviennent pas des pages : « les leads des publicités jusqu'au CRM » et « une
campagne qui ouvre des conversations » redisent `publicites-click-to-whatsapp`, `conversations-en-actions`,
`campagnes-et-scenarios` et `pilotage-des-couts`, vers lesquelles renvoient les pages de secteur et le carrefour des
cas ; « piloter WhatsApp depuis Claude » devient une section de `/developpeurs/` ; « agence : dix clients d'un coup »
est le cœur de `/solutions/agences/`. Le cas « une demande prise par l'agent IA arrive dans votre application » devient
« prendre des rendez-vous », son exemple le plus parlant (le film 1), et perd son ancienne adresse.

Redirections permanentes (`site/vercel.json`) : `/pricing/` vers `/tarifs/`, `/industries/` vers `/solutions/` (deux
pages `noindex` en ligne aujourd'hui, liées par le menu). Aucune autre adresse de ce tableau n'est publiée au 2026-10-16
(`site/sitemap.xml`) : elles se décident ici, une fois, et une adresse publiée ne se renomme plus sans redirection.

## L'anatomie d'une page de cas d'usage

1. **Le H1 dit le problème** dans les mots de celui qui cherche (« Recevoir dans votre application les demandes que
   l'agent IA prend sur WhatsApp »), jamais le nom d'une de nos fonctionnalités. Titre de 60 caractères au plus,
   description de 155.
2. **Le film**, en tête : 16:9 sur ordinateur, sa version 9:16 au téléphone (`data-vertical`, comme les pages de
   fonctionnalités), affiche et sous-titres dans la langue de la page.
3. **Le schéma des étapes**, un SVG en ligne et accessible (texte réel, pas une image de texte) : chaque brique de
   notre produit et de l'application du client, et ce qui circule entre elles.
4. **Pas à pas, avec le vrai** : les noms d'outils MCP, les routes de l'API, les événements des webhooks, un extrait du
   SDK, et l'invite à coller dans Claude Code. Rien d'inventé : chaque nom cité existe dans le produit (voir les
   garde-fous).
5. **Ce que l'on paie** : l'offre qu'il faut (Free, Pro, Entreprise), ce que Meta facture directement, le crédit IA
   s'il y a un agent. Chaque chiffre porte `data-offre`, comme sur la page développeurs.
6. **Une courte FAQ** (trois à cinq questions réelles), balisée `FAQPage`.
7. **Les liens** : vers les fonctionnalités et la page développeurs qu'il utilise, vers les tarifs, vers les cas
   voisins ; et l'appel à l'action (commencer gratuitement, ou les commandes du plugin). Une page anglaise ne lie une
   page française (une fonctionnalité, le contact) qu'avec `hreflang="fr"` et la mention « (in French) ».
8. **Le guide et le code** : le guide de la doc (`data-guide`) et, quand le cas a une commande du plugin, son dossier sur
   GitHub (`data-recette`), tous deux dérivés du registre de la spec 6 bis.

Données structurées de chaque page : `BreadcrumbList`, `TechArticle`, `FAQPage`, `VideoObject`. Pas de `HowTo` (Google
ne l'affiche plus depuis 2023).

## La page des tarifs

Les trois offres, la location du numéro, le crédit IA (sa commission par offre), ce que Meta facture directement et
pourquoi, une FAQ. **Tous les chiffres viennent du code et portent `data-offre`** : les limites de la Free et du Pro
(`DROITS`), le prix du Pro au mois et à l'an (`PRIX_PRO_HT_CENTIMES`), le numéro (`PRIX_NUMERO_HT_CENTIMES`), la
commission sur le crédit (`src/offres/commission.ts`). L'Entreprise est « sur devis ». La page s'ouvre aux moteurs,
et `SoftwareApplication` de l'accueil reçoit ses `offers`.

## La rubrique « Solutions »

Elle répond à « est-ce pour moi » ; les fonctionnalités répondent à « qu'est-ce que c'est », la doc à « comment je fais ».
Son carrefour présente les secteurs, les métiers et le lien vers « Tous les cas d'usage ».

- **Une page de secteur** (assurance, tourisme, enseignement supérieur) dit, avec les mots du secteur, les usages de
  WhatsApp qui s'y appliquent : les cas (des cartes vers leurs pages, avec leurs films), les fonctionnalités marketing
  (campagnes, publicités Click-to-WhatsApp, analyse des conversations), ce que l'on paie, une FAQ. Rien d'inventé : un
  usage cité est faisable aujourd'hui (✅ du catalogue de la spec 6 bis). Un client n'y est cité (nom, logo,
  témoignage) qu'avec son accord écrit.
- **Une page de métier** parle à celui qui construit. « SaaS et app builders » reprend ce que devait dire l'ancienne
  industrie « Claude Code et Codex » : brancher WhatsApp à son application en une session, et piloter depuis son
  assistant ; avec ses cas (accueil, paiement échoué, rendez-vous, rappels, bulle). « Agences » porte le cas « dix
  clients d'un coup » : un espace par client, une seule adresse pour tous, le plugin dans chaque espace, la
  refacturation.
- **Pas de film en propre** : une page Solutions montre ceux des cas qui la concernent ; le film « agence » de la spec
  6 bis est celui de `/solutions/agences/`.
- **Codex, Cursor et Lovable ne sont cités comme branchés qu'après leur essai réel** (essais 98 et 121 de
  `docs/prive/ESSAIS-REELS.md`) : pour Codex, notre serveur MCP déclaré dans `config.toml`, la connexion par `codex mcp
  login` (d'après la doc d'OpenAI), un outil appelé jusqu'au bout. Sans cet essai, la page parle de Claude Code et dit
  que les autres clients MCP se branchent par l'adresse publique.
- Données structurées : `BreadcrumbList`, `FAQPage`, et `VideoObject` pour chaque film montré.

## La doc développeurs

Chaque cas qui a du code entre comme guide, en français et en anglais, écrit dans
`web/app/developers/api/guides/<slug anglais>/page.tsx`, déclaré dans `web/lib/doc-api-pages.ts` sous un groupe
« Recettes » (où la recette Next.js existante est rangée, sans changer d'adresse), sa version `.md` produite par
`npm run doc:md`, ce qui le met dans le `llms.txt` de la console : le même cas, version technique, sans le film ni le
discours, et un lien vers la page de la vitrine. Le cas « notifications de commande » a déjà le sien : la recette
Next.js.

## Les films

Un par cas, donc sept, chacun en français et en anglais, en 16:9 et en 9:16 : 28 fichiers, plus le film « agence » de
`/solutions/agences/` ; leur ordre suit les vagues de la spec 6 bis. Fabriqués dans l'atelier
`~/engageme-motion` selon son `CLAUDE.md` (marque, ouverture, signature, deux exports au plus à la fois), un dossier
par film, un `SCRIPT.md` validé par Julien avant toute animation. **Le texte à l'écran en anglais est une règle neuve
de l'atelier** : elle s'écrit dans son `CLAUDE.md` au premier film. Les écrans de la console montrés sont de vrais
écrans (la console existe en anglais), jamais une maquette inventée.

## Ce que les moteurs et les modèles lisent

Chaque page entre dans `site/sitemap.xml`, dans une section de `site/llms.txt` (« Solutions », « Cas d'usage »,
« Tarifs »), porte son adresse canonique et sa paire `hreflang`. Une image ou un film remplacé sous le même nom
prend un `?v=`.

## Les garde-fous (tests)

Le test de la vitrine (`tests/vitrine-developpeurs.test.ts`, ou un voisin qui partage ses lecteurs) s'étend à toutes les
pages neuves :
- chaque chiffre marqué `data-offre` vaut ce que dit le code, sur la page des tarifs comme sur les cas ;
- chaque outil MCP cité existe dans `CATALOGUE_MCP`, chaque événement dans `EVENEMENTS_OPENAPI`, chaque route dans le
  contrat OpenAPI ;
- chaque page indexable est dans le plan du site et dans `llms.txt`, chaque paire se déclare l'une l'autre, chaque
  lien interne mène à une page qui existe ;
- titre et description dans leurs bornes, un seul H1, le JSON-LD se lit sans erreur.

S'y ajoutent les garde-fous de la spec 6 bis (§ « Enrichir sans désordre ») : le test du registre dans les deux sens, le
même en-tête et le même pied de page sur toutes les pages d'une langue, les liens des pages anglaises, la compilation du
code de chaque cas, et la vérification hebdomadaire des liens vers l'extérieur.

## Hors du lot

D'autres secteurs et des pages par profil ; les articles du blog de `www.messagingme.fr` (Geoffrey) ; la vérification du domaine dans la
Search Console et Bing Webmaster Tools, geste de Julien qui ne dépend pas de ce lot et le précède de préférence ; la
mesure de performance (à faire sur une page à film après la livraison A).
