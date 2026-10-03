import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newTestToken, lireJetonDeTest, waMeTestLink } from '../src/workflow/test-token';
import { processTestTokens } from '../src/webhooks/test-token';
import { entrantsDe } from './webhook-fixtures';

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
    expect(lireJetonDeTest(t)).toEqual({ jeton: t, nodeId: null });
    // 20 tirages sans doublon : l'aléa est réel (un compteur ou une constante échouerait ici).
    expect(new Set(Array.from({ length: 20 }, () => newTestToken())).size).toBe(20);
  });

  it('tolère la casse et les espaces (clavier de téléphone, copier-coller)', () => {
    expect(lireJetonDeTest('  TEST-A7K2M9P3 ')).toEqual({ jeton: 'test-a7k2m9p3', nodeId: null });
    // ⚠️ CE CAS ÉTAIT PORTÉ PAR `normalizeTestToken`, retirée le 2026-09-16 (elle n'avait plus d'appelant de
    // production, et sa documentation affirmait qu'elle était le filtre du chemin chaud, ce qui était devenu
    // faux). Le cas, lui, est conservé : espaces INTERNES retirés, casse du jeton ramenée en minuscules.
    expect(lireJetonDeTest(' Test-A7K2 M9P3 ')).toEqual({ jeton: 'test-a7k2m9p3', nodeId: null });
  });

  it('refuse tout ce qui n’est pas EXACTEMENT un jeton', () => {
    for (const body of ['bonjour', 'test', 'test-', 'test-court', 'test-a7k2m9p33', 'je teste test-a7k2m9p3', '', null]) {
      expect(lireJetonDeTest(body), String(body)).toBeNull();
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
  it('jeton vide avec numéro valide -> pas de lien fabriqué', () => {
    expect(waMeTestLink('+33 5 25 68 02 50', '')).toBeNull();
  });
});

describe('processTestTokens', () => {
  // Jeton FICTIF (aucun secret) : valeur figée pour rendre les assertions lisibles.
  const MOT_TEST = 'test-a7k2m9p3';
  function deps(over: Partial<Parameters<typeof processTestTokens>[1]> = {}) {
    const trace = { started: [] as string[] };
    return {
      trace,
      deps: {
        findByTestToken: async (tok: string) => (tok === MOT_TEST ? { workflowId: 'wf1', tenantId: 't1' } : null),
        mayStart: async () => true,
        startTestRun: async (_t: string, wf: string) => { trace.started.push(wf); return true; },
        ...over,
      },
    };
  }

  it('jeton reconnu -> scénario démarré, message CONSOMMÉ, et la conversation n’est PAS marquée test', async () => {
    const { deps: d, trace } = deps();
    const consumed = await processTestTokens(await entrantsDe(payload(MOT_TEST)), d);
    // 🔴 CAS CONSERVE, ATTENTE AJUSTEE, deux fois. Ce test verifiait que cette etape fermait elle-meme le parcours
    // en cours (`ended`) : la fermeture est descendue dans `runFrom`. Il verifiait ensuite que le jeton MARQUAIT la
    // conversation (`marked`) : il ne le fait plus depuis le 2026-10-03 (decision de Julien, un essai se comporte
    // comme une vraie conversation), et `TestTokenDeps` n'a plus de quoi marquer, ce qui tient la regle au type.
    expect(trace).toEqual({ started: ['wf1'] });
    expect(consumed.has(`wamid.${MOT_TEST}`)).toBe(true);
  });

  it('message ordinaire -> rien, et AUCUNE requête de résolution (filtre du chemin chaud)', async () => {
    let lookups = 0;
    const { deps: d, trace } = deps({ findByTestToken: async () => { lookups += 1; return null; } });
    const consumed = await processTestTokens(await entrantsDe(payload('bonjour, je voudrais un devis')), d);
    expect(lookups).toBe(0);
    expect(trace.started).toEqual([]);
    expect(consumed.size).toBe(0);
  });

  it('jeton d’un AUTRE client -> aucun déclenchement (le numéro fait autorité sur le tenant)', async () => {
    const { deps: d, trace } = deps({ findByTestToken: async () => ({ workflowId: 'wf-autre', tenantId: 'AUTRE-TENANT' }) });
    const consumed = await processTestTokens(await entrantsDe(payload(MOT_TEST)), d);
    expect(trace.started).toEqual([]);
    expect(consumed.size).toBe(0);
  });

  it('jeton inconnu (scénario supprimé) -> rien, pas de throw', async () => {
    const { deps: d, trace } = deps({ findByTestToken: async () => null });
    await expect(processTestTokens(await entrantsDe(payload(MOT_TEST)), d)).resolves.toBeInstanceOf(Set);
    expect(trace.started).toEqual([]);
  });

  it('🔴 message STANDBY (l’agent de Meta tient le fil) -> le test DÉMARRE et lui reprend le fil', async () => {
    /**
     * 🔴 CE CAS A CHANGÉ DE SENS LE 2026-09-16, SUR DEUX ESSAIS RÉELS, ET LE CAS EST CONSERVÉ.
     *
     * Il affirmait « message STANDBY -> aucun déclenchement », et c'était le défaut : `standby`, c'est Meta qui
     * dit « mon agent tient ce fil », donc EXACTEMENT la situation où le testeur a besoin qu'on la lui reprenne.
     * Julien a scanné deux fois, l'agent a répondu « je n'ai pas bien compris votre message » les deux fois, et
     * le scénario n'a jamais démarré. Sa règle : « quand y a un jeton, le MBA ne marche pas ».
     *
     * ⚠️ CE QUI RESTE VRAI, et que ce test ne doit pas laisser croire disparu : le `standby` reste refusé par
     * l'avance de scénario et par les automations. Seul le JETON le traverse, parce que lui seul est un geste
     * délibéré de quelqu'un qui tient le téléphone.
     */
    const { deps: d, trace } = deps();
    const consumed = await processTestTokens(await entrantsDe(payload(MOT_TEST, 'standby')), d);
    expect(trace.started).toEqual(['wf1']);
    expect(consumed.size).toBe(1); // consommé : il ne doit pas repartir vers l'avance ou les automations
  });

  it('numéro inconnu (aucun tenant) -> aucun déclenchement', async () => {
    const { deps: d, trace } = deps();
    await processTestTokens(await entrantsDe(payload(MOT_TEST), null), d);
    expect(trace.started).toEqual([]);
  });

  it('le message reste CONSOMMÉ même si le démarrage échoue (ce n’est pas une réponse du contact)', async () => {
    const { deps: d } = deps({ startTestRun: async () => false });
    const consumed = await processTestTokens(await entrantsDe(payload(MOT_TEST)), d);
    expect(consumed.has(`wamid.${MOT_TEST}`)).toBe(true);
  });

  // L'écriture qui lève était le marquage, retiré le 2026-10-03 : c'est désormais le démarrage, seule écriture
  // restante après la consommation.
  it('une erreur sur un jeton n’empêche pas les autres messages du webhook', async () => {
    // Deux jetons dans le même webhook : le premier lève, le second doit partir quand même.
    let appels = 0;
    const { deps: d, trace } = deps({
      startTestRun: async (_t: string, wf: string) => {
        appels += 1;
        if (appels === 1) throw new Error('base indisponible');
        trace.started.push(wf);
        return true;
      },
    });
    const deuxJetons = { entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'pn1' }, messages: [
      { id: 'wamid.un', from: '33611', type: 'text', text: { body: MOT_TEST } },
      { id: 'wamid.deux', from: '33622', type: 'text', text: { body: MOT_TEST } },
    ] } }] }] };
    const consumed = await processTestTokens(await entrantsDe(deuxJetons), d);
    expect(trace.started).toEqual(['wf1']);
    expect([...consumed].sort()).toEqual(['wamid.deux', 'wamid.un']);
  });

  // --- Corrections issues de la revue du Lot F ---

  it('le message est CONSOMMÉ même si une écriture LÈVE (sinon il retomberait dans l’avance et les automations)', async () => {
    const { deps: d } = deps({ startTestRun: async () => { throw new Error('base indisponible'); } });
    const consumed = await processTestTokens(await entrantsDe(payload(MOT_TEST)), d);
    expect(consumed.has(`wamid.${MOT_TEST}`)).toBe(true);
  });

  describe('fil tenu par l’agent de Meta ou par un humain', () => {
    /**
     * 🔴 CE CAS A CHANGÉ DE SENS LE 2026-09-16, ET C'EST UNE DÉCISION DE JULIEN, PAS UNE DÉRIVE.
     *
     * Il s'appelait « ne détruit RIEN : ni marquage, ni clôture, ni démarrage », et il gardait une garde
     * `mayStart` qui refusait de démarrer dès que le fil n'appartenait pas au scénario. Julien a scanné son QR
     * le 2026-09-16 : l'agent de Meta tenait le fil, il a répondu « je n'ai pas bien compris votre message »,
     * et le test n'a jamais démarré. Sa règle, mot pour mot : « quand y a un jeton, le MBA ne marche pas. Un
     * opérateur sera pas en train de répondre au mec qui est en train de faire des tests ».
     *
     * Le cas qu'exerçait l'ancien test est donc conservé, RETOURNÉ : le détenteur du fil ne bloque plus rien,
     * et c'est l'exécuteur qui reprend le fil chez Meta (`ignoreHumanControl`, posé par le câblage). Ce que
     * l'ancien test protégeait vraiment, lui, n'a pas bougé : on ne casse aucun état pour un test qui ne
     * partirait pas, puisqu'il part toujours.
     */
    it('🔴 le jeton démarre QUOI QU IL ARRIVE : le détenteur du fil ne le bloque plus', async () => {
      const { deps: d, trace } = deps();
      const consumed = await processTestTokens(await entrantsDe(payload(MOT_TEST)), d);
      expect(trace.started).toEqual(['wf1']);
      expect(consumed.has(`wamid.${MOT_TEST}`)).toBe(true); // le message reste un jeton, pas une réponse
    });
  });

  /**
   * 🔴 PLUS RIEN NE MARQUE UNE CONVERSATION COMME TEST (décision de Julien du 2026-10-03, « ne mets plus jamais un
   * flag test sur ma conversation »). Marquée, elle l'était pour toujours, et l'agent de Meta ne la reprenait plus
   * jamais tout seul, même hors de tout test. Le type de `TestTokenDeps` n'a plus de quoi marquer ; ce cas garde le
   * reste de `src/`, où une écriture de la colonne reviendrait sans qu'aucun type ne bouge.
   */
  it('🔴 aucun code de src/ n’affecte `is_test`', () => {
    // Toute affectation, pas seulement `= true` : la forme la plus probable d'un retour est `set is_test = $3`.
    // Les lectures s'écrivent `is_test` ou `not is_test`, jamais avec `=`. Hors de portée : une liste de colonnes
    // d'`insert`.
    const racine = join(__dirname, '..', 'src');
    const fautifs = (readdirSync(racine, { recursive: true }) as string[])
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => /\bis_test"?\s*=(?!=)/i.test(readFileSync(join(racine, f), 'utf8')));
    expect(fautifs).toEqual([]);
    // Il lit tout `src/` : près de 5 s mesurées sur le poste, la limite par défaut de vitest.
  }, 30_000);

  describe('rejeu du webhook (at-least-once)', () => {
    it('message DÉJÀ traité -> aucune relance (pas de double envoi facturé), mais toujours consommé', async () => {
      const { deps: d, trace } = deps();
      const seen = new Set([`wamid.${MOT_TEST}`]);
      const consumed = await processTestTokens(await entrantsDe(payload(MOT_TEST)), d, seen);
      expect(trace).toEqual({ started: [] });
      expect(consumed.has(`wamid.${MOT_TEST}`)).toBe(true);
    });

    it('message NEUF -> traité normalement', async () => {
      const { deps: d, trace } = deps();
      await processTestTokens(await entrantsDe(payload(MOT_TEST)), d, new Set(['wamid.autre']));
      expect(trace.started).toEqual(['wf1']);
    });
  });
});
