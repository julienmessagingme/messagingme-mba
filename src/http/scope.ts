/**
 * Helpers partagés par TOUTES les routes de la console.
 *
 * `scopeTenant` était recopié à l'identique dans 22 fichiers de ce dossier : c'est le contrôle d'accès
 * tenant du produit, donc une divergence locale (un durcissement appliqué à 21 copies sur 22) serait
 * silencieuse. Une seule définition, importée partout.
 */

/** Tenant effectif = celui du JWT ; l'URL doit correspondre. null si interdit. */
export function scopeTenant(req: { params: unknown; auth?: { tenantId: string } }): string | null {
  const { tenantId } = req.params as { tenantId: string };
  const authTenant = req.auth?.tenantId;
  if (authTenant !== undefined && authTenant !== tenantId) return null;
  return authTenant ?? tenantId;
}

/** Chaîne réellement renseignée (une chaîne d'espaces ne compte pas). */
export function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}
