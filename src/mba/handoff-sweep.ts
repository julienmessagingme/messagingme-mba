import { withinBusinessHours } from '../workflow/conditions';
import type { BusinessHours } from '../workflow/conditions';
import type { EtatHandoff } from './handoff';

/** Ce dont le balayage a besoin. Interface étroite, satisfaite par le store et le client MBA. */
export interface HandoffSweepDeps {
  /** Les tenants qui ont choisi « seulement pendant mes heures d'ouverture », avec leur fuseau et horaires. */
  tenantsHandoffSurHoraires(): Promise<Array<{ tenantId: string; timezone: string; businessHours: BusinessHours }>>;
  /** État actuel de `handoff.enabled` chez Meta. Voir `EtatHandoff` : `'absent'` et `null` ne sont PAS pareils. */
  lireHandoffEnabled(tenantId: string): Promise<EtatHandoff>;
  /** Écrit `handoff.enabled` chez Meta. Les autres champs de `handoff` sont préservés par `modifierSettings`. */
  ecrireHandoffEnabled(tenantId: string, enabled: boolean): Promise<void>;
  now?: () => number;
}

/**
 * Fait varier le passage de main de l'agent selon les heures d'ouverture du client.
 *
 * Raison d'être : Meta n'a AUCUNE notion d'horaires. Un agent configuré pour passer la main la passe à 3 h du
 * matin comme à 10 h, et le client lit « un conseiller arrive » quand personne n'est là. Ce balayage est la
 * seule façon de faire dépendre ce que le client PERÇOIT de l'heure qu'il est.
 *
 * On n'écrit que lorsque l'état voulu diffère de l'état lu : sans cette comparaison, le balayage réécrirait la
 * configuration de l'agent toutes les cinq minutes pour rien.
 *
 * Renvoie le nombre de tenants réellement basculés.
 */
export async function runHandoffSweep(deps: HandoffSweepDeps): Promise<number> {
  const maintenant = new Date(deps.now ? deps.now() : Date.now());
  const tenants = await deps.tenantsHandoffSurHoraires();
  let bascules = 0;
  for (const t of tenants) {
    const voulu = withinBusinessHours(maintenant, t.timezone, t.businessHours);
    let actuel: EtatHandoff;
    try {
      actuel = await deps.lireHandoffEnabled(t.tenantId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`handoff-sweep: lecture impossible pour ${t.tenantId}:`, err instanceof Error ? err.message : err);
      continue;
    }
    if (actuel === null) continue; // rien à lire : ne pas écrire à l'aveugle
    // `'absent'` force l'écriture même quand la valeur voulue est `false` : un agent jamais configuré est
    // dans un état inconnu, et le laisser tel quel reviendrait à ne jamais l'initialiser.
    if (actuel === voulu) continue;
    try {
      await deps.ecrireHandoffEnabled(t.tenantId, voulu);
      bascules += 1;
    } catch (err) {
      // Un échec est rattrapé au prochain passage : la base garde le choix du client, seule l'application
      // chez Meta a raté. Faire échouer le balayage entier priverait les autres tenants de leur bascule.
      // eslint-disable-next-line no-console
      console.error(`handoff-sweep: bascule impossible pour ${t.tenantId}:`, err instanceof Error ? err.message : err);
    }
  }
  return bascules;
}
