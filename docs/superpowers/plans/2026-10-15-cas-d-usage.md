# Plan : les cas d'usage, les tarifs et la rubrique « Industries » (lot 6, 2026-10-15)

> **Spec** : [docs/superpowers/specs/2026-10-15-cas-d-usage-design.md](../specs/2026-10-15-cas-d-usage-design.md)
> (adresses, anatomie d'une page, films, garde-fous). Ce plan ne la recopie pas : il découpe en trois livraisons.
>
> 🔴 **À NE PAS EXÉCUTER : le rangement a été revu le 2026-10-16** (rubrique « Solutions » à la place d'« Industries »,
> sept pages de cas dont trois nouvelles, registre, dépôts : spec du lot 6 mise à jour et
> [spec 6 bis](../specs/2026-10-16-cas-d-usage-par-profil-design.md)). Il est remplacé par
> [le plan du 2026-10-16](2026-10-16-cas-d-usage-solutions-depot.md).

## Méthode de livraison

**En direct**, sans agent, parce que ce sont des pages statiques : elles ne touchent aucun chemin que la production
emprunte pour recevoir ou envoyer un message, se retirent par un simple revert, et la vérité de ce qu'elles affirment
(chiffres, outils, événements, routes, liens) est tenue par un test, le reste demande un œil plutôt qu'une boucle.
Une relecture indépendante par livraison, en fin de livraison. Les films passent par l'atelier `~/engageme-motion`,
script validé par Julien avant l'animation.

**L'essai réel qui clôt chaque livraison** : Julien lit chaque page EN LIGNE, au téléphone et sur ordinateur, film
compris, dans les deux langues, et suit un lien de chaque type (fonctionnalité, tarifs, développeurs, cas voisin).
Pour la livraison B, un essai réel de Codex branché sur notre serveur MCP précède la page qui le cite. Et quelques
jours après chaque mise en ligne, la Search Console montre les pages neuves découvertes (geste de Julien ci-dessous).

## Ce qui se fait avant (Julien, sans attendre le lot)

Vérifier `app.messagingme.fr` dans la **Google Search Console** et dans **Bing Webmaster Tools** (enregistrement TXT
chez OVH), puis y soumettre `https://app.messagingme.fr/sitemap.xml`. C'est la seule façon de savoir si le site est
indexé, et ce sera la mesure du lot.

## Livraison A : les tarifs, le carrefour et les trois cas développeurs

1. **Le test de vérité, d'abord** : ses lecteurs partagés (chiffres `data-offre`, outils `data-outil`, événements
   `data-evenement`, routes `data-route`, plan du site et `llms.txt`, paires `hreflang`, liens internes, bornes du
   titre et de la description, un seul H1, JSON-LD lisible) s'appliquent à toute page de `site/` qui n'est pas en
   `noindex`. Il échoue sur les pages qui n'existent pas encore, puis passe page après page.
2. **Les tarifs** `/tarifs/` et `/en/pricing/`, `/pricing/` redirigé (`site/vercel.json`) ; nouvelles clés
   `data-offre` (prix du Pro à l'an, commission du crédit par offre) ajoutées à l'attendu du test depuis le code ;
   `offers` dans le `SoftwareApplication` de l'accueil.
3. **Le carrefour** `/cas-d-usage/` et `/en/use-cases/`, et le menu de TOUTES les pages (« Cas d'usage » ;
   « Pricing » devient « Tarifs ») : l'en-tête est recopié dans chaque fichier, la liste se lit par `grep`.
4. **Les cas 1, 2 et 3** (agent vers l'application, notifications, bulle sur un site Lovable), en paire.
5. **Les films 1, 2 et 3** : `SCRIPT.md` validé par Julien, animation, exports français et anglais, 16:9 et 9:16
   (deux exports au plus à la fois), intégration (`site/films/`, affiche, `data-vertical`).
6. `site/sitemap.xml`, `site/llms.txt` (sections « Tarifs » et « Cas d'usage »).
7. Relecture, push (lance la CI de la racine : il s'annonce comme un push de code), essai réel.

## Livraison B : le support IA, le pilotage depuis Claude, et la rubrique Industries

1. **L'essai réel de Codex** (adresse publique de `/mcp` dans `config.toml`, `codex mcp login`, un outil appelé) : son
   résultat décide de ce que dit la page.
2. **Les cas 4 et 6** (support IA avec relais, piloter WhatsApp depuis Claude), en paire, et leurs films.
3. **Industries** : le carrefour `/industries/` et `/en/industries/` sort de `noindex`, et la page « Claude Code et
   Codex » en paire.
4. Plan du site, `llms.txt` (section « Industries »), relecture, push, essai réel.

## Livraison C : les cas marketing, et la doc développeurs

1. **Les cas 5 et 7** (leads de pubs vers le CRM, campagne qui ouvre des conversations), en paire, et leurs films.
2. **Les sept cas comme guides** de la doc développeurs (`web/public/developers/api/guides/`, français et anglais,
   déclarés dans `web/lib/doc-api-pages.ts`) : version technique, lien vers la page de la vitrine.
3. ⚠️ Ce morceau touche `web/` : la suite racine ENTIÈRE tourne avant de pousser (règle du `CLAUDE.md`), et la console
   se publie au push par Vercel.
4. Plan du site, `llms.txt`, relecture, push, essai réel.

## Les interfaces

- Les adresses de la spec, décidées une fois.
- Les marqueurs que lit le test : `data-offre="<clé>"` (clés dérivées du code), `data-outil="<nom MCP>"`,
  `data-evenement="<type>"`, `data-route="<MÉTHODE /chemin>"`.
- Les films : `site/films/<cas>-<langue>.mp4` et `-9x16`, leurs affiches `.webp` ; un fichier remplacé sous le même nom
  prend un `?v=` dans chaque page qui le cite.

## Tests attendus

- Le test de vérité ci-dessus, vérifié dans les deux sens (un chiffre faussé, un outil inventé, une page absente du plan
  du site : chacun le rend rouge, puis restauré).
- `tests/vitrine-developpeurs.test.ts` reste vert (les pages développeurs ne changent pas de sens).
- Livraison C : `web/lib/doc-md.test.ts` et la suite racine.

## L'ordre de déploiement

Aucune API ni migration : chaque livraison part par un push de `site/` (Vercel publie la vitrine), puis, pour C, un push
de `web/` (Vercel publie la console). Les films sont prêts AVANT le push de leur page. On ne pousse pas pendant la CI
d'une session voisine.

## Les gestes de Julien

- La Search Console et Bing Webmaster Tools, dès maintenant.
- La validation des sept `SCRIPT.md` de film, un par un.
- La lecture de chaque livraison en ligne (l'essai réel).
- L'essai de Codex, si Codex n'est pas installé sur le poste où Claude travaille.
