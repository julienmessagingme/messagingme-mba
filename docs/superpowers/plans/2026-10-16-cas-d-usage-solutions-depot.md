# Plan : les cas d'usage, la rubrique « Solutions », les tarifs et le dépôt du plugin (lots 6 et 6 bis, 2026-10-16)

> **Pour un exécutant** : sous-skill requise, superpowers:executing-plans (ou subagent-driven-development si Julien le
> choisit). Les étapes se cochent (`- [ ]`).

**But** : la vitrine range ses pages en Fonctionnalités, Solutions, Développeurs, Tarifs, avec sept cas d'usage et cinq
pages Solutions en français et en anglais, et le dépôt GitHub du plugin montre ce qu'on construit, sans remplissage.

**Architecture** : un registre unique (`web/lib/registre-vitrine.ts`) déclare chaque page de cas et de Solutions ; les
carrefours, le menu, le README du plugin, la liste des commandes, le plan du site, `llms.txt` et les tests en dérivent.
Le code d'un cas s'écrit une fois (`EXEMPLES_CAS`), compilé contre le SDK publié, affiché par le guide et la page,
recopié par génération dans le dossier de sa commande. Les pages restent du HTML statique écrit à la main, tenu par des
tests.

**Outils** : HTML statique (`site/`, Vercel), Next.js pour la doc (`web/`), TypeScript et vitest, `tsx` pour les
générateurs, l'atelier `~/engageme-motion` pour les films.

**Specs** : [lot 6](../specs/2026-10-15-cas-d-usage-design.md) (le menu, toutes les adresses, l'anatomie d'une page, les
tarifs) et [lot 6 bis](../specs/2026-10-16-cas-d-usage-par-profil-design.md) (les profils, le registre, les dépôts, les
garde-fous). Ce plan ne les recopie pas. Il remplace [le plan du 2026-10-15](2026-10-15-cas-d-usage.md).

## Méthode de livraison

**En direct, sans agent, avec une relecture indépendante par livraison**, parce que l'essentiel est du HTML statique et
du texte généré : aucune page ne touche un chemin par lequel la production reçoit ou envoie un message, une page se
retire par un revert, et la vérité de ce qu'elle affirme (chiffres, outils, routes, événements, liens) est tenue par des
tests, le reste demandant l'œil de Julien plutôt qu'une boucle. Pas de `feature-loop` : la plupart des critères sont
visuels. La publication du plugin est la seule chose qui part chez des tiers et ne se rappelle pas : elle passe après
la relecture de sa livraison et un essai sur une installation neuve.

🔴 **Pousser `site/` publie en production** (Vercel) : avant CHAQUE push qui touche `site/`, le rendu est montré à Julien
(captures téléphone et ordinateur, deux langues) et il dit oui explicitement.

**L'essai réel qui clôt chaque livraison** : Julien lit chaque livraison EN LIGNE, au téléphone et sur ordinateur, dans les
deux langues, film compris, et suit un lien de chaque sorte (menu, carrefour, cas voisin, tarifs, guide de la doc,
dossier GitHub). Pour le plugin : une installation neuve dans Claude Code depuis la marketplace, `/messagingme:accueil`
lancé sur un projet d'essai jusqu'au premier envoi, et le README lu sur GitHub avec son animation. La Search Console
montre les pages neuves découvertes quelques jours après.

## Contraintes communes

- Pas de tiret cadratin ni demi-cadratin, dans les pages, les README générés et les commits.
- L'éditeur est SmartLink, Messaging Me SAS ; jamais le nom de l'infrastructure sous-jacente.
- Les adresses sont celles du tableau de la spec du lot 6, sans variante.
- Codex, Cursor et Lovable ne sont jamais présentés comme branchés avant leurs essais réels (98 et 121 de
  `docs/prive/ESSAIS-REELS.md`).
