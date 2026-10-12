# Lot 10 : le plugin Claude Code, ses skills et la FAQ

Lot 10 de « Messaging Me pour Claude Code » (plan privé, sections « Le plugin Claude Code » et « La FAQ du plugin »).
Décisions de Julien du 2026-10-12, en deux rondes de questions, puis le design accepté le même jour.

## Ce qu'on veut

Un développeur installe Messaging Me dans Claude Code en deux commandes, tape `/messagingme:demarrer`, et Claude le
mène jusqu'à un agent IA qui répond sur WhatsApp et une bulle sur son site, dans le bon ordre, sans rien oublier. Une
session coupée reprend le lendemain où elle en était. Quand il bute, Claude lui répond avec une FAQ juste, la même
que celle de la vitrine.

## Les décisions

| Sujet | Décision |
| --- | --- |
| Dépôt | Comme le SDK : le code dans ce dépôt (`plugin/`), testé par la CI, copié à la main par une action dans le dépôt public `julienmessagingme/messagingme-plugin` |
| Installation | `/plugin marketplace add julienmessagingme/messagingme-plugin`, puis `/plugin install messagingme@messagingme` |
| Contenu | Le serveur MCP (sans clé, par autorisation), le point d'entrée `/messagingme:demarrer`, trois skills : mise en service, règles de WhatsApp, FAQ. L'import de contacts plus tard |
| Reprise | Un outil MCP de lecture neuf, « où en est l'espace » ; rien n'est bloqué côté serveur |
| Langue | Skills en anglais, avec la consigne de répondre dans la langue de la personne ; FAQ en français et en anglais |
| Commande publiée | Le plugin remplace `claude mcp add` pour Claude Code (page `/demarrer`, pages développeurs de la vitrine) ; `claude mcp add` reste dans la doc MCP |
| FAQ | Une seule source, publiée dans le plugin, sur les deux pages développeurs de la vitrine et dans `llms.txt`, tenue égale par un test |

## Ce qui existe déjà, mesuré le 2026-10-12

- Les outils du serveur MCP sont au catalogue (`web/lib/partage/catalogue-mcp.ts`), chacun documenté sur la page MCP
  (`tests/mcp-doc-parite.test.ts`). Sa consigne d'initialisation (`instructions`, `src/mcp/serveur.ts`) ne parle que des
  conversations. Aucun outil ne dit où en est la mise en service d'un espace.
- Le parcours a changé depuis le plan du 2 octobre : l'inscription et le numéro se font dans le navigateur, par le
  tunnel `/demarrer` (lot 19), qui donne ensuite `claude mcp add --transport http messagingme <API>/mcp` (`commandeMcp`,
  `web/lib/demarrer.ts`) et un prompt à coller. La vitrine montre la même commande (lot 18, tenue par
  `tests/vitrine-developpeurs.test.ts`).
- Le SDK se publie dans son dépôt par `.github/workflows/sdk.yml`, lancé à la main après le déploiement de l'API, inerte
  sans la clé de déploiement `SDK_DEPLOY_KEY` créée par Julien. C'est le modèle.
- La FAQ du plan est périmée sur un point au moins : elle dit les réponses dans les 24 h gratuites chez Meta, or le
  service est payant depuis le 2026-10-01 (`brain/MESSAGINGME.md`, § tarifs). Ses autres réponses se revérifient
  contre le code et les fiches d'aide (`docs/aide/fiches/`).
- Ce que dit la doc de Claude Code (lue le 2026-10-12) :
  - un dépôt peut être à la fois le catalogue et le plugin (`.claude-plugin/marketplace.json` dont l'entrée a pour
    source `"./"`, `.claude-plugin/plugin.json`, les composants à la racine) ;
  - le serveur se déclare dans `.mcp.json` (`type: "http"`, `url`) ; ses outils s'appellent
    `mcp__plugin_messagingme_messagingme__<outil>`, nom complet à écrire dans `allowed-tools` (le joker n'est pas
    documenté pour un serveur de plugin) ;
  - le point d'entrée est une skill (`skills/demarrer/SKILL.md`, `disable-model-invocation: true`), `commands/` étant
    l'ancienne forme ;
  - le champ `version` de `plugin.json` fige les utilisateurs sur cette version jusqu'à son changement, et un catalogue
    tiers ne se met PAS à jour tout seul (l'utilisateur doit l'activer ou mettre à jour à la main) ;
  - 🔴 **non documenté** : que l'autorisation OAuth par `/mcp` s'applique à un serveur fourni par un plugin. Seule une
    installation réelle le prouve.

