import { describe, it, expect } from 'vitest';
import { ouvertureApi } from '../src/workflow/ouverture-api';
import { scanOpening, entryNode } from '../src/workflow/engine';
import { canalDOuverture } from '../src/workflow/store.pg';
import type { WorkflowEdge, WorkflowGraph, WorkflowNode } from '../src/workflow/graph';

/**
 * CE QU'UN ENVOI PAR L'API FAIT PARTIR EN PREMIER (spec 2026-09-24, § 3, défaut 3).
 *
 * 🔴 CE QUE CE FICHIER PROTÈGE : une cible `node` était jugée sur le TYPE du bloc visé (`exigeFenetre24h`).
 * Une condition, une étiquette ou un champ qui mène à un message rapide ne demandait aucune fenêtre, et le
 * message partait vers des gens qui n'avaient pas écrit (Meta 131047). Ce qui compte est ce qui PART.
 *
 * ⚠️ La parité avec la console est gardée ici : `whatsapp_template` et `rcs` valent le canal de
 * `canalDOuverture`, `whatsapp_session` et `null` y valent « pas de campagne ». Une exception assumée, et
 * tenue par son propre cas : un bloc RCS suivi d'une attente (la console refuse, l'API envoie en `rcs`).
 */
const n = (id: string, type: WorkflowNode['type'], data: Record<string, unknown> = {}): WorkflowNode => ({ id, type, position: { x: 0, y: 0 }, data });
const a = (id: string, source: string, target: string, sourceHandle?: string): WorkflowEdge => ({ id, source, target, ...(sourceHandle ? { sourceHandle } : {}) });
const g = (nodes: WorkflowNode[], edges: WorkflowEdge[] = []): WorkflowGraph => ({ nodes, edges });

const TEMPLATE = n('t', 'template', { templateName: 'promo' });
const RCS = n('r', 'rcs_message', { text: 'Bonjour' });
const MESSAGE_RAPIDE = n('q', 'quick_message', { body: 'On en parle ?' });
const QUESTION = n('qu', 'question', { body: 'Quel créneau ?' });
const FORMULAIRE = n('f', 'flow', { flowId: 'flow-1' });
const AGENT = n('ag', 'agent', { agentId: 'agent-1' });
const SESSIONS = [MESSAGE_RAPIDE, QUESTION, FORMULAIRE, AGENT];