- Aucun prix de Meta ; chaque chiffre d'offre porte `data-offre` et vaut ce que dit le code.
- Chaque page existe en français et en anglais ; une page anglaise ne lie que des pages anglaises.
- Aucun binaire dans `plugin/` ; les images du README sont servies par la vitrine, avec un `?v=` à chaque remplacement.
- Toute la suite racine (`npm test`, `npx tsc --noEmit`, `npx tsx scripts/auto-attaque.mts`) passe avant un push qui
  touche `site/`, `web/`, `scripts/` ou `tests/` : `ci.yml` lit `site/` et `web/`.
- Commits en plomberie depuis l'extraction (arbre partagé), annoncés aux sessions voisines ; pas de push de code
  pendant la CI d'un pair.

## Points à surveiller (non couverts par les tâches, à relire en revue)

1. **Un carrefour qui lie une page pas encore publiée** (un cas de la vague 2, un cas dont le film n'est pas prêt) :
   la tâche 1 exige qu'aucune page ne lie une entrée `enLigne: false`.
2. **Un profil sans aucun cas en ligne** (l'équipe produit, dont le seul cas propre est en vague 2) : le filtre ne doit
   pas afficher une liste vide ; la tâche 5 exige au moins un cas en ligne par profil proposé, sinon le filtre n'apparaît
   pas.
3. **Le menu au téléphone** : le menu déroulant Solutions à trois colonnes doit exister à l'identique dans le menu
   burger ; la tâche 4 exige les mêmes adresses dans les deux.
4. **Le README du plugin publié avant la page qu'il lie** : la tâche 9 refuse une adresse de la vitrine absente de
   `site/`, et l'ordre de déploiement publie la vitrine d'abord.
5. **Le visiteur anglais renvoyé vers du français** par un lien oublié du menu ou du pied de page : la tâche 4 l'interdit
   sur toutes les pages anglaises.

---

## Avant tout (Julien, et une vérification)

- [ ] **Les conditions d'utilisation** : Julien choisit où elles vivent (la vitrine, ou www.messagingme.fr à côté de la
  politique de confidentialité). Claude en propose un premier jet tiré du produit réel, Julien le relit, elles sont
  publiées en français et en anglais.
- [ ] **L'adresse `security@messagingme.fr`** créée et lue (Julien).
- [ ] **La vitrine anglaise de la session voisine** (`2026-10-16-vitrine-en-anglais.md`, lot 2) est sur `main` : ses
  en-têtes et pieds de page anglais sont la base de la tâche 4.
- [ ] **Les trois vérifications de la spec 6 bis**, consignées dans le journal du lot avec leur preuve : la forme d'un
  clic sur un bouton de réponse rapide dans `message.received` (dans le code du webhook et, si possible, un événement réel
  en base, en lecture seule) ; ce que fait l'autorisation OAuth du plugin quand une adresse a plusieurs espaces (code du
  serveur MCP) ; les catégories qu'accepte `create_template` et le tarif de Meta pour chacune (`brain/MESSAGINGME.md`).
  Un cas dont la vérification échoue sort de la vague 1.

## Livraison 0 : la version 0.2.0 du plugin

### Tâche 0 : des liens légaux qui répondent

**Fichiers** : `plugin/.claude-plugin/plugin.json`, `scripts/plugin/` (la section « Data and privacy » si elle y est
générée), `plugin/README.md`, `tests/plugin.test.ts`.

- [ ] `privacyPolicyUrl` vers `https://www.messagingme.fr/politique-de-confidentialite/`, `termsOfServiceUrl` vers les
  conditions publiées.
- [ ] Test : `tests/plugin.test.ts` exige que ces deux adresses soient celles du manifeste et du README, identiques ; la
  vérification hebdomadaire des liens (tâche 9) les lira.
- [ ] Publication : `gh workflow run plugin.yml --ref main`, puis le dépôt publié montre la 0.2.0 et sa licence.

## Livraison A : les fondations (rien de visible)

### Tâche 1 : le registre et son test

**Fichiers** : créer `web/lib/registre-vitrine.ts` (sans import de valeur, comme `web/lib/doc-api-pages.ts`), créer
`tests/registre-vitrine.test.ts`.

