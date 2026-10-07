import { describe, it, expect } from 'vitest';
import { buildWorkflowRuntime } from '../src/workflow/wiring';
import type { WorkflowExecutorDeps } from '../src/workflow/executor';
import type { BesoinsContexte } from '../src/workflow/conditions';

/**
 * LE CONTEXTE D'UN CONTACT, VRAI CÂBLAGE (`buildEvalContext`, `src/workflow/wiring.ts`), POUR LES CHAMPS SYSTÈME (RC5).
 *
 * 🔴 CE QUI SE JOUE ICI EST UN COMPTE DE REQUÊTES. Le dernier message reçu et la langue détectée coûtent chacun une
 * lecture, sur le chemin de CHAQUE contact qui traverse une Condition : une campagne de 5 000 destinataires les
 * paierait 5 000 fois. L'exécuteur ne les demande que si un bloc les teste (`tests/workflow-executor.test.ts`) ; ce
 * fichier montre l'autre moitié : une demande à `false` ne lit RIEN, et une lecture en panne rend un champ vide,
 * jamais une valeur inventée ni un contexte perdu.
 *
 * `buildWorkflowRuntime` se monte sans base (ses dépôts ne font que retenir le pool), comme dans
 * `tests/controle-du-fil-cablage.test.ts` : seuls la fiche, les réglages et les deux lectures parlent.
 */
function cablage(lectures: { recu?: () => Promise<Date | null>; langue?: () => Promise<string | null> } = {}) {
  const appels: string[] = [];
  const inerte = {} as never;
  const { executor } = buildWorkflowRuntime({
    pool: inerte, queue: { enqueue: async () => {} }, dryRun: true, repo: inerte,
    contactStore: {
      getContactStateByWaId: async () => ({ fields: {}, tags: [], optIn: 'unknown', name: null, phone: '+33612345678', bsuid: null, analyse: null }),
      langueDetecteeParWaId: async () => { appels.push('langue'); return (lectures.langue ?? (async () => 'es'))(); },
    } as never,
    inboxStore: {
      derniereSaisieDuContact: async () => { appels.push('saisie'); return 'bonjour'; },
      dateDernierMessageRecu: async () => { appels.push('recu'); return (lectures.recu ?? (async () => new Date('2026-10-01T08:00:00Z')))(); },
    } as never,
    settingsStore: { get: async () => ({ timezone: 'Europe/Paris', businessHours: {} }) } as never,
    workflowStore: inerte, metaCredentials: inerte, metaFactory: inerte, rcsProvider: 'fake', emailTemplates: inerte,
    emailResolver: inerte, numeroDeLEspace: async () => null, runStore: inerte, fil: inerte,
  });
  // `deps` est privé à l'exécuteur : on lit la dépendance que le câblage lui a donnée.
  const { evalContext } = Reflect.get(executor, 'deps') as WorkflowExecutorDeps;
  return { evalContext, appels };
}

const RIEN: BesoinsContexte = { derniereSaisie: false, dernierMessageRecu: false, langueDetectee: false };

describe('buildEvalContext : les champs système, lus seulement quand on les demande', () => {
  it('🔴 rien de demandé : AUCUNE lecture, et les deux champs valent vide', async () => {
    for (const besoins of [undefined, RIEN]) {
      const { evalContext, appels } = cablage();
      const ctx = await evalContext('t1', '33612345678', besoins);
      expect(appels).toEqual([]);
      expect(ctx?.dernierMessageRecu ?? null).toBeNull();
      expect(ctx?.langueDetectee ?? null).toBeNull();
    }
  });

  it('chaque champ demandé est lu une fois, et lui seul', async () => {
    const recu = cablage();
    const ctxRecu = await recu.evalContext('t1', 'w', { ...RIEN, dernierMessageRecu: true });
    expect(recu.appels).toEqual(['recu']);
    // En ISO 8601 : la clause le relit comme un instant absolu, quel que soit le fuseau de l'espace.
    expect(ctxRecu?.dernierMessageRecu).toBe('2026-10-01T08:00:00.000Z');
    expect(ctxRecu?.langueDetectee ?? null).toBeNull();

    const langue = cablage();
    const ctxLangue = await langue.evalContext('t1', 'w', { ...RIEN, langueDetectee: true });
    expect(langue.appels).toEqual(['langue']);
    expect(ctxLangue?.langueDetectee).toBe('es');
  });

  it('🔴 une lecture en PANNE rend un champ vide, sans faire tomber le contexte (donc les autres conditions)', async () => {
    const { evalContext } = cablage({
      recu: async () => { throw new Error('base indisponible'); },
      langue: async () => { throw new Error('base indisponible'); },
    });
    const ctx = await evalContext('t1', 'w', { derniereSaisie: false, dernierMessageRecu: true, langueDetectee: true });
    expect(ctx).not.toBeNull();
    expect(ctx?.phone).toBe('+33612345678');
    expect(ctx?.dernierMessageRecu).toBeNull();
    expect(ctx?.langueDetectee).toBeNull();
  });

  it('un contact qui n’a jamais écrit : `null`, pas une date inventée', async () => {
    const { evalContext } = cablage({ recu: async () => null });
    expect((await evalContext('t1', 'w', { ...RIEN, dernierMessageRecu: true }))?.dernierMessageRecu).toBeNull();
  });
});
