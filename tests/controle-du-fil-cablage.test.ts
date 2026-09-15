import { describe, it, expect } from 'vitest';
import { creerPrendreLeFilAvecUnRejeu, REJEU_ATTENTE_DEFAUT_MS, REJEU_ATTENTE_MAX_MS } from '../src/inbox/controle-du-fil';
import { MetaApiError } from '../src/meta/errors';
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
 * 🔴 LA FIN D'UN PARCOURS NE RELÂCHE PLUS LE FIL DANS LA FOULÉE DE SON DERNIER ENVOI (migration 0149).
 *
 * Mesuré en production le 2026-09-15 : Meta acquitte nos envois avec DEUX MINUTES de retard, et sa
 * documentation dit qu'envoyer un message PREND le fil implicitement. Le release partait donc avant que Meta
 * ne traite l'envoi, et l'envoi reprenait le fil juste derrière. Trois releases émis deux secondes après un
 * envoi ont échoué, celui émis quatorze minutes après a marché.
 */
describe('le fil est rendu sur ACCUSÉ, pas sur horloge', () => {
  const wiring = readFileSync(resolve(__dirname, '../src/workflow/wiring.ts'), 'utf8');
  const bloc = wiring.slice(wiring.indexOf('releaseToMba: async (tenant, waId)'), wiring.indexOf('evalContext:'));

  it('🔴 la fin de parcours MARQUE, elle n’appelle pas Meta', () => {
    expect(bloc).toContain('demanderReleaseMba(tenant, waId)');
    // C'est l'assertion qui porte tout le correctif : plus aucun appel à Meta sur ce chemin.
    expect(bloc).not.toContain('releaseThreadChezMeta');
  });

  it('🔴 l’état d’attente est `app_human`, la SEULE valeur qui garde le fil dans « À traiter »', () => {
    // `app_workflow` l'en sortirait (c'est le défaut réparé la veille), et `mba` afficherait la marque du
    // robot sur un fil que nous tenons encore.
    expect(bloc).toContain("setControlOwner(tenant, waId, 'app_human', { only: ['app_workflow'] })");
    const dansATraiter = (owner: string) => owner !== 'app_workflow';
    expect(dansATraiter('app_human')).toBe(true);
    expect(dansATraiter('app_workflow')).toBe(false);
  });

  it('🔴 rien n’a été envoyé -> on relâche TOUT DE SUITE, sinon le fil attend un accusé qui ne viendra pas', () => {
    const compact = bloc.replace(/\s+/g, ' ');
    expect(compact).toContain('if (attendu) return; await rendreLeFilMaintenant(tenant, waId);');
  });

  it('🔴 la remise écrit `mba` APRÈS l’accord de Meta, jamais avant', () => {
    // L'ordre inverse est celui qui mentait : la colonne restait à `mba` sur un refus, et la seule trace
    // était une ligne de console. Ici l'état d'attente est déjà honnête, donc il n'y a rien à anticiper.
    const geste = wiring.slice(wiring.indexOf('const rendreLeFilMaintenant'), wiring.indexOf('const remiseMbaSurAccuse'));
    expect(geste.indexOf('releaseThreadChezMeta(tenant, waId)')).toBeGreaterThan(-1);
    expect(geste.indexOf('releaseThreadChezMeta(tenant, waId)'))
      .toBeLessThan(geste.indexOf("setControlOwner(tenant, waId, 'mba', { only: ['app_human'] })"));
  });

  it('🔴 les DEUX files qui voient des statuts reçoivent la remise', () => {
    // Une capacité câblée sur un consommateur sur deux est un correctif à moitié : un accusé arrive par
    // `webhook` ou par `webhook-status` selon le lot que Meta nous envoie, et ce découpage ne nous
    // appartient pas.
    const worker = readFileSync(resolve(__dirname, '../src/worker.ts'), 'utf8');
    const lignes = worker.split('\n').filter((l) => l.includes('remiseMba:'));
    expect(lignes).toHaveLength(2);
    expect(lignes.every((l) => l.includes('remiseMbaSurAccuse'))).toBe(true);
  });

  it('⚠️ le BALAYAGE, lui, appelle Meta directement, et c’est correct', () => {
    // Il tourne loin de tout envoi : il n'y a aucune course à éviter, et passer par le marqueur ferait
    // attendre un accusé qui n'arrivera jamais sur une conversation sans envoi récent.
    const worker = readFileSync(resolve(__dirname, '../src/worker.ts'), 'utf8');
    const ligne = worker.split('\n').find((l) => l.includes('releaseToMba:')) ?? '';
    expect(ligne).toContain('releaseThreadChezMeta(tenant, waId)');
  });
});

