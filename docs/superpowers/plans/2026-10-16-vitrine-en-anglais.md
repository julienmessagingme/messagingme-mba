# La vitrine en anglais, et les films de l'accueil refaits (2026-10-16)

Demandé par Julien le 2026-10-16 : tout le site app.messagingme.fr en anglais, le drapeau anglais menant à la version
anglaise de la page où l'on est ; les films refaits en anglais, d'abord les deux de l'accueil, avec la nouvelle musique.

## Décisions (Julien, 2026-10-16)

- **Le drapeau fait passer en anglais au clic** (pas d'objection au défaut proposé), comme sur `/developpeurs/`.
- **Musique** : « Tech House » d'Aurec (Pixabay), celle du film 1 des cas d'usage, licence lue et risque Content ID
  accepté. 127,725 BPM contre 128 pour nos films : le montage ne bouge pas, `B` se recale sur le morceau.
- **Le contenu propre à la France reste** dans les films anglais : « 56 million people in France », la même source
  (Meta), les quatre opérateurs français du film RCS.
- **Le menu actuel** (Features, Industries, Pricing, Developers) : le menu « Solutions » du lot 6 arrivera avec ses pages,
  et la session qui le porte reprendra les deux langues à ce moment (accord du 2026-10-16).
- **Chaque mise en ligne de `site/` se montre à Julien avant le push** (règle de `~/engageme-motion/CLAUDE.md`).

## Lot 1 : les films de l'accueil, en français et en anglais, sur Tech House

1. `engageme-accueil` et `engageme-rcs` passent au modèle bilingue (`<film>.modele.html` et `textes.json`, par
   `langues.cjs` du dossier des cas d'usage, lu sans être modifié). Le 16:9 français reconstruit doit rester identique
   à l'image près, musique mise à part (md5 d'une trentaine de captures avant et après, règle de l'atelier).
2. La musique : l'extrait Opus de Tech House embarqué (`tempo.cjs` pour le départ), la synthèse se tait, les bruitages
   restent, comme dans `cas1v3.modele.html`. Calage mesuré sur le rendu (`son-seul.cjs`, `profil-wav.cjs`).
3. Planches contact dans les deux langues, à Julien, AVANT les exports (une heure chacun, deux au plus à la fois sur la
   machine, annoncés à l'autre session).
4. Huit livrables (deux films, deux langues, deux formats), encodés pour la vitrine ; les films français remplacent les
   actuels sous le même nom avec un `?v=` incrémenté, les anglais vont avec les pages anglaises.

## Lot 2 : les pages anglaises

- Adresses (accord avec la session du lot 6) : `/en/`, `/en/features/{whatsapp-and-rcs, campaigns-and-scenarios,
  whatsapp-channels, conversations-into-actions, click-to-whatsapp-ads, cost-control}/`, `/en/industries/` et
  `/en/pricing/` (noindex comme leurs pages françaises), `/en/contact/` et `/en/contact/thanks/` ; `/en/developers/`
  reçoit le menu anglais complet.
- Chaque page : `lang="en"`, `canonical`, `hreflang` fr/en/x-default dans les DEUX langues, JSON-LD traduit, liens de la
  console en `?lang=en`, le drapeau de chaque page française vers sa jumelle. `sitemap.xml` et `llms.txt` pour les pages
  indexables. Les pieds de page corrigés au passage (« Accueil » et « Blog » de messagingme.fr, en 404).
- **Contact** : le formulaire anglais porte `langue=en`, une valeur FERMÉE (`z.literal('en')`, jamais une adresse de
  retour lue dans la requête) ; `src/http/contact-vitrine.ts` redirige alors vers `/en/contact/thanks/` ou
  `/en/contact/?erreur=…`. L'API se déploie AVANT la page anglaise.
- Les captures d'écran des pages restent en français dans ce lot ; les shorts des fonctionnalités en anglais suivent
  dans un lot 3.

## Lot 3 (après) : les six shorts des fonctionnalités et les captures en anglais

## Tests attendus

- Les tests de la racine qui lisent `site/` (vitrine-developpeurs et voisins) étendus aux pages anglaises : chaque page
  anglaise a sa jumelle et des `hreflang` réciproques, aucun lien interne anglais vers une page française qui a sa
  jumelle, aucun tiret long.
- Contact : `langue=en` mène aux pages anglaises, une autre valeur ou son absence aux françaises, jamais ailleurs.

## Méthode de livraison

**En direct, sans agent, avec une relecture indépendante pour le seul changement de l'API**, parce que l'essentiel est
du contenu (traduction, films) que seul l'œil de Julien juge, et que le seul chemin de production touché est la route
du formulaire de contact. Pas de `feature-loop` : les critères ne sont pas mécaniquement testables.

**Essai réel qui clôt la feature** : Julien parcourt la vitrine en anglais depuis le drapeau, page par page, envoie le
formulaire de contact anglais et arrive sur la page de remerciement anglaise ; les films de l'accueil se lisent dans
les deux langues, avec la nouvelle musique, sur ordinateur et sur téléphone.
