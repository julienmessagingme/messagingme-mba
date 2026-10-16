# Les cas d'usage par profil, la rubrique « Solutions » et les dépôts GitHub (lot 6 bis, spec du 2026-10-16)

> Complète [la spec du lot 6](2026-10-15-cas-d-usage-design.md) sans la refaire. **Toutes les adresses de la vitrine
> vivent dans la spec du lot 6** (§ « Le menu et les pages ») ; celle-ci porte les profils, les cas ajoutés, le registre
> qui relie le site, la doc et GitHub, et les dépôts. Demandes de Julien du 2026-10-16 : partir de ceux qui utilisent
> Claude Code, Lovable, Cursor, imaginer leurs cas d'usage, enrichir le dépôt GitHub du plugin, « vraiment light », et
> que ni le site ni le dépôt ne soient « le bordel ».

## Les décisions de Julien (2026-10-16, trois rondes)

| Sujet | Décision |
|---|---|
| Profils visés | Les quatre : fondateur solo de SaaS, entrepreneur Lovable non technique, agence ou freelance, équipe produit de startup. Ce sont les filtres de la page « Tous les cas d'usage », pas des pages |
| Nouveaux cas | Rappels de rendez-vous anti-absence, accueil et activation d'un SaaS, paiement échoué et relance, agence : dix clients d'un coup |
| Menu | « Solutions » remplace « Industries » : par secteur (assurance, tourisme, enseignement supérieur), par métier (SaaS et app builders, agences), par cas d'usage. Le menu : Fonctionnalités, Solutions, Développeurs, Tarifs |
| Pages de cas | Sept au lieu de onze : les leads des publicités et la campagne renvoient vers leurs fonctionnalités, « piloter depuis Claude » devient une section de `/developpeurs/`, l'agence est la page `/solutions/agences/` |
| Langues | Chaque page en français et en anglais, Solutions comprises |
| Films | Un par cas ; les pages Solutions montrent ceux des cas qui les concernent |
| Dépôt GitHub | Tout dans le dépôt du plugin : une commande par cas avec son code dans son dossier, un README qui montre, un journal des versions, la licence, les mots-clés, une image d'aperçu |
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

```
README.md          généré : ce que l'on peut construire, l'installation, les commandes
CHANGELOG.md       une entrée par version
LICENSE            MIT
icon.svg
.claude-plugin/    plugin.json, marketplace.json
.mcp.json
skills/
  demarrer/ mise-en-service/ regles-whatsapp/ faq/       (existantes)
  accueil/ relance-paiement/ rappels/ agence/            (nouvelles)
    SKILL.md       la commande, invoquée par l'utilisateur seulement
    README.md      ce que GitHub affiche dans le dossier : le cas, son guide, sa page
    code/          les fichiers du cas, générés depuis EXEMPLES_CAS
    .env.example
```

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
  source `./`). Les films restent servis par la vitrine.
