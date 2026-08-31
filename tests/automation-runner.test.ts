import { describe, it, expect } from 'vitest';
import { runAutomations } from '../src/automation/runner';
import type { AutomationRunnerDeps } from '../src/automation/runner';
import type { AutomationRow, AutomationEvent } from '../src/automation/match';
import type { EvalContext } from '../src/workflow/conditions';

/**
 * Orchestration d'un déclenchement (IO injectée).
 *
 * Ce que ces tests protègent :
 *  1. Les trois filtres sont bien composés : déclencheur, puis anti-rebond, puis condition. Sauter l'un d'eux
 *     envoie un message à un client qui ne devait pas le recevoir.
 *  2. Le marquage anti-rebond a lieu AVANT le démarrage. Sinon un scénario qui échoue à mi-chemin se
 *     re-déclenche en boucle sur le message suivant.
 *  3. Une automation qui plante n'empêche pas les autres (le job webhook est partagé).
 *  4. Le contexte contact n'est chargé QUE si une condition l'exige, et une seule fois.
 */

const T = new Date('2026-08-03T12:00:00Z').getTime();

const auto = (over: Partial<AutomationRow> = {}): AutomationRow => ({
  id: 'a1', tenantId: 't1', name: 'A', enabled: true,
  triggerKind: 'keyword', triggerConfig: { keywords: ['rdv'] }, conditionGroup: null,
  workflowId: 'wf1', startNodeId: null, cooldownSeconds: null, ...over,
});
const ctx = (over: Partial<EvalContext> = {}): EvalContext => ({
  fields: {}, tags: [], optIn: 'unknown', name: null, phone: null, bsuid: null,
  now: new Date(T), timeZone: 'Europe/Paris', businessHours: {}, ...over,
});
const MSG: AutomationEvent = { kind: 'message', waId: '33611', body: 'je veux un rdv', isNewContact: false, channel: 'whatsapp' };

interface Trace {
  started: Array<{ workflowId: string; startNodeId: string | null; windowOpen: boolean }>;
  fired: string[]; cleared: string[]; ctxCalls: number;
}

function make(rows: AutomationRow[], over: Partial<AutomationRunnerDeps> = {}): { deps: AutomationRunnerDeps; trace: Trace } {
  const trace: Trace = { started: [], fired: [], cleared: [], ctxCalls: 0 };
  const deps: AutomationRunnerDeps = {
    listEnabled: async () => rows,
    lastFiredAt: async () => null,
    markFired: async (id) => { trace.fired.push(id); return true; },
    clearFired: async (id) => { trace.cleared.push(id); },
    hasWaitingRun: async () => false,
    evalContext: async () => { trace.ctxCalls += 1; return ctx(); },
    startWorkflow: async (_t, workflowId, _w, startNodeId, windowOpen) => { trace.started.push({ workflowId, startNodeId, windowOpen }); return true; },
    defaultCooldownSeconds: 3600,
    now: () => T,
    ...over,
  };
  return { deps, trace };
}

