/**
 * Helpers partagés par TOUTES les routes de la console.
 *
 * `scopeTenant` était recopié à l'identique dans 22 fichiers de ce dossier : c'est le contrôle d'accès
 * tenant du produit, donc une divergence locale (un durcissement appliqué à 21 copies sur 22) serait
 * silencieuse. Une seule définition, importée partout.
 */

/**
 * Tenant effectif = celui du JWT ; l'URL doit correspondre. `null` si interdit.
 *
 * 🔴 ELLE ÉCHOUE FERMÉ, ET C'EST UN CORRECTIF (audit de surface publique du 2026-09-03). Elle rendait
 * auparavant le tenant PRIS DANS L'URL quand `req.auth` était absent. Autrement dit, elle n'était un contrôle
 * d'accès que tant que la garde d'authentification avait bien été posée au montage, ailleurs, dans un autre
 * fichier. Or chaque module de routes recevait alors sa garde en paramètre OPTIONNEL et la dégradait en
 * silence (`garde ? { preHandler: garde } : {}`, le motif était dans 45 endroits) : un câblage qui aurait
 * oublié `auth` aurait monté ces routes sans aucun contrôle, et cette fonction aurait alors distribué à
 * chacun le tenant qu'il demandait. C'est-à-dire tous les espaces, à tout le monde, sans une ligne d'erreur.
 *
 * Ce n'était pas un trou vivant : `src/index.ts` fournit toujours `auth`. Mais un contrôle d'accès dont la
 * sûreté dépend d'un appelant lointain n'est pas un contrôle d'accès, c'est une convention. Et le prix d'une
 * convention muette monte le jour où l'API répond sous son propre nom.
 *
 * ⚠️ Le pendant : une route tenant montée SANS garde rend désormais 403 au lieu de servir. C'est le
 * comportement voulu. Si un jour une route à `:tenantId` doit être publique, elle ne passe pas par ici.
 *
 * 🔴 LES DEUX MOITIÉS DU DÉFAUT SONT FERMÉES DEPUIS LE 2026-09-15, et le paragraphe ci-dessus est désormais
 * au PASSÉ pour cette raison. Plan `docs/superpowers/plans/2026-09-14-dependances-non-optionnelles.md`.
 *
 * - Lot 1 : la couverture du garde-fou de `buildServer` ne s'écrit plus à la main, elle se DÉRIVE du registre
 *   (`modulesDeRoutes`, `src/server.ts`), où chaque module déclare sa classe d'accès. Ce texte disait qu'il
 *   « faudra y penser encore au 37e » : il n'y a plus de liste à allonger.
 * - Lot 2 : la garde n'est plus optionnelle NULLE PART. Mesuré après coup : zéro signature de module de
 *   routes portant une garde optionnelle, zéro occurrence du motif de dégradation. `gardeEtendue` elle-même
 *   exige désormais une garde et rend toujours un `preHandler`, là où elle acceptait `undefined` et rendait
 *   un objet vide pour sept modules.
 *
 * ⚠️ CE QUI RESTE VRAI, ET POURQUOI CETTE FONCTION NE BOUGE PAS : elle échoue toujours fermé. Une garde
 * requise par le type se pose au montage ; elle ne dit rien de ce qu'un module en fait. C'est
 * `tests/scope-tenant.test.ts` qui vérifie que toute route portant `:tenantId` a bien un `preHandler`, et ce
 * test a déjà attrapé une route qui avait perdu le sien.
 */
export function scopeTenant(req: { params: unknown; auth?: { tenantId: string } }): string | null {
  const { tenantId } = req.params as { tenantId: string };
  const authTenant = req.auth?.tenantId;
  if (authTenant === undefined) return null;
  return authTenant === tenantId ? authTenant : null;
}

/** Chaîne réellement renseignée (une chaîne d'espaces ne compte pas). */
export function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * Identifiant qui a la forme d'un uuid.
 *
 * 🔴 POURQUOI CE CONTRÔLE EST DANS LA COUCHE HTTP. Un identifiant de chemin part tel quel dans un `where id =
 * $1` sur une colonne `uuid` : une valeur mal formée n'y rend pas zéro ligne, elle fait LEVER Postgres
 * (`22P02`), donc un 500, dont Cloudflare remplace le corps par sa page d'erreur. Une adresse tapée de
 * travers doit rendre 404, pas une page d'incident.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function estUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}
