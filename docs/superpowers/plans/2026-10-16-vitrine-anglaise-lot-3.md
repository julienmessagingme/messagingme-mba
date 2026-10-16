# Vitrine anglaise, lot 3 : les courts films, les écrans et la 404

Demande de Julien (2026-10-16) : ranger l'outil de traduction dans le dépôt, puis enchaîner sur le reste de la vitrine
anglaise. Suite du plan `2026-10-16-vitrine-en-anglais.md` (lots 1 et 2 en ligne : les pages, les films de l'accueil).

## Méthode de livraison

**En direct, sans agent.** Des fichiers statiques de la vitrine et des films de l'atelier : aucun chemin que la
production emprunte (ni envoi, ni donnée, ni API), réversibles par un retour arrière du commit. Les critères se
vérifient par des tests (paires, fichiers, génération des pages anglaises) ET à l'œil (planches contact, rendu des
pages), d'où un aperçu montré à Julien avant chaque push de `site/`.

## Tâches

1. **L'outil dans le dépôt** : `scripts/vitrine/anglais.ts` et ses dictionnaires (`anglais/`), `npm run
   vitrine:anglais`, `tests/vitrine-anglais.test.ts` (chaque page anglaise égale à sa génération, rien de français
   resté, aucune entrée morte). Il reproduit à l'octet près les onze pages en ligne.
2. **Les six courts films** des pages Fonctionnalités, passés au modèle bilingue de l'atelier comme ceux de
   l'accueil (`langues.cjs`, `textes.json`), la source française régénérée à l'octet près ; planches contact dans les
   deux langues et les deux formats ; douze exports anglais (16:9 et 9:16), deux à la fois au plus ; posés sous
   `site/films/<nom>-en.*`.
3. **Les 22 écrans** des pages Fonctionnalités (`site/img/`), rendus depuis les sources des films
   (`~/engageme-motion/rendre-images.cjs`) : chaque recette (instant, sélecteur, largeur, qualité) est d'abord
   rejouée sur la source française et comparée à l'image en ligne, puis appliquée à la source anglaise
   (`site/img/<nom>-en.webp`).
4. **La 404** dans les deux langues, sur une seule page (Vercel ne sert qu'un `404.html`).
5. L'outil fait pointer les pages anglaises vers les films et les écrans anglais ; un test refuse un film ou un
   écran français sur une page anglaise quand sa version anglaise existe.

## Ordre de déploiement

Tâche 1 seule (aucune page ne change). Puis les films et les écrans, page par page ou ensemble, chaque push de
`site/` après l'accord de Julien sur le rendu.

## Essai réel qui clôt

Julien parcourt les six pages anglaises de fonctionnalités, sur ordinateur et au téléphone : chaque film et chaque
écran est en anglais, et la 404 se lit dans les deux langues (`docs/prive/ESSAIS-REELS.md`).
