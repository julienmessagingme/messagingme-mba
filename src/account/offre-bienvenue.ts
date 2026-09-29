import type { TravauxEnVol } from '../lib/en-vol';

/**
 * Le crédit de bienvenue tel que la route de l'inscription le demande : l'offre en base, puis la remontée du plafond
 * de la clé de modèle de l'espace s'il en a déjà une (`EmbeddedSignupRouteDeps.offrirCredit`).
 *
 * 🔴 LA REMONTÉE NE SE FAIT PAS ATTENDRE (relecture du 2026-09-29). Elle appelle Vercel, qui peut prendre jusqu'à
 * 30 s : attendue, elle retenait la réponse de l'inscription d'autant, alors que le client regarde la fenêtre de Meta
 * se fermer. Elle part en arrière-plan, SUIVIE par `travaux` : l'arrêt du processus l'attend au lieu de couper
 * l'appel à Vercel en route. Un échec se journalise : l'offre est écrite, et le plafond se recalcule depuis le solde à
 * la remontée suivante (`remonterPlafondApresRecharge`).
 *
 * Sans offre (déjà servie, éteinte, numéro inconnu), rien ne part chez Vercel.
 */
export function creerOffreDeBienvenue(deps: {
  /** L'offre en base (`PgEmbeddedSignupStore.offrirCredit`) : le montant offert, 0 si rien. */
  offrir(tenantId: string, phoneNumberId: string): Promise<number>;
  /** `null` : provisionnement des clés éteint sur cette instance, aucun plafond à suivre. */
  remonterPlafond: ((tenantId: string) => Promise<unknown>) | null;
  travaux: Pick<TravauxEnVol, 'suivre'>;
  journal(msg: string, err: unknown, tenantId: string): void;
}): (tenantId: string, phoneNumberId: string) => Promise<void> {
  return async (tenantId, phoneNumberId) => {
    const offert = await deps.offrir(tenantId, phoneNumberId);
    const remonter = deps.remonterPlafond;
    if (offert <= 0 || remonter === null) return;
    void deps.travaux.suivre(remonter(tenantId)).catch((err: unknown) => {
      deps.journal('plafond gateway non remonte apres le credit offert', err, tenantId);
    });
  };
}