describe('ouvertureApi depuis l’entrée (cible scénario)', () => {
  it('un template nommé ouvre en whatsapp_template, un bloc RCS configuré en rcs', () => {
    expect(ouvertureApi(g([TEMPLATE]))).toEqual({ ouverture: 'whatsapp_template' });
    expect(ouvertureApi(g([RCS]))).toEqual({ ouverture: 'rcs' });
  });

  it('un message de SESSION ouvre en whatsapp_session, quel que soit son bloc', () => {
    for (const b of SESSIONS) expect(ouvertureApi(g([b])), b.type).toEqual({ ouverture: 'whatsapp_session' });
  });

  it('🔴 un scénario jamais publié (graphe publié vide) ne part pas, et la raison le dit', () => {
    const v = ouvertureApi(g([]));
    if (v.ouverture !== null) throw new Error('attendu : aucune ouverture');
    expect(v.raison).toMatch(/publi/);
  });

  it('rien ne part : attente avant tout envoi, deux templates possibles, template sans nom, aucun envoi', () => {
    // La raison part au client dans le message du 422 : chaque cas doit rendre LA SIENNE, pas une autre.
    const cas: Array<[string, WorkflowGraph, RegExp]> = [
      ['attente puis template', g([n('w', 'wait', { seconds: 60 }), TEMPLATE], [a('e', 'w', 't')]), /attente/],
      ['deux templates', g([n('c', 'condition'), n('t1', 'template', { templateName: 'a' }), n('t2', 'template', { templateName: 'b' })], [a('e1', 'c', 't1', 'true'), a('e2', 'c', 't2', 'false')]), /plusieurs templates/],
      ['template sans nom', g([n('t', 'template', { templateName: '  ' })]), /modèle choisi/],
      ['une étiquette seule', g([n('x', 'action', { actionKind: 'add_tag', tag: 'vip' })]), /rien ne part/],
      // Les deux drapeaux à la fois : c'est l'attente qui est nommée, l'ordre des contrôles est tenu ici.
      ['attente puis deux templates', g([n('w', 'wait', { seconds: 60 }), n('c', 'condition'), n('t1', 'template', { templateName: 'a' }), n('t2', 'template', { templateName: 'b' })], [a('e0', 'w', 'c'), a('e1', 'c', 't1', 'true'), a('e2', 'c', 't2', 'false')]), /attente/],
    ];
    for (const [nom, graphe, motif] of cas) {
      const v = ouvertureApi(graphe);
      if (v.ouverture !== null) throw new Error(`${nom} : attendu aucune ouverture`);
      expect(v.raison, nom).toMatch(motif);
    }
  });

  it('🔴 un bloc RCS suivi d’une ATTENTE part en rcs : le RCS est le premier envoi, il part au lancement', () => {
    const W = n('w', 'wait', { seconds: 172800 });
    const rcsAttente = g([RCS, W], [a('e1', 'r', 'w', 'sent')]);
    const rcsAttenteRelance = g([RCS, W, TEMPLATE], [a('e1', 'r', 'w', 'sent'), a('e2', 'w', 't')]);
    expect(ouvertureApi(rcsAttente)).toEqual({ ouverture: 'rcs' });
    expect(ouvertureApi(rcsAttenteRelance)).toEqual({ ouverture: 'rcs' });
    expect(ouvertureApi(rcsAttenteRelance, 'r')).toEqual({ ouverture: 'rcs' });
  });

  it('⚠️ un bloc RCS, une attente, puis un message rapide : whatsapp_session, par prudence', () => {
    const graphe = g([RCS, n('w', 'wait', { seconds: 60 }), MESSAGE_RAPIDE], [a('e1', 'r', 'w', 'sent'), a('e2', 'w', 'q')]);
    expect(ouvertureApi(graphe)).toEqual({ ouverture: 'whatsapp_session' });
  });

  it('une attente AVANT le bloc RCS : refusé, rien ne part au lancement', () => {
    const graphe = g([n('w', 'wait', { seconds: 60 }), RCS], [a('e', 'w', 'r')]);
    const v = ouvertureApi(graphe);
    if (v.ouverture !== null) throw new Error('attendu : aucune ouverture');
    expect(v.raison).toMatch(/attente/);
  });

  it('⚠️ prudence : si UNE branche envoie un message de session, c’est whatsapp_session pour tous', () => {
    const graphe = g([n('c', 'condition'), TEMPLATE, MESSAGE_RAPIDE], [a('e1', 'c', 't', 'true'), a('e2', 'c', 'q', 'false')]);
    expect(ouvertureApi(graphe)).toEqual({ ouverture: 'whatsapp_session' });
  });
});

describe('ouvertureApi depuis un bloc (cible node)', () => {
  it('🔴 défaut 3 : une CONDITION qui mène à un message rapide exige la fenêtre', () => {
    const graphe = g([n('c', 'condition'), MESSAGE_RAPIDE], [a('e', 'c', 'q', 'true')]);
    expect(ouvertureApi(graphe, 'c')).toEqual({ ouverture: 'whatsapp_session' });
  });

  it('🔴 défaut 3 : une ÉTIQUETTE ou un CHAMP qui mène à un message rapide aussi', () => {
    const tag = g([n('x', 'action', { actionKind: 'add_tag', tag: 'vip' }), MESSAGE_RAPIDE], [a('e', 'x', 'q')]);
    const champ = g([n('x', 'action', { actionKind: 'set_field', fieldKey: 'ville', value: 'Lyon' }), MESSAGE_RAPIDE], [a('e', 'x', 'q')]);
    expect(ouvertureApi(tag, 'x')).toEqual({ ouverture: 'whatsapp_session' });
    expect(ouvertureApi(champ, 'x')).toEqual({ ouverture: 'whatsapp_session' });
  });

  it('le DÉPART décide : un template placé après un message de session ouvre en template quand on le vise', () => {
    const graphe = g([MESSAGE_RAPIDE, TEMPLATE], [a('e', 'q', 't')]);
    expect(ouvertureApi(graphe)).toEqual({ ouverture: 'whatsapp_session' });
    expect(ouvertureApi(graphe, 't')).toEqual({ ouverture: 'whatsapp_template' });
  });

  it('les cas de l’ancien jugement par TYPE (exigeFenetre24h) sont conservés', () => {
    for (const b of SESSIONS) expect(ouvertureApi(g([b]), b.id).ouverture, b.type).toBe('whatsapp_session');
    expect(ouvertureApi(g([TEMPLATE]), 't').ouverture).toBe('whatsapp_template');
    expect(ouvertureApi(g([RCS]), 'r').ouverture).toBe('rcs');
    // L'ancien « type null » (bloc qu'on n'a pas su relire) exigeait la fenêtre par prudence ; un bloc
    // introuvable ne part plus du tout, ce qui est plus prudent encore.
    expect(ouvertureApi(g([TEMPLATE]), 'inconnu').ouverture).toBeNull();
  });

  it('⚠️ un bloc « Envoi de mail » seul ne fait partir ni WhatsApp ni RCS : refusé', () => {
    const mail = n('m', 'email', { emailAccountId: 'b1', templateId: 'm1', to: [{ kind: 'literal', value: 'a@exemple.fr' }] });
    expect(ouvertureApi(g([mail]), 'm').ouverture).toBeNull();
  });

  it('un bloc suivi d’une attente avant tout envoi : refusé', () => {
    const graphe = g([n('w', 'wait', { seconds: 60 }), TEMPLATE], [a('e', 'w', 't')]);
    expect(ouvertureApi(graphe, 'w').ouverture).toBeNull();
  });
});