**Interfaces produites** : `PROFILS` (les quatre clés : `saas`, `lovable`, `agence`, `produit`) ; le type `EntreeVitrine`
(`cle`, `nature` : `cas` | `secteur` | `metier`, `fr` et `en` : adresse et titre, `profils`, `vague` : 1 | 2,
`recherche`, `commande` facultative, `chemin` : `console` | `code`, `guide` facultatif : le slug anglais, `film`
facultatif : le nom de base dans `site/films/`, `enLigne` : booléen) ; `ENTREES` (les sept cas et les cinq pages
Solutions de la spec, toutes `enLigne: false`) ; `entreesEnLigne()`.

**Tests attendus** : clés, adresses et recherches uniques ; adresses conformes aux préfixes de la spec (`/cas-d-usage/`,
`/solutions/`, `/en/use-cases/`, `/en/solutions/`) ; profils parmi `PROFILS` ; une `commande` implique `chemin: code` ;
une entrée `enLigne` a ses deux pages, et une entrée hors ligne n'a ni page ni lien entrant depuis aucune page de
`site/` ; tout dossier de `site/cas-d-usage/`, `site/solutions/`, `site/en/use-cases/`, `site/en/solutions/` est au
registre. Vérifié dans les deux sens (une page créée sans entrée rend le test rouge).

### Tâche 2 : le code de chaque cas, compilé dans son dossier

**Fichiers** : `web/lib/exemples-code.ts` (`EXEMPLES_CAS` devient un enregistrement par clé de cas puis par chemin de
fichier), `tests/doc-exemples-compiles.test.ts`.

**Interfaces produites** : `EXEMPLES_CAS: Record<cle de cas, Record<chemin de fichier, ExempleCode>>`, commentaires en
anglais (ils seront lus sur GitHub).

**Tests attendus** : le test compile chaque cas dans son propre dossier temporaire, contre les déclarations du SDK
publié ; il échoue sur un champ inventé dans un exemple de cas (vérifié dans les deux sens) ; deux cas qui écrivent le
même chemin ne se masquent plus. Le commentaire de `EXEMPLES_CAS` dit enfin vrai.

### Tâche 3 : le groupe « Recettes » de la doc