describe('runAutomations', () => {
  it('déclencheur qui correspond -> démarre le scénario et enregistre le tir', async () => {
    const { deps, trace } = make([auto()]);
    expect(await runAutomations('t1', MSG, deps)).toBe(1);
    expect(trace.started).toEqual([{ workflowId: 'wf1', startNodeId: null, windowOpen: true }]);
    expect(trace.fired).toEqual(['a1']);
  });

  it('déclencheur qui ne correspond pas -> rien, et AUCUNE requête d’anti-rebond', async () => {
    let lastFiredCalls = 0;
    const { deps, trace } = make([auto({ triggerConfig: { keywords: ['facture'] } })], {
      lastFiredAt: async () => { lastFiredCalls += 1; return null; },
    });
    expect(await runAutomations('t1', MSG, deps)).toBe(0);
    expect(trace.started).toEqual([]);
    expect(lastFiredCalls).toBe(0); // le filtre pur passe AVANT toute requête
  });

  it('une automation désactivée n’est jamais déclenchée, même si le store la renvoyait', async () => {
    // Ceinture-bretelles : la requête filtre déjà `enabled`, le runner revérifie.
    const { deps, trace } = make([auto({ enabled: false })]);
    expect(await runAutomations('t1', MSG, deps)).toBe(0);
    expect(trace.started).toEqual([]);
  });

  it('contact en anti-rebond -> ne démarre pas, et ne re-marque pas le tir', async () => {
    const { deps, trace } = make([auto()], { lastFiredAt: async () => new Date(T - 60_000) });
    expect(await runAutomations('t1', MSG, deps)).toBe(0);
    expect(trace.started).toEqual([]);
    expect(trace.fired).toEqual([]);
  });

  it('démarre à un BLOC PRÉCIS quand l’automation en cible un', async () => {
    const { deps, trace } = make([auto({ startNodeId: 'n5' })]);
    await runAutomations('t1', MSG, deps);
    expect(trace.started).toEqual([{ workflowId: 'wf1', startNodeId: 'n5', windowOpen: true }]);
  });

  describe('filtre de condition', () => {
    const withTag = auto({ conditionGroup: { match: 'all', clauses: [{ kind: 'tag', op: 'has', tag: 'vip' }] } });

    it('condition NON satisfaite -> pas de démarrage', async () => {
      const { deps, trace } = make([withTag], { evalContext: async () => ctx({ tags: [] }) });
      expect(await runAutomations('t1', MSG, deps)).toBe(0);
      expect(trace.started).toEqual([]);
    });

    it('condition satisfaite -> démarrage', async () => {
      const { deps, trace } = make([withTag], { evalContext: async () => ctx({ tags: ['vip'] }) });
      expect(await runAutomations('t1', MSG, deps)).toBe(1);
      expect(trace.started).toHaveLength(1);
    });

    it('contact introuvable -> on NE déclenche PAS (filtre invérifiable)', async () => {
      const { deps, trace } = make([withTag], { evalContext: async () => null });
      expect(await runAutomations('t1', MSG, deps)).toBe(0);
      expect(trace.started).toEqual([]);
    });

    it('aucune condition -> le contexte contact n’est JAMAIS chargé (pas de requête inutile)', async () => {
      const { deps, trace } = make([auto(), auto({ id: 'a2' })]);
      await runAutomations('t1', MSG, deps);
      expect(trace.ctxCalls).toBe(0);
    });

    it('plusieurs automations avec condition -> contexte chargé UNE seule fois', async () => {
      let calls = 0;
      const { deps } = make([withTag, { ...withTag, id: 'a2' }], {
        evalContext: async () => { calls += 1; return ctx({ tags: ['vip'] }); },
      });
      expect(await runAutomations('t1', MSG, deps)).toBe(2);
      expect(calls).toBe(1); // 2 automations conditionnées, 1 seule requête de contexte
    });
  });

  it('le tir est marqué AVANT le démarrage : un scénario qui échoue ne reboucle pas', async () => {
    const order: string[] = [];
    const { deps } = make([auto()], {
      markFired: async () => { order.push('fired'); return true; },
      startWorkflow: async () => { order.push('started'); throw new Error('scénario cassé'); },
    });
    expect(await runAutomations('t1', MSG, deps)).toBe(0); // l'échec n'est pas compté comme un démarrage
    expect(order).toEqual(['fired', 'started']);
  });

  it('un scénario qui ne démarre pas (false) n’est pas compté', async () => {
    const { deps } = make([auto()], { startWorkflow: async () => false });
    expect(await runAutomations('t1', MSG, deps)).toBe(0);
  });

  it('une automation qui plante n’empêche pas les suivantes', async () => {
    const started: string[] = [];
    const { deps } = make([auto({ id: 'ko' }), auto({ id: 'ok', workflowId: 'wf2' })], {
      lastFiredAt: async (id) => { if (id === 'ko') throw new Error('base indisponible'); return null; },
      startWorkflow: async (_t, wf) => { started.push(wf); return true; },
    });
    expect(await runAutomations('t1', MSG, deps)).toBe(1);
    expect(started).toEqual(['wf2']);
  });

  it('aucune automation active -> aucun travail', async () => {
    const { deps, trace } = make([]);
    expect(await runAutomations('t1', MSG, deps)).toBe(0);
    expect(trace.ctxCalls).toBe(0);
  });

  // --- Corrections issues de la revue du Lot E ---

  describe('fenêtre de service prouvée par l’événement', () => {
    it('déclenché par un MESSAGE -> fenêtre ouverte : le scénario peut ouvrir par un message rapide', async () => {
      // Le contact vient d'écrire, donc la fenêtre 24 h est ouverte : c'est TOUT l'intérêt du déclencheur
      // mot-clé (« rdv » -> message rapide « quel créneau ? »). Sans ce signal, la garde de l'exécuteur
      // refusait ce scénario et RIEN ne partait, en silence.
      const { deps, trace } = make([auto()]);
      await runAutomations('t1', MSG, deps);
      expect(trace.started[0]?.windowOpen).toBe(true);
    });

    it('🔴 déclenché par un message RCS -> fenêtre NON prouvée (le RCS ne passe pas par Meta)', async () => {
      // Un message reçu en RCS ne rouvre aucune fenêtre de service WhatsApp : il n est jamais passé par Meta.
      // Sans ce test, brancher les automations sur le RCS aurait fait ouvrir un scénario par un message rapide
      // chez un contact hors fenêtre, refusé en 131047. C est mot pour mot le défaut corrigé par bf0408d,
      // réintroduit par une autre porte.
      const { deps, trace } = make([auto()]);
      await runAutomations('t1', { ...MSG, channel: 'rcs' }, deps);
      expect(trace.started).toHaveLength(1); // l automation part BIEN : c est le but du branchement
      expect(trace.started[0]?.windowOpen).toBe(false); // mais sans prétendre que Meta est ouvert
    });

    it('déclenché par un TAG (fenêtre non prouvée) -> garde normale conservée', async () => {
      const a = auto({ triggerKind: 'tag_added', triggerConfig: { tag: 'vip' } });
      const { deps, trace } = make([a]);
      await runAutomations('t1', { kind: 'tag_added', waId: '33611', tag: 'vip' }, deps);
      expect(trace.started[0]?.windowOpen).toBe(false);
    });
  });

  describe('un seul parcours actif par contact', () => {
    it('un run est DÉJÀ en attente -> aucun démarrage, et l’anti-rebond n’est pas consommé', async () => {
      // Sinon un message qui répond à un scénario en cours ET contient le mot-clé enverrait DEUX messages,
      // et le premier run deviendrait orphelin (l'avance n'en retrouve qu'un).
      const { deps, trace } = make([auto()], { hasWaitingRun: async () => true });
      expect(await runAutomations('t1', MSG, deps)).toBe(0);
      expect(trace.started).toEqual([]);
      expect(trace.fired).toEqual([]);
    });
  });

  describe('anti-rebond libéré quand rien n’est parti', () => {
    it('scénario NON démarré (false) -> le tir est annulé (la prochaine demande du client passera)', async () => {
      // `false` = les gardes ont refusé AVANT tout envoi (fil tenu par un opérateur, scénario supprimé).
      // Garder le tir ferait taire une vraie demande pendant toute la durée de l'anti-rebond.
      const { deps, trace } = make([auto()], { startWorkflow: async () => false });
      expect(await runAutomations('t1', MSG, deps)).toBe(0);
      expect(trace.fired).toEqual(['a1']);
      expect(trace.cleared).toEqual(['a1']);
    });

    it('scénario NON démarré avec une RAISON (chaîne) -> même traitement que `false`', async () => {
      // Une chaîne est truthy : testée comme une simple vérité, elle passait pour un succès. Le tir restait
      // alors marqué, et l'anti-rebond avalait en silence la prochaine vraie demande du client.
      const { deps, trace } = make([auto()], { startWorkflow: async () => 'la conversation est tenue par un opérateur' });
      expect(await runAutomations('t1', MSG, deps)).toBe(0);
      expect(trace.fired).toEqual(['a1']);
      expect(trace.cleared).toEqual(['a1']);
    });

    it('scénario qui LÈVE une exception -> le tir est CONSERVÉ (un envoi a pu partir)', async () => {
      const { deps, trace } = make([auto()], { startWorkflow: async () => { throw new Error('coupure réseau'); } });
      expect(await runAutomations('t1', MSG, deps)).toBe(0);
      expect(trace.fired).toEqual(['a1']);
      expect(trace.cleared).toEqual([]); // pas d'annulation : on ne sait pas si un message est parti
    });

    it('démarrage réussi -> le tir reste (c’est lui qui protège de la boucle)', async () => {
      const { deps, trace } = make([auto()]);
      await runAutomations('t1', MSG, deps);
      expect(trace.cleared).toEqual([]);
    });
  });
});

