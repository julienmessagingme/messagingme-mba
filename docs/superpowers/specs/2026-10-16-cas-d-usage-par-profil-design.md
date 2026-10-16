# Les cas d'usage par profil, la rubrique « Solutions » et les dépôts GitHub (lot 6 bis, spec du 2026-10-16)

> Complète [la spec du lot 6](2026-10-15-cas-d-usage-design.md) sans la refaire. **Toutes les adresses de la vitrine
> vivent dans la spec du lot 6** (§ « Le menu et les pages ») ; celle-ci porte les profils, les cas ajoutés, le registre
> qui relie le site, la doc et GitHub, et les dépôts. Demandes de Julien du 2026-10-16 : partir de ceux qui utilisent
> Claude Code, Lovable, Cursor, imaginer leurs cas d'usage, enrichir le dépôt GitHub du plugin, « vraiment light », et
> que ni le site ni le dépôt ne soient « le bordel ».

## Les décisions de Julien (2026-10-16, quatre rondes)

| Sujet | Décision |
|---|---|
| Profils visés | Les quatre : fondateur solo de SaaS, entrepreneur Lovable non technique, agence ou freelance, équipe produit de startup. Ce sont les filtres de la page « Tous les cas d'usage », pas des pages |
| Nouveaux cas | Rappels de rendez-vous anti-absence, accueil et activation d'un SaaS, paiement échoué et relance, agence : dix clients d'un coup |
| Menu | « Solutions » remplace « Industries » : par secteur (assurance, tourisme, enseignement supérieur), par métier (SaaS et app builders, agences), par cas d'usage. Le menu : Fonctionnalités, Solutions, Développeurs, Tarifs |
| Pages de cas | Sept au lieu de onze : les leads des publicités et la campagne renvoient vers leurs fonctionnalités, « piloter depuis Claude » devient une section de `/developpeurs/`, l'agence est la page `/solutions/agences/` |
| Langues | Chaque page en français et en anglais, Solutions comprises |
| Films | Un par cas ; les pages Solutions montrent ceux des cas qui les concernent |
| Dépôt GitHub | Tout dans le dépôt du plugin : une commande par cas avec son code dans son dossier, un README qui montre, un journal des versions, la licence, les mots-clés, une image d'aperçu |
| Dépôt plus fourni (quatrième ronde) | Oui, sans remplissage : en tête, l'animation téléphone et agenda tirée du film 1 ; les conditions d'utilisation s'écrivent ; un formulaire de bug sur GitHub et une page sécurité vers `security@messagingme.fr` |
| Code de connexion par WhatsApp | Au backlog (`todo.md`) : la catégorie « authentification » de Meta n'est pas gérée |

## Les quatre profils, et ce dont ils ont besoin

Sources (souvent publiées par les éditeurs eux-mêmes, donc ordres de grandeur) : le rapport de Lovable (environ 80 %
d'utilisateurs non techniques), le sondage JetBrains 2026 (39 % des développeurs professionnels utilisent Claude Code
au travail), un sondage Pragmatic Engineer relayé (adoption plus forte dans les petites structures).

1. **Le fondateur solo de SaaS** (Claude Code, Cursor) : accueillir et activer ses nouveaux utilisateurs, relancer les
   fins d'essai et les paiements échoués, un support qui répond depuis sa doc, savoir qui a lu.
2. **L'entrepreneur non technique qui construit avec Lovable** (coach, studio, artisan, commerce) : une bulle avec un
   agent qui répond depuis le site, la prise de rendez-vous et les rappels, la collecte de demandes de devis, sans
   écrire de back-end. **Le plugin ne s'installe pas dans Lovable** : Lovable branche un serveur MCP comme connecteur de
   son chat, propre à chaque utilisateur (docs.lovable.dev/integrations/custom-mcp). Ses cas passent par la console et
   par ce connecteur, jamais par un dossier de code.
3. **L'agence ou le freelance** qui livre des applications à des PME : un module WhatsApp à installer chez chaque
   client, un espace par client, refacturable.
4. **L'équipe produit d'une startup** : notifications transactionnelles, webhooks signés vers son CRM ou son support,
   un agent branché sur son back-end, l'hébergement en Europe.

