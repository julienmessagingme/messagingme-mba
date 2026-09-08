import { describe, it, expect } from 'vitest';
import {
  walk, waitMode, waitDurationMs, waitEstimationMs, waitResumeInMs, waitBeforeSessionMessage,
  WAIT_MAX_MS, FENETRE_SERVICE_MS,
} from '../src/workflow/engine';
import type { EvalContext, BusinessHours } from '../src/workflow/conditions';
import type { WorkflowGraph, WorkflowNode } from '../src/workflow/graph';

/**
 * Les deux modes DATÉS du bloc Attente (demande de Julien du 2026-09-08) : « à une date précise » et
 * « aux prochaines heures ouvrées ».
 *
 * 🔴 CE QUE CES CAS PROTÈGENT. Un envoi programmé au mauvais moment n'échoue pas, il PART. Les deux façons
 * de se tromper sont opposées et coûtent chacune quelque chose : rendre 0 fait envoyer à 1 h du matin ce
 * qu'on voulait retenir, et l'analyse de montage qui croirait ces attentes courtes laisserait publier un
 * message rapide derrière une attente longue, message qui ne partirait jamais.
 */

const PARIS = 'Europe/Paris';
const jour = (open: string, close: string) => ({ closed: false, open, close });
const FERME = { closed: true, open: '', close: '' };
const BH: BusinessHours = {
  '0': FERME, '6': FERME,
  '1': jour('09:00', '18:00'), '2': jour('09:00', '18:00'), '3': jour('09:00', '18:00'),
  '4': jour('09:00', '18:00'), '5': jour('09:00', '18:00'),
};

const nd = (id: string, type: string, data: Record<string, unknown> = {}): WorkflowNode =>
  ({ id, type: type as WorkflowNode['type'], position: { x: 0, y: 0 }, data });
const ed = (source: string, target: string) => ({ id: `${source}-${target}`, source, target });
const g = (nodes: WorkflowNode[], edges: WorkflowGraph['edges'] = []): WorkflowGraph => ({ nodes, edges });

/** Par défaut : mardi 8 septembre 2026, 1 h du matin à Paris. Le cas exact décrit par Julien. */
const ctx = (over: Partial<EvalContext> = {}): EvalContext => ({
  fields: {}, tags: [], optIn: 'unknown', name: null, phone: null, bsuid: null,
  now: new Date('2026-09-07T23:00:00Z'), timeZone: PARIS, businessHours: BH, ...over,
});

describe('waitMode : lecture défensive du mode', () => {
  it('absent -> délai : un bloc enregistré avant le 2026-09-08 ne change pas de comportement', () => {
    expect(waitMode(nd('w', 'wait', { delay: 2, unit: 'hours' }))).toBe('delai');
  });

  it('inconnu -> délai, jamais une erreur : `data` est du JSON libre venu du client', () => {
    expect(waitMode(nd('w', 'wait', { waitMode: 'quand_il_pleut' }))).toBe('delai');
    expect(waitMode(nd('w', 'wait', { waitMode: 42 }))).toBe('delai');
  });

  it('les deux modes neufs sont reconnus', () => {
    expect(waitMode(nd('w', 'wait', { waitMode: 'date' }))).toBe('date');
    expect(waitMode(nd('w', 'wait', { waitMode: 'heures_ouvrees' }))).toBe('heures_ouvrees');
  });
});

describe('waitDurationMs : un mode daté n’a PAS de durée', () => {
  it('🔴 le `delay` resté dans data est IGNORÉ après un changement de mode', () => {
    // Le client règle « 5 minutes », puis bascule sur « heures ouvrées » : `delay` reste en base. Rendre 5 min
    // ici annoncerait une durée que le bloc ne tiendra pas, et l'analyse de montage la croirait.
    const n = nd('w', 'wait', { delay: 5, unit: 'minutes', waitMode: 'heures_ouvrees' });
    expect(waitDurationMs(n)).toBe(0);
    expect(waitDurationMs(nd('w', 'wait', { delay: 5, unit: 'minutes', waitMode: 'date' }))).toBe(0);
  });

  it('le mode délai est inchangé, au caractère près', () => {
    expect(waitDurationMs(nd('w', 'wait', { delay: 5, unit: 'minutes', waitMode: 'delai' }))).toBe(5 * 60_000);
  });
});