describe('plafond par automation (borne le fan-out de masse)', () => {
  // L'anti-rebond est par (automation, CONTACT) : il ne borne RIEN à l'échelle d'une population. Or un seul
  // acte d'exploitation peut produire des milliers d'événements (une campagne directe rouvre l'analyse de tous
  // ses destinataires, qui repartent ensuite en « conversation analysée »). Ce plafond est le seul garde-fou.
  it('plafond atteint -> aucun démarrage, et le tir n’est pas consommé', async () => {
    const { deps, trace } = make([auto()], { firedSince: async () => 200, maxFiresPerHour: 200 });
    expect(await runAutomations('t1', MSG, deps)).toBe(0);
    expect(trace.started).toEqual([]);
    expect(trace.fired).toEqual([]);
  });

  it('sous le plafond -> déclenchement normal', async () => {
    const { deps, trace } = make([auto()], { firedSince: async () => 199, maxFiresPerHour: 200 });
    expect(await runAutomations('t1', MSG, deps)).toBe(1);
    expect(trace.started).toHaveLength(1);
  });

  it('plafond à 0 ou dep absente -> aucun plafond (rétro-compatible)', async () => {
    const zero = make([auto()], { firedSince: async () => 10_000, maxFiresPerHour: 0 });
    expect(await runAutomations('t1', MSG, zero.deps)).toBe(1);
    const absent = make([auto()]); // pas de firedSince du tout
    expect(await runAutomations('t1', MSG, absent.deps)).toBe(1);
  });
});

