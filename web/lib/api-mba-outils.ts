import { request } from './http';

/**
 * L'ONGLET « OUTILS » DE L'AGENT DE META, côté client (spec 2026-09-21-outils-maison-mba, § 9).
 * Miroir de `src/mba/vue-outils.ts` et `src/http/mba-outils.ts`.
 */
export type TypeOutilMba = 'tag' | 'champ' | 'bloc' | 'scenario' | 'connecteur';

export type CibleVue =
  | { type: 'tag'; tag: string }
  | { type: 'champ'; champ: string; valeurs: string[] }
  | { type: 'connecteur'; requeteId: string; libelle: string | null }
  | { type: 'inconnu' };

export interface OutilMbaVue {
  id: string;
  name: string;
  title: string;
  description: string;
  nePasUtiliser: string;
  type: TypeOutilMba | 'inconnu';
  cible: CibleVue;
  /** Pourquoi la cible n'existe plus, ou `null`. Texte du serveur, affiché tel quel. */
  cibleManquante: string | null;
  /** Les agents IA qui partagent cet outil (connecteur seulement). */
  aussiUtilisePar: string[];
  /** Faux quand le départ de son auteur l'a éteint : il n'est plus publié chez Meta. */
  actif: boolean;
}

export type CibleSaisie =
  | { type: 'tag'; tag: string }
  | { type: 'champ'; champ: string; valeurs: string[] }
  | { type: 'connecteur'; requeteId: string };

export interface TextesOutil { name: string; title: string; description: string; nePasUtiliser: string }

const base = (tenantId: string): string => `/tenants/${tenantId}/mba-outils`;

export function listerOutilsMba(tenantId: string): Promise<{ outils: OutilMbaVue[]; phoneNumberId: string | null }> {
  return request(base(tenantId));
}

export function creerOutilMba(tenantId: string, corps: TextesOutil & { cible: CibleSaisie }): Promise<{ id: string }> {
  return request(base(tenantId), { method: 'POST', body: JSON.stringify(corps) });
}

export function modifierOutilMba(
  tenantId: string, id: string, patch: Partial<TextesOutil> & { cible?: CibleSaisie },
): Promise<{ id: string }> {
  return request(`${base(tenantId)}/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
}

export async function retirerOutilMba(tenantId: string, id: string): Promise<void> {
  await request<void>(`${base(tenantId)}/${id}`, { method: 'DELETE' });
}

/** Rallumer un outil éteint par le départ de son auteur (plan 2026-09-21-outils-maison-mba, écart 4). */
export function reactiverOutilMba(tenantId: string, id: string): Promise<{ actif: true }> {
  return request(`${base(tenantId)}/${id}/actif`, { method: 'PUT', body: JSON.stringify({ valeur: true }) });
}
