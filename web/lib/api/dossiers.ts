import { request } from '../http';
import { routeInconnue } from '../canaux-services';

/**
 * Les dossiers qui rangent les scénarios et les templates (décision de Julien du 2026-10-13, routes `src/http/dossiers.ts`).
 * Une seule route de lecture rend les dossiers ET le rangement (clé -> dossier : l'id d'un scénario, ou le NOM d'un
 * template) ; la page fusionne avec sa propre liste, qui ne change pas.
 */
export type TypeDossier = 'scenario' | 'template';
export interface Dossier { id: string; nom: string }
export interface VueDossiers { dossiers: Dossier[]; rangement: Record<string, string> }

/** Ce que la page montre quand l'API ne connaît pas encore les dossiers : la page telle qu'avant, sans barre. */
export const SANS_DOSSIERS: VueDossiers = { dossiers: [], rangement: {} };

/**
 * La liste. 🔴 La console part chez Vercel au push, avant le `up` de l'API : pendant cette fenêtre, la route rend le 404
 * du routeur, et la page doit rester celle d'avant (`SANS_DOSSIERS`), jamais une erreur. Tout autre échec remonte.
 */
export async function listerDossiers(tenantId: string, type: TypeDossier): Promise<VueDossiers | null> {
  try {
    const r = await request<Partial<VueDossiers>>(`/tenants/${tenantId}/dossiers?type=${type}`);
    return { dossiers: Array.isArray(r.dossiers) ? r.dossiers : [], rangement: r.rangement ?? {} };
  } catch (err) {
    if (routeInconnue(err)) return null;
    throw err;
  }
}

export async function creerDossier(tenantId: string, type: TypeDossier, nom: string): Promise<Dossier> {
  const r = await request<{ dossier: Dossier }>(`/tenants/${tenantId}/dossiers`, { method: 'POST', body: JSON.stringify({ type, nom }) });
  return r.dossier;
}

export async function renommerDossier(tenantId: string, id: string, nom: string): Promise<Dossier> {
  const r = await request<{ dossier: Dossier }>(`/tenants/${tenantId}/dossiers/${id}`, { method: 'PATCH', body: JSON.stringify({ nom }) });
  return r.dossier;
}

export async function supprimerDossier(tenantId: string, id: string): Promise<void> {
  await request(`/tenants/${tenantId}/dossiers/${id}`, { method: 'DELETE' });
}

/** Range des clés dans un dossier, ou dans « Sans dossier » (`null`). Rend le nombre d'éléments rangés. */
export async function ranger(tenantId: string, type: TypeDossier, cles: string[], dossierId: string | null): Promise<number> {
  const r = await request<{ ranges: number }>(`/tenants/${tenantId}/dossiers/rangement`, {
    method: 'PUT', body: JSON.stringify({ type, cles, dossierId }),
  });
  return r.ranges;
}

/** Les deux onglets fixes de la barre, à côté des dossiers. */
export const TOUS = 'tous';
export const SANS_DOSSIER = 'sans';

/** L'onglet choisi garde-t-il un élément ? `TOUS` les garde tous, `SANS_DOSSIER` ceux qui ne sont nulle part. */
export function dansLOnglet(onglet: string, dossierDeLElement: string | undefined): boolean {
  if (onglet === TOUS) return true;
  if (onglet === SANS_DOSSIER) return dossierDeLElement === undefined;
  return dossierDeLElement === onglet;
}