/**
 * LE REJEU DE PRISE DU FIL, ENFIN EXERÇABLE (lot du 2026-09-15, plan `2026-09-15-rejeu-prise-du-fil.md`).
 *
 * 🔴 CES CAS REMPLACENT UN GREP, et c'est tout l'intérêt du lot. Le rejeu vivait dans une fermeture de
 * `buildWorkflowRuntime` : il n'avait aucune interface, donc personne ne pouvait l'appeler, donc ses quatre
 * règles étaient gardées par `tests/scenario-fil-non-repris.test.ts` qui cherchait les chaînes
 * `err.retryable` et `tentative < 2` dans le TEXTE de `wiring.ts`. Ce grep prouvait qu'un motif était écrit ;
 * il ne prouvait ni qu'on rejoue UNE fois, ni qu'on ne rejoue pas un refus définitif, ni combien on attend.
 */
describe('prendre le fil chez Meta : un rejeu, et jamais deux', () => {
  const rejouable = (retryAfterMs?: number) => new MetaApiError(429, null, retryAfterMs);
  const definitif = () => new MetaApiError(400, null);

  /** Un banc qui compte les appels et les attentes, sans jamais dormir. */
  function banc(resultats: Array<'ok' | Error>) {
    const attentes: number[] = [];
    let appels = 0;
    const prendre = creerPrendreLeFilAvecUnRejeu({
      prendre: async () => {
        const r = resultats[appels] ?? 'ok';
        appels += 1;
        if (r !== 'ok') throw r;
        return true;
      },
      attendre: async (ms) => { attentes.push(ms); },
    });
    return { prendre, attentes, appels: () => appels };
  }

  it('du premier coup : un seul appel, aucune attente', async () => {
    const b = banc(['ok']);
    expect(await b.prendre('t1', '33600000001')).toBe(true);
    expect(b.appels()).toBe(1);
    expect(b.attentes).toEqual([]);
  });

  it('🔴 un refus REJOUABLE est rejoué UNE fois, et le second essai réussit', async () => {
    const b = banc([rejouable(), 'ok']);
    expect(await b.prendre('t1', '33600000001')).toBe(true);
    expect(b.appels()).toBe(2);
    expect(b.attentes).toHaveLength(1);
  });

  it('🔴 deux refus rejouables : on s’arrête à DEUX appels, on ne boucle pas', async () => {
    // Meta réserve `take` au « configured escalation partner » : insister ajouterait N appels inutiles au
    // milieu d'une campagne, un par destinataire.
    const b = banc([rejouable(), rejouable(), 'ok']);
    expect(await b.prendre('t1', '33600000001')).toBe(false);
    expect(b.appels()).toBe(2);
  });

  it('🔴 un refus DÉFINITIF n’est jamais rejoué', async () => {
    const b = banc([definitif(), 'ok']);
    expect(await b.prendre('t1', '33600000001')).toBe(false);
    expect(b.appels(), 'un 400 de Meta a été rejoué').toBe(1);
    expect(b.attentes, 'on a attendu avant de renoncer').toEqual([]);
  });

  it('🔴 l’attente vaut le `Retry-After` de Meta, PLAFONNÉ à 2 s', async () => {
    // Le plafond est la vraie règle : on est dans la boucle d'envoi d'une campagne, et une attente longue ne
    // retarde pas ce destinataire-là, elle retarde tous les suivants.
    expect((await (async () => { const b = banc([rejouable(1200), 'ok']); await b.prendre('t', 'w'); return b.attentes; })())).toEqual([1200]);
    expect((await (async () => { const b = banc([rejouable(30_000), 'ok']); await b.prendre('t', 'w'); return b.attentes; })())).toEqual([REJEU_ATTENTE_MAX_MS]);
  });

  it('⚠️ sans `Retry-After`, on attend le défaut du dépôt', async () => {
    const b = banc([rejouable(), 'ok']);
    await b.prendre('t1', '33600000001');
    expect(b.attentes).toEqual([REJEU_ATTENTE_DEFAUT_MS]);
  });

  it('🔴 AUCUN NUMÉRO CONNECTÉ rend `true`, et ce contrat était implicite', async () => {
    // `prendre` rend `false` quand aucun numéro n'est connecté. La boucle d'origine jetait ce booléen et
    // rendait `true` : le résultat est juste (sans numéro il n'y a aucun agent Meta à qui prendre le fil,
    // donc écrire notre état local est correct) mais il l'était par accident. `true` signifie « Meta n'a pas
    // protesté », ce qui couvre les deux cas. L'appelant garde exactement le comportement qu'il avait.
    const prendre = creerPrendreLeFilAvecUnRejeu({
      prendre: async () => false,
      attendre: async () => { throw new Error('ne doit pas attendre'); },
    });
    expect(await prendre('t1', '33600000001')).toBe(true);
  });

  it('⚠️ il ne LÈVE jamais : l’appelant décide d’écrire ou non son état local', async () => {
    const b = banc([definitif()]);
    await expect(b.prendre('t1', '33600000001')).resolves.toBe(false);
  });
});
