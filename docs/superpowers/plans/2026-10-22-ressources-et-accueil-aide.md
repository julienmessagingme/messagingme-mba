# Le menu « Ressources » et le nouvel accueil de l'aide (2026-10-22)

Demande de Julien : dans l'en-tête de la vitrine, un menu « Ressources » qui porte « Aide » et « Blog » (le blog du site
principal) ; l'accueil de l'aide repensé : des films en carrousel d'abord, puis les grandes sections en cartes à
accordéon, avec une barre latérale (les sections et une recherche).

## Décisions (cadrage du 2026-10-22)

- **Menu** : « Ressources » (« Resources ») remplace le lien « Aide » de l'en-tête, au bureau et dans le burger. Il
  porte l'aide (`/aide/`, `/en/help/`) et le blog, `https://www.messagingme.fr/blog-messaging-me-agence-conversationelle/`
  (le même dans les deux langues : le blog est en français). Le pied de page garde son lien « Aide ».
- **Carrousel** : les dix films du centre (six guides, quatre pages « Depuis Claude Code »), en 16:9 partout. Ils
  n'existent qu'en 16:9 ; au téléphone, un film par écran qu'on fait glisser. Des versions 9:16 seraient un chantier à
  part dans `~/engageme-motion`.
- **Cartes** : une carte par guide (titre, chapeau) ; son accordéon déplie les étapes numérotées, chacune liée à son
  ancre (`#etape-<n>`), et « Lire le guide ». Un guide sans étape n'a pas d'accordéon.
- **Barre latérale** : la recherche, puis les grandes sections (Démarrer, Parler aux clients, Depuis Claude Code). La
  recherche filtre les cartes, avec la normalisation existante (`motsDeRecherche`).
- **Périmètre** : l'accueil seulement (`/aide/`, `/en/help/`). Les pages de guide gardent le gabarit du 2026-10-20.

## Tâches

1. Gabarits `scripts/vitrine/entete.{fr,en}.html` : le menu « Ressources », puis `npm run vitrine:entete`.
2. `scripts/vitrine/aide.ts`, `accueilAide` : carrousel, barre latérale, cartes à accordéon ; `npm run vitrine:aide`.
3. `site/site.css` et `site/site.js` : le carrousel (défilement aimanté, boutons, un seul film joue à la fois) et le
   filtre étendu aux cartes.
4. `tests/vitrine-aide.test.ts` : le lien d'aide de l'en-tête se cherche dans le menu « Ressources », avec le blog.

## Méthode de livraison

**En direct**, sans agent : une page statique de la vitrine et un menu, réversibles d'un push, sans chemin que la
production des messages emprunte ; les critères (pages égales à leur génération, liens vivants) sont déjà tenus par
les tests de la vitrine, et le reste demande un œil.

**Essai réel qui clôt** : l'accueil de l'aide ouvert dans le navigateur, au bureau et au téléphone (375 px) : le
carrousel glisse et lit un film, un accordéon s'ouvre et son étape mène à la bonne ancre, la recherche « modele » ne
laisse que la carte du modèle, le menu « Ressources » ouvre l'aide et le blog. Captures montrées à Julien avant le push.
