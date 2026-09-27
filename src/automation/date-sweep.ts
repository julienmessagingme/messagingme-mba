import { coerceConfigAvantDate, minutesDuDelai, estDu } from './avant-date';
import type { AutomationRow } from './match';
import { texteDe } from '../lib/erreur';

/**
 * Balayage du déclencheur `avant_date` : le seul qui répond à l'écoulement du temps, pas à un événement. IO
 * injectée, testable sans base ; la décision par contact vit dans `avant-date.ts`.
 *
 * 🔴 Il publie, il ne démarre rien : le scénario part par `runAutomations`, avec les garde-fous de tous les
 * déclencheurs (contact bloqué, plafond horaire, un seul parcours à la fois).
 *
 * Quand le scénario ne démarre pas (fil tenu par un humain, scénario vide), `runAutomations` annule le tir et
 * son marqueur : le balayage suivant republie, tant que la fenêtre de tolérance est ouverte. Voulu (un fil
 * momentanément tenu doit pouvoir laisser passer le rappel), borné, et aucun message ne part pendant les
 * tentatives ; un scénario cassé produit une ligne de journal par minute.
 */

export interface DateSweepDeps {
  /** Les déclencheurs « avant la date » des automations. */
  declencheurs: {
    /** Espaces ayant au moins une automation `avant_date` active. */
    tenantsAvecDeclencheurDate(): Promise<string[]>;
    /** Contacts dont la date tombe dans la fenêtre grossière, avec la valeur déjà tirée. */
    contactsDusPourDate(
      tenantId: string,
      automationId: string,
      fieldKey: string,
      borneBasse: string,
      borneHaute: string,
    ): Promise<Array<{ waId: string; valeur: string; dejaTirePour: string | null }>>;
  };
  /** Automations actives de ce type pour cet espace. */
  automations(tenantId: string): Promise<AutomationRow[]>;
  /** Fuseau de l'espace : une date sans fuseau est une heure murale, elle n'est un instant que là-dedans. */
  timeZone(tenantId: string): Promise<string>;
  /** Publie l'événement d'automation. C'est le worker qui décide ensuite quoi déclencher. */
  publish(tenantId: string, ev: { kind: 'avant_date'; waId: string; automationId: string; valeur: string }): Promise<void>;
  /**
   * Fenêtre de rattrapage après le moment prévu : pour qu'un redémarrage du worker ne perde pas les échéances
   * de la minute d'avant, pas pour rattraper un retard réel.
   */
  toleranceMinutes: number;
  now?: () => number;
  log?: (m: string) => void;
}

/** Marge de la fenêtre SQL, de chaque côté. Voir `contactsDusPourDate` : le tri se fait sur du texte. */
const MARGE_MS = 24 * 60 * 60 * 1000;

/**
 * Un passage ; renvoie le nombre d'événements publiés. Isolation par automation : une automation qui échoue
 * ne doit pas empêcher les autres de partir.
 */
export async function runDateSweep(deps: DateSweepDeps): Promise<number> {
  const now = deps.now ?? (() => Date.now());
  const journal = deps.log ?? (() => {});
  let publies = 0;

  for (const tenantId of await deps.declencheurs.tenantsAvecDeclencheurDate()) {
    let timeZone = 'Europe/Paris';
    try {
      timeZone = await deps.timeZone(tenantId);
    } catch {
      // Fuseau illisible : repli sur le défaut plutôt qu'abandonner l'espace (un rappel à une heure approchante
      // vaut mieux qu'aucun).
      journal(`date-sweep: fuseau illisible pour ${tenantId}, repli sur ${timeZone}`);
    }

    for (const a of await deps.automations(tenantId)) {
      try {
        const cfg = coerceConfigAvantDate(a.triggerConfig);
        if (!cfg) {
          journal(`date-sweep: automation ${a.id} (${a.name}) mal configurée, ignorée`);
          continue;
        }
        const offsetMinutes = minutesDuDelai(cfg.delai, cfg.unite);
        const t = now();
        // Les dates cherchées sont celles dont l'échéance tombe maintenant, à un jour près (écarts de fuseau). Le
        // centre change de côté avec le sens : `maintenant + délai` pour « avant », `maintenant - délai` pour
        // « après » ; du même côté, la fenêtre ne contiendrait jamais les bons contacts, sans erreur.
        const centre = t + (cfg.sens === 'apres' ? -1 : 1) * offsetMinutes * 60_000;
        const borneBasse = new Date(centre - MARGE_MS).toISOString();
        const borneHaute = new Date(centre + MARGE_MS).toISOString();

        const candidats = await deps.declencheurs.contactsDusPourDate(tenantId, a.id, cfg.fieldKey, borneBasse, borneHaute);
        for (const c of candidats) {
          const r = estDu({
            valeur: c.valeur,
            offsetMinutes,
            sens: cfg.sens,
            now: t,
            toleranceMinutes: deps.toleranceMinutes,
            timeZone,
            dejaTirePour: c.dejaTirePour,
          });
          if (!r.du) continue;
          await deps.publish(tenantId, { kind: 'avant_date', waId: c.waId, automationId: a.id, valeur: c.valeur });
          publies += 1;
        }
      } catch (err) {
        journal(`date-sweep: automation ${a.id} ignorée : ${texteDe(err)}`);
      }
    }
  }

  return publies;
}
