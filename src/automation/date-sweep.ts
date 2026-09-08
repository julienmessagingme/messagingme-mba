import { coerceConfigAvantDate, minutesDuDelai, estDu } from './avant-date';
import type { AutomationRow } from './match';

/**
 * Balayage du déclencheur `avant_date` : le seul qui ne répond pas à un événement mais à l'ÉCOULEMENT DU
 * TEMPS. Rien ne se passe côté client ; c'est nous qui devons aller voir si une échéance est arrivée.
 *
 * IO INJECTÉE (aucun import pg) -> testable sans base, comme `runAutomations`. La décision par contact vit
 * dans `avant-date.ts`, qui est pur ; ce module ne fait que la promener sur les contacts candidats.
 *
 * 🔴 Il PUBLIE, il ne démarre rien. Le scénario part par le chemin commun (`runAutomations`), donc avec les
 * mêmes garde-fous que tous les autres déclencheurs. Démarrer ici aurait dupliqué le contact bloqué, le
 * plafond horaire et « un seul parcours à la fois ».
 *
 * ⚠️ CONSÉQUENCE À CONNAÎTRE, mesurée en production le 2026-08-23. Quand le scénario ne DÉMARRE pas (fil tenu
 * par un humain, scénario vide, bloc absent), `runAutomations` annule le tir : rien n'est parti, donc rien
 * n'est à protéger. Le marqueur d'occurrence disparaît avec lui, et le balayage suivant REPUBLIE. L'échéance
 * est donc retentée à chaque passage tant que la fenêtre de tolérance est ouverte, puis abandonnée.
 *
 * C'est le comportement voulu : un fil momentanément tenu par un opérateur doit pouvoir laisser passer le
 * rappel une minute plus tard. Ça reste borné (la fenêtre), et aucun message ne part pendant les tentatives.
 * En revanche un scénario structurellement cassé produit une ligne de journal par minute pendant la fenêtre :
 * c'est bruyant, et c'est le signal qu'il y a quelque chose à corriger.
 */

export interface DateSweepDeps {
  /** Espaces ayant au moins une automation `avant_date` active. */
  tenants(): Promise<string[]>;
  /** Automations ACTIVES de ce type pour cet espace. */
  automations(tenantId: string): Promise<AutomationRow[]>;
  /** Fuseau de l'espace : une date sans fuseau est une heure MURALE, elle n'est un instant que là-dedans. */
  timeZone(tenantId: string): Promise<string>;
  /** Contacts dont la date tombe dans la fenêtre grossière, avec la valeur déjà tirée. */
  candidats(
    tenantId: string,
    automationId: string,
    fieldKey: string,
    borneBasse: string,
    borneHaute: string,
  ): Promise<Array<{ waId: string; valeur: string; dejaTirePour: string | null }>>;
  /** Publie l'événement d'automation. C'est le worker qui décide ensuite quoi déclencher. */
  publish(tenantId: string, ev: { kind: 'avant_date'; waId: string; automationId: string; valeur: string }): Promise<void>;
  /**
   * Fenêtre de rattrapage après le moment prévu. Elle existe pour qu'un redémarrage du worker ne perde pas
   * les échéances de la minute d'avant, PAS pour rattraper un retard réel : au-delà, on n'envoie rien.
   */
  toleranceMinutes: number;
  now?: () => number;
  log?: (m: string) => void;
}

/** Marge de la fenêtre SQL, de chaque côté. Voir `contactsDusPourDate` : le tri se fait sur du texte. */
const MARGE_MS = 24 * 60 * 60 * 1000;

/**
 * Un passage. Renvoie le nombre d'événements publiés.
 *
 * Isolation PAR AUTOMATION : une automation qui échoue (champ supprimé, base indisponible) ne doit pas
 * empêcher les autres de partir, ni faire échouer le balayage entier.
 */
export async function runDateSweep(deps: DateSweepDeps): Promise<number> {
  const now = deps.now ?? (() => Date.now());
  const journal = deps.log ?? (() => {});
  let publies = 0;

  for (const tenantId of await deps.tenants()) {
    let timeZone = 'Europe/Paris';
    try {
      timeZone = await deps.timeZone(tenantId);
    } catch {
      // Fuseau illisible : on continue sur le défaut plutôt que d'abandonner l'espace entier. Un rappel à
      // une heure approchante vaut mieux qu'aucun rappel, et le cas ne devrait pas exister.
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
        // Les dates cherchées sont celles dont l'échéance tombe maintenant. La marge d'un jour absorbe les
        // écarts de fuseau entre valeurs stockées.
        // ⚠️ LE CENTRE CHANGE DE CoTÉ AVEC LE SENS. Pour « avant », l'échéance tombe maintenant quand la date
        // vaut `maintenant + délai` ; pour « après », quand elle vaut `maintenant - délai`. Chercher du même
        // côté dans les deux cas ramènerait une fenêtre de contacts qui ne contient jamais les bons, et
        // l'automation serait muette sans aucune erreur.
        const centre = t + (cfg.sens === 'apres' ? -1 : 1) * offsetMinutes * 60_000;
        const borneBasse = new Date(centre - MARGE_MS).toISOString();
        const borneHaute = new Date(centre + MARGE_MS).toISOString();

        const candidats = await deps.candidats(tenantId, a.id, cfg.fieldKey, borneBasse, borneHaute);
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
        journal(`date-sweep: automation ${a.id} ignorée : ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return publies;
}
