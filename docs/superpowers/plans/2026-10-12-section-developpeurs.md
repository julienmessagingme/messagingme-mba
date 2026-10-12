# Lot 18 : la section développeurs de la vitrine

Spec : `docs/superpowers/specs/2026-10-12-section-developpeurs-design.md` (`0859202e`, décisions de Julien du
2026-10-12). Une seule livraison, aucune migration, aucune route.

## Méthode de livraison

**En direct** (moi, sans agent implémenteur), puis UNE relecture indépendante en fin de lot : des pages statiques et un
petit ajout de la console, réversibles en un push, qu'aucun chemin de production (envoi, webhook, base) n'emprunte. Les
chiffres, la commande et les outils montrés sont tenus par un test ; le reste (texte, mise en page, animation) se juge
à l'œil, et l'œil qui clôt est celui de Julien.

**L'essai réel qui clôt le lot** : Julien, sur téléphone et ordinateur, la page en français puis en anglais, le
terminal, les liens ; depuis la page anglaise, « Create my workspace » ouvre l'inscription en anglais ; puis une
inscription neuve de bout en bout depuis la vitrine, qui clôt aussi l'essai dû du tunnel (lot 19). Essai n° 98 de
`docs/prive/ESSAIS-REELS.md`.

## Ce que la relecture regarde en priorité

1. Un visiteur qui a coupé les animations, ou sans JavaScript : la séance du terminal est là, finie, lisible.
2. Un téléphone de 375 px : aucun défilement horizontal de la page, le terminal revient à la ligne dans son cadre.
3. Un visiteur qui avait choisi le français dans la console et arrive par un lien `?lang=en` : l'adresse l'emporte,
   et le choix est mémorisé ; une valeur inconnue (`?lang=de`) ne change rien.
4. Le sélecteur de langue : un lien sur les deux pages jumelles, « coming soon » partout ailleurs, sans lien mort.
5. Les liens sortants des deux pages (console, doc, API) : aucun vers un domaine de la console où `/mcp` rend 404, aucun
   vers une page de la vitrine qui n'existe pas.

## Les tâches

1. **La console lit la langue dans l'adresse.** `web/lib/locale.ts` gagne une fonction pure
   `langueDeLAdresse(recherche: string): Locale | null` (`?lang=fr` ou `en`, sinon `null`) ; `LocaleProvider`
   (`web/lib/i18n.tsx`) l'applique au montage AVANT la mémoire, et la mémorise comme le bouton FR/EN. Tests :
   `web/lib/locale.test.ts` (neuf) : les deux langues, l'absence, une valeur inconnue, la casse.

2. **Le test de la vitrine, écrit d'abord et vu rouge** : `tests/vitrine-developpeurs.test.ts` (neuf, racine), qui lit
   `site/` :
   - chaque `data-offre` des deux pages vaut ce que dit le code (`DROITS.base` : contacts, envois de modèles par mois,
     utilisateurs ; `PRIX_PRO_HT_CENTIMES` : le mois), et les deux pages portent les mêmes ;
   - toute commande `claude mcp add` de `site/` est `commandeMcp(API_PUBLIQUE)` (`web/lib/demarrer.ts`) ;
   - chaque outil du terminal (`data-outil`) est au catalogue (`web/lib/mcp-outils.ts`), et la balise montrée a la forme
     de `baliseDuScript(adresseDuScript('https://api.messagingme.app', <code>))` ;
   - l'exemple de code de la page est `EXEMPLES_SDK.premierAppel.code` (ou un extrait nommé, décodé du HTML) ;
   - plus aucun `/#developpeurs` dans `site/`, et chaque page qui a un menu mène à `/developpeurs/` ;
   - `sitemap.xml` et `llms.txt` citent les deux pages ; chaque page déclare l'autre en `hreflang` et `x-default`.

3. **La page française** `site/developpeurs/index.html` : l'en-tête et le pied de page de la vitrine, les cinq blocs de
   la spec (en tête et terminal, trois étapes, ou par le code, gratuit pour commencer, dernier appel), le texte de la
   spec. Le style dans `site.css` (classes neuves préfixées `dev-`), la boucle du terminal dans `site.js` (aucune boucle
   sous `prefers-reduced-motion` ni sans la classe `js`).

4. **La page anglaise** `site/en/developers/index.html` : le même contenu traduit, l'en-tête réduit (logo, langue, « Sign
   in »), le pied de page réduit ; ses liens vers la console portent `?lang=en`.

5. **L'accueil et les menus** : « Créer mon espace » en haut de l'accueil ; le bloc développeurs de l'accueil gagne son
   lien vers la page, et sa commande devient celle du tunnel (le commentaire qui dit d'où elle vient suit) ;
   `/#developpeurs` remplacé par `/developpeurs/` dans les menus bureau et téléphone des douze pages qui le portent ;
   le drapeau anglais des deux jumelles devient un lien.

6. **Pour les moteurs et les modèles** : `sitemap.xml` (les deux pages), `llms.txt` (en tête de « Développeurs », une
   phrase chacune), l'image `img/partage/developpeurs.jpg` (1200 × 630, capture du terminal), titre, description,
   canonique, balises de partage et fil d'Ariane JSON-LD des deux pages.

7. **La CI lit la vitrine** : `site/**` sort des deux `paths-ignore` de `ci.yml`, et son commentaire dit pourquoi
   (`tests/ci-decoupage.test.ts` reste vert : le filtre reste négatif). `CLAUDE.md` (section Déploiement) et la mémoire
   des sessions (`arbre-partage-entre-sessions`) : un push `site/` lance désormais la CI.

8. **Vérification** : le test de la tâche 2 vert, puis vérifié dans les deux sens (un chiffre de la Free changé dans la
   page, puis une commande d'ancien format remise : rouge avec le bon message, restauré) ; `npm run typecheck`,
   `npm test` à la racine, `npm test` et `npm run typecheck` dans `web/`. La vitrine regardée dans le navigateur intégré
   (serveur statique local) à 1440 et 375 px, animations coupées comprises, en français et en anglais ; la console en
   local avec `?lang=en`.

9. **Relecture, push, contrôle en production** : un relecteur indépendant sur le diff ; jaunes simples corrigés avant
   le push. Le push est annoncé à la session voisine (il lance la CI des deux côtés). CI lue job par job ; Vercel publie
   la console et la vitrine. Puis `curl` des deux pages (200, `hreflang`), du sitemap et de `llms.txt`, et la console
   ouverte par `?lang=en`.

10. **Les docs** : `features.md` (la vitrine a sa page développeurs ; `tests/aide-proposer.test.ts` avant de pousser),
    `documentation.md` (la console lit `?lang=`, la vitrine est lue par un test), le journal, `wip.md`, le plan privé et
    son Claude Doc, l'essai n° 98.

## Ordre de mise en ligne

Un seul push, rien sur le VPS. La console et la vitrine se publient ensemble chez Vercel ; une console encore ancienne
ignore `?lang=en` sans rien casser, donc l'ordre entre les deux n'a pas d'importance.