describe('waitEstimationMs : ce que l’ANALYSE DE GRAPHE prête à l’attente', () => {
  it('🔴 un mode daté compte pour la FENÊTRE ENTIÈRE, pas pour zéro', () => {
    // Le défaut à ne pas laisser passer : à 0, l'analyse croirait la fenêtre encore ouverte derrière.
    expect(waitEstimationMs(nd('w', 'wait', { waitMode: 'heures_ouvrees' }))).toBe(FENETRE_SERVICE_MS);
    expect(waitEstimationMs(nd('w', 'wait', { waitMode: 'date', waitDate: '2026-09-08T09:00' }))).toBe(FENETRE_SERVICE_MS);
  });

  it('un délai reste estimé à sa durée réelle', () => {
    expect(waitEstimationMs(nd('w', 'wait', { delay: 2, unit: 'hours' }))).toBe(2 * 3_600_000);
    expect(waitEstimationMs(nd('w', 'wait', {}))).toBe(0); // non configuré : passe-plat des deux côtés
  });

  it('🔴 le builder REFUSE « attente datée puis message rapide », comme derrière une attente de 24 h', () => {
    // C'est la conséquence visible du choix ci-dessus, et la seule qui protège vraiment le client : sans elle,
    // ce montage serait publiable et son message ne partirait jamais.
    const graph = g(
      [nd('e', 'template', { templateName: 'promo' }), nd('w', 'wait', { waitMode: 'heures_ouvrees' }), nd('q', 'quick_message', { body: 'salut' })],
      [ed('e', 'w'), ed('w', 'q')],
    );
    expect(waitBeforeSessionMessage(graph)).toEqual({ waitNodeId: 'w', messageNodeId: 'q' });
  });
});

describe('waitResumeInMs, mode « heures ouvrées »', () => {
  it('🔴 il est 1 h du matin -> on repart à 9 h, le cas exact demandé', () => {
    const ms = waitResumeInMs(nd('w', 'wait', { waitMode: 'heures_ouvrees' }), ctx());
    expect(ms).toBe(8 * 3_600_000); // 01:00 -> 09:00
  });

  it('déjà dans les heures ouvertes -> 0, rien à attendre', () => {
    const mardi14h = new Date('2026-09-08T12:00:00Z');
    expect(waitResumeInMs(nd('w', 'wait', { waitMode: 'heures_ouvrees' }), ctx({ now: mardi14h }))).toBe(0);
  });

  it('vendredi soir -> lundi matin : les jours fermés sont sautés', () => {
    const vendredi22h = new Date('2026-09-11T20:00:00Z');
    const ms = waitResumeInMs(nd('w', 'wait', { waitMode: 'heures_ouvrees' }), ctx({ now: vendredi22h }));
    expect(new Date(vendredi22h.getTime() + ms).toISOString()).toBe('2026-09-14T07:00:00.000Z'); // lundi 9 h à Paris
  });

  it('🔴 semaine ENTIÈREMENT fermée -> 0 (passe-plat), jamais un parcours figé pour toujours', () => {
    const tousFermes: BusinessHours = Object.fromEntries(['0', '1', '2', '3', '4', '5', '6'].map((d) => [d, FERME]));
    expect(waitResumeInMs(nd('w', 'wait', { waitMode: 'heures_ouvrees' }), ctx({ businessHours: tousFermes }))).toBe(0);
  });

  it('le fuseau de l’espace est respecté, pas le nôtre', () => {
    // 1 h du matin à New York : on repart à 9 h à New York, soit 8 h plus tard, pas à 9 h à Paris.
    const ny = new Date('2026-09-08T05:00:00Z');
    expect(waitResumeInMs(nd('w', 'wait', { waitMode: 'heures_ouvrees' }), ctx({ now: ny, timeZone: 'America/New_York' }))).toBe(8 * 3_600_000);
  });
});

