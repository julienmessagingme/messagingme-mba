import { request } from './http';

/**
 * Les SOURCES externes d'outils : le système du client, tel que la console le déclare (lot L2).
 *
 * 🔴 LE SECRET NE REVIENT JAMAIS. Aucune réponse ne le porte : l'écran connaît seulement son EXISTENCE
 * (`aAuthentification`). Un champ laissé vide dans un formulaire de modification veut donc dire « inchangé »,
 * et l'écran doit le DIRE, sinon le client croira l'avoir effacé.
 *
 * 🔴 ET L'ADRESSE EST FIGÉE ICI, pas dans l'outil. C'est la garde anti-SSRF du lot : le modèle ne compose
 * qu'un gabarit de chemin, et le serveur vérifie que la cible reste sous cette adresse. Un outil ne peut pas
 * porter sa propre adresse, et c'est voulu.
 */

export type AuthSource = 'none' | 'bearer' | 'header';
export type StatutSource = 'draft' | 'active' | 'disabled';

export interface SourceAgent {
  id: string;
  kind: 'http' | 'mcp';
  label: string;
  baseUrl: string;
  authKind: AuthSource;
  authHeaderName: string | null;
  aAuthentification: boolean;
  status: StatutSource;
  /** Dernière épreuve réussie. C'est ce qui rend un jeton mort visible AVANT qu'un contact ne le découvre. */
  lastOkAt: string | null;
  lastError: string | null;
  /** Outils ACTIFS qui en dépendent : au-dessus de zéro, la suppression est refusée. */
  outilsActifs: number;
}

export interface ResultatEpreuve {
  ok: boolean;
  httpStatus?: number;
  erreur?: string;
}

const base = (tenantId: string) => `/tenants/${tenantId}/agent-sources`;

export async function listSources(tenantId: string): Promise<SourceAgent[]> {
  const r = await request<{ sources?: SourceAgent[] }>(base(tenantId));
  return r.sources ?? [];
}

export async function creerSource(tenantId: string, input: {
  label: string; baseUrl: string; authKind: AuthSource; authHeaderName?: string; authSecret?: string;
}): Promise<SourceAgent> {
  const r = await request<{ source: SourceAgent }>(base(tenantId), { method: 'POST', body: JSON.stringify(input) });
  return r.source;
}

/** ⚠️ `authSecret` ABSENT = inchangé. L'écran ne peut pas le renvoyer : il ne l'a jamais eu. */
export async function patchSource(tenantId: string, id: string, patch: {
  label?: string; baseUrl?: string; authKind?: AuthSource; authHeaderName?: string | null;
  authSecret?: string; status?: StatutSource;
}): Promise<SourceAgent> {
  const r = await request<{ source: SourceAgent }>(`${base(tenantId)}/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
  return r.source;
}

export async function supprimerSource(tenantId: string, id: string): Promise<void> {
  await request(`${base(tenantId)}/${id}`, { method: 'DELETE' });
}

/** ÉPROUVER la source : un appel réel. Le résultat est une information, pas une erreur de la console. */
export async function eprouverSource(tenantId: string, id: string, chemin: string): Promise<ResultatEpreuve> {
  return request<ResultatEpreuve>(`${base(tenantId)}/${id}/epreuve`, {
    method: 'POST', body: JSON.stringify({ chemin }),
  });
}
