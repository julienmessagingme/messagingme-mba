# Lot 10 : le plugin Claude Code, ses skills et la FAQ

Spec : `docs/superpowers/specs/2026-10-12-plugin-claude-code-design.md` (décisions de Julien du 2026-10-12). Deux
livraisons, aucune migration.

## Méthode de livraison

**A (l'outil, le plugin, la FAQ, la publication)** : implémenteur (moi, en direct) puis UNE relecture du diff, parce
que A ajoute un outil au serveur MCP que la production sert, change la consigne envoyée à tous les clients MCP, et
monte un circuit qui écrit dans un dépôt public. Les critères se vérifient par des tests (la règle de l'étape suivante,
les noms d'outils des skills, la FAQ générée), mais ce que Claude fera des skills ne se voit qu'à l'usage : c'est
l'installation de Julien qui le prouve.

**B (les pages)** : en direct, puis UNE relecture en fin de livraison : des pages réversibles en un push, tenues par le
test de la vitrine et ceux de `/demarrer`.

**L'essai réel qui clôt le lot** : Julien, dans un Claude Code neuf et avec un espace neuf, installe le plugin, autorise
par `/mcp`, tape `/messagingme:demarrer` et va jusqu'à l'agent qui répond sur son téléphone et la bulle sur une page de
test ; il coupe la session et la reprend le lendemain ; il pose une question de la FAQ à Claude. Essai n° 99 de
`docs/prive/ESSAIS-REELS.md`.

## Ce que la relecture regarde en priorité

1. Un espace déjà en route (numéro branché, agent actif, répondeur réglé par Julien sur l'agent de Meta ou un
   scénario) : l'étape suivante ne pousse pas à défaire ce qui est voulu.
2. Une lecture qui échoue (numéro, abonnement, crédit) : l'outil rend ce qu'il sait, et dit ce qu'il n'a pas pu lire,
   au lieu d'échouer en entier.
3. Une clé d'API sans personne derrière (droit `mcp:read`) : l'outil marche, et ne rend rien qu'une clé ne doit pas
   voir.
4. Les skills : aucun outil cité qui n'existe pas, aucun geste d'écriture pré-autorisé, aucune affirmation de prix
   de Meta.
5. La publication : rien ne part sans changement de version, rien ne part sans la clé, et le contenu publié est
   exactement `plugin/`.

## Livraison A

1. **La règle de l'étape suivante**, pure : `src/mcp/mise-en-service.ts` -> `etatMiseEnService(lectures)`, qui rend
   l'offre, le crédit, le numéro (connecté, à activer, fourni, abonnement), les agents IA (actifs, à compléter avec leurs
   manques), le répondeur, les bulles, `etape_suivante` (`connecter_numero`, `creer_agent`, `completer_agent`,
   `activer_agent`, `choisir_repondeur`, `poser_bulle`, `pret`) et les avertissements (crédit épuisé, numéro à activer,
   lecture manquée). Le répondeur n'est demandé que si personne ne répond automatiquement (mode « equipe ») : un mode
   choisi (agent de Meta, scénario, application) compte comme fait.
   Tests : `tests/mcp-mise-en-service.test.ts` (neuf), un cas par étape, les modes choisis, les lectures manquées.
2. **L'outil `get_setup_state`** : sa fiche au catalogue (`web/lib/partage/catalogue-mcp.ts`, `mcp:read`), son texte
   dans les deux langues (`web/lib/mcp-outils.ts`), son exécution dans `src/mcp/outils.ts` à partir des lectures que
   les outils voisins font déjà (`deps.offre`, `deps.numero.etat`, `deps.agentIa`, `deps.widgets`, aucune dépendance
   neuve, donc aucun câblage). La consigne d'initialisation (`src/mcp/serveur.ts`) le nomme pour la mise en service.
   Tests : `tests/mcp-catalogue.test.ts`, `tests/mcp-doc-parite.test.ts`, `tests/mcp-serveur.test.ts` (la consigne), et
   l'outil appelé sur des faux, avec une clé et avec une personne.
3. **La FAQ, une source** : `scripts/plugin/faq.ts` (questions et réponses en deux langues, la source qui fait foi
   pour chacune), et `scripts/plugin/generer.mts` (`npm run plugin:generer`) qui écrit `plugin/skills/faq/SKILL.md`
   et, quand les pages portent leurs marques (livraison B), le bloc FAQ de la vitrine. Chaque réponse est vérifiée
   contre sa source en l'écrivant (les prix de Meta : `brain/MESSAGINGME.md`, sans chiffre).
   Tests : `tests/plugin-faq.test.ts` (neuf) refait les sorties et les compare au caractère près.
4. **Le plugin** (`plugin/`) : `.claude-plugin/marketplace.json` et `plugin.json` (version 0.1.0, auteur SmartLink),
   `.mcp.json`, les skills `demarrer` (réservée à la personne), `mise-en-service`, `regles-whatsapp`, `faq`, et le
   README. Vérifié par `claude plugin validate plugin/` en local.
   Tests : `tests/plugin.test.ts` (neuf) : les noms concordent (plugin, entrée du catalogue, serveur), l'adresse du
   serveur est `API_PUBLIQUE` + `/mcp`, chaque outil cité par une skill est au catalogue, `allowed-tools` ne
   pré-autorise que des outils de lecture ou d'attente, sous leur nom complet, `demarrer` porte
   `disable-model-invocation: true`, la version est de la forme x.y.z.
5. **La publication** : `.github/workflows/plugin.yml` sur le modèle de `sdk.yml` (à la main, copie de `plugin/`, tag
   `v<version>`, refus d'une version inchangée sur un contenu changé, inerte sans `PLUGIN_DEPLOY_KEY`). `DEPLOY.md` :
   la section « le plugin se publie après l'API ».
6. **Vérification** : `npm run typecheck`, `npm test`, l'auto-attaque, les tests de la console, `claude plugin
   validate`. Relecture, jaunes simples corrigés, push annoncé aux sessions voisines, CI lue job par job,
   déploiement (`mba-api`, `mba-worker`, `mba-worker-analyse`), cinq portes, puis `tools/list` en production montre
   `get_setup_state`.
7. **Le geste de Julien** : créer le dépôt public vide et sa clé de déploiement (commandes PowerShell prêtes à coller).
   Puis `gh workflow run plugin.yml --ref main`, le run lu, et Julien installe le plugin dans un Claude Code neuf :
   🔴 **le passage à B attend que `/mcp` ouvre l'autorisation du serveur fourni par le plugin.** Sinon : le plugin
   perd `.mcp.json`, et B montre la commande actuelle avec le plugin.
8. **Les docs** : `features.md` (le serveur MCP et le plugin ; `tests/aide-proposer.test.ts` avant de pousser),
   `documentation.md` (l'outil, la règle, le plugin et sa publication), le journal, le plan privé et son Claude Doc,
   l'essai n° 99.

## Livraison B

Poussée APRÈS la publication et l'installation réussie de A.

1. **Une constante** `COMMANDES_PLUGIN` (`web/lib/demarrer.ts`) et la commande de démarrage `/messagingme:demarrer`.
   La page `/demarrer` les montre à la place de `claude mcp add` et du prompt ; la clé de l'application ne change pas.
   Tests : `web/lib/demarrer.test.ts`, l'e2e de `/demarrer` (et ceux qui la trouvent par rôle).
2. **La vitrine** : l'étape 2 et le terminal des deux pages développeurs montrent les commandes du plugin ; la FAQ
   générée entre ses marques, avec son balisage `FAQPage` ; `llms.txt`. `tests/vitrine-developpeurs.test.ts` passe de
   `commandeMcp` à `COMMANDES_PLUGIN` et exige la FAQ égale à la source.
3. **La doc MCP** de la console nomme le plugin et garde `claude mcp add` pour qui ne veut que le serveur.
4. Relecture, push, CI des deux côtés, publication Vercel, `curl` des pages, et `/demarrer` regardée en production.
5. **Les docs** : `features.md`, `documentation.md`, le journal, le plan privé.

## Ordre de mise en ligne

A : push, CI, déploiement de l'API, puis le dépôt et la clé (Julien), la publication 0.1.0, l'installation de Julien.
B : seulement ensuite, un push publié par Vercel.