describe('waitResumeInMs, mode « date précise »', () => {
  it('🔴 la date est une heure MURALE du fuseau de l’espace, pas de l’UTC', () => {
    // 9 h le 8 septembre à Paris (été, UTC+2) = 07:00 UTC. Depuis 23:00 UTC la veille : 8 h.
    const ms = waitResumeInMs(nd('w', 'wait', { waitMode: 'date', waitDate: '2026-09-08T09:00' }), ctx());
    expect(ms).toBe(8 * 3_600_000);
  });

  it('une date NUE vaut minuit local', () => {
    const ms = waitResumeInMs(nd('w', 'wait', { waitMode: 'date', waitDate: '2026-09-09' }), ctx());
    expect(new Date(ctx().now.getTime() + ms).toISOString()).toBe('2026-09-08T22:00:00.000Z'); // minuit le 9 à Paris
  });

  it('🔴 une date DÉJÀ PASSÉE ne retient personne (0), elle ne pose pas une attente négative', () => {
    expect(waitResumeInMs(nd('w', 'wait', { waitMode: 'date', waitDate: '2020-01-01T09:00' }), ctx())).toBe(0);
  });

  it('date absente ou illisible -> 0 : un bloc non configuré est un passe-plat', () => {
    for (const waitDate of [undefined, '', '   ', 'la semaine prochaine']) {
      expect(waitResumeInMs(nd('w', 'wait', { waitMode: 'date', waitDate }), ctx())).toBe(0);
    }
  });

  it('bornée à 30 jours : une date en 2099 ne pose pas une échéance dans 70 ans', () => {
    expect(waitResumeInMs(nd('w', 'wait', { waitMode: 'date', waitDate: '2099-01-01T09:00' }), ctx())).toBe(WAIT_MAX_MS);
  });
});

describe('waitResumeInMs sans contexte', () => {
  it('un délai n’a besoin de rien : il se calcule sans contexte', () => {
    expect(waitResumeInMs(nd('w', 'wait', { delay: 2, unit: 'hours' }))).toBe(2 * 3_600_000);
  });

  it('🔴 un mode daté SANS contexte -> passe-plat, et c’est pourquoi `buildCtx` doit le réclamer', () => {
    // Documenté plutôt que subi : sans l'instant courant ni le fuseau, il n'y a rien à calculer, et figer le
    // parcours pour toujours serait pire. La vraie garde est côté exécuteur (`buildCtx` construit le contexte
    // dès qu'un bloc daté est dans le graphe), tenue par `tests/workflow-executor-attente.test.ts`.
    expect(waitResumeInMs(nd('w', 'wait', { waitMode: 'heures_ouvrees' }))).toBe(0);
    expect(waitResumeInMs(nd('w', 'wait', { waitMode: 'date', waitDate: '2026-09-08T09:00' }))).toBe(0);
  });
});

describe('walk : le parcours dort réellement jusqu’à l’échéance calculée', () => {
  it('🔴 les actions d’avant partent, et le run dort 8 h (1 h -> 9 h)', () => {
    const graph = g(
      [nd('t', 'tag', { tag: 'vip' }), nd('w', 'wait', { waitMode: 'heures_ouvrees' }), nd('tpl', 'template', { templateName: 'promo' })],
      [ed('t', 'w'), ed('w', 'tpl')],
    );
    const r = walk(graph, 't', ctx());
    expect(r.actions).toEqual([{ nodeId: 't', action: { kind: 'tag', tag: 'vip' } }]);
    expect(r.rest).toEqual({ status: 'sleeping', nodeId: 'w', resumeInMs: 8 * 3_600_000 });
  });

  it('déjà ouvert -> le bloc est traversé et le template part tout de suite', () => {
    const graph = g(
      [nd('w', 'wait', { waitMode: 'heures_ouvrees' }), nd('tpl', 'template', { templateName: 'promo' })],
      [ed('w', 'tpl')],
    );
    const r = walk(graph, 'w', ctx({ now: new Date('2026-09-08T12:00:00Z') }));
    expect(r.actions.map((a) => a.nodeId)).toEqual(['tpl']);
    expect(r.rest.status).toBe('waiting');
  });
});
