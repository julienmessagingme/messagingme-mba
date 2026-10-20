# Centre d'aide et modes opératoires : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** un centre d'aide public sur la vitrine (`/aide/`, `/en/help/`), généré depuis les fiches d'aide, des pages
« Depuis Claude Code » dans la doc développeurs, un lien « Comment faire » dans la console, des films courts, et le bot
d'aide qui reçoit la bonne étape d'une fiche au lieu de ses 2 000 premiers caractères.

**Architecture :** la fiche reste la seule source. Un module lit sa STRUCTURE (chapeau, étapes, encadrés) ; le chargeur
du bot s'en sert pour découper, le générateur de la vitrine pour écrire les pages, sur le modèle de
`scripts/vitrine/cas.ts` (pages entières, égales à leur génération par test). La version anglaise d'une fiche vit à
côté d'elle et porte l'empreinte du français qu'elle traduit. La console importe une correspondance écran vers page,
générée elle aussi.

**Tech Stack :** TypeScript, vitest, tsx ; vitrine HTML statique ; console Next.js ; Playwright pour les captures ;
ffmpeg (poste) pour le `.webp` ; l'atelier `~/engageme-motion` pour les films.

**Spec :** `docs/superpowers/specs/2026-10-20-doc-fonctionnelle-design.md` (d54a47ae), validée par Julien le
2026-10-20.

## Global Constraints

- Première vague, rubrique **Démarrer** (`demarrer`) dans cet ordre : `choisir-mon-offre`, `ce-qu-il-faut-chez-meta`,
  `connecter-mon-numero-whatsapp`, `me-reperer-dans-la-console`. Rubrique **Parler aux clients**
  (`parler-aux-clients`) : `repondre-dans-l-inbox`, `la-fenetre-de-24-heures`, `faire-approuver-un-modele`,
  `importer-mes-contacts`, `lancer-une-campagne`. Libellés anglais : « Get started », « Talk to customers ».
- Adresses : `/aide/` et `/aide/<cle>/` ; `/en/help/` et `/en/help/<slug>/` (le `slug` est dans la fiche anglaise).
  Pages Claude Code : `/developpeurs/installer-le-plugin/`, `/developpeurs/connecter-son-numero/`,
  `/developpeurs/repondre-a-une-conversation/`, `/developpeurs/preparer-une-campagne/` ; en anglais
  `/en/developers/install-the-plugin/`, `/en/developers/connect-your-number/`,
  `/en/developers/reply-to-a-conversation/`, `/en/developers/prepare-a-campaign/`.
- « Comment faire » sur six écrans : `accueil` vers `connecter-mon-numero-whatsapp`, `offre` vers `choisir-mon-offre`,
  `inbox` vers `repondre-dans-l-inbox`, `templates` vers `faire-approuver-un-modele`, `contacts` vers
  `importer-mes-contacts`, `campagnes` vers `lancer-une-campagne`. Jamais deux pages pour un écran.
