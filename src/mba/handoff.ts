import { modifierSettings } from './client';
import type { MbaClient } from './client';
import type { HorairesEffectifs, MbaHandoffMode } from '../settings/store.pg';
import { withinBusinessHours, type BusinessHours } from '../workflow/conditions';
import { messageDe } from '../lib/erreur';

/**
 * Tout ce qu'il faut pour piloter `handoff.enabled` : le choix persistant, les horaires qui déterminent sa
 * valeur et la cible Meta. Les adapters HTTP et worker ne connaissent ni l'ordre des effets ni les règles de
 * reprise.
 */
export interface PilotageHandoffDeps {
  reglages: {
    setMbaHandoffMode(tenantId: string, mode: MbaHandoffMode): Promise<void>;
    horairesEffectifs(tenantId: string): Promise<HorairesEffectifs>;
    tenantsHandoffSurHoraires(): Promise<Array<{ tenantId: string; timezone: string; businessHours: BusinessHours }>>;
  };
  meta: { mbaClientForTenant(tenantId: string): Promise<MbaClient> };
  /** Numéro du tenant. `null` = aucun numéro, donc rien à régler chez Meta. */
  numeros: { getTenantPhoneNumberId(tenantId: string): Promise<string | null> };
  now?: () => number;
}

/**
 * État actuel de `handoff.enabled` chez Meta, en trois cas à ne pas confondre :
 * - `true` / `false` : lu chez Meta ;
 * - `'absent'` : réglages lisibles mais `handoff` jamais configuré (« Null if not configured ») : l'état réel est
 *   inconnu, donc il faut écrire même si la valeur voulue est `false`, sinon un agent neuf ne serait jamais configuré ;
 * - `null` : rien à lire (pas de numéro, ou agent pas encore créé) : ne rien écrire à l'aveugle.
 */
type EtatHandoff = boolean | 'absent' | null;

async function lireHandoffEnabled(deps: PilotageHandoffDeps, tenantId: string): Promise<EtatHandoff> {
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
async function ecrireHandoffEnabled(deps: PilotageHandoffDeps, tenantId: string, enabled: boolean): Promise<void> {
  const pn = await deps.numeros.getTenantPhoneNumberId(tenantId);
  if (pn === null) return;
  const client = await deps.meta.mbaClientForTenant(tenantId);
  await modifierSettings(client, pn, { handoff: { enabled } });
}

function valeurVoulue(
  mode: MbaHandoffMode,
  maintenant: Date,
  horaires?: { timezone: string; businessHours: BusinessHours },
): boolean {
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  if (!horaires) throw new Error('horaires requis pour le passage de main sur heures ouvrées');
  return withinBusinessHours(maintenant, horaires.timezone, horaires.businessHours);
}

/**
 * Enregistre le choix du client puis tente de l'appliquer immédiatement chez Meta. La base reste la source de
 * vérité : une panne Meta rend `false`, sans annuler le choix, et le balayage le rattrapera. La réponse HTTP
 * n'a donc plus à connaître l'ordre « persister, calculer, appliquer ».
 */
export async function reglerModeHandoff(
  deps: PilotageHandoffDeps,
  tenantId: string,
  mode: MbaHandoffMode,
): Promise<{ appliqueChezMeta: boolean }> {
  await deps.reglages.setMbaHandoffMode(tenantId, mode);
  const horaires = mode === 'business_hours' ? await deps.reglages.horairesEffectifs(tenantId) : undefined;
  const voulu = valeurVoulue(mode, new Date(deps.now ? deps.now() : Date.now()), horaires);
  try {
    await ecrireHandoffEnabled(deps, tenantId, voulu);
    return { appliqueChezMeta: true };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`mba-handoff: application chez Meta impossible pour ${tenantId}:`, messageDe(err));
    return { appliqueChezMeta: false };
  }
}

/**
 * Réconcilie les seuls tenants dont le choix varie au fil de la journée. Un échec reste local au tenant :
 * la base conserve le choix et le passage suivant retente la convergence. Rend le nombre d'écritures Meta
 * effectivement réussies.
 */
export async function reconcilierHandoffSurHoraires(deps: PilotageHandoffDeps): Promise<number> {
  const maintenant = new Date(deps.now ? deps.now() : Date.now());
  const tenants = await deps.reglages.tenantsHandoffSurHoraires();
  let bascules = 0;
  for (const tenant of tenants) {
    const voulu = valeurVoulue('business_hours', maintenant, tenant);
    let actuel: EtatHandoff;
    try {
      actuel = await lireHandoffEnabled(deps, tenant.tenantId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`handoff-sweep: lecture impossible pour ${tenant.tenantId}:`, messageDe(err));
      continue;
    }
    if (actuel === null || actuel === voulu) continue;
    // `'absent'` force l'écriture même si la valeur voulue est `false` : un agent jamais configuré est dans
    // un état inconnu et doit être initialisé explicitement.
    try {
      await ecrireHandoffEnabled(deps, tenant.tenantId, voulu);
      bascules += 1;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`handoff-sweep: bascule impossible pour ${tenant.tenantId}:`, messageDe(err));
    }
  }
  return bascules;
}
