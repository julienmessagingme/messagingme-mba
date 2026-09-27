import { modifierSettings } from './client';
import type { MbaClient } from './client';

/**
 * Lecture et écriture de `handoff.enabled` par tenant, partagées par l'API (choix du client) et le balayage
 * horaire : un seul endroit. `enabled` ne décide pas si l'agent transfère, mais s'il lâche le fil après l'avoir
 * annoncé (voir `AgentSettings.handoff`).
 */
export interface HandoffCibleDeps {
  meta: { mbaClientForTenant(tenantId: string): Promise<MbaClient> };
  /** Numéro du tenant. `null` = aucun numéro, donc rien à régler chez Meta. */
  numeros: { getTenantPhoneNumberId(tenantId: string): Promise<string | null> };
}

/**
 * État actuel de `handoff.enabled` chez Meta, en trois cas à ne pas confondre :
 * - `true` / `false` : lu chez Meta ;
 * - `'absent'` : réglages lisibles mais `handoff` jamais configuré (« Null if not configured ») : l'état réel est
 *   inconnu, donc il faut écrire même si la valeur voulue est `false`, sinon un agent neuf ne serait jamais configuré ;
 * - `null` : rien à lire (pas de numéro, ou agent pas encore créé) : ne rien écrire à l'aveugle.
 */
export type EtatHandoff = boolean | 'absent' | null;

export async function lireHandoffEnabled(deps: HandoffCibleDeps, tenantId: string): Promise<EtatHandoff> {
  const pn = await deps.numeros.getTenantPhoneNumberId(tenantId);
  if (pn === null) return null;
  const client = await deps.meta.mbaClientForTenant(tenantId);
  const settings = await client.getSettings(pn);
  if (settings === null) return null;
  const h = settings.handoff;
  if (h === undefined || h === null || typeof h.enabled !== 'boolean') return 'absent';
  return h.enabled;
}

/**
 * Écrit `handoff.enabled`. No-op sans numéro. Les autres champs de `handoff` (le texte lu par le client et
 * qui le rédige) sont préservés par la fusion par sous-objet de `modifierSettings`.
 */
export async function ecrireHandoffEnabled(deps: HandoffCibleDeps, tenantId: string, enabled: boolean): Promise<void> {
  const pn = await deps.numeros.getTenantPhoneNumberId(tenantId);
  if (pn === null) return;
  const client = await deps.meta.mbaClientForTenant(tenantId);
  await modifierSettings(client, pn, { handoff: { enabled } });
}
