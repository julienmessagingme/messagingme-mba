import type { WorkflowGraph } from '../workflow/graph';
import type { UserFieldType, UserFieldDef } from '../crm/types';
import { slugify, SYSTEM_FIELD_KEYS } from '../crm/fields';

/**
 * Résolution d'un handle d'API (code stable ou nom) vers l'entité interne, toujours filtrée sur l'espace de la clé.
 * Un code (scn_/tag_/fld_/nod_) est non ambigu ; un nom peut désigner plusieurs entités : `ambiguous` (409), jamais
 * un choix silencieux.
 */
export type ResolveResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'ambiguous'; matches: T[] };

export interface WorkflowLister {
  list(tenantId: string): Promise<Array<{ id: string; name: string; code?: string | null; graph: WorkflowGraph }>>;
}
export interface FieldLister {
  list(tenantId: string): Promise<UserFieldDef[]>;
}

const eqName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Scénario par code `scn_...` (exact, jamais ambigu) ou par nom (0/1/plusieurs). */
export async function resolveScenario(
  tenantId: string,
  ref: string,
  workflows: WorkflowLister,
): Promise<ResolveResult<{ id: string; name: string; graph: WorkflowGraph }>> {
  const all = await workflows.list(tenantId);
  const pick = (w: (typeof all)[number]) => ({ id: w.id, name: w.name, graph: w.graph });
  if (ref.startsWith('scn_')) {
    const hit = all.find((w) => w.code === ref);
    return hit ? { ok: true, value: pick(hit) } : { ok: false, reason: 'not_found' };
  }
  const matches = all.filter((w) => eqName(w.name, ref)).map(pick);
  if (matches.length === 0) return { ok: false, reason: 'not_found' };
  if (matches.length > 1) return { ok: false, reason: 'ambiguous', matches };
  return { ok: true, value: matches[0]! };
}

/** Node par code `nod_...`, cherché dans les graphes de l'espace (le code vit dans node.data.code). Jamais ambigu. */
export async function resolveNode(
  tenantId: string,
  code: string,
  workflows: WorkflowLister,
): Promise<ResolveResult<{ workflowId: string; nodeId: string; graph: WorkflowGraph }>> {
  if (!code.startsWith('nod_')) return { ok: false, reason: 'not_found' };
  const all = await workflows.list(tenantId);
  for (const w of all) {
    const node = w.graph.nodes.find((n) => n.data.code === code);
    if (node) return { ok: true, value: { workflowId: w.id, nodeId: node.id, graph: w.graph } };
  }
  return { ok: false, reason: 'not_found' };
}

const SYS_RE = /^fld_[0-9a-z]+_sys_(.+)$/;

export type FieldResolve =
  | { ok: true; key: string; type: UserFieldType; known: boolean }
  | { ok: false; reason: 'not_found' };

/**
 * Résout un champ contact par sa clé technique ou son code, jamais par libellé :
 *  - `fld_<tenant>_sys_<key>` (clé système) : résolu sans base, type 'text' ;
 *  - autre `fld_...` : cherché par code ; introuvable -> not_found (un code ne se devine pas) ;
 *  - sinon, la clé technique : présente -> connue, absente -> `known:false` (le webhook entrant et la saisie à la
 *    main créent un champ texte ; l'API publique refuse, `preparateurDeChamps`).
 */
export async function resolveFieldKey(tenantId: string, ref: string, fields: FieldLister): Promise<FieldResolve> {
  const sys = SYS_RE.exec(ref);
  if (sys) {
    const key = sys[1]!;
    return SYSTEM_FIELD_KEYS.includes(key) ? { ok: true, key, type: 'text', known: true } : { ok: false, reason: 'not_found' };
  }
  const defs = await fields.list(tenantId);
  if (ref.startsWith('fld_')) {
    const hit = defs.find((d) => d.code === ref);
    return hit ? { ok: true, key: hit.key, type: hit.type, known: true } : { ok: false, reason: 'not_found' };
  }
  const exact = defs.find((d) => d.key === ref);
  if (exact) return { ok: true, key: exact.key, type: exact.type, known: true };
  return { ok: true, key: slugify(ref), type: 'text', known: false };
}
