import { describe, it, expect } from 'vitest';
import { newTestToken, looksLikeTestToken, normalizeTestToken, waMeTestLink } from '../src/workflow/test-token';
import { processTestTokens } from '../src/webhooks/test-token';

/**
 * Jeton de test d'un scénario (Lot F).
 *
 * Ce que ces tests protègent, et qui ne se voit pas à la lecture :
 *  1. Le jeton ne doit JAMAIS être déclenché par une phrase de client ordinaire : la comparaison porte sur le
 *     message ENTIER, pas sur « contient ». Sinon un client qui écrit « test-... » dans une phrase lancerait
 *     un scénario, poserait des tags et déclencherait des envois facturés.
 *  2. Un jeton d'un AUTRE client ne doit rien déclencher : le jeton désigne le scénario, mais c'est le numéro
 *     qui fait autorité sur le tenant.
 *  3. Le message porteur du jeton est CONSOMMÉ : sans ça, l'avance de scénario et les automations le
 *     traiteraient aussi, et un seul message déclencherait trois choses.
 */

const payload = (body: string, field = 'messages', waId = '33611') => ({
  entry: [{ changes: [{ field, value: { metadata: { phone_number_id: 'pn1' }, messages: [{ id: `wamid.${body}`, from: waId, type: 'text', text: { body } }] } }] }],
});

describe('forme du jeton', () => {
  it('newTestToken produit un jeton reconnu, préfixé et non devinable', () => {
    const t = newTestToken();
    expect(t).toMatch(/^test-[0-9a-hjkmnp-tv-z]{8}$/);
    expect(looksLikeTestToken(t)).toBe(true);
    // 20 tirages sans doublon : l'aléa est réel (un compteur ou une constante échouerait ici).
    expect(new Set(Array.from({ length: 20 }, () => newTestToken())).size).toBe(20);
  });

  it('tolère la casse et les espaces (clavier de téléphone, copier-coller)', () => {
    expect(looksLikeTestToken('  TEST-A7K2M9P3 ')).toBe(true);
    expect(normalizeTestToken(' Test-A7K2 M9P3 ')).toBe('test-a7k2m9p3');
  });

  it('refuse tout ce qui n’est pas EXACTEMENT un jeton', () => {
    for (const body of ['bonjour', 'test', 'test-', 'test-court', 'test-a7k2m9p33', 'je teste test-a7k2m9p3', '', null]) {
      expect(looksLikeTestToken(body), String(body)).toBe(false);
    }
  });
});

describe('lien wa.me', () => {
  it('retire le + et les espaces du numéro affiché, encode le jeton', () => {
    expect(waMeTestLink('+33 5 25 68 02 50', 'test-a7k2m9p3')).toBe('https://wa.me/33525680250?text=test-a7k2m9p3');
  });
  it('aucun numéro connecté -> pas de lien fabriqué', () => {
    expect(waMeTestLink(null, 'test-a7k2m9p3')).toBeNull();
    expect(waMeTestLink('', 'test-a7k2m9p3')).toBeNull();
  });
});