## Livraison A : l'outil, le plugin, la FAQ, la publication

### L'outil « où en est l'espace »

Un outil MCP de lecture (`get_setup_state`, droit `mcp:read`, ouvert dans toutes les offres). En un appel :

- l'offre et le solde du crédit IA ;
- le numéro WhatsApp : connecté ou non, son affichage, et pour un numéro fourni l'état de son abonnement ;
- les agents IA : combien, lesquels sont actifs ;
- qui répond aux clients (le répondeur par défaut) ;
- les bulles : combien, lesquelles sont actives ;
- l'étape suivante, une parmi : connecter le numéro, créer l'agent, l'activer, en faire le répondeur, poser la bulle,
  tester, prêt. La même règle de décision que la skill décrit, écrite une fois dans le code.

Il lit ce que les outils existants lisent déjà, sans requête neuve sur la base si elles suffisent. Sa page dans la doc
MCP arrive avec lui. La consigne d'initialisation du serveur le nomme : « pour mettre en service un espace, commence
par `get_setup_state` », pour tout client MCP, plugin ou pas.

### Le plugin (`plugin/`)

```
plugin/
├── .claude-plugin/marketplace.json   catalogue « messagingme », une entrée, source "./"
├── .claude-plugin/plugin.json        nom « messagingme », version, description, auteur SmartLink
├── .mcp.json                         serveur « messagingme », https://api.messagingme.app/mcp, sans clé
├── skills/demarrer/SKILL.md          /messagingme:demarrer : lance la mise en service (réservé à la personne)
├── skills/mise-en-service/SKILL.md   le parcours, ses questions, l'ordre des outils, la réaction à chaque refus
├── skills/regles-whatsapp/SKILL.md   fenêtre de 24 h, modèles, consentement et STOP, qualité du numéro
├── skills/faq/SKILL.md               généré depuis la source de la FAQ
└── README.md                         l'installation, la mise à jour, le désabonnement
```