describe('scanOpening : sans point de départ, rien ne change', () => {
  it('partir explicitement de l’entrée rend exactement l’examen d’aujourd’hui', () => {
    const graphes = [
      g([]),
      g([TEMPLATE]),
      g([MESSAGE_RAPIDE, TEMPLATE], [a('e', 'q', 't')]),
      g([RCS, TEMPLATE], [a('e', 'r', 't', 'unreachable')]),
      // L'entrée n'est PAS le premier bloc : un repli sur `graph.nodes[0]` se verrait ici.
      g([TEMPLATE, MESSAGE_RAPIDE], [a('e', 'q', 't')]),
    ];
    for (const graphe of graphes) expect(scanOpening(graphe, entryNode(graphe) ?? undefined)).toEqual(scanOpening(graphe));
  });

  it('sans point de départ, on part de l’ENTRÉE, pas du premier bloc de la liste', () => {
    const graphe = g([TEMPLATE, MESSAGE_RAPIDE], [a('e', 'q', 't')]);
    expect(entryNode(graphe)).toBe('q');
    expect(scanOpening(graphe).sessionOpen).toBe(true);
    expect(ouvertureApi(graphe)).toEqual({ ouverture: 'whatsapp_session' });
  });
});

describe('🔴 parité avec la console (canalDOuverture)', () => {
  it('whatsapp_template vaut whatsapp, rcs vaut rcs, whatsapp_session et aucune ouverture valent null', () => {
    const cas: Array<[string, WorkflowGraph]> = [
      ['template nommé', g([TEMPLATE])],
      ['template sans nom', g([n('t', 'template', { templateName: ' ' })])],
      ['RCS configuré', g([RCS])],
      ['RCS vide', g([n('r', 'rcs_message', { text: ' ' })])],
      ['message rapide', g([MESSAGE_RAPIDE])],
      ['agent', g([AGENT])],
      ['graphe vide', g([])],
      ['attente puis template', g([n('w', 'wait', { seconds: 60 }), TEMPLATE], [a('e', 'w', 't')])],
      ['étiquette puis template', g([n('x', 'action', { actionKind: 'add_tag', tag: 'v' }), TEMPLATE], [a('e', 'x', 't')])],
      ['RCS puis template de repli', g([RCS, TEMPLATE], [a('e', 'r', 't', 'unreachable')])],
      ['deux templates', g([n('c', 'condition'), n('t1', 'template', { templateName: 'a' }), n('t2', 'template', { templateName: 'b' })], [a('e1', 'c', 't1', 'true'), a('e2', 'c', 't2', 'false')])],
      ['condition : template ou message rapide', g([n('c', 'condition'), TEMPLATE, MESSAGE_RAPIDE], [a('e1', 'c', 't', 'true'), a('e2', 'c', 'q', 'false')])],
    ];
    for (const [nom, graphe] of cas) {
      const v = ouvertureApi(graphe).ouverture;
      const attendu = v === 'whatsapp_template' ? 'whatsapp' : v === 'rcs' ? 'rcs' : null;
      expect(canalDOuverture(graphe), nom).toBe(attendu);
    }
  });

  it('⚠️ L’EXCEPTION ASSUMÉE : RCS puis attente, la console refuse, l’API envoie en rcs', () => {
    const graphe = g([RCS, n('w', 'wait', { seconds: 60 }), TEMPLATE], [a('e1', 'r', 'w', 'sent'), a('e2', 'w', 't')]);
    expect(canalDOuverture(graphe)).toBeNull();
    expect(ouvertureApi(graphe)).toEqual({ ouverture: 'rcs' });
  });
});
