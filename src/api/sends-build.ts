import { optInAllows } from '../campaign/guardrails';
import type { BuildContact } from '../campaign/build';
import type { CampaignCategory } from '../campaign/types';

/** Motif d'écart d'un destinataire (D-5). `missing_variable` fusionné en aval depuis buildRecipients. */
export type ApiSkipReason = 'not_opted_in' | 'invalid_phone' | 'out_of_window' | 'unknown_contact' | 'missing_variable';
export interface ApiSkip { phone: string; reason: ApiSkipReason }

/**
 * Filtre les destinataires d'un envoi API avec un MOTIF par écart (contrairement à buildRecipients qui écarte
 * silencieusement l'opt-in). Ne touche PAS campaign/build.ts (partagé/testé). Dédup par identité. `windowOpenById`
 * (fourni seulement pour une cible node, D-1) écarte un contact hors fenêtre 24h en `out_of_window`. La
 * résolution des variables de template (missing_variable) est faite APRÈS par buildRecipients sur `eligible`.
 */
export function buildApiRecipients(
  category: CampaignCategory,
  contacts: BuildContact[],
  opts?: { windowOpenById?: Map<string, boolean> },
): { eligible: BuildContact[]; skipped: ApiSkip[] } {
  const seen = new Set<string>();
  const eligible: BuildContact[] = [];
  const skipped: ApiSkip[] = [];
  for (const c of contacts) {
    const to = c.phone_e164 ?? c.bsuid ?? '';
    if (!to || seen.has(to)) continue; // pas d'identité, ou doublon (silencieux)
    seen.add(to);
    if (!optInAllows(category, c)) { skipped.push({ phone: to, reason: 'not_opted_in' }); continue; }
    if (opts?.windowOpenById && !opts.windowOpenById.get(c.id)) { skipped.push({ phone: to, reason: 'out_of_window' }); continue; }
    eligible.push(c);
  }
  return { eligible, skipped };
}