- Films (spec) : `connecter-mon-numero-whatsapp`, `me-reperer-dans-la-console`, `repondre-dans-l-inbox`,
  `faire-approuver-un-modele`, `importer-mes-contacts`, `lancer-une-campagne`, et les quatre pages Claude Code (celle de
  l'installation reprend `cas-onboarding`). 16:9, français et anglais, sous-titres incrustés, AUCUNE piste son, une
  minute trente au plus.
- Pages de la console : elles disent l'offre demandée (Pro, essai de 14 jours) ; les pages Claude Code valent pour toutes
  les offres.
- Captures : console réelle construite en local, données INVENTÉES (marque « Votre marque », Léa, collection
  d'automne, `AUTOMNE20`), jamais une donnée d'un client, aucun envoi réel, aucune session ni mot de passe.
- Bas de page : « Une question sans réponse ? Écrivez-nous » (EN « A question this page does not answer? Write to
  us »), vers `/contact/?aide=<titre>` ou `/en/contact/?aide=<titre>`.
- Le bot garde les fiches FRANÇAISES ; son coût par réponse ne monte pas (`FICHES_RENDUES` reste 3).
- Textes : pas de tiret cadratin ni demi-cadratin, jamais « UChat », vouvoiement dans la console.

## Review Focus

1. **Un marqueur d'étape mal écrit** (`**3 . Titre.**`, un numéro sauté, « Bon à savoir » sans le gras) ferait d'une
   étape un simple paragraphe, et la page montrerait une étape de moins que la console. `erreursDeStructure` le
   signale ; test en tâche 1.
2. **Un morceau du bot sans son contexte** : « cliquez sur Lancer » seul ne dit pas de quel écran il parle. Chaque
   morceau d'étape commence par son marqueur (numéro et titre) et le titre de la fiche part à côté ; test en tâche 2.
3. **Une recherche tapée sans accents** (« modele ») doit trouver « Faire approuver un modèle ». Les mots indexés sont
   normalisés ; test en tâche 5.
4. **Le titre passé au formulaire de contact** est une entrée du visiteur : il se pose en `.value`, borné à 120
   caractères, jamais en HTML ; relu en tâche 6.
5. **Rien de perdu en scindant** « Connecter mon numéro » : chaque paragraphe retiré se retrouve dans une autre fiche
   (le bot y répondait). Relecture paragraphe par paragraphe en tâche 3.

## Méthode de livraison

**Deux méthodes, parce que deux natures.** Le lot du bot (tâches 1 et 2) touche un chemin que la production emprunte
(chaque question posée au bot d'aide) : **implémenteur par lot, puis une relecture indépendante du diff**, qui regarde
d'abord la taille des morceaux, les sources dédoublonnées et le rechargement. Le reste (fiches, vitrine statique,
lien de la console, films) est réversible et tenu par des tests de génération : **en direct**, avec une relecture
indépendante en fin de lot et le rendu vérifié au navigateur, bureau et téléphone, avant chaque push de `site/`.

**L'essai réel qui clôt** (spec) : Julien crée un espace neuf (Free), passe à l'essai Pro, suit « Comment faire » depuis
l'Accueil et va jusqu'à sa première campagne programmée en ne lisant que le centre d'aide ; puis il refait le chemin
depuis Claude Code avec les pages développeurs. Chaque endroit où il a dû deviner est un défaut de page. Pour le bot :
en production, après le rechargement, « comment je programme ma campagne pour demain ? » reçoit une réponse juste qui
cite « Lancer une campagne ».

---

### Tâche 1 : la structure d'une fiche

**Fichiers :** créer `src/aide/structure.ts` ; test `tests/aide-structure.test.ts`.

**La grammaire (le contrat que les fiches publiques suivent) :** blocs séparés par une ligne vide ; un bloc est un
paragraphe, une liste (lignes `- `) ou un intertitre `## `. Le premier paragraphe est le **chapeau**. Une **étape** est
un paragraphe qui commence par `**N. Titre.**` (N de 1 à n, sans trou) ; elle possède les blocs qui suivent jusqu'à
l'étape suivante, un encadré ou un intertitre. Un **encadré** est un paragraphe qui commence par `**Bon à savoir.**`
(anglais : `**Good to know.**`). En ligne, seul le gras `**...**` existe ; interdits : accent grave, lien `](`,
italique `*x*`, titre autre que `## `, liste numérotée `1. `.

**Interfaces, produit :**
- `type BlocFiche = { type: 'paragraphe'; texte: string } | { type: 'liste'; items: string[] }`
- `type SectionFiche = { type: 'prose'; titre: string | null; blocs: BlocFiche[] } | { type: 'etape'; numero: number;
  titre: string; tete: string; detail: BlocFiche[] } | { type: 'encadre'; texte: string }`
- `interface StructureFiche { chapeau: string; sections: SectionFiche[] }`
- `structureFiche(corps: string, langue: 'fr' | 'en' = 'fr'): StructureFiche` : ne lève jamais (le chargeur la passe
  sur les 31 fiches, publiques ou non).
- `erreursDeStructure(corps: string, langue: 'fr' | 'en'): string[]` : vide si la fiche suit la grammaire ;
  `CHAPEAU_MAX = 320`, `TETE_MAX = 400` caractères.

- [ ] Tests : la fiche `lancer-une-campagne` actuelle rend 5 étapes, numéros 1 à 5, la `tete` de l'étape 1 commence par
      « Il n'est visible » ; un encadré entre deux étapes garde sa place ; `erreursDeStructure` signale un numéro sauté,
      `**3 . X.**`, un paragraphe qui commence par `**` et un chiffre sans être un marqueur, un accent grave, un lien, un
      chapeau de 321 caractères ; une fiche sans étape rend `sections` en prose. Rouges.
- [ ] Implémenter. Verts.

### Tâche 2 : le bot reçoit la bonne étape

**Fichiers :** modifier `src/aide/fiches.ts` (`MORCEAU_MAX`, `decouperFiche`), `db/charger-aide.ts` (`main` charge
`fichesDuDepot().flatMap(decouperFiche)`), `src/aide/repondre.ts` (`CORPS_MAX` remplacé par l'import de
`MORCEAU_MAX`, sources dédoublonnées) ; tests `tests/aide-decoupage.test.ts`, `tests/aide-repondre.test.ts`.

**Interfaces, produit :**
- `MORCEAU_MAX = 2_000` (la valeur de `CORPS_MAX`, désormais une seule constante).
- `decouperFiche(f: FicheFichier): FicheFichier[]` : une fiche dont le corps tient dans `MORCEAU_MAX` reste ENTIÈRE sous
  sa clé (son vecteur est gardé) ; sinon des morceaux de clé `<cle>#<n>` (n depuis 1), même titre, même écran, même
  source : le chapeau et la prose d'avant la première étape, puis une étape par morceau (marqueur compris), un encadré
  par morceau, la prose regroupée par paragraphes sous la borne ; un paragraphe trop long se coupe à une fin de phrase.
- `fichesDuDepot()` et `chargerFiches(client, fiches)` gardent leur signature (`tests/aide-fiches-format.test.ts` compte
  les fichiers, l'intégration passe des `FicheFichier`).

- [ ] Tests : aucun morceau des 31 fiches réelles ne dépasse `MORCEAU_MAX` ; chaque morceau d'étape commence par
      `**N. ` (Review Focus 2) ; une fiche courte garde sa clé sans `#` ; `lancer-une-campagne` donne un morceau par
      étape ; deux morceaux d'une même fiche retenus donnent UNE source (`aide-repondre`). Rouges.
- [ ] Implémenter. Verts, plus `tests/aide-*.test.ts` et `npm run typecheck`.
- [ ] Déploiement : API seule (le worker vectorise déjà les lignes sans vecteur), puis
      `docker compose run --rm --no-deps mba-api npm run aide:charger` (`DEPLOY.md`), puis en lecture seule : le nombre de
      clés `#`, les vecteurs qui se remplissent, et une question réelle posée au bot.

### Tâche 3 : les fiches françaises de la première vague

**Fichiers :** les neuf fiches de la vague dans `docs/aide/fiches/` ; les fiches neuves nées de la scission de
`connecter-mon-numero-whatsapp` ; test `tests/aide-fiches-format.test.ts` (étendu).

**En-tête ajouté :** `publique: oui`, `rubrique: demarrer|parler-aux-clients`, `rang: <entier>` ; selon la fiche :
`comment_faire: oui` (les six de « Global Constraints »), `captures: non` (étapes hors de la console :
`ce-qu-il-faut-chez-meta`, `la-fenetre-de-24-heures`), `video: oui` (les six films de la console), `prerequis: <cle>`
(le second bouton de la page, par exemple `faire-approuver-un-modele` pour la campagne), `offre: non` (les deux pages
qui ne demandent pas le Pro : `choisir-mon-offre`, `ce-qu-il-faut-chez-meta`).

- [ ] Tests : chaque fiche publique passe `erreursDeStructure` ; `rubrique` connue, `rang` unique dans sa rubrique ;
      `comment_faire` unique par `ecran` ; `prerequis` désigne une fiche publique. Rouges.
- [ ] Réécrire les neuf fiches : chapeau, étapes `**N. Titre.**` dont la première phrase dit le geste, « Bon à
      savoir », resserrées sans perdre ce dont le bot a besoin. Scinder `connecter-mon-numero-whatsapp` : le geste reste,
      HubSpot, canaux et services, abonnement au numéro et déconnexion partent dans des fiches neuves, chacune avec son
      `ecran`, sa `source_section` et sa `source_empreinte` (Review Focus 5).
- [ ] Verts, `tests/aide-proposer.test.ts` compris ; push (`.md` seuls, aucune CI : tests lancés avant, `&&`), puis
      `aide:charger` en production.

### Tâche 4 : les fiches anglaises

**Fichiers :** `docs/aide/fiches/en/<cle>.md` pour chaque fiche publique ; test `tests/aide-fiches-anglais.test.ts`.
Le chargeur du bot et `aide-proposer` lisent `docs/aide/fiches/*.md` sans descendre dans `en/` : à vérifier par test.

**Interfaces, produit :** en-tête `slug: <slug-anglais>` et `traduit_de: <empreinte>`, où l'empreinte est
`empreinteDe(texte)` de `scripts/aide-proposer.ts` sur le fichier français entier ; corps suivant la grammaire en
anglais.

- [ ] Tests : chaque fiche publique a sa version anglaise ; `traduit_de` égale l'empreinte du français ACTUEL (le
      message d'échec donne la valeur attendue) ; même nombre d'étapes ; `slug` unique, `^[a-z0-9-]+$` ; aucune fiche
      anglaise sans fiche publique ; `fichesDuDepot()` ne voit aucune fiche de `en/`. Rouges.
- [ ] Traduire. Verts.

### Tâche 5 : le générateur du centre d'aide

**Fichiers :** créer `scripts/vitrine/aide.ts` (`npm run vitrine:aide`), `scripts/vitrine/aide-pages.ts` (le registre
des pages, sans dépendance vers `anglais.ts`) ; modifier `scripts/vitrine/cas.ts` (exporter sa fonction `page`, plutôt
que de la recopier), `scripts/vitrine/anglais.ts` (`JUMELLES` étendu par le registre, `hors()` écarte `/aide/` et les
pages de la tâche 7) ; générés : `site/aide/**`, `site/en/help/**`, `web/lib/aide-pages.ts`, le bloc des adresses
d'aide de `site/sitemap.xml`, la section « ## Aide » de `site/llms.txt` (avant « ## Tarifs ») ; test
`tests/vitrine-aide.test.ts`.

**Interfaces, produit :**
- `PAGES_AIDE` (registre) : par fiche publique, `{ cle, rubrique, rang, fr: { adresse, titre }, en: { adresse, titre },
  ecran, commentFaire, video, captures }`.
- `pagesAide(): Array<{ chemin: string; contenu: string }>` : l'accueil `/aide/` (rubriques et pages), puis une page
  par fiche et par langue, au gabarit de la maquette validée (`scratchpad/maquette-aide/main.html`) : fil d'Ariane,
  titre, chapeau, sauf `offre: non` la mention de l'offre sous le chapeau (« Avec l'offre Pro, ou pendant l'essai
  Pro de N jours », N lu dans `ESSAI_PRO_JOURS`, jamais recopié), bouton vers l'écran de la console
  (`CARTE_CONSOLE`, `https://console.messagingme.app` + `href`, la
  console en `lang=en` pour l'anglais), bouton du `prerequis`, menu à gauche par rubrique, film si `video`, étapes
  avec `tete` visible et `detail` replié sous « En détail » (`<details>`), capture si le fichier existe, encadrés,
  précédente et suivante, lien de contact. JSON-LD : `BreadcrumbList`, `HowTo` (les étapes), `VideoObject` si film.
- `motsDeRecherche(texte: string): string` : minuscules, sans diacritiques, espaces réduits ; posé en `data-mots` sur
  chaque entrée du menu (titre et chapeau).
- `web/lib/aide-pages.ts` : `PAGES_COMMENT_FAIRE: Readonly<Record<string, { fr: string; en: string }>>`, l'écran vers
  les deux adresses absolues.

- [ ] Tests : chaque page égale sa génération ; une page par fiche publique et par langue, et rien d'autre sous
      `site/aide/` et `site/en/help/` ; le nombre d'étapes affichées égale celui de la fiche ; une étape avec détail a
      son `<details>` ; chaque lien interne mène à une page qui existe ; plan du site et `llms.txt` citent chaque
      page ; la mention de l'offre est sur chaque page sauf les deux `offre: non` ;
      `motsDeRecherche('Faire approuver un modèle')` contient `modele` (Review Focus 3) ;
      `web/lib/aide-pages.ts` égal à sa génération, avec les six écrans. Rouges.
- [ ] Implémenter, générer. Verts, plus `vitrine-langues`, `vitrine-entete`, `registre-vitrine`, `vitrine-anglais`.

### Tâche 6 : styles et script de la vitrine

**Fichiers :** `site/site.css` (les styles `aide-*` de la maquette, sur fond clair : la recherche et les séparateurs
foncés, captures bornées à 380 px de haut), `site/site.js` (filtre du menu, préremplissage du contact).

- [ ] Filtre : l'entrée tapée passe par la même normalisation que `motsDeRecherche`, le menu ne garde que les entrées
      dont `data-mots` contient tous les mots ; une rubrique vide se masque.
- [ ] Contact : sur `/contact/` et `/en/contact/`, `?aide=` remplit `#c-message` s'il est vide, par `.value`, titre
      borné à 120 caractères (Review Focus 4).
- [ ] Vérifier au navigateur (serveur Node du scratchpad, `apercu-vitrine-extraction`) : bureau et téléphone,
      `scrollWidth` égal à `clientWidth`, filtre avec et sans accents, préremplissage.

### Tâche 7 : les pages « Depuis Claude Code »

**Fichiers :** créer `scripts/vitrine/aide-claude-textes.ts` (source bilingue `{ fr, en }`, sur le modèle de
`scripts/plugin/faq.ts`) ; `scripts/vitrine/aide.ts` les génère aussi ; `tests/vitrine-aide.test.ts` (étendu).

**Interfaces, produit :** par page : `cle`, adresses, titre, chapeau, `etapes: Array<{ titre; dire: string; outils:
string[]; reponse: string }>` (ce qu'on dit à Claude, les outils qu'il appelle, ce qu'il répond), `bonASavoir?`,
`film?`. Rendu : même gabarit, le menu de gauche liste les pages développeurs (accueil Développeurs, compte Meta
Business, les quatre pages) ; chaque outil cité porte `data-outil`.

- [ ] Tests : chaque `data-outil` est une clé de `CATALOGUE_MCP` et s'affiche sous son nom (comme
      `tests/vitrine-developpeurs.test.ts`) ; « préparer une campagne » cite `prepare_campaign` avant `launch_campaign` ;
      pages égales à leur génération, citées par le plan du site et `llms.txt`, jumelles déclarées. Rouges.
- [ ] Écrire les textes à partir des outils réels (`src/mcp/`) et de la FAQ du plugin. Verts.

### Tâche 8 : les captures

**Fichiers :** `web/playwright.captures.config.ts` (lancé à la main, jamais par la CI), `web/e2e/captures/donnees-demo.ts`
(la marque fictive et ses réponses d'API simulées), un fichier de scénario par fiche dans `web/e2e/captures/`,
`scripts/aide/captures-webp.mjs` (PNG vers `site/img/aide/<cle>/etape-<n>.webp` et `etape-<n>-en.webp` par ffmpeg),
`npm run aide:captures` ; `tests/vitrine-aide.test.ts` (étendu).

- [ ] La console se sert comme pour les e2e (`next start`, `BACKEND_URL=http://127.0.0.1:9`, session posée dans
      `localStorage`, `page.route` sur `**/api/backend/**`), en français puis en anglais ; chaque scénario amène l'écran
      à l'état de l'étape et en fait la capture. Le cadre de navigateur des captures des pages Fonctionnalités est
      repris si le rendu l'exige (choix du constructeur).
- [ ] La fenêtre de Meta (étape de `connecter-mon-numero-whatsapp`) ne se simule pas : son image est la forme
      générique en trois étapes du film `cas-onboarding`, rendue en `.webp` sous le même nom que les autres captures.
- [ ] Test ajouté : chaque étape d'une fiche publique sans `captures: non` a ses deux fichiers ; aucun fichier orphelin
      sous `site/img/aide/`. Rouge avant les captures, vert après.
- [ ] Relire chaque capture à l'œil : aucune vraie donnée, aucun écran d'erreur, la bonne langue.

### Tâche 9 : « Aide » dans le menu de la vitrine

**Fichiers :** `scripts/vitrine/entete.fr.html`, `entete.en.html`, `pied.fr.html`, `pied.en.html` ; `npm run
vitrine:entete`.

- [ ] « Aide » (« Help ») entre Tarifs et Développeurs, au bureau et dans le burger ; lien en pied de page. Test : chaque
      page française mène à `/aide/`, chaque anglaise à `/en/help/`, au bureau et au téléphone.
- [ ] **Montrer à Julien le rendu avant de pousser** (changement de la face publique, sa règle) ; pousser sur son oui.

### Tâche 10 : « Comment faire » dans la console

**Fichiers :** créer `web/lib/comment-faire.ts`, `web/components/LienCommentFaire.tsx` ; modifier
`web/components/AppShell.tsx` (posé UNE fois dans la barre du haut, à droite, avant le menu de compte) ; tests
`web/lib/comment-faire.test.ts`, `web/e2e/comment-faire.spec.ts`.

**Écart à la spec, assumé :** la spec dit « à côté du titre ». Le titre est écrit par 61 écrans (`TitrePage`) ; la barre
du haut est l'en-tête commun, posée une fois, comme le bouton d'aide. Le lien y est le même pour tous les écrans.

**Interfaces, produit :** `pageCommentFaire(ecran: string, locale: Locale): string | null` (lit
`PAGES_COMMENT_FAIRE`). Le lien : icône `question` de `Icone`, libellé « Comment faire » (« How to »), `target="_blank"`,
`rel="noopener"`.

- [ ] Tests : `campagnes` en français mène à `/aide/lancer-une-campagne/`, en anglais à la page anglaise ; `webhooks`
      rend `null`. E2E : le lien est sur Campagnes avec la bonne adresse, absent sur Webhooks. Rouges, puis verts.
- [ ] Suite racine ENTIÈRE avant de pousser (`web-icones`, `web-vouvoiement`, `web-formes`), et les e2e qui trouvent la
      barre du haut par rôle (`grep -rn "banner\|AccountMenu" web/e2e`).

### Tâche 11 : les films

**Fichiers :** dans `~/engageme-motion`, un dossier `engageme-aide-<cle>` par film (lire son `CLAUDE.md` avant) ;
livrés dans `site/films/aide-<cle>.mp4`, `aide-<cle>-en.mp4` et leurs affiches `.webp` ; `video: oui` posé dans la
fiche, puis `npm run vitrine:aide`.

- [ ] Par film : `SCRIPT.md` (introduction animée de 5 secondes, puis les captures de la tâche 8 animées : curseur,
      zoom), sous-titres incrustés dans la langue du film, export SANS piste son (`ffprobe` ne montre aucun flux audio),
      16:9, une minute trente au plus. Pas plus de deux exports à la fois.
- [ ] Test ajouté : une fiche `video: oui` a ses quatre fichiers ; un fichier remplacé sous le même nom prend un `?v=`
      incrémenté.

### Tâche 12 : documentation et essais

- [ ] `documentation.md` : la grammaire des fiches, le découpage du bot, le générateur, la règle « fiche publique
      retouchée = `npm run vitrine:aide`, puis `aide:charger` après le push ». `features.md` : le centre d'aide et
      « Comment faire » (puis `tests/aide-proposer.test.ts`). `CLAUDE.md` : la règle seule, sans récit. `todo.md` :
      retirer « le bot ne lit que le début de ses fiches ». `docs/JOURNAL-TECHNIQUE.md` : le récit.
- [ ] `docs/prive/ESSAIS-REELS.md` : l'essai réel de la « Méthode de livraison », et celui du bot.

## Ordre de déploiement

1. **Tâches 1 et 2** : push, CI lue job par job, relecture du diff, `up -d --build mba-api` avec sa `REVISION`, puis
   `aide:charger` en production et la question réelle au bot.
2. **Tâches 3 et 4** : tests lancés avant le push (`.md` seuls), push, `aide:charger`.
3. **Tâches 5 à 8** : poussées ensemble (le push de `site/` lance la CI racine et publie la vitrine), après le rendu
   vérifié au navigateur et la relecture du lot. Sans le menu : les pages sont trouvables par les moteurs et la console.
4. **Tâche 9** sur le oui de Julien.
5. **Tâche 10** après que les pages sont en ligne (vérifiées par `curl -I`), jamais avant : la console se publie au push.
6. **Tâche 11** au fil des films ; une page sans film s'affiche sans le bloc.
7. **Tâche 12**, puis l'essai réel.
