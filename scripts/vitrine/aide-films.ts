// scripts/vitrine/aide-films.ts
// LES FILMS DU CENTRE D'AIDE (plan docs/superpowers/plans/2026-10-20-centre-d-aide.md, tâche 11). Fabriqués dans
// `~/engageme-motion/engageme-aide` (un gabarit commun nourri des captures de `npm run aide:captures` et de leurs boîtes),
// livrés dans `site/films/aide-<clé>.mp4` et `aide-<clé>-en.mp4`, avec leur affiche `.webp`. Une page les montre quand
// l'en-tête de sa fiche porte `video: oui` ; cette table dit ce que la page en annonce : la date de publication, et la
// durée de chaque langue en secondes entières (les sous-titres n'ont pas la même longueur). `tests/vitrine-aide.test.ts`
// lit la vraie durée dans chaque MP4, et vérifie qu'il n'a aucune piste son.

export interface FilmAide {
  /** La date de publication, AAAA-MM-JJ. */
  readonly publie: string;
  readonly secondes: { readonly fr: number; readonly en: number };
}

export const FILMS_AIDE: Readonly<Record<string, FilmAide>> = {
  'connecter-mon-numero-whatsapp': { publie: '2026-10-21', secondes: { fr: 52, en: 51 } },
  'me-reperer-dans-la-console': { publie: '2026-10-21', secondes: { fr: 60, en: 59 } },
  'repondre-dans-l-inbox': { publie: '2026-10-21', secondes: { fr: 46, en: 45 } },
  'faire-approuver-un-modele': { publie: '2026-10-21', secondes: { fr: 47, en: 46 } },
  'importer-mes-contacts': { publie: '2026-10-21', secondes: { fr: 48, en: 47 } },
  'lancer-une-campagne': { publie: '2026-10-21', secondes: { fr: 53, en: 52 } },
};
