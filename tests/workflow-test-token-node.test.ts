import { describe, it, expect, vi } from 'vitest';
import { blocDesigne, lireJetonDeTest } from '../src/workflow/test-token';
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
    expect(accepte('test-abc12345.')).toBe(false); // un point suivi de rien ne DÉSIGNE rien
    expect(accepte('test-abc12345 ' + NODE)).toBe(false); // sans point, le tout doit être un jeton

    // ⚠️ DEUX CAS ONT CHANGÉ DE RÈGLE LE 2026-09-16, et le changement est le correctif d'un rouge de la
    // revue finale. « Deux suffixes » et « au-delà de 64 caractères » étaient REFUSÉS, sur une classe
    // supposée pour l'identifiant de bloc. Or `parseGraph` n'en impose aucune : un identifiant hors classe
    // faisait rendre `null`, donc le message n'était pas CONSOMMÉ et descendait jusqu'à l'agent de Meta.
    // Ils sont désormais LUS, et c'est `runFrom` qui refuse un bloc introuvable, avec sa raison et sa trace.
    expect(accepte(`test-abc12345.${NODE}.${NODE}`)).toBe(true);
    expect(accepte(`test-abc12345.${'a'.repeat(300)}`)).toBe(true);
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

  it('🔴 le JETON se met en minuscules, le SUFFIXE garde sa casse', () => {
    // Le texte entier était mis en minuscules. Un identifiant de bloc portant une majuscule passait donc le
    // filtre puis échouait à l'égalité : un refus pour une raison parfaitement invisible. Seul le jeton a une
    // forme connue, et c'est sur la PREMIÈRE lettre du message qu'un clavier de téléphone met une majuscule
    // tout seul. Les espaces, eux, restent retirés des deux côtés.
    expect(lireJetonDeTest(`  TEST-ABC12345.${NODE} `))
      .toEqual({ jeton: 'test-abc12345', nodeId: NODE });
    expect(lireJetonDeTest('test-abc12345.Bloc-Majuscule'))
      .toEqual({ jeton: 'test-abc12345', nodeId: 'Bloc-Majuscule' });
  });

  it('⚠️ l’identifiant de repli du constructeur passe aussi', () => {
    // `uid()` (`web/components/WorkflowBuilder.tsx`) retombe sur `id-<base36>-<horodatage>` quand
    // `crypto.randomUUID` n'existe pas (contexte non sécurisé). ⚠️ L'inventaire complet des formes qui
    // doivent voyager vit dans `tests/web-jeton-test-parite.test.ts`, qui lit le navigateur ET le serveur.
    expect(lireJetonDeTest('test-abc12345.id-k3f9x2p-1758012345678'))
      .toEqual({ jeton: 'test-abc12345', nodeId: 'id-k3f9x2p-1758012345678' });
  });
});

describe('blocDesigne : le bloc que le suffixe désigne', () => {
  const g = (...ids: string[]) => ({ nodes: ids.map((id) => ({ id })) });

  it('🔴 l’identifiant EXACT gagne toujours', () => {
    expect(blocDesigne(g('Bloc-A', 'bloc-a'), 'Bloc-A')).toBe('Bloc-A');
  });

  it('🔴 un testeur qui recopie son mot en CAPITALES retrouve son bloc', () => {
    // Le cas mesuré par la seconde passe de revue : préserver la casse du suffixe réparait l'identifiant à
    // majuscule (inatteignable depuis l'écran) et cassait celui-là, qui est le courant.
    expect(blocDesigne(g(NODE), NODE.toUpperCase())).toBe(NODE);
  });

  it('🔴 un identifiant de bloc À MAJUSCULE se retrouve aussi', () => {
    // Inatteignable depuis le constructeur, atteignable par l'API : `parseGraph` n'impose rien à `node.id`.
    expect(blocDesigne(g('Bloc-Majuscule'), 'bloc-majuscule')).toBe('Bloc-Majuscule');
  });

  it('⚠️ DEUX blocs qui ne diffèrent que par la casse : on n’en choisit aucun', () => {
    // Deviner enverrait au testeur une séquence qu'il n'a pas demandée. Le suffixe ressort tel quel, et
    // `runFrom` rend son refus lisible.
    expect(blocDesigne(g('Bloc-A', 'bloc-a'), 'BLOC-A')).toBe('BLOC-A');
  });

  it('⚠️ un bloc introuvable ressort tel quel : le refus appartient à l’exécuteur', () => {
    expect(blocDesigne(g('autre'), 'disparu')).toBe('disparu');
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
