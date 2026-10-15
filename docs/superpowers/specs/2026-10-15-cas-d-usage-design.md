# Les cas d'usage, les tarifs et la rubrique « Industries » de la vitrine (lot 6, spec du 2026-10-15)

> Point 6 des décisions du 2026-10-13 (`docs/prive/2026-10-02-engageme-claude-code.md`) : montrer à un développeur et à
> un vibe codeur ce qu'ils peuvent COMBINER avec nos outils, de bout en bout, sur la vitrine et dans la doc
> développeurs, pour les campagnes de publicité à venir et pour les robots (moteurs et IA). Il dépendait du point 7,
> l'audit SEO, fait le 2026-10-15 (`docs/prive/2026-10-15-audit-seo-vitrine.md`). Plan :
> [docs/superpowers/plans/2026-10-15-cas-d-usage.md](../plans/2026-10-15-cas-d-usage.md).

## Les décisions de Julien (2026-10-15, trois rondes)

| Sujet | Décision |
|---|---|
| Tarifs | La page des tarifs, aujourd'hui « en construction » et fermée aux moteurs, entre dans ce lot |
| Langues | Français et anglais, chaque page en paire, comme la page développeurs |
| Industries | Une vraie rubrique ; sa première industrie : **WhatsApp pour ceux qui codent avec Claude Code et Codex** ; d'autres viendront après |
| Cas de la première vague | Les sept proposés (liste ci-dessous) |
| Découpage | Trois livraisons, chacune en ligne dès qu'elle est relue |
| Format d'une page | Texte, schéma des étapes, vrais extraits de code, ce que l'on paie, courte FAQ, **et un court film** |
| Langue des films | Une version par langue, depuis la même source |

## Les pages

| Page | Français | Anglais |
|---|---|---|
| Carrefour des cas d'usage (dans le menu) | `/cas-d-usage/` | `/en/use-cases/` |
| 1. Une demande prise par l'agent IA arrive dans votre application, et la réponse repart | `/cas-d-usage/agent-ia-vers-votre-application/` | `/en/use-cases/ai-agent-to-your-app/` |
| 2. Les notifications de commande et de rendez-vous, envoyées par votre application | `/cas-d-usage/notifications-de-commande/` | `/en/use-cases/order-notifications/` |
| 3. La bulle WhatsApp et son agent sur un site fait avec Lovable ou v0 | `/cas-d-usage/bulle-whatsapp-site-lovable/` | `/en/use-cases/whatsapp-bubble-lovable-site/` |
| 4. Le support client par un agent IA, avec relais à l'équipe | `/cas-d-usage/support-ia-relais-humain/` | `/en/use-cases/ai-support-human-handover/` |
| 5. Les leads des publicités Click-to-WhatsApp qualifiés jusqu'au CRM | `/cas-d-usage/leads-publicites-vers-crm/` | `/en/use-cases/ad-leads-to-crm/` |
| 6. Piloter WhatsApp depuis Claude : lire, répondre, demander des graphiques | `/cas-d-usage/piloter-whatsapp-depuis-claude/` | `/en/use-cases/run-whatsapp-from-claude/` |
| 7. Une campagne qui ouvre des conversations, et son coût par engagement | `/cas-d-usage/campagne-qui-ouvre-une-conversation/` | `/en/use-cases/campaign-that-starts-conversations/` |
| Tarifs | `/tarifs/` (et `/pricing/` y redirige) | `/en/pricing/` |
| Industries (carrefour) | `/industries/` | `/en/industries/` |
| Industrie : Claude Code et Codex | `/industries/claude-code-et-codex/` | `/en/industries/claude-code-and-codex/` |

Une adresse publiée ne se renomme plus sans redirection : celles-ci se décident ici, une fois. Le menu gagne « Cas
d'usage » ; « Pricing » devient « Tarifs » côté français ; « Industries » reste et mène à la rubrique.

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
   voisins ; et l'appel à l'action (commencer gratuitement, ou les commandes du plugin).

Données structurées de chaque page : `BreadcrumbList`, `TechArticle`, `FAQPage`, `VideoObject`. Pas de `HowTo` (Google
ne l'affiche plus depuis 2023).

## La page des tarifs

Les trois offres, la location du numéro, le crédit IA (sa commission par offre), ce que Meta facture directement et
pourquoi, une FAQ. **Tous les chiffres viennent du code et portent `data-offre`** : les limites de la Free et du Pro
(`DROITS`), le prix du Pro au mois et à l'an (`PRIX_PRO_HT_CENTIMES`), le numéro (`PRIX_NUMERO_HT_CENTIMES`), la
commission sur le crédit (`src/offres/commission.ts`). L'Entreprise est « sur devis ». La page s'ouvre aux moteurs,
et `SoftwareApplication` de l'accueil reçoit ses `offers`.

## La rubrique « Industries » et sa première industrie

Le carrefour présente les industries ; la première, « WhatsApp pour ceux qui codent avec Claude Code et Codex », dit
ce que ces développeurs y gagnent : brancher WhatsApp à leur application en une session, et piloter depuis leur
assistant. **Codex n'y est cité qu'après un essai réel** : notre serveur MCP branché dans Codex (adresse dans
`config.toml`, connexion par `codex mcp login`, d'après la doc d'OpenAI), un outil appelé jusqu'au bout. Sans cet
essai, la page parle de Claude Code seul et dit que les autres clients MCP se branchent par l'adresse publique.

## La doc développeurs

Chaque cas entre comme guide, en français et en anglais, sous `web/public/developers/api/guides/`, déclaré dans
`web/lib/doc-api-pages.ts`, ce qui le met dans le `llms.txt` de la console : le même cas, version technique, sans le
film ni le discours, et un lien vers la page de la vitrine.

## Les films

Un par cas, donc sept, chacun en français et en anglais, en 16:9 et en 9:16 : 28 fichiers. Fabriqués dans l'atelier
`~/engageme-motion` selon son `CLAUDE.md` (marque, ouverture, signature, deux exports au plus à la fois), un dossier
par film, un `SCRIPT.md` validé par Julien avant toute animation. **Le texte à l'écran en anglais est une règle neuve
de l'atelier** : elle s'écrit dans son `CLAUDE.md` au premier film. Les écrans de la console montrés sont de vrais
écrans (la console existe en anglais), jamais une maquette inventée.

## Ce que les moteurs et les modèles lisent

Chaque page entre dans `site/sitemap.xml`, dans une section de `site/llms.txt` (« Cas d'usage », « Tarifs »,
« Industries »), porte son adresse canonique et sa paire `hreflang`. Une image ou un film remplacé sous le même nom
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

## Hors du lot

Les autres industries ; les articles du blog de `www.messagingme.fr` (Geoffrey) ; la vérification du domaine dans la
Search Console et Bing Webmaster Tools, geste de Julien qui ne dépend pas de ce lot et le précède de préférence ; la
mesure de performance (à faire sur une page à film après la livraison A).
