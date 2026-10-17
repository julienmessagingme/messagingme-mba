import type { AuditSink } from '../audit/journal';
import type { PlafondCles } from './api-key-store.pg';
import { API_SCOPES, DROIT_RELAIS } from '../../web/lib/partage/droits-api';
import { LimiteOffreError, STATUT_REFUS_OFFRE, corpsRefusLimite } from '../offres/refus';
import { refus, type Issue } from '../lib/issue';
import { tenter } from '../lib/tenter';

/**
 * LA CRÉATION D'UNE CLÉ D'API, UNE FOIS (spec offres v2) : la route de la console et l'outil MCP `create_api_key`
 * passent ici, donc par les mêmes contrôles, le même plafond de l'offre et la même trace.
 */
export interface DepsCreationCle {
  cles: {
    /** `null` = plafond atteint, rien n'est créé. */
    creerSousPlafond(tenantId: string, name: string, scopes: string[], plafond: PlafondCles): Promise<{ id: string; key: string } | null>;
  };
  /** Les clés actives que l'offre de l'espace permet (`Limites.clesApi`) ; `null` = sans limite. */
  limiteCles(tenantId: string): Promise<number | null>;
  audit: AuditSink;
}

/** Qui crée la clé, tel que le journal le garde. */
export interface AuteurCle {
  userId: string | null;
  email: string | null;
}

export interface CleCreee {
  id: string;
  /** En clair, rendue UNE fois : seul son hash est gardé. */
  key: string;
  name: string;
  scopes: string[];
}

/** Par où la clé est créée : la console, ou Claude (`create_api_key`), que la trace d'audit nomme. */
export type OrigineCle = 'console' | 'mcp';

export async function creerCleApi(
  deps: DepsCreationCle, tenantId: string, nom: string, scopes: readonly string[], auteur: AuteurCle, origine: OrigineCle,
): Promise<Issue<CleCreee>> {
  const name = nom.trim().slice(0, 100);
  if (name === '') return refus(400, 'name requis');
  const droits = [...new Set(scopes)];
  if (droits.length === 0) return refus(400, 'au moins un scope requis');
  // `mba:relais` n'est pas dans la liste : seule la publication chez Meta pose cette clé.
  const inconnus = droits.filter((s) => !(API_SCOPES as readonly string[]).includes(s));
  if (inconnus.length > 0) return refus(400, `scope(s) inconnu(s) : ${inconnus.join(', ')}`);
  const max = await deps.limiteCles(tenantId);
  const creee = await deps.cles.creerSousPlafond(tenantId, name, droits, { max, horsDroit: DROIT_RELAIS });
  if (creee === null) {
    // `max` ne peut être `null` ici : sans limite, le magasin crée toujours.
    const c = corpsRefusLimite(new LimiteOffreError(tenantId, 'clesApi', max ?? 0));
    return refus(STATUT_REFUS_OFFRE, c.error, { code: c.code, limite: c.limite, max: c.max, upgradeUrl: c.upgradeUrl });
  }
  // Best-effort, comme `makeJournal` : la clé existe, un journal en panne ne doit pas faire croire le contraire.
  // 🔴 Le détail porte les droits accordés, jamais la clé ni son empreinte (ce journal n'est pas purgé).
  await tenter('audit ignoré:', () => deps.audit(tenantId, auteur, 'cle_api.creee', { kind: 'api_key', id: creee.id }, origine === 'mcp' ? { scopes: droits, via: 'mcp' } : { scopes: droits }));
  return { ok: true, valeur: { id: creee.id, key: creee.key, name, scopes: droits } };
}