/**
 * Modération : un contact BLOQUÉ ne déclenche plus aucune automation.
 *
 * Son message reste enregistré et lisible dans l'historique : filtrer à la réception ferait disparaître une
 * résiliation ou une menace juridique sans que personne ne le sache. Ce qui s'arrête, c'est ce qui PART.
 */
describe('runAutomations : contact bloqué', () => {
  it('🔴 bloqué -> aucune automation ne démarre', async () => {
    const { deps, trace } = make([auto()], { contactBloque: async () => true });
    expect(await runAutomations('t1', MSG, deps)).toBe(0);
    expect(trace.started).toEqual([]);
    // Et rien n'est marqué comme déclenché : sinon l'anti-rebond bloquerait le contact après son déblocage.
    expect(trace.fired).toEqual([]);
  });

  it('non bloqué -> l’automation démarre normalement', async () => {
    const { deps, trace } = make([auto()], { contactBloque: async () => false });
    expect(await runAutomations('t1', MSG, deps)).toBe(1);
    expect(trace.started).toHaveLength(1);
  });

  it('la garde est OPTIONNELLE : sans elle, rien ne change', async () => {
    // Une instance dont le store n'expose pas la modération ne doit pas se retrouver à tout bloquer.
    const { deps, trace } = make([auto()]);
    expect(await runAutomations('t1', MSG, deps)).toBe(1);
    expect(trace.started).toHaveLength(1);
  });
});