- **Le README, généré**, dans cet ordre : une phrase et une image qui mène au film ; l'installation ; « What you can
  build », un tableau Cas | Pour qui | Commande | Guide | Page dérivé du registre ; ce que contient le plugin ; les autres
  assistants (l'adresse du serveur MCP ; Cursor, Codex et Lovable nommés seulement après leur essai réel) ; la mise à
  jour ; « Data and privacy » ; le journal des versions, la licence, « généré, ne pas modifier à la main ».
- **Le journal des versions plutôt que des releases** : la clé de publication ne donne qu'un accès git. Un test exige que
  la première entrée de `CHANGELOG.md` porte la version de `plugin.json`.
- **Les réglages qui ne sont pas des fichiers** (mots-clés, adresse du site, image d'aperçu) : un geste unique de Julien,
  par une commande `gh repo edit` que Claude lui donne, et l'image d'aperçu (1280 × 640, fabriquée dans l'atelier) déposée
  dans les réglages du dépôt. Mots-clés : `whatsapp`, `whatsapp-business-api`, `whatsapp-cloud-api`, `mcp`, `mcp-server`,
  `claude-code`, `claude-code-plugin`, `ai-agent` ; `cursor` et `lovable` après leur essai réel.

## Le dépôt du SDK, et le dépôt principal

- **`messagingme-sdk`** : une description en anglais, ses mots-clés et son adresse de site (même geste unique de Julien),
  un `CHANGELOG.md` ajouté à la liste des fichiers que `sdk.yml` publie, et un lien vers le tableau des cas du plugin.
  Il ne porte aucune recette.
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
- **Les pages anglaises** ne lient une page française qu'avec `hreflang="fr"` et la mention « (in French) ».
- **Le code de chaque cas compilé, chacun dans son dossier** : `tests/doc-exemples-compiles.test.ts` n'importe pas
  aujourd'hui `EXEMPLES_CAS`, dont le commentaire affirme le contraire. À brancher, et à vérifier dans les deux sens,
  avant le premier cas ; un dossier par cas, sinon deux cas qui écrivent le même chemin (le gestionnaire de webhook) se
  masquent l'un l'autre.
- **Le plugin** : la liste des skills attendues (`tests/plugin.test.ts`) dérive du registre, le contenu de chaque dossier
  généré est égal au caractère près à la génération (comme `tests/plugin-faq.test.ts`), et `plugin.yml` relance ces tests
  avant de publier.
- **Les liens vers l'extérieur** (vitrine, `plugin.json`, README du plugin) vérifiés chaque semaine : c'est le seul
  contrôle qui voit une page de www.messagingme.fr disparaître ou un dossier GitHub pas encore publié.

## Ce qui se corrige d'abord (constaté le 2026-10-16)

- **Les liens « confidentialité » et « conditions d'utilisation » du plugin 0.2.0 rendent 404** :
  `https://www.messagingme.fr/privacy-policy/` et `/terms-of-use/` (`plugin/.claude-plugin/plugin.json`,
  `plugin/README.md`). La politique de confidentialité est sur `/politique-de-confidentialite/` (200) ; aucune page de
  conditions d'utilisation n'a été trouvée. À corriger avant de publier la 0.2.0, qui précède tout enrichissement du
  dépôt (le dépôt publié est encore en 0.1.5, sans licence), et avant la soumission à l'annuaire de Claude.
- **Le pied de page de la vitrine** lie `https://www.messagingme.fr/accueil/` et `/articles/`, qui rendent 404 ; le blog est
  sur `/blog/`.
- **`/developpeurs/` promet que Cursor, VS Code et Lovable se branchent** comme Claude Code, et le film 1 montre les logos
  de Codex, Cursor et Lovable : rien de cela ne se publie avant les essais 98 et 121 de `docs/prive/ESSAIS-REELS.md`.

## À vérifier avant d'écrire le code (le plan le fait en premier)

- La forme d'un clic sur un bouton de réponse rapide dans `message.received` (texte, charge utile) : les rappels en
  dépendent.
- L'autorisation OAuth du plugin quand une adresse a plusieurs espaces : choisit-on l'espace, et peut-on en changer
  dans une même session ? La page Agences et la commande `agence` en dépendent.
- Les catégories de modèle qu'accepte `create_template` pour une fin d'essai et une relance de paiement (utilitaire
  ou marketing, selon la grille de Meta), et ce que Meta facture pour chacune.
- La page de conditions d'utilisation que le plugin doit citer (Julien).
- Un client n'est cité sur une page de secteur (nom, logo, témoignage) qu'avec son accord écrit (Julien).

## Ce que ce lot ne fait pas

- Le code de connexion par WhatsApp (backlog).
- Les formulaires WhatsApp par l'API ou le MCP (le cas « devis » attend).
- Des pages par profil (elles ne naîtront qu'avec un contenu à elles, un témoignage) et d'autres secteurs.
- Un manifeste du plugin pour Cursor ou Codex (`.cursor-plugin`, `.codex-plugin`) avant leur essai réel.
- Le sort public ou privé du dépôt principal.
