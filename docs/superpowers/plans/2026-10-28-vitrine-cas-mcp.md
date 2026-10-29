# Plan : les cas d'usage MCP sur la vitrine (2026-10-28)

Source : [le bilan du 2026-10-28](../../BILAN-CAS-USAGE-MCP-2026-10-28.md), ses § 2 (cas et preuves) et § 5 (décisions de
Julien). Trois pages changent : « Boutiques Shopify », « SaaS et app builders », développeurs. Aucune route d'API neuve,
aucune migration : la vitrine part à son push.

## Méthode de livraison

**En direct, sans agent, avec une relecture indépendante en fin de lot**, parce que les quatre questions répondent
toutes du côté léger : la production n'emprunte aucun de ces chemins (des pages statiques, aucun envoi, aucun chiffre
facturé), tout se défait par un `git revert` et le redéploiement de Vercel, les critères sont pour moitié vérifiables par
un test (outils existants, étiquettes dérivées, aucun « bientôt ») et pour moitié par un œil (le rendu), et les
invariants invisibles (marque Shopify, QR code qui ne fait que répondre, agent jamais dit gratuit, jamais le mot
« coexistence ») sont déjà tenus par des tests. Un feature-loop ne servirait à rien sur un rendu, et un workflow
encore moins.

**Essai réel qui clôt** : Julien relit les trois pages en ligne, en français puis en anglais, sur ordinateur et au
téléphone (375 px) : chaque liste repliée ouverte, chaque étiquette lue, le bouton de l'essai du Pro qui mène à
l'inscription, le guide du numéro qui propose de garder l'application sans « bientôt ». Puis le README du plugin sur
GitHub après sa publication. Hors de cette clôture, à inscrire dans `docs/prive/ESSAIS-REELS.md` (décision 7 : la page
ne les attend pas) : la bulle posée sur le thème de la boutique de test, visible et cliquable au téléphone ; et, sur la
boutique de test, les combinaisons S4, S6, S7, S10 et S11 du bilan jouées une fois depuis Claude Code.

## Avant de commencer : deux sessions voisines

- **« Fabriquer le film Shopify »** pose un film sur la même page (`scripts/vitrine/boutique*.ts`) : lui annoncer le
  lot avant d'éditer ces deux fichiers, et ne pas commiter pendant qu'il y travaille.
- **L'offre Business** (spec `2026-10-27-offre-business-design.md`, lot 1 en cours ailleurs) change la grille du Pro
  (1 000 contacts, plus d'agent de Meta ni d'assistants). Le bloc Pro lit ses chiffres dans `DROITS` et ne nomme ni
  l'agent de Meta ni les assistants : il suit sans retouche. L'étiquette « Pro » veut dire « Pro et au-delà ».

## Tâche 1 : la page « Boutiques Shopify »

Fichiers : `scripts/vitrine/boutique-textes.ts` (français ET anglais : la page anglaise s'y écrit, pas dans les
dictionnaires), `scripts/vitrine/boutique.ts`, `site/site.css`, `scripts/plugin/familles-outils.ts`, `features.md`
(le paragraphe de la page, avant la première section), `tests/vitrine-boutique.test.ts`.