## Le catalogue, et ce que le produit sait faire

✅ faisable aujourd'hui ; 🟡 en partie (console seulement) ; ❌ manque au produit. Une page de secteur ne cite qu'un
usage ✅.

| Cas | Profils | Statut | Briques | Où il vit |
|---|---|---|---|---|
| Prise de rendez-vous | tous | ✅ | actions de l'agent, `agent.action`, `POST /v1/messages/whatsapp` | page de cas |
| Réponse aux questions, jour et nuit | tous | ✅ | agent IA, `import_site`, `import_document_text`, bulle | page « support » |
| Relais vers un humain | tous | ✅ | `set_transfer_mode`, Inbox, `assign_conversation` | page « support » |
| Accueil et activation d'un SaaS | 1, 4 | ✅ | `POST /v1/contacts`, `POST /v1/sends`, `message.read` | page de cas |
| Paiement échoué et relance | 1, 4 | ✅ | modèle à bouton lien, `link.clicked` | page de cas |
| Fin d'essai | 1 | ✅ | `POST /v1/sends` | page « accueil » |
| Avis et NPS | 1, 2, 4 | ✅ | modèle, `conversation.analyzed` | pages de secteur |
| Bulle et agent sur un site Lovable | 2 | ✅ | `create_widget`, agent IA | page de cas |
| Rappels anti-absence « Confirmer / Annuler » | 2, 4 | ✅ | modèle à réponses rapides, `message.received` | page de cas |
| Demande de devis par formulaire WhatsApp | 2, 3 | 🟡 | formulaires de la console, pas encore dans l'API ni le MCP | plus tard |
| Relance de panier abandonné | 2 | ✅ | modèle marketing, consentement | pages de secteur |
| Agence : dix clients, dix espaces | 3 | ✅ | une adresse ouvre plusieurs espaces (`features.md`), le plugin par espace | `/solutions/agences/` |
| Leads des publicités vers le CRM | 3, 4 | ✅ | publicités Click-to-WhatsApp, intégrations CRM | fonctionnalités |
| Notifications transactionnelles | 4 | ✅ | `POST /v1/sends`, accusés | page de cas (vague 2) |
| Code de connexion par WhatsApp | 1 | ❌ | catégorie « authentification » non gérée | backlog |

## Les vagues

| Vague | Pages | Films |
|---|---|---|
| 1 | les cas prise de rendez-vous, rappels, support et relais, bulle Lovable, accueil SaaS, paiement échoué ; les cinq pages Solutions et leur carrefour ; le carrefour des cas ; les tarifs | prise de rendez-vous (fait), bulle Lovable, rappels, un film « SaaS » pour l'accueil et le paiement échoué, agence (montré sur `/solutions/agences/`) |
| 2 | le cas notifications de commande | support et relais, notifications |

## Une seule source par contenu

| Endroit | La question du visiteur | Ce qu'on y met | Ce qu'on n'y met jamais |
|---|---|---|---|
| La vitrine | « Est-ce pour moi, combien ça coûte ? » | l'argument, le film, le schéma, les prix (`data-offre`), une FAQ, un extrait de code court | le pas-à-pas |
| La doc de la console | « Comment je fais ? » | le guide, la phrase à donner à l'assistant, le code commenté, sa version `.md` | le discours, le film |
| Le dépôt du plugin | « Je le branche dans mon projet » | une commande par cas, avec son code | un texte écrit à la main |
| Le dépôt du SDK | « Le client typé de l'API » | le paquet, son README, son journal des versions | les recettes |

Tout s'écrit une fois, dans `messagingme-mba`, et les autres endroits le reçoivent par génération ou par un lien :
- **le code d'un cas** vit dans `EXEMPLES_CAS` (`web/lib/exemples-code.ts`), rangé par cas puis par fichier, compilé
  contre le SDK publié ; le guide l'affiche, la vitrine en montre un extrait (`data-exemple`), `npm run plugin:generer`
  l'écrit dans le dossier de la commande ;
