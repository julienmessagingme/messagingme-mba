/**
 * OÙ EN SONT LES MIGRATIONS, calculé et jamais écrit (`npm run migrations`, `db/etat.ts`).
 *
 * 🔴 Le numéro d'une migration se LIT : le DOSSIER `db/migrations/` tranche sur ce qui est PRIS, la BASE
 * (`public.schema_migrations`) sur ce qui est APPLIQUÉ. Un compteur écrit à la main dans `CLAUDE.md` a dérivé onze
 * fois, et il était devenu le registre où chaque déploiement racontait sa migration (820 lignes, sorties le
 * 2026-10-10, décision de Julien de le supprimer).
 */
export interface EtatMigrations {
  /** Le dernier fichier du dossier, donc le dernier numéro PRIS. */
  dernierPris: string | null;
  /** Le numéro suivant, sur quatre chiffres. */
  prochainLibre: string;
  /** `null` = la base n'a pas été lue. */
  dernierApplique: string | null;
  /** Fichiers du dossier absents de la base : ce que `migrate` appliquerait. */
  enAttente: string[];
  /** Lignes de la base sans fichier (0060 l'est, voulu : `CLAUDE.md`, section Déploiement). */
  sansFichier: string[];
}

const numero = (nom: string): number => Number.parseInt(nom.slice(0, 4), 10);

/** `fichiers` : les `.sql` du dossier ; `appliquees` : les noms de `schema_migrations`, ou `null` si la base n'est pas lue. */
export function etatMigrations(fichiers: readonly string[], appliquees: readonly string[] | null): EtatMigrations {
  const dossier = fichiers.filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  const dernierPris = dossier.at(-1) ?? null;
  const prochainLibre = String(dernierPris ? numero(dernierPris) + 1 : 1).padStart(4, '0');
  if (appliquees === null) return { dernierPris, prochainLibre, dernierApplique: null, enAttente: [], sansFichier: [] };
  const base = new Set(appliquees);
  const fichiersConnus = new Set(dossier);
  return {
    dernierPris,
    prochainLibre,
    dernierApplique: [...appliquees].sort().at(-1) ?? null,
    enAttente: dossier.filter((f) => !base.has(f)),
    sansFichier: [...appliquees].filter((a) => !fichiersConnus.has(a)).sort(),
  };
}