1. **Le « bientôt » corrigé** (décision 1) : le terme du lexique, l'issue `garder-application` au présent (Claude
   ouvre la fenêtre de Meta, vous reliez l'application, les messages de la boutique partent), la FAQ « Quel numéro
   WhatsApp utiliser ? », le commentaire d'en-tête, et « (annoncé « bientôt ») » dans `features.md`. Ne rien promettre
   du lot 2 de la coexistence (les messages tapés dans l'application visibles dans Messaging Me).
2. **« Et ensuite » remplacé** par la section `claude` (ancre `#claude`), trois besoins de quatre cartes au plus :
   - *Répondre à vos clients* : l'agent IA qui connaît la boutique (Free) ; « Où est ma commande ? » (Free) ; vous
     répondez depuis Claude (Free) ; votre équipe répond dans l'Inbox (Pro).
   - *Vendre et faire revenir* : la bulle WhatsApp sur la boutique, balise à coller dans le thème (Free) ; un message à
     un client précis (Free) ; vos promotions en campagne (Pro) ; la publicité Click-to-WhatsApp (Entreprise).
   - *Piloter depuis Claude* : la boutique en un coup d'œil (Free) ; vos messages écrits pour vous (Free) ; vos contacts
     en ordre (Free) ; le coût et les clics de vos campagnes, le travail de votre agent IA (Pro).
   Chaque carte : titre, une phrase, une ligne « Avec » qui cite ses outils en `<code>`, et **son étiquette d'offre,
   toujours** (décision 4). Les cartes Pro et Entreprise ressortent (couleur d'accent de l'étiquette et du bord).
   Interface : `Carte` gagne `outils: readonly NomOutilMcp[]` (vide pour une fonction de la console) ; l'offre ne
   s'écrit plus à la main, elle se calcule (point 5).
3. **Le bloc « Ce que le Pro ajoute »** sous les besoins : les campagnes et le ciblage ; la console et l'Inbox de
   l'équipe, la carte de la boutique dans la console ; les chiffres des campagnes et de l'agent IA ; la bulle sans
   « Propulsé par Messaging Me » ; un numéro fourni inclus ; les envois sans limite par mois et les contacts du Pro. Les
   chiffres et le prix viennent de `DROITS`, `PRIX_PRO_HT_CENTIMES` et `ESSAI_PRO_JOURS`. Bouton « Essayer le Pro
   14 jours » vers l'inscription de la console (`/signup`, `?lang=en` en anglais), comme le bouton de la une.
4. **La section « Les outils de Claude, un par un »** (ancre `#outils`) : un `<details>` fermé par famille de
   `FAMILLES_OUTILS`, chaque outil avec sa phrase (`OUTILS_MCP` de `web/lib/mcp-outils.ts`, déjà bilingue) et son
   étiquette d'offre ; puis le lien vers la doc MCP publique (`/developers/mcp`, `?lang=en` en anglais).
   `FAMILLES_OUTILS` gagne un titre français à côté de l'anglais ; le README du plugin garde l'anglais, son contenu ne
   doit pas bouger (le vérifier par `npm run plugin:generer` puis `git diff plugin/`).
5. **L'offre d'un outil se dérive** : un petit module des générateurs de la vitrine lit `fonction` dans `OUTILS`
   (`src/mcp/outils.ts` ; précédent : `scripts/plugin/faq.ts` importe déjà `src/mcp`) et rend la plus petite offre dont
   `DROITS` ouvre cette fonction (`null` = Free). L'offre d'une carte est la plus haute de ses outils ; une carte sans
   outil (Inbox, publicité) déclare la fonction qui la porte (`inbox`, `publicites`), dérivée de la même façon.
6. **La une** gagne un troisième lien discret « Tout ce que Claude fait » vers `#claude`.
7. **La FAQ** gagne « Puis-je envoyer une promotion à mes clients ? » et « Puis-je répondre moi-même à mes clients ? »
   (textes du bilan, § 4) ; le JSON-LD `FAQPage` suit seul.

Tests à ajouter à `tests/vitrine-boutique.test.ts` : chaque outil cité par une carte existe au catalogue ; l'étiquette
de chaque carte égale l'offre dérivée ; la liste repliée porte chaque outil du catalogue une fois et une seule, avec son
offre dérivée ; aucune phrase de la page ne dit « bientôt » ni « soon » ; les chiffres du bloc Pro égalent `DROITS`.
Vérifier chaque test dans les deux sens (une étiquette faussée à la main, un outil retiré de la liste : le test rougit).
Les tests existants restent verts : QR code, « coexistence », agent jamais gratuit, marque Shopify.

## Tâche 2 : la page « SaaS et app builders »

Fichiers : `scripts/vitrine/cas-textes.ts` (`TEXTES_CARREFOUR`, bilingue), `scripts/vitrine/cas.ts` (`pagesCarrefour`),
`site/site.css` si besoin, `tests/vitrine-cas.test.ts`.

Sous la grille des sept cas filmés, avant « Comment ça marche », la section « Et depuis Claude, sans écrire de code »
(décision 5), au style `dev-construire` déjà au site, trois colonnes :
- *Vos utilisateurs* : contacts et champs (Free, masse en Pro) ; une annonce en campagne (Pro) ; le droit à l'effacement
  en une demande (Free).
- *Votre app* : webhooks inscrits, testés et rejoués (Free) ; l'agent IA qui déclenche votre code, une demande de démo,
  de résiliation ou de retour (Free) ; modèles écrits par Claude et soumis à Meta (Free).
- *Vos clients* : leurs boutiques Shopify branchées en une demande, lien vers la page Boutiques Shopify (Free) ; le
  numéro de leur application WhatsApp Business gardé (Free) ; vos chiffres dans Claude (Free, puis Pro, puis
  Entreprise).
Même étiquette dérivée qu'à la tâche 1 (module partagé), outils en `<code>`, lien vers la doc MCP. Test : les noms
d'outils existent (la règle de `tests/vitrine-cas.test.ts`), les étiquettes égalent l'offre dérivée.

## Tâche 3 : la page développeurs et le README du plugin

Fichiers : `scripts/plugin/construire.ts`, `plugin/.claude-plugin/plugin.json`, puis `npm run plugin:generer` (les deux
pages développeurs et `plugin/README.md`).

Trois lignes (décision 6) : « Votre boutique Shopify branchée par Claude : confirmation, expédition, relance de panier »
vers `/solutions/shopify/` (famille « Leur écrire au bon moment ») ; « Vos modèles écrits par Claude et soumis à Meta »
vers la doc des modèles ; « Vos webhooks créés, testés et rejoués depuis Claude » vers la doc des adresses de webhook
(famille « Brancher à votre app »). La version du plugin monte d'un cran depuis celle de la tête de `main` au moment du
commit. `tests/plugin-readme.test.ts` vérifie les copies identiques et les liens.

## Vérifier, relire, pousser

1. `npm run vitrine:cas`, `npm run vitrine:entete` si un gabarit bouge (il ne devrait pas), `npm run plugin:generer`.
2. La suite racine ENTIÈRE (`npm test`, en lisant « Test Files »), `tests/aide-proposer.test.ts` (le paragraphe de
   `features.md` est hors section, mais la règle le demande), `npm run typecheck`, `npm run lint`.
3. Le rendu au navigateur, depuis l'aperçu de la vitrine (serveur Node du bloc-notes) : les trois pages à 1280 px et à
   375 px, chaque `<details>` ouvert, en français et en anglais.
4. **Une relecture indépendante** des trois tâches ensemble, à froid, sur le diff : promesses fausses (chaque carte face
   à son outil), étiquettes, marque Shopify, tirets longs, vouvoiement. Rouge = une promesse que le produit ne tient pas.
5. Annoncer le push aux sessions voisines (vitrine et plugin). Deux commits par `git commit --only`, liste construite
   depuis ses propres fichiers et `git diff` relu juste avant : (a) tâches 1 et 2 ; (b) tâche 3. Le push de la vitrine
   lance la CI de la racine : lire `gh run view <id> --json jobs`, job par job.
6. Après le push du commit (b) : lister ce que `plugin/` de la tête de `main` emporte (les lots des voisins compris),
   puis `gh workflow run plugin.yml --ref main`.
7. Inscrire l'essai réel et les deux essais hors clôture dans `docs/prive/ESSAIS-REELS.md` ; le récit de la livraison au
   journal technique.

## Écarts tranchés à l'exécution (2026-10-29)

- Le plan a été écrit sur un arbre partagé qui avait 107 commits de retard. Sur origin, le « bientôt » était déjà corrigé
  (`5788c367`) : le point 1 de la tâche 1 se réduit au test qui l'interdit. L'offre Business est arrivée dans `DROITS` :
  elle n'ouvre aucun outil que le Pro n'ouvre pas, les étiquettes restent Free, Pro et Entreprise.
- Le bouton de l'essai mène à `/signup?offre=pro`, comme « Tout faire depuis la console » depuis `fcdfbf3a`.
- L'étiquette porte `data-etiquette`, pas `data-offre` : trois tests lisent `data-offre` comme un chiffre de la grille.
- Aucune carte ne promet ce que coûtera une campagne : son récapitulatif donne un volume, jamais un montant.
- La phrase d'un outil, sur la page, est la première de la doc MCP, coupée avant son premier « ; ».
- Les modèles écrits par Claude rejoignent la famille « Leur écrire au bon moment » de la page développeurs, les webhooks
  « Brancher à votre app ».

## Hors de ce plan

La page Intégrations (carte Shopify enrichie de l'import et de l'agent IA, carte Claude Code qui cite la boutique) et
un paragraphe « Ce que vous pouvez demander ensuite » dans la fiche publique Shopify : proposés par le bilan (§ 2.3),
non tranchés.
