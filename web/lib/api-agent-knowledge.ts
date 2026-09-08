import { request } from './http';

/**
 * La base de connaissance d'un agent IA.
 *
 * 🔴 CE QUE CES FICHES SONT VRAIMENT. Elles ne sont pas de la documentation : elles sont la SEULE source que
 * l'agent a le droit d'utiliser. Une base vide ne fait pas un agent muet, elle fait un agent qui sort du
 * parcours à la première question (le handle « Aucune source » du bloc). L'écran doit le dire, sans quoi le
 * client croit avoir mal réglé son agent.
 */

export interface FicheConnaissance {
  id: string;
  titre: string;
  corps: string;
  sourceUrl: string | null;
  /** `null` pour une fiche écrite à la main : il n'y a rien eu à relire. */
  derniereLectureAt: string | null;
  updatedAt: string;
}

/** Le bilan d'une relecture de source : ce qui est parti, ce qui est arrivé. */
export interface BilanImport {
  url: string;
  retirees: number;
  ecrites: number;
  plafond: number;
}

const base = (tenantId: string, agentId: string) => `/tenants/${tenantId}/agents/${agentId}/knowledge`;

export async function listFiches(tenantId: string, agentId: string): Promise<FicheConnaissance[]> {
  const r = await request<{ fiches?: FicheConnaissance[] }>(base(tenantId, agentId));
  return r.fiches ?? [];
}

export async function createFiche(tenantId: string, agentId: string, fiche: { titre: string; corps: string }): Promise<FicheConnaissance> {
  const r = await request<{ fiche: FicheConnaissance }>(base(tenantId, agentId), { method: 'POST', body: JSON.stringify(fiche) });
  return r.fiche;
}

export async function patchFiche(
  tenantId: string, agentId: string, ficheId: string, patch: { titre?: string; corps?: string },
): Promise<FicheConnaissance> {
  const r = await request<{ fiche: FicheConnaissance }>(`${base(tenantId, agentId)}/${ficheId}`, {
    method: 'PATCH', body: JSON.stringify(patch),
  });
  return r.fiche;
}

export async function deleteFiche(tenantId: string, agentId: string, ficheId: string): Promise<void> {
  await request<void>(`${base(tenantId, agentId)}/${ficheId}`, { method: 'DELETE' });
}

/** Relit une adresse : REMPLACE les fiches que cette même adresse avait déjà produites. */
export async function importerSource(
  tenantId: string, agentId: string, url: string, pages?: string[],
): Promise<BilanImport> {
  return request<BilanImport>(`${base(tenantId, agentId)}/import`, {
    method: 'POST',
    body: JSON.stringify(pages === undefined ? { url } : { url, pages }),
  });
}

/** Ce que l'import RAMÈNERAIT, sans rien écrire. */
export interface ApercuImport {
  url: string;
  /** `site` (racine d'un domaine), `page` (adresse précise), ou `sous-arbre` (choix explicite). */
  portee: 'page' | 'sous-arbre' | 'site';
  /** ⚠️ VRAI veut dire « il en manque » : 50 pages n'est pas « tout le site ». */
  plafondAtteint: boolean;
  pages: Array<{ url: string; fiches: number; caracteres: number }>;
  ecartees: Array<{ url: string; raison: string }>;
}

/**
 * Ce que l'import ramènerait, SANS ÉCRIRE.
 *
 * 🔴 Il existe parce qu'un import est difficile à défaire : cinquante pages écrites d'un coup, ce sont
 * cinquante jeux de fiches à relire ou supprimer une par une si la portée était mauvaise.
 */
export async function apercuImport(
  tenantId: string, agentId: string, url: string, portee?: ApercuImport['portee'],
): Promise<ApercuImport> {
  return request<ApercuImport>(`${base(tenantId, agentId)}/apercu`, {
    method: 'POST',
    body: JSON.stringify(portee === undefined ? { url } : { url, portee }),
  });
}
