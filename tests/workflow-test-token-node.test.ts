import { describe, it, expect, vi } from 'vitest';
import { lireJetonDeTest } from '../src/workflow/test-token';
import { processTestTokens } from '../src/webhooks/test-token';

/**
 * UN JETON DE TEST QUI DÉSIGNE UN BLOC (2026-09-16).
 *
 * Le jeton d'un scénario gagne un suffixe facultatif : `test-abc12345.<identifiant du bloc>`. Le secret reste
 * celui du scénario, le suffixe n'est qu'un pointeur, et un lien SANS point continue de démarrer à l'entrée.
 *
 * 🔴 CE QUE CES TESTS PROTÈGENT VRAIMENT, c'est le FILTRE DU CHEMIN CHAUD : `lireJetonDeTest` décide si un
 * message entrant coûte une requête en base. L'élargir de travers ferait payer une résolution à chaque message
 * de chaque client, pour rien.
 */

/** Un identifiant de bloc tel que le constructeur en produit : `crypto.randomUUID()`. */
const NODE = '0f7c9a21-4d3e-4b18-9a55-1c2e3f4a5b6c';

describe('un jeton de test qui désigne un bloc', () => {
  it('🔴 le suffixe est LU, et le jeton reste celui du scénario', () => {
    // Le jeton rendu est celui du SCÉNARIO : c'est lui qu'on cherche en base, le suffixe n'y est pas stocké.
    expect(lireJetonDeTest(`test-abc12345.${NODE}`)).toEqual({ jeton: 'test-abc12345', nodeId: NODE });
  });

  it('⚠️ sans suffixe, c’est le jeton d’avant et il démarre à l’entrée', () => {
    // Les liens déjà distribués doivent continuer de marcher : ils n'ont pas de point.
    expect(lireJetonDeTest('test-abc12345')).toEqual({ jeton: 'test-abc12345', nodeId: null });
  });

  it('⚠️ ce qui n’est pas un jeton rend null, pas un objet vide', () => {
    for (const body of ['bonjour', 'test', 'test-', 'test-court', 'je teste test-abc12345', '', null]) {
      expect(lireJetonDeTest(body), String(body)).toBeNull();
    }
  });

  it('🔴 le FILTRE DU CHEMIN CHAUD accepte les deux formes, et rien d’autre', () => {
    const accepte = (body: string): boolean => lireJetonDeTest(body) !== null;
    expect(accepte('test-abc12345')).toBe(true);
    expect(accepte(`test-abc12345.${NODE}`)).toBe(true);
    expect(accepte('bonjour je teste test-abc12345')).toBe(false);
    expect(accepte('test-abc12345.')).toBe(false); // un point suivi de rien
    expect(accepte(`test-abc12345.${NODE}.${NODE}`)).toBe(false); // deux suffixes
    expect(accepte(`test-abc12345.${'a'.repeat(65)}`)).toBe(false); // au-delà de la borne
    expect(accepte('test-abc12345 ' + NODE)).toBe(false); // un espace n'est pas un point
  });

  it('🔴 LE FILTRE N’A PAS ÉTÉ AFFAIBLI : ce qu’il refusait AVANT, il le refuse encore', () => {
    // Élargir le domaine d'une expression régulière est le motif n°1 des régressions muettes de ce dépôt :
    // on ouvre le suffixe, et la partie GAUCHE se relâche sans que personne le voie.
    const accepte = (body: string): boolean => lireJetonDeTest(body) !== null;
    expect(accepte('test-a7k2m9p33')).toBe(false); // neuf caractères, pas huit
    expect(accepte('test-a7k2m9p')).toBe(false); // sept
    expect(accepte('test-a7k2m9pi')).toBe(false); // `i` n'est pas dans l'alphabet Crockford
    expect(accepte(`xtest-abc12345.${NODE}`)).toBe(false); // le préfixe est ancré
  });

  it('⚠️ la normalisation d’avant tient toujours : majuscules et espaces', () => {
    expect(lireJetonDeTest(`  TEST-ABC12345.${NODE.toUpperCase()} `))
      .toEqual({ jeton: 'test-abc12345', nodeId: NODE });
  });

  it('⚠️ l’identifiant de repli du constructeur passe aussi, et c’est mesuré', () => {
    // Les 64 blocs en production portent tous un UUID minuscule (mesuré le 2026-09-16). Mais `uid()`
    // (`web/components/WorkflowBuilder.tsx`) retombe sur `id-<base36>-<horodatage>` quand `crypto.randomUUID`
    // n'existe pas : borner le suffixe à la FORME d'un UUID rendrait ces blocs intestables EN SILENCE, le
    // message partant alors comme un message ordinaire.
    expect(lireJetonDeTest('test-abc12345.id-k3f9x2p-1758012345678'))
      .toEqual({ jeton: 'test-abc12345', nodeId: 'id-k3f9x2p-1758012345678' });
  });
});