describe('processTestTokens', () => {
  // Jeton FICTIF (aucun secret) : valeur figée pour rendre les assertions lisibles.
  const MOT_TEST = 'test-a7k2m9p3';
  function deps(over: Partial<Parameters<typeof processTestTokens>[1]> = {}) {
    const trace = { marked: [] as string[], ended: [] as string[], started: [] as string[] };
    return {
      trace,
      deps: {
        phoneNumberTenant: async () => 't1',
        findByTestToken: async (tok: string) => (tok === MOT_TEST ? { workflowId: 'wf1', tenantId: 't1' } : null),
        mayStart: async () => true,
        markConversationTest: async (_t: string, waId: string) => { trace.marked.push(waId); },
        endWaitingRun: async (_t: string, waId: string) => { trace.ended.push(waId); },
        startTestRun: async (_t: string, wf: string) => { trace.started.push(wf); return true; },
        ...over,
      },
    };
  }

  it('jeton reconnu -> fil marqué test, parcours en cours clos, scénario démarré, message CONSOMMÉ', async () => {
    const { deps: d, trace } = deps();
    const consumed = await processTestTokens(payload(MOT_TEST), d);
    expect(trace).toEqual({ marked: ['33611'], ended: ['33611'], started: ['wf1'] });
    expect(consumed.has(`wamid.${MOT_TEST}`)).toBe(true);
  });

  it('message ordinaire -> rien, et AUCUNE requête de résolution (filtre du chemin chaud)', async () => {
    let lookups = 0;
    const { deps: d, trace } = deps({ findByTestToken: async () => { lookups += 1; return null; } });
    const consumed = await processTestTokens(payload('bonjour, je voudrais un devis'), d);
    expect(lookups).toBe(0);
    expect(trace.started).toEqual([]);
    expect(consumed.size).toBe(0);
  });

  it('jeton d’un AUTRE client -> aucun déclenchement (le numéro fait autorité sur le tenant)', async () => {
    const { deps: d, trace } = deps({ findByTestToken: async () => ({ workflowId: 'wf-autre', tenantId: 'AUTRE-TENANT' }) });
    const consumed = await processTestTokens(payload(MOT_TEST), d);
    expect(trace.started).toEqual([]);
    expect(consumed.size).toBe(0);
  });

  it('jeton inconnu (scénario supprimé) -> rien, pas de throw', async () => {
    const { deps: d, trace } = deps({ findByTestToken: async () => null });
    await expect(processTestTokens(payload(MOT_TEST), d)).resolves.toBeInstanceOf(Set);
    expect(trace.started).toEqual([]);
  });

  it('message STANDBY (le MBA tient le fil) -> aucun déclenchement', async () => {
    const { deps: d, trace } = deps();
    const consumed = await processTestTokens(payload(MOT_TEST, 'standby'), d);
    expect(trace.started).toEqual([]);
    expect(consumed.size).toBe(0);
  });

  it('numéro inconnu (aucun tenant) -> aucun déclenchement', async () => {
    const { deps: d, trace } = deps({ phoneNumberTenant: async () => null });
    await processTestTokens(payload(MOT_TEST), d);
    expect(trace.started).toEqual([]);
  });

  it('le message reste CONSOMMÉ même si le démarrage échoue (ce n’est pas une réponse du contact)', async () => {
    const { deps: d } = deps({ startTestRun: async () => false });
    const consumed = await processTestTokens(payload(MOT_TEST), d);
    expect(consumed.has(`wamid.${MOT_TEST}`)).toBe(true);
  });

  it('une erreur sur un jeton n’empêche pas les autres messages du webhook', async () => {
    const { deps: d, trace } = deps({ markConversationTest: async () => { throw new Error('base indisponible'); } });
    await expect(processTestTokens(payload(MOT_TEST), d)).resolves.toBeInstanceOf(Set);
    expect(trace.started).toEqual([]);
  });

  // --- Corrections issues de la revue du Lot F ---

  it('le message est CONSOMMÉ même si une écriture LÈVE (sinon il retomberait dans l’avance et les automations)', async () => {
    const { deps: d } = deps({ markConversationTest: async () => { throw new Error('base indisponible'); } });
    const consumed = await processTestTokens(payload(MOT_TEST), d);
    expect(consumed.has(`wamid.${MOT_TEST}`)).toBe(true);
  });

  describe('fil tenu par un humain ou par MBA', () => {
    it('ne détruit RIEN : ni marquage, ni clôture du parcours en cours, ni démarrage', async () => {
      // Le trou attrapé en revue : les deux écritures passaient AVANT la garde de contrôle (qui vit dans
      // l'exécuteur), donc un test sur un fil repris par un opérateur clôturait son parcours pour rien.
      const { deps: d, trace } = deps({ mayStart: async () => false });
      const consumed = await processTestTokens(payload(MOT_TEST), d);
      expect(trace).toEqual({ marked: [], ended: [], started: [] });
      expect(consumed.has(`wamid.${MOT_TEST}`)).toBe(true); // le message reste un jeton, pas une réponse
    });
  });

  describe('rejeu du webhook (at-least-once)', () => {
    it('message DÉJÀ traité -> aucune relance (pas de double envoi facturé), mais toujours consommé', async () => {
      const { deps: d, trace } = deps();
      const seen = new Set([`wamid.${MOT_TEST}`]);
      const consumed = await processTestTokens(payload(MOT_TEST), d, seen);
      expect(trace).toEqual({ marked: [], ended: [], started: [] });
      expect(consumed.has(`wamid.${MOT_TEST}`)).toBe(true);
    });

    it('message NEUF -> traité normalement', async () => {
      const { deps: d, trace } = deps();
      await processTestTokens(payload(MOT_TEST), d, new Set(['wamid.autre']));
      expect(trace.started).toEqual(['wf1']);
    });
  });
});