- **le guide** vit dans `web/app/developers/api/guides/<slug anglais>/page.tsx`, dans un groupe « Recettes » de la doc
  (où la recette Next.js existante est rangée, sans changer d'adresse) ;
- **l'argument et le film** vivent sur la page de la vitrine, les films dans `site/films/`.

**Le registre** (`web/lib/registre-vitrine.ts`, sans import de valeur, comme `web/lib/doc-api-pages.ts`) relie le tout :
une entrée par page de cas et par page Solutions, avec sa clé, sa nature (cas, secteur, métier), ses deux adresses, ses
profils, sa vague, la recherche qu'elle vise (unique : une recherche à laquelle une page répond déjà enrichit cette page
au lieu d'en créer une), sa commande du plugin s'il en a une, son chemin (console ou code) et son guide. Les carrefours,
le tableau du README du plugin, la liste des commandes, le plan du site, `llms.txt` et les tests en dérivent.

## Le dépôt du plugin (`messagingme-plugin`)

Il se publie depuis `plugin/` par `.github/workflows/plugin.yml`, qui efface le dépôt et recopie le dossier, à la main,
après l'API, avec une version montée à chaque fois (`DEPLOY.md`).

**Plus fourni, sans remplissage** (demande de Julien du 2026-10-16, quatrième ronde). Mesuré sur 15 dépôts d'IA et de
MCP parmi les plus suivis et 19 dépôts WhatsApp et SDK : les plus suivis ne gagnent pas par la longueur (100 à 460
lignes de README pour la plupart, la référence renvoyée vers la doc) mais en montrant ce que l'outil change : le
résultat en image, une première phrase à copier, le tableau de ce qu'on peut construire, un schéma. Le remplissage
relevé : les murs de badges, les courbes d'étoiles, les traductions (2 dépôts sur 34), les listes de vidéos de tiers.
Le comparable le plus proche est Kapso (plateforme sur l'API officielle, Inbox ouverte, skills, plugin Claude Code).

```
README.md          généré, environ 200 lignes (plan ci-dessous)
CHANGELOG.md       une entrée par version
SECURITY.md        où signaler une faille : security@messagingme.fr
LICENSE            MIT
icon.svg
.github/ISSUE_TEMPLATE/
  config.yml       pas d'issue vierge
  bug.yml          version du plugin et de Claude Code, commande, message d'erreur ; jamais de clé ni de numéro
.claude-plugin/    plugin.json, marketplace.json
.mcp.json
skills/
  demarrer/ mise-en-service/ regles-whatsapp/ faq/       (existantes)
  accueil/ relance-paiement/ rappels/ agence/            (nouvelles)
    SKILL.md       la commande, invoquée par l'utilisateur seulement
    README.md      ce que GitHub affiche dans le dossier (ci-dessous)
    code/          les fichiers du cas, générés depuis EXEMPLES_CAS
    .env.example
```

**Le README, dans cet ordre** (titres réels en anglais) :
1. `# Messaging Me for Claude Code` : une phrase, « Free to start, no subscription. Official WhatsApp Business API. », et
   une ligne honnête : les réponses de l'agent IA se paient sur un crédit prépayé, Meta facture certains messages. Puis
   **l'animation** : la partie du film 1 où le client écrit et où le rendez-vous arrive dans l'application (téléphone et
   agenda, 960 px, 5 Mio au plus, mesurée à 4,6 Mo), sans l'ouverture, qui montre les logos de Codex, Cursor et Lovable,
   ni aucun nom d'outil qui vieillirait. Elle mène au film complet (la page du cas, `/en/developers/` tant qu'elle n'est
   pas publiée). Légende : une illustration, pas une capture.
2. `## Before you start` : une application en ligne en https (un webhook ne part pas vers une adresse locale), un compte
   Facebook et un portefeuille Meta.
3. `## Install`, puis `## Your first prompt` : `/messagingme:demarrer`, et la phrase à coller.
4. `## What you can build` : le tableau Cas | Pour qui | Commande | Guide | Page, dérivé du registre. **Une ligne n'y entre
   que si sa commande (ou `demarrer`), son guide et sa page existent** : le dépôt s'enrichit au rythme des livraisons,
   sans rien annoncer de vide.
5. `## How it works` : un schéma mermaid (du texte, rendu par GitHub) en deux couloirs. La mise en place : Claude Code,
   le serveur MCP en OAuth, l'espace. Le quotidien : le téléphone du client, Meta, Messaging Me, l'événement signé vers
   l'application, sa réponse par `POST /v1/messages/whatsapp` avec sa clé d'API. Claude Code n'est pas sur le chemin des
   messages.
6. `## Why the official WhatsApp API` : pas de QR code à scanner, pas de téléphone qui doit rester allumé, pas de risque de
   blocage pour client non officiel ; et ce que Meta impose quand même (modèles approuvés pour écrire en premier, fenêtre
   de 24 h, note de qualité, limites d'envoi). Aucun tiers nommé.
7. `## What's inside`, `## Build it in code` (le SDK, la recette Next.js), `## MCP server address` (l'adresse seule, aucun
   bouton ni logo d'assistant avant son essai réel), `## Update`, `## Data and privacy`, puis le journal des versions, la
   licence et « Generated from messagingme-mba, do not edit ».

**Le README d'un dossier de cas** : le titre de sa page, l'affiche de son film (servie par la vitrine, menant à la
page), « Run it: /messagingme:<commande> », la phrase à coller, les fichiers de `code/`, les outils, routes et événements
qu'il utilise (tirés du registre), le lien vers le guide. Celui de `mise-en-service` présente ses trois cas.

**Les images sont servies par la vitrine** par adresse absolue (`site/img/github/`, affiches dans `site/films/`), avec un
`?v=` incrémenté à chaque remplacement : `/img/` reste un jour en cache, le proxy d'images de GitHub aussi.

- **Pas de dossier `recipes/`** : le code d'un cas vit dans le dossier de sa commande, qui le lit par le chemin documenté
  des fichiers d'appui d'une skill. Un second dossier serait une seconde copie.
- **Pas de commande en double** : la prise de rendez-vous (les actions de l'agent), le relais vers l'équipe et la bulle
  sont déjà dans `mise-en-service` (`/messagingme:demarrer`). Leur code entre dans `skills/mise-en-service/code/`, et
  leurs pages renvoient à `/messagingme:demarrer`. Quatre commandes nouvelles : `accueil`, `relance-paiement`, `rappels`,
  `agence`, en français court comme les quatre déjà publiées (une commande publiée ne se renomme pas).
- **Une skill par cas, invoquée par l'utilisateur** (`disable-model-invocation: true`, la forme que la doc de Claude Code
  recommande à la place de `commands/`) : elle ne coûte rien au contexte de Claude à chaque tour. Revers, Claude ne la
  propose pas de lui-même : l'étape finale de `mise-en-service` liste les commandes, générées depuis le registre.
- **Aucun binaire** (film, image lourde) : installer le plugin clone le dépôt entier (`marketplace.json` déclare la
  source `./`, et on la garde : changer la source d'une installation existante n'est documenté nulle part). Le texte
  ajouté pèse quelques dizaines de Ko et reste inerte pour Claude Code.
- **Le journal des versions plutôt que des releases** : la clé de publication ne donne qu'un accès git. Un test exige que
  la première entrée de `CHANGELOG.md` porte la version de `plugin.json`.
- **Tout est généré et vérifié au caractère près**, sur le modèle de `tests/plugin-faq.test.ts` : le README, chaque README
  de cas, `code/`, `CHANGELOG.md`, `SECURITY.md` et les formulaires. Le texte écrit à la main (l'accroche, « Why the
  official WhatsApp API », `SECURITY.md`) vit dans `scripts/plugin/`. Les garde-fous du README sont dans « Enrichir sans
  désordre ».
- **Ce qu'on n'y met pas** : badges, courbe d'étoiles, mur de contributeurs, traductions, `docs/` (la référence est dans
  la console), `examples/`, `CONTRIBUTING.md` (un dépôt généré n'accepte pas de contribution, le README le dit), un code de
  conduite, les Discussions (un onglet vide souligne le vide ; à ouvrir aux premières questions), une vidéo intégrée,
  les logos ou boutons d'autres assistants avant leur essai réel, les logos de clients sans leur accord, un prix de Meta.
- **Les réglages qui ne sont pas des fichiers** (mots-clés, adresse du site, image d'aperçu) : un geste unique de Julien,
  par une commande `gh repo edit` que Claude lui donne, et l'image d'aperçu (1280 × 640, fabriquée dans l'atelier) déposée
  dans les réglages du dépôt. Mots-clés : `whatsapp`, `whatsapp-business-api`, `whatsapp-cloud-api`, `mcp`, `mcp-server`,
  `claude-code`, `claude-code-plugin`, `ai-agent` ; `cursor` et `lovable` après leur essai réel.

## Le dépôt du SDK, et le dépôt principal

- **`messagingme-sdk`** : son README passe en anglais (il est en français ; `tests/doc-exemples-compiles.test.ts` exige
  qu'il contienne `EXEMPLES_SDK` mot pour mot, donc les commentaires de ces exemples passent aussi en anglais, et la page
  SDK de la console les montre ainsi), avec une ligne d'installation depuis GitHub (le paquet n'est pas sur npm). Un
  `CHANGELOG.md` tiré de sa section « Versions », ajouté à la liste des fichiers que `sdk.yml` publie, dont un test
  exige que la première entrée porte la version de `package.json`. Un lien vers le tableau des cas du plugin, et le
  plugin lie le SDK. Une description en anglais, ses mots-clés et son adresse de site (même geste unique de Julien). Il
  ne porte aucune recette.
- **`messagingme-mba`** n'est pas mis en avant : public, 26 de ses fichiers nomment l'infrastructure sous-jacente, que la
  règle globale rend invisible face au client. Son adresse de site périmée (`messagingme-mba.vercel.app`) s'efface, aucune
  description commerciale. Le garder public ou le rendre privé se tranche à part (hors de ce lot).

## Enrichir sans désordre

Un cas s'ajoute en une fois, dans cet ordre : sa ligne au registre (et la recherche qu'il vise), son code dans
`EXEMPLES_CAS`, son guide, sa commande si le registre en déclare une (`npm run plugin:generer`, version montée, entrée au
journal), son film (script validé par Julien avant l'animation), ses deux pages et les deux carrefours, le plan du site
et `llms.txt`. Les garde-fous à ajouter :

- **Un test du registre** : pour chaque entrée, les deux pages existent, portent leur `data-guide` exact (avec `?lang=en`
  sur la page anglaise), leur `data-recette` s'il y a une commande et leur `data-exemple` ; le guide est dans la doc ; la
  commande existe ; les carrefours lient exactement les entrées du registre ; les recherches visées sont uniques ; les
  profils sont parmi les quatre. **Et l'inverse** : un dossier de `site/cas-d-usage/`, `site/solutions/`,
  `site/en/use-cases/`, `site/en/solutions/` ou `plugin/skills/` absent du registre le rend rouge.
- **Le même en-tête et le même pied de page** sur toutes les pages d'une langue, au `aria-current` près (ils sont recopiés
  à la main dans chaque fichier).
- **Les pages anglaises** ne lient que des pages anglaises, sauf le sélecteur de langue (toute la vitrine passe en
  anglais, spec du lot 6).
- **Le code de chaque cas compilé, chacun dans son dossier** : `tests/doc-exemples-compiles.test.ts` n'importe pas
  aujourd'hui `EXEMPLES_CAS`, dont le commentaire affirme le contraire. À brancher, et à vérifier dans les deux sens,
  avant le premier cas ; un dossier par cas, sinon deux cas qui écrivent le même chemin (le gestionnaire de webhook) se
  masquent l'un l'autre.
- **Le plugin** : la liste des skills attendues (`tests/plugin.test.ts`) dérive du registre, le contenu de chaque dossier
  généré est égal au caractère près à la génération (comme `tests/plugin-faq.test.ts`), et `plugin.yml` relance ces tests
  avant de publier.
- **Ce que disent les README** du plugin et des dossiers de cas : chaque événement cité (un nom à point comme
  `agent.action`) existe dans `TYPES_ABONNABLES`, chaque route `/v1/...` dans `sdk/openapi.json`, chaque outil dans le
  catalogue MCP ; le motif qui refuse un prix de Meta (`tests/plugin.test.ts`) s'y applique (pas au journal des
  versions, où « 0.3.0 » est une version) ; aucun nom de l'infrastructure sous-jacente, aucun tiret long ; chaque adresse
  de la vitrine citée (image, page) correspond à un fichier de `site/`, et chaque guide à une page de
  `web/app/developers/api/guides/`, contrôlé hors ligne puisque tout est dans le même dépôt.
- **Les liens vers l'extérieur** (vitrine, `plugin.json`, README du plugin) vérifiés chaque semaine : c'est le seul
  contrôle qui voit une page de www.messagingme.fr disparaître ou un dossier GitHub pas encore publié.

## Ce qui se corrige d'abord (constaté le 2026-10-16)

- **Les liens « confidentialité » et « conditions d'utilisation » du plugin 0.2.0 rendent 404** :
  `https://www.messagingme.fr/privacy-policy/` et `/terms-of-use/` (`plugin/.claude-plugin/plugin.json`,
  `plugin/README.md`). La politique de confidentialité est sur `/politique-de-confidentialite/` (200) ; aucune page de
  conditions d'utilisation n'existe : **elles s'écrivent** (décision de Julien du 2026-10-16), en français et en
  anglais, et servent aussi aux ventes par Stripe. À publier avant la 0.2.0, qui précède tout enrichissement du dépôt (le
  dépôt publié est encore en 0.1.5, sans licence), et avant la soumission à l'annuaire de Claude.
- **L'adresse de sécurité** `security@messagingme.fr`, que cite `SECURITY.md`, se crée et se lit (Julien) avant la
  publication qui l'ajoute.
- **Le pied de page de la vitrine** lie `https://www.messagingme.fr/accueil/` et `/articles/`, qui rendent 404 ; le blog est
  sur `/blog/`. Corrigé par le plan de la vitrine en anglais (`docs/superpowers/plans/2026-10-16-vitrine-en-anglais.md`),
  qui réécrit tous les pieds de page.
- **`/developpeurs/` promet que Cursor, VS Code et Lovable se branchent** comme Claude Code, et le film 1 montre les logos
  de Codex, Cursor et Lovable : rien de cela ne se publie avant les essais 98 et 121 de `docs/prive/ESSAIS-REELS.md`.

## À vérifier avant d'écrire le code (le plan le fait en premier)

- La forme d'un clic sur un bouton de réponse rapide dans `message.received` (texte, charge utile) : les rappels en
  dépendent.
- L'autorisation OAuth du plugin quand une adresse a plusieurs espaces : choisit-on l'espace, et peut-on en changer
  dans une même session ? La page Agences et la commande `agence` en dépendent.
- Les catégories de modèle qu'accepte `create_template` pour une fin d'essai et une relance de paiement (utilitaire
  ou marketing, selon la grille de Meta), et ce que Meta facture pour chacune.
- Où vivent les conditions d'utilisation (la vitrine, à côté des tarifs, ou www.messagingme.fr, à côté de la politique
  de confidentialité), et qui les relit (Julien) ; Claude peut en proposer un premier jet tiré du produit réel.
- L'animation passe le proxy d'images de GitHub (5 Mio au plus) : essai sur un dépôt jetable avant de la figer ; sinon,
  l'affiche fixe du film.
- Un client n'est cité sur une page de secteur (nom, logo, témoignage) qu'avec son accord écrit (Julien).

## Ce que ce lot ne fait pas

- Le code de connexion par WhatsApp (backlog).
- Les formulaires WhatsApp par l'API ou le MCP (le cas « devis » attend).
- Des pages par profil (elles ne naîtront qu'avec un contenu à elles, un témoignage) et d'autres secteurs.
- Un manifeste du plugin pour Cursor ou Codex (`.cursor-plugin`, `.codex-plugin`) avant leur essai réel.
- Le sort public ou privé du dépôt principal.