/**
 * LE CÂBLAGE DU HANDLER, et c'est la moitié qui compte.
 *
 * Un test qui n'exercerait que `lireJetonDeTest` resterait vert si le handler continuait d'appeler l'ancienne
 * lecture : le suffixe serait lu, puis jeté, et le test démarrerait à l'entrée sans que rien ne le signale.
 */
describe('processTestTokens transmet le bloc', () => {
  const payload = (body: string) => ({
    entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: 'pn1' },
      messages: [{ id: 'wamid.1', from: '33600000001', type: 'text', text: { body } }],
    } }] }],
  });

  function deps(over: Record<string, unknown> = {}) {
    const trace = { cherche: [] as string[], demarres: [] as Array<{ wf: string; nodeId: string | null }> };
    return {
      trace,
      deps: {
        phoneNumberTenant: async () => 't1',
        findByTestToken: async (token: string) => { trace.cherche.push(token); return { workflowId: 'wf1', tenantId: 't1' }; },
        mayStart: async () => true,
        markConversationTest: async () => {},
        startTestRun: async (_t: string, wf: string, _w: string, nodeId: string | null) => {
          trace.demarres.push({ wf, nodeId });
          return true;
        },
        ...over,
      } as Parameters<typeof processTestTokens>[1],
    };
  }

  it('🔴 le scénario est cherché sur le jeton SEUL, et le bloc est transmis au démarrage', async () => {
    // Le suffixe n'est PAS stocké en base : chercher `test-abc12345.<bloc>` ne trouverait jamais rien, et le
    // test ne démarrerait pas du tout.
    const { deps: d, trace } = deps();
    await processTestTokens(payload(`test-abc12345.${NODE}`), d);
    expect(trace.cherche).toEqual(['test-abc12345']);
    expect(trace.demarres).toEqual([{ wf: 'wf1', nodeId: NODE }]);
  });

  it('⚠️ un lien SANS suffixe démarre à l’entrée, comme avant', async () => {
    const { deps: d, trace } = deps();
    await processTestTokens(payload('test-abc12345'), d);
    expect(trace.cherche).toEqual(['test-abc12345']);
    expect(trace.demarres).toEqual([{ wf: 'wf1', nodeId: null }]);
  });

  it('🔴 un démarrage REFUSÉ est journalisé : un chemin qui n’agit pas doit le dire', async () => {
    // Le cas courant du lien PERMANENT : un lien collé il y a trois semaines pointe un bloc supprimé depuis.
    // L'exécuteur refuse et rend la raison ; sans cette trace, elle n'allait nulle part et le testeur voyait
    // seulement un silence, exactement le défaut relevé sur le gel d'avance le 2026-09-14.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { deps: d } = deps({ startTestRun: async () => 'le bloc de départ n’existe plus dans le scénario' });
    const consumed = await processTestTokens(payload(`test-abc12345.${NODE}`), d);
    expect(consumed.has('wamid.1'), 'le message reste CONSOMMÉ : c’est un jeton, il ne doit pas partir au MBA').toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('n’existe plus dans le scénario');
    warn.mockRestore();
  });
});
