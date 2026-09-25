import type { Pool } from 'pg';
import { enfilerEvenementAutomation, type AutomationEventJob, type FileDEvenements } from '../automation/event-job';
import type { AutomationRow, AutomationTriggerKind } from '../automation/match';
import type { Emetteur } from '../signaux/emetteur';
import { PgTenantSettingsStore } from '../settings/store.pg';
import { balayerRisqueEspace, type BilanRisque, type DepsBalayageRisque } from './balayage';
import { PgRisqueStore } from './risque.pg';

/**
 * LE CÂBLAGE DU BALAYAGE DU RISQUE, PARTAGÉ par ses deux lanceurs : la tâche de nuit du worker et `/ops` dans
 * l'API. Deux câblages recopiés seraient deux endroits où le plafond, l'émetteur ou la file peuvent diverger.
 *
 * ⚠️ LE PARAMÈTRE DE FILE EST LE PLUS PETIT QUI CONVIENT (`FileDEvenements`) : l'enfilement passe par
 * `enfilerEvenementAutomation`, qui pose l'espace comme clé de groupe, jamais par un `enqueue` direct.
 *
 * ⚠️ LES HEURES D'OUVERTURE SE LISENT ICI, sur le pool, et pas par une dépendance de plus : c'est la même
 * lecture que celle des campagnes (`PgTenantSettingsStore.get`, défauts du serveur compris), et les deux
 * lanceurs l'obtiennent sans que leur câblage ait à changer.
 */
export interface OptionsCablageRisque {
  pool: Pool;
  file: FileDEvenements;
  emetteur: Pick<Emetteur, 'emettreSignaux'>;
  /** Les automations ACTIVES d'un espace pour ces types (le chemin chaud de `PgAutomationStore.listEnabled`). */
  automationsActives(tenantId: string, kinds: readonly AutomationTriggerKind[]): Promise<AutomationRow[]>;
  /** Nommé `journal` et pas `log` : un `.log` sur un autre objet que `deps` se lit comme le journal muet de Fastify. */
  journal?: (message: string) => void;
}

export function depsBalayageRisque(o: OptionsCablageRisque): DepsBalayageRisque {
  const store = new PgRisqueStore(o.pool);
  const reglages = new PgTenantSettingsStore(o.pool);
  return {
    espaces: () => store.espaces(),
    contactsAEvaluer: (t, depuis) => store.contactsAEvaluer(t, depuis),
    faits: (t, ids, depuis, maintenant) => store.faits(t, ids, depuis, maintenant),
    ecrire: (t, lignes, calculeLe) => store.ecrire(t, lignes, calculeLe),
    declenchablesDepuis: (t, depuis) => store.declenchablesDepuis(t, depuis),
    automationRisqueActive: async (t) => (await o.automationsActives(t, ['risque_eleve'])).length > 0,
    horairesOuvres: async (t) => {
      const s = await reglages.get(t);
      return { timeZone: s.timezone, businessHours: s.businessHours };
    },
    // Le SEUL événement que ce chemin de masse publie (cf. l'exception écrite au point d'émission, `balayage.ts`).
    publierRisqueEleve: (t, waId, depart) => enfilerEvenementAutomation(o.file, { tenantId: t, event: { kind: 'risque_eleve', waId } } satisfies AutomationEventJob, depart),
    emettreSignaux: (t, signaux) => o.emetteur.emettreSignaux(t, signaux),
    ...(o.journal ? { log: o.journal } : {}),
  };
}

/** Le lancement À LA DEMANDE d'un espace (`/ops`), pour l'essai réel et le dépannage. `null` = espace inconnu. */
export function lanceurBalayageRisque(o: OptionsCablageRisque): (tenantId: string) => Promise<BilanRisque | null> {
  const deps = depsBalayageRisque(o);
  const store = new PgRisqueStore(o.pool);
  return async (tenantId) => ((await store.espaceExiste(tenantId)) ? balayerRisqueEspace(tenantId, deps) : null);
}