- **La mise en service** commence toujours par `get_setup_state`, saute ce qui est fait, et suit l'étape suivante :
  numéro (`start_whatsapp_connection`, puis `watch_whatsapp_connection`), agent IA (`create_agent`, `preview_site` et
  `import_site`, `update_agent`, `set_agent_tools`, `test_agent`, `activate_agent`), répondeur
  (`set_default_responder`), bulle (`create_widget`, puis la balise insérée dans le code de l'app), test depuis le
  téléphone. Elle dit quoi faire à chaque refus connu (offre, crédit, fenêtre de 24 h) et les interdits (jamais une
  clé dans le code, jamais un envoi sans consentement). Elle pré-autorise les outils de lecture et d'attente
  (`allowed-tools`, noms complets).
- Les noms d'outils cités par les skills et leur `allowed-tools` existent au catalogue : un test le tient.
- **Un serveur ajouté à la main** (`claude mcp add ... messagingme`, la commande d'avant) ferait voir chaque outil en
  double : la mise en service le repère (deux jeux d'outils) et propose `claude mcp remove messagingme`.

### La FAQ, une seule source

Un module de données en français et en anglais (question, réponse, et la source qui fait foi pour chaque réponse :
un fichier de code, une fiche d'aide, la fiche produit). Un générateur écrit `plugin/skills/faq/SKILL.md` et le bloc
FAQ des deux pages développeurs de la vitrine ; un test refait les sorties et les compare au caractère près (le modèle
de `sdk:contrat`). Les questions :

- C'est l'API officielle de Meta ?
- Mon nom d'entreprise s'affiche mal.
- Mon message n'est pas parti (la fenêtre de 24 h).
- Pourquoi Meta me demande une carte, et que facture-t-il ? Sans aucun chiffre, avec le lien vers la grille de Meta
  (décision du lot 17), et juste depuis le 2026-10-01.
- Mon modèle a été refusé.
- Mon agent ne répond plus (crédit épuisé, ou un humain a pris la conversation).
- Le code de vérification n'arrive pas.
- Puis-je garder ce numéro dans l'application WhatsApp ?
- Le numéro fourni m'appartient-il ?
- Combien de messages puis-je envoyer ?
- Comment ajouter un collègue ?
- Comment résilier, et que devient le numéro ?
- Comment mettre à jour le plugin ?
- J'avais déjà ajouté le serveur à la main : que faire ?

Chaque réponse est vérifiée contre sa source au moment de l'écrire, et la source est nommée dans le module.

### La publication

`.github/workflows/plugin.yml`, sur le modèle de `sdk.yml` : lancé à la main, il copie `plugin/` dans le dépôt public,
l'étiquette `v<version>`, ne fait rien si le contenu n'a pas changé, et refuse de partir si la version n'a pas bougé
alors que le contenu, si. Inerte sans la clé `PLUGIN_DEPLOY_KEY`. Julien crée le dépôt vide et la clé (commandes
prêtes à coller dans le plan), puis la version 0.1.0 part après le déploiement de l'API qui porte `get_setup_state`.

🔴 **Avant la livraison B** : Julien installe le plugin publié dans un Claude Code neuf et vérifie que `/mcp` ouvre
l'autorisation du serveur fourni par le plugin. Si elle échoue, le plugin perd son `.mcp.json`, garde ses skills, et la
mise en service fait taper la commande actuelle ; les pages de B montrent alors les deux.

## Livraison B : les pages passent au plugin

- La page `/demarrer` de la console : les deux commandes du plugin à copier, puis « tapez `/messagingme:demarrer` »,
  à la place de `claude mcp add` et du prompt à coller. La clé de l'application (`MESSAGINGME_API_KEY`) ne change pas.
- Les deux pages développeurs de la vitrine : l'étape 2 et le terminal montrent les commandes du plugin, et la page
  porte la FAQ (avec son balisage `FAQPage` pour les moteurs). `llms.txt` pointe vers elle.
- La doc MCP de la console garde `claude mcp add`, pour qui ne veut que le serveur, et nomme le plugin.
- Une constante unique porte les commandes du plugin (`web/lib/demarrer.ts`) ; le test de la vitrine passe de
  `commandeMcp` à elle.

B ne part qu'après la publication de A et l'installation réussie de Julien : une commande qui pointe vers un dépôt
vide serait cassée dès le push (la vitrine et la console sont publiées par Vercel au push).

## Hors périmètre

- La skill d'import de contacts.
- Cursor et les autres clients (le plugin ne sert que Claude Code).
- Un serveur qui refuse un outil appelé avant son étape (troisième couche du plan).
- La mise à jour automatique : elle dépend de l'utilisateur ; la FAQ et le README disent comment l'activer.

## Méthode de livraison

**A** : implémenteur (moi, en direct) puis UNE relecture du diff, parce que A ajoute un outil au serveur que la
production sert, une consigne envoyée à tous les clients MCP, et un circuit qui écrit dans un dépôt public. **B** : en
direct, avec une relecture en fin de livraison : des pages réversibles en un push, tenues par le test de la vitrine.

## L'essai réel qui clôt le lot

Julien, dans un Claude Code neuf et avec un espace neuf : les deux commandes, `/mcp` et l'autorisation, puis
`/messagingme:demarrer`, jusqu'à voir l'agent répondre sur son téléphone et la bulle sur une page de test. Il coupe
la session et la reprend le lendemain : Claude repart de l'étape où il s'était arrêté. Puis il pose une question de la
FAQ à Claude, et la retrouve sur la vitrine.