**Fichiers** : `web/lib/doc-api-pages.ts` (`GroupeDoc` gagne `recettes`, « Recettes » / « Recipes » ; `nextjs` y
passe sans changer d'adresse), `web/lib/doc-md.test.ts` et les `.md` régénérés (`npm run doc:md` dans `web/`).

**Tests attendus** : la suite de `web/` et la suite racine (des tests racine lisent `web/lib`).

### Tâche 4 : un en-tête et un pied de page écrits une fois

**Fichiers** : créer `scripts/vitrine/entete.ts` (sur le modèle de `scripts/plugin/generer.ts` et de ses marques
`faq:debut` / `faq:fin`), un script `vitrine:entete` dans `package.json`, créer `tests/vitrine-entete.test.ts` ; toutes
les pages de `site/` reçoivent les marques.

**Interfaces produites** : `enteteVitrine(langue, page)` et `piedVitrine(langue)` ; le lien actif (`aria-current`)
calculé depuis l'adresse de la page ; le menu lu dans le registre (seules les entrées `enLigne`).

**Tests attendus** : chaque page égale au caractère près à sa génération (comme `tests/plugin-faq.test.ts`) ; le menu
burger porte les mêmes adresses que le menu de bureau ; aucune page anglaise ne lie une page française, sauf le
sélecteur de langue. Dans cette livraison, le menu reste celui d'aujourd'hui : la génération ne change aucun rendu
(comparaison des pages avant et après, au caractère près hors marques).

**Fini quand** : la suite racine passe, le rendu est inchangé (montré à Julien), son oui reçu, poussé.

## Livraison B : le menu, les tarifs et la rubrique Solutions

### Tâche 5 : les tarifs, les carrefours et les cinq pages Solutions

**Fichiers** : créer `site/tarifs/`, `site/en/pricing/` (remplace la page d'attente), `site/solutions/` et
`site/en/solutions/` (carrefour et cinq pages), `site/cas-d-usage/` et `site/en/use-cases/` (carrefour seul, filtré par
profil) ; `site/vercel.json` (redirections permanentes `/pricing/`, `/industries/`, `/en/industries/`) ; retrait de
`site/pricing/`, `site/industries/`, `site/en/industries/` ; `site/sitemap.xml`, `site/llms.txt` ; le menu de la
spec dans `scripts/vitrine/entete.ts` ; `site/developpeurs/` et `site/en/developers/` (la section « piloter WhatsApp
depuis Claude », qui remplace le cas 6, et la promesse « Cursor, VS Code ou Lovable : la même autorisation s'ouvre »
ramenée à « tout client MCP se branche par l'adresse publique » tant que l'essai 98 n'est pas fait) ;
`tests/vitrine-pages.test.ts` (créé, son brouillon du 2026-10-15 est dans
l'extraction de la session) ; le registre passe les cinq pages Solutions en `enLigne`.

**Tests attendus** : tous ceux de la spec du lot 6 (chiffres `data-offre`, outils, routes, événements, plan du site,
`llms.txt`, paires `hreflang`, bornes du titre et de la description, un seul H1, JSON-LD lisible) appliqués à chaque
page neuve ; la page des tarifs porte toute la grille ; le carrefour des cas ne lie que des entrées `enLigne` et ne
propose un filtre de profil que s'il a au moins un cas en ligne ; les seuils de `tests/vitrine-developpeurs.test.ts`
(nombre de pages à menu) mis à jour dans le même commit.

**Fini quand** : rendu montré à Julien dans les deux langues, son oui reçu, poussé, lu en ligne (essai réel).

## Livraison C : les cas, un par un, chacun avec son film

### Tâche 6 : les films de la vague 1

Dans l'atelier, selon son `CLAUDE.md` (un `SCRIPT.md` validé par Julien avant toute animation, deux exports au plus à la
fois sur la machine, annoncés à la session voisine, tempo vérifié sur une longue fenêtre) : bulle Lovable, rappels,
« SaaS » (accueil et paiement échoué), agence. Le film 1 (prise de rendez-vous) part tel quel après les essais 98 et
121, ou dans une variante dont l'ouverture ne montre que Claude Code : choix de Julien au moment de publier.

### Tâche 7 : une page de cas (à répéter pour chaque cas)

Ordre : prise de rendez-vous, support et relais, bulle Lovable, accueil SaaS, paiement échoué, rappels (après la
vérification des réponses rapides) ; le film « agence » entre dans `/solutions/agences/`. Vague 2, ensuite :
notifications de commande (son guide est la recette Next.js existante).

**Fichiers** : l'entrée du registre (`enLigne: true`) ; son code dans `EXEMPLES_CAS` s'il en a ; son guide
`web/app/developers/api/guides/<slug>/page.tsx` dans le groupe `recettes`, sa phrase dans `RESUMES_PAGES`, ses `.md` ;
ses deux pages ; ses films dans `site/films/` ; les carrefours, `sitemap.xml`, `llms.txt`.

**Tests attendus** : ceux des tâches 1, 2 et 5 sur la nouvelle entrée (`data-guide` exact, avec `?lang=en` sur la page
anglaise ; `data-exemple` égal au code compilé ; le guide déclaré) ; `data-recette` seulement quand la commande est
publiée (livraison D), donc absent à la première mise en ligne.

**Fini quand** : rendu montré, oui de Julien, poussé, lu en ligne.

## Livraison D : le dépôt du plugin plus fourni

### Tâche 8 : les quatre commandes et le code des cas

**Fichiers** : `plugin/skills/{accueil,relance-paiement,rappels,agence}/` (`SKILL.md` avec
`disable-model-invocation: true`, `code/`, `.env.example`), `plugin/skills/mise-en-service/code/` (rendez-vous,
relais, bulle) et sa dernière étape qui liste les commandes ; générés par `scripts/plugin/` depuis le registre et
`EXEMPLES_CAS` (`npm run plugin:generer`).

**Tests attendus** : `tests/plugin.test.ts` dérive la liste des skills du registre ; chaque dossier généré est égal à sa
génération au caractère près ; les règles actuelles des `SKILL.md` (noms existants, aucun prix, `allowed-tools` en
lecture seule) s'appliquent aux nouvelles.

### Tâche 9 : le README, les README de cas et les fichiers autour

**Fichiers** : générés dans `plugin/` : `README.md` (le plan de la spec 6 bis, sections dans l'ordre), un `README.md` par
dossier de cas, `CHANGELOG.md`, `SECURITY.md`, `.github/ISSUE_TEMPLATE/config.yml` et `bug.yml` ; les textes écrits à la
main dans `scripts/plugin/` ; l'animation dans `site/img/github/` (tirée du film 1 anglais, téléphone et agenda,
960 px, 5 Mio au plus) ; `plugin/.claude-plugin/plugin.json` (version montée) ; `.github/workflows/plugin.yml` (sa
liste de tests) ; un workflow hebdomadaire de vérification des liens vers l'extérieur.

**Tests attendus** : chaque fichier généré égal à sa génération ; le tableau « What you can build » ne liste que les
entrées `enLigne` dont la commande existe (ou `demarrer`) ; chaque événement cité est dans `TYPES_ABONNABLES`, chaque
route dans `sdk/openapi.json`, chaque outil dans le catalogue MCP ; aucun prix de Meta (hors journal des versions) ;
aucun nom de l'infrastructure, aucun tiret long ; chaque adresse de la vitrine citée correspond à un fichier de `site/` ;
la première entrée du journal porte la version de `plugin.json`. Les pages de cas reçoivent alors leur `data-recette`.

**Fini quand** : la suite racine passe, la relecture de la livraison est faite, la vitrine porte déjà les pages liées,
`gh workflow run plugin.yml --ref main` publie, l'animation s'affiche sur GitHub (sinon, repli sur l'affiche fixe du film
à la publication suivante), et l'essai réel d'installation neuve est fait.

## Livraison E : le SDK

### Tâche 10 : le SDK en anglais, avec son journal

**Fichiers** : `sdk/README.md` (en anglais, une ligne d'installation depuis GitHub, un lien vers le tableau des cas du
plugin), `web/lib/exemples-code.ts` (`EXEMPLES_SDK` commentés en anglais), `sdk/CHANGELOG.md` (tiré de la section
« Versions »), `.github/workflows/sdk.yml` (le journal dans les fichiers publiés), `sdk/package.json` et `VERSION_SDK`
(version montée), `tests/sdk-publie/` régénéré.

**Tests attendus** : `tests/doc-exemples-compiles.test.ts` (le README contient chaque exemple mot pour mot) ; la première
entrée du journal égale `package.json` et `VERSION_SDK` ; la page SDK de la console relue dans les deux langues.

**Fini quand** : publié par `sdk.yml`, le dépôt du SDK lu sur GitHub.

## Ordre de déploiement

Aucune API, aucune migration. Avant tout, puis 0 (plugin 0.2.0), A, B, C (au rythme des films), D, E. Chaque push de
`site/` publie la vitrine dès que Vercel a construit, après le oui de Julien. Le plugin et le SDK se publient à la main,
APRÈS la vitrine qui porte les pages qu'ils lient. Les réglages GitHub (mots-clés, adresse du site, image d'aperçu,
description du SDK en anglais, et l'adresse de site périmée du dépôt principal effacée) sont donnés à Julien en
commandes prêtes à coller, à la livraison D.

## Les gestes de Julien

Les conditions d'utilisation (emplacement, relecture) ; `security@messagingme.fr` ; la Search Console et Bing Webmaster
Tools ; un `SCRIPT.md` validé par film ; les essais 98 et 121, ou le choix d'une ouverture du film 1 sans ces logos ; le
oui sur chaque rendu avant un push de `site/` ; les réglages GitHub ; l'accord écrit d'un client avant de le citer ; la
lecture en ligne de chaque livraison.
