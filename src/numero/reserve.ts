import { journaliser } from '../lib/journal';

/**
 * LA RÉSERVE DE NUMÉROS FOURNIS : ce qu'un espace peut en prendre, et à qui va un numéro qui y revient (audit de structure
 * du 2026-10-25, lot B du plan `docs/superpowers/plans/2026-10-26-audits-simplicite-structure.md`).
 *
 * 🔴 « Un numéro qui revient à la réserve va d'abord à l'abonné qui attend le sien depuis le plus longtemps, jamais à
 * l'espace qui vient de le rendre » était écrit QUATRE fois (la route du numéro fourni, la suppression d'un espace, la
 * libération du worker, la déclaration dans /ops), avec quatre façons d'échouer : une levait dans le balayage et y
 * sautait les alertes de libération de l'espace, une autre faisait répondre 500 à /ops pour un numéro bien déclaré.
 * `servirLAttente` est le seul exemplaire, et il ne lève jamais : le numéro est déjà rendu ou déclaré, l'abonné sera
 * servi à la prochaine déclaration.
 */

/** Les deux magasins que la réserve lit, pris par leur seule forme (les faux de test les implémentent). */
export interface DepsReserve {
  numeros: {
    attribuer(tenantId: string): Promise<{ numero: string } | null>;
    compterLibres(): Promise<number>;
    numeroDeLEspace(tenantId: string): Promise<{ numero: string } | null>;
  };
  abonnements: {
    /** Les abonnés qui attendent leur numéro, du plus ancien au plus récent (`PgAbonnementsNumeroStore`). */
    enAttenteDeNumero(): Promise<string[]>;
    deLEspace(tenantId: string): Promise<{ statut: string } | null>;
  };
}

/** Le titre auquel un espace prend un numéro NEUF, ou `null` : aucun droit. */
export type DroitAuNumero = 'attribue' | 'abonne' | 'inclus';

/** Un abonnement vivant : payé, ou en retard d'un renouvellement. Le droit au numéro ne se perd qu'à la résiliation. */
export const abonnementVivant = (a: { statut: string } | null): boolean => a !== null && a.statut !== 'resilie';

/**
 * Les numéros libres que personne n'attend : un abonné en attente a payé, les libres lui sont dus d'abord. Ouvrir un
 * paiement neuf, ou servir un Pro, sur un numéro déjà dû ferait payer pour rien ou prendrait le numéro d'un abonné.
 */
export async function numerosDisponibles(deps: Pick<DepsReserve, 'numeros' | 'abonnements'>): Promise<number> {
  const [libres, attente] = await Promise.all([deps.numeros.compterLibres(), deps.abonnements.enAttenteDeNumero()]);
  return Math.max(0, libres - attente.length);
}

/**
 * L'espace a-t-il droit à un numéro, et à quel titre ? Un numéro déjà attribué se rend toujours ; sinon il faut un
 * abonnement du numéro vivant, ou une offre qui l'inclut (la grille, `limites.numeroInclus` : le Pro, le Business et
 * l'Entreprise, spec du 2026-10-27). 🔴 Pas de numéro avant le paiement : la même garde pour obtenir et pour remplacer,
 * sans quoi « Remplacer » donnerait un numéro sans payer.
 */
export async function droitAuNumero(
  deps: {
    numeros: Pick<DepsReserve['numeros'], 'numeroDeLEspace'>;
    abonnements: Pick<DepsReserve['abonnements'], 'deLEspace'>;
    offre: { numeroInclus(tenantId: string): Promise<boolean> };
  },
  tenantId: string,
): Promise<DroitAuNumero | null> {
  if (await deps.numeros.numeroDeLEspace(tenantId)) return 'attribue';
  if (abonnementVivant(await deps.abonnements.deLEspace(tenantId))) return 'abonne';
  return (await deps.offre.numeroInclus(tenantId)) ? 'inclus' : null;
}

/** D'où vient le numéro qui revient à la réserve : le journal le dit. */
export type OrigineRetour = 'abandon' | 'suppression_espace' | 'liberation' | 'declaration_ops';

/**
 * Un numéro vient de revenir à la réserve (rendu, libéré, ou déclaré dans /ops) : il va à l'abonné qui attend le sien
 * depuis le plus longtemps, sauf à l'espace `sauf` qui vient de le rendre (`null` pour une déclaration). Rend l'abonné
 * servi et le numéro attribué (`null` si la réserve s'est vidée entre-temps), ou `null` si personne n'attend. `trace` :
 * ce que les deux lignes de journal portent en plus (l'auteur d'une déclaration dans /ops).
 * 🔴 Ne lève jamais : le geste qui précède a réussi, un échec ici se journalise et ne change pas sa réponse.
 */
export async function servirLAttente(
  deps: { numeros: Pick<DepsReserve['numeros'], 'attribuer'>; abonnements: Pick<DepsReserve['abonnements'], 'enAttenteDeNumero'> },
  sauf: string | null,
  origine: OrigineRetour,
  trace: Record<string, unknown> = {},
): Promise<{ tenantId: string; numero: string | null } | null> {
  // Hors du `try` : l'abonné qui a payé et n'a pas été servi est celui que la ligne d'erreur doit nommer.
  let suivant: string | undefined;
  try {
    suivant = (await deps.abonnements.enAttenteDeNumero()).find((t) => t !== sauf);
    if (suivant === undefined) return null;
    const n = await deps.numeros.attribuer(suivant);
    journaliser('warn', 'numero_attribue_a_un_abonne_en_attente', { ...trace, tenantId: suivant, numero: n?.numero ?? null, origine, sauf });
    return { tenantId: suivant, numero: n?.numero ?? null };
  } catch (err) {
    journaliser('error', 'numero_abonne_en_attente_non_servi', { ...trace, tenantId: suivant ?? null, origine, sauf, err });
    return null;
  }
}
