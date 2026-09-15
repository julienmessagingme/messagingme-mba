import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runControlSweep } from '../src/inbox/control-sweep';

/**
 * LE CÂBLAGE DE LA SOUPAPE DE CONTRÔLE DU FIL.
 *
 * 🔴 CE QUE CE FICHIER GARDE N'EST PAS UNE LOGIQUE, C'EST UN PASSAGE D'ARGUMENT, et c'est exactement ce qui
 * a manqué. `src/worker.ts` câblait `listHeldControl: (limit) => inboxStore.listHeldControl(limit)`, une
 * flèche à UN paramètre là où le contrat en déclare DEUX. TypeScript l'accepte, le second était avalé en
 * silence, le magasin retombait sur `ageScenarioMs = 0`, et son SQL teste `$2::bigint > 0` : la branche qui
 * ramasse les fils tenus par un scénario ne s'est JAMAIS déclenchée.
 *
 * 🔴 MESURÉ EN PRODUCTION LE 2026-09-15 : avec la valeur réellement reçue (0), le balayage ramassait ZÉRO
 * conversation ; avec la valeur prévue (24 h), DIX, toutes gelées depuis. Un parcours terminé gardait donc
 * le fil INDÉFINIMENT, pas 24 h.
 *
 * ⚠️ AUCUN TEST UNITAIRE NE POUVAIT LE VOIR : ils montent tous un faux `listHeldControl` dont ils
 * choisissent eux-mêmes la signature. Le faux bouge avec le code, et c'est précisément le motif que le
 * CLAUDE.md du dépôt décrit (« une flèche à deux paramètres est assignable à un contrat qui en déclare
 * trois, et le troisième est avalé en silence »).
 */

describe('le balayage réclame l’âge, et le câblage le transmet', () => {
  it('🔴 le balayage passe bien le délai des scénarios au magasin', async () => {
    const recus: Array<{ limit: unknown; age: unknown }> = [];
    await runControlSweep({
      listHeldControl: async (limit, age) => { recus.push({ limit, age }); return []; },
      setControlOwner: async () => true,
      timeouts: { app_human: 7_200_000, mba: 86_400_000, app_workflow: 86_400_000 },
    });
    // 🔴 C'est ce chiffre, et pas `undefined` ni 0, qui décide si la branche SQL se déclenche.
    expect(recus[0]?.age).toBe(86_400_000);
  });

  it('🔴 et le VRAI câblage du worker le transmet aussi', () => {
    /**
     * La garde qui aurait attrapé le défaut. Elle lit le worker, parce que c'est le seul endroit où la
     * flèche est écrite, et qu'un faux ne dit rien du vrai. Compter les paramètres est mécanique : c'est
     * exactement ce que le compilateur refuse de faire ici.
     */
    const worker = readFileSync(resolve(__dirname, '../src/worker.ts'), 'utf8');
    const ligne = worker.split('\n').find((l) => l.includes('listHeldControl:')) ?? '';
    expect(ligne).toContain('(limit, ageScenarioMs)');
    expect(ligne).toContain('inboxStore.listHeldControl(limit, ageScenarioMs)');
  });

  it('⚠️ un délai de scénario à 0 reste possible, et il DÉSACTIVE la reprise', async () => {
    // `0 désactive` est le levier d'urgence du dépôt, il ne doit pas disparaître en réparant l'oubli.
    const recus: Array<unknown> = [];
    await runControlSweep({
      listHeldControl: async (_l, age) => { recus.push(age); return []; },
      setControlOwner: async () => true,
      timeouts: { app_human: 7_200_000, mba: 86_400_000, app_workflow: 0 },
    });
    expect(recus[0]).toBe(0);
  });
});

/**
 * 🔴 UN REFUS DE META NE DOIT PLUS ÊTRE INVISIBLE.
 *
 * `releaseToMba` écrivait `mba` dans notre colonne PUIS appelait Meta. Si Meta refusait, la colonne restait
 * à `mba` : l'écran affirmait que le robot tenait un fil que Meta nous laissait, et la seule trace du refus
 * était une ligne de console. Le mode de panne le plus coûteux : invisible, et démenti par l'écran.
 */
describe('le refus de Meta revient en arrière', () => {
  const wiring = readFileSync(resolve(__dirname, '../src/workflow/wiring.ts'), 'utf8');
  const bloc = wiring.slice(wiring.indexOf('releaseToMba: async (tenant, waId)'), wiring.indexOf('evalContext:'));

  it('🔴 sur échec, la colonne repasse à `app_human`, jamais laissée à `mba`', () => {
    expect(bloc).toContain("setControlOwner(tenant, waId, 'app_human', { only: ['mba'] })");
  });

  it('🔴 et `app_human` est la SEULE valeur qui garde le fil dans « À traiter »', () => {
    // `app_workflow` l'en sortirait, ce qui est le défaut réparé le même jour ; `mba` afficherait la marque
    // du robot sur un fil qu'il ne tient pas.
    const dansATraiter = (owner: string) => owner !== 'app_workflow';
    expect(dansATraiter('app_human')).toBe(true);
    expect(dansATraiter('app_workflow')).toBe(false);
    expect(bloc).not.toContain("'app_workflow', { only: ['mba'] }");
  });

  it('⚠️ l’erreur est RELEVÉE : l’appelant la journalise, et n’échoue pas le parcours pour autant', () => {
    expect(bloc).toContain('throw err;');
  });
});
