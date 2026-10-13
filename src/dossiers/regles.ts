/**
 * LES RÈGLES DES DOSSIERS qui rangent les scénarios et les templates WhatsApp (décision de Julien du 2026-10-13, spec
 * `docs/superpowers/specs/2026-10-13-dossiers-scenarios-templates-design.md`). Une seule source : la migration 0229 les
 * reprend dans ses CHECK, et `tests/migration-0229.test.ts` exige qu'ils concordent.
 */

/** À quelle page un dossier appartient : deux listes séparées, un dossier de templates ne range pas un scénario. */
export const TYPES_DOSSIER = ['scenario', 'template'] as const;
export type TypeDossier = (typeof TYPES_DOSSIER)[number];

/** La longueur d'un nom de dossier (CHECK `dossiers_nom_chk`, par `char_length`). */
export const MAX_NOM_DOSSIER = 60;

/** Combien de dossiers par type et par espace : au-delà, la barre d'onglets ne se lit plus. Tenu par le magasin. */
export const MAX_DOSSIERS_PAR_TYPE = 50;
