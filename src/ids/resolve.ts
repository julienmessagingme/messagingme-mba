import type { WorkflowGraph } from '../workflow/graph';
import type { UserFieldType, UserFieldDef } from '../crm/types';
import { slugify, SYSTEM_FIELD_KEYS } from '../crm/fields';

/**
 * Résolution d'un handle d'API (code stable OU nom) vers l'entité interne. Toujours scopé au tenant de la
 * clé d'API. Un `code` (scn_/tag_/fld_/nod_) est non ambigu (index unique) ; un NOM peut matcher plusieurs
 * entités (workflows.name n'a aucune contrainte d'unicité) -> `ambiguous` (409 côté route, jamais un choix
 * silencieux). Chaque résolveur ne lit que ce dont il a besoin (interfaces étroites -> fakes de test simples).
 */
export type ResolveResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'ambiguous'; matches: T[] };

export interface WorkflowLister {
  list(tenantId: string): Promise<Array<{ id: string; name: string; code?: string | null; graph: WorkflowGraph }>>;
}
export interface TagLister {
  listDistinct(tenantId: string): Promise<Array<{ tag: string; code?: string | null }>>;
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

/** Node par code `nod_...` : scan des graphes du tenant (le code vit dans node.data.code). Jamais ambigu. */
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

/** Tag par code `tag_...` ou par nom. PK (tenant,name) -> ambiguïté impossible, chemin gardé par symétrie. */
export async function resolveTag(
  tenantId: string,
  ref: string,
  tags: TagLister,
): Promise<ResolveResult<{ tag: string; code: string | null }>> {
  const all = await tags.listDistinct(tenantId);
  const pick = (t: (typeof all)[number]) => ({ tag: t.tag, code: t.code ?? null });
  if (ref.startsWith('tag_')) {
    const hit = all.find((t) => t.code === ref);
    return hit ? { ok: true, value: pick(hit) } : { ok: false, reason: 'not_found' };
  }
  const matches = all.filter((t) => eqName(t.tag, ref)).map(pick);
  if (matches.length === 0) return { ok: false, reason: 'not_found' };
  if (matches.length > 1) return { ok: false, reason: 'ambiguous', matches };
  return { ok: true, value: matches[0]! };
}

const SYS_RE = /^fld_[0-9a-z]+_sys_(.+)$/;

export type FieldResolve =
  | { ok: true; key: string; type: UserFieldType; known: boolean }
  | { ok: false; reason: 'not_found' };

/**
 * Résout un champ contact désigné par sa CLÉ technique OU son code (D-2). Jamais par libellé.
 *  - `fld_<tenant>_sys_<key>` (key système) -> résolu SANS DB (déterministe), type 'text'.
 *  - `fld_...` (autre code) -> lookup par code en base ; introuvable -> not_found (un code ne se devine pas).
 *  - sinon -> traité comme la clé technique : présente dans les defs -> connue ; absente -> `known:false`
 *    (l'appelant /v1/contacts auto-crée un champ texte, comme l'import CSV ; /v1/sends n'en a pas l'usage).
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
