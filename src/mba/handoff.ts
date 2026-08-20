import { modifierSettings } from './client';
import type { MbaClient } from './client';

/**
 * Lecture / écriture de `handoff.enabled` par TENANT, partagées par l'API (le client vient de choisir) et par
 * le balayage horaire (l'heure a changé). Les deux doivent se comporter à l'identique : un seul endroit.
 *
 * ⚠️ `enabled` ne décide pas si l'agent transfère, mais s'il LÂCHE le fil après l'avoir annoncé. Voir
 * `AgentSettings.handoff`.
 */
export interface HandoffCibleDeps {
  clientFor(tenantId: string): Promise<MbaClient>;
  /** Numéro du tenant. `null` = aucun numéro, donc rien à régler chez Meta. */
  phoneNumberFor(tenantId: string): Promise<string | null>;
}

/**
 * État actuel de `handoff.enabled` chez Meta, en TROIS cas qu'il ne faut surtout pas confondre :
 *
 * - `true` / `false` : lu chez Meta, on sait où on en est ;
 * - `'absent'` : les réglages sont lisibles mais `handoff` n'a JAMAIS été configuré (Meta le documente,
 *   « Null if not configured »). L'état réel de l'agent est alors inconnu, donc il faut écrire, même si la
 *   valeur voulue est `false` : sans cela un agent neuf ne serait jamais configuré ;
 * - `null` : rien à lire (pas de numéro, ou agent pas encore créé par Meta). L'appelant ne doit rien écrire,
 *   plutôt que d'écrire à l'aveugle sur une ressource qui n'existe pas.
 */
export type EtatHandoff = boolean | 'absent' | null;

export async function lireHandoffEnabled(deps: HandoffCibleDeps, tenantId: string): Promise<EtatHandoff> {
  const pn = await deps.phoneNumberFor(tenantId);
  if (pn === null) return null;
  const client = await deps.clientFor(tenantId);
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
  const pn = await deps.phoneNumberFor(tenantId);
  if (pn === null) return;
  const client = await deps.clientFor(tenantId);
  await modifierSettings(client, pn, { handoff: { enabled } });
}