/**
 * R10 : LE RAPPEL « AVANT DATE » NE PART PLUS DEUX FOIS.
 *
 * 🔴 CE QUE ÇA RÉPARE. La déduplication vivait UNIQUEMENT dans le balayage, qui lit le marqueur d'occurrence
 * avant de publier. Tant que l'événement publié n'était pas consommé, le balayage suivant revoyait le contact
 * comme dû et republiait. Un client avec quinze rendez-vous à la même heure suffit à faire prendre du retard à
 * la file : deux, parfois trois rappels WhatsApp IDENTIQUES, facturés, visibles du client, avec le risque de
 * note de qualité Meta. La garantie descend donc au RUNNER, seul endroit atomique.
 */
describe('runAutomations : le claim d’occurrence (avant_date)', () => {
  const AVANT_DATE: AutomationEvent = { kind: 'avant_date', waId: '33611', valeur: '2026-09-04', automationId: 'a1' };
  const autoDate = () => auto({ triggerKind: 'avant_date', triggerConfig: { fieldKey: 'rdv', delai: '1j' } });

  it('🔴 claim REFUSÉ : le scénario ne démarre pas, et rien n’est envoyé une seconde fois', async () => {
    const { deps, trace } = make([autoDate()], { markFired: async () => false });
    expect(await runAutomations('t1', AVANT_DATE, deps)).toBe(0);
    expect(trace.started).toEqual([]);
    // Et on n'efface RIEN : le marqueur appartient au tour qui a gagné le claim, l'effacer le priverait de sa
    // protection et rouvrirait exactement le doublon qu'on ferme.
    expect(trace.cleared).toEqual([]);
  });

  it('contrôle : claim GAGNÉ -> le scénario démarre normalement', async () => {
    const { deps, trace } = make([autoDate()]);
    expect(await runAutomations('t1', AVANT_DATE, deps)).toBe(1);
    expect(trace.started).toHaveLength(1);
  });

  it('🔴 le marqueur d’occurrence est bien la VALEUR de la date, pas juste « déjà tiré »', async () => {
    // Sans lui, un rendez-vous REPORTÉ ne redonnerait aucun rappel : c'est la même ligne en base.
    const vus: Array<string | undefined> = [];
    const { deps } = make([autoDate()], { markFired: async (_id, _wa, m) => { vus.push(m); return true; } });
    await runAutomations('t1', AVANT_DATE, deps);
    expect(vus).toEqual(['2026-09-04']);
  });

  it('🔴 le RATTRAPAGE du balayage n’est pas cassé : scénario non démarré -> le marqueur est effacé', async () => {
    // C'est le comportement voulu, documenté dans `date-sweep.ts` : un fil momentanément tenu par un opérateur
    // doit pouvoir laisser passer le rappel une minute plus tard. Le claim ne doit pas le condamner.
    const { deps, trace } = make([autoDate()], { startWorkflow: async () => false });
    expect(await runAutomations('t1', AVANT_DATE, deps)).toBe(0);
    expect(trace.fired).toEqual(['a1']);
    expect(trace.cleared).toEqual(['a1']);
  });

  it('🔴 un déclencheur ORDINAIRE n’est pas soumis au claim : il n’a pas de marqueur', async () => {
    // Le rendre conditionnel là aussi casserait l'anti-boucle : `fired_for` y vaut toujours null, et plus
    // aucun déclenchement répété ne passerait.
    const vus: Array<string | undefined> = [];
    const { deps, trace } = make([auto()], { markFired: async (_id, _wa, m) => { vus.push(m); return true; } });
    expect(await runAutomations('t1', MSG, deps)).toBe(1);
    expect(vus).toEqual([undefined]);
    expect(trace.started).toHaveLength(1);
  });
});
