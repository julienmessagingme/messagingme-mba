import { describe, it, expect } from 'vitest';
import {
  entryNodeOf, isCampaignEligible, firstTemplateOf, scanOpening, waitBeforeSessionMessage, sessionMessageAfterRcs,
} from '../web/lib/campaign-eligibility';
import { scanOpening as scanServeur, waitBeforeSessionMessage as waitBeforeSessionMessageServeur } from '../src/workflow/engine';
import type { WorkflowGraph } from '../src/workflow/graph';
import type { GraphLike, GraphNodeLike } from '../web/lib/campaign-eligibility';

/**
 * Helper PUR du sélecteur de scénarios côté campagne (web/lib/campaign-eligibility.ts), testé depuis la suite
 * racine par import RELATIF (aucune dépendance React/Next).
 *
 * Ce qu'il protège : depuis le Lot D, un scénario peut démarrer par autre chose qu'un template et reste
 * enregistrable. Le sélecteur de campagne ne doit proposer QUE ce qui partira réellement en broadcast (audience
 * froide -> seul un template peut ouvrir, sinon Meta 131047). Un faux positif ici = une campagne proposée qui
 * échoue au clic (le serveur la refuse en 400) ; un faux négatif = un scénario valide invisible, donc
 * inutilisable depuis l'UI.
 */

const g = (nodes: GraphNodeLike[], edges: GraphLike['edges'] = []): GraphLike => ({ nodes, edges });
const n = (id: string, type: string, data: Record<string, unknown> = {}): GraphNodeLike => ({ id, type, data });

describe('entryNodeOf', () => {
  it('entrée = bloc SANS arête entrante, même s’il n’est pas le premier du tableau', () => {
    // L'ordre du tableau ne fait pas foi : c'est la topologie qui décide (miroir du serveur).
    const graph = g([n('b', 'tag', { tag: 'x' }), n('a', 'template', { templateName: 'promo' })], [{ id: 'e', source: 'a', target: 'b' }]);
    expect(entryNodeOf(graph)?.id).toBe('a');
  });

  it('graphe vide -> null ; cycle (tous les blocs ont une entrée) -> repli sur le 1er', () => {
    expect(entryNodeOf(g([]))).toBeNull();
    const cycle = g([n('a', 'template', { templateName: 'p' }), n('b', 'tag')], [{ id: 'e1', source: 'a', target: 'b' }, { id: 'e2', source: 'b', target: 'a' }]);
    expect(entryNodeOf(cycle)?.id).toBe('a');
  });
});

describe('isCampaignEligible', () => {
  it('entrée template CONFIGURÉE -> éligible', () => {
    expect(isCampaignEligible(g([n('a', 'template', { templateName: 'promo' })]))).toBe(true);
  });

  it('entrée template NON configurée (nom vide ou absent) -> NON éligible (échouerait au lancement)', () => {
    expect(isCampaignEligible(g([n('a', 'template', { templateName: '   ' })]))).toBe(false);
    expect(isCampaignEligible(g([n('a', 'template')]))).toBe(false);
  });

  /**
   * 🔴 LE bug du 2026-08-24. Un scénario qui commence par un bloc RCS n'apparaissait pas dans le selecteur de
   * l'Inbox quand la fenetre WhatsApp etait fermee, c'est-a-dire precisement quand il servait. La fenetre de
   * 24 h est une contrainte de WhatsApp ; le RCS ne passe pas par WhatsApp.
   */
  it('entrée bloc RCS CONFIGURÉ -> éligible, sans aucun template', () => {
    expect(isCampaignEligible(g([n('r', 'rcs_message', { text: 'Bonjour' })]))).toBe(true);
    expect(firstTemplateOf(g([n('r', 'rcs_message', { text: 'Bonjour' })]))).toBeNull();
  });

  it('entrée bloc RCS VIDE -> NON éligible (rien ne partirait)', () => {
    expect(isCampaignEligible(g([n('r', 'rcs_message', { text: '  ' })]))).toBe(false);
    expect(isCampaignEligible(g([n('r', 'rcs_message')]))).toBe(false);
  });

  // La cascade : le RCS ouvre, et « non joignable » mène au template de repli. Le scénario reste éligible ET
  // la campagne retrouve le template dont elle doit mapper les variables.
  it('RCS puis repli WhatsApp -> éligible, et le template de repli reste identifié', () => {
    const cascade = g(
      [n('r', 'rcs_message', { text: 'Bonjour' }), n('t', 'template', { templateName: 'repli' })],
      [{ id: 'e', source: 'r', target: 't', sourceHandle: 'unreachable' }],
    );
    expect(isCampaignEligible(cascade)).toBe(true);
    expect(firstTemplateOf(cascade)?.id).toBe('t');
  });

  it('une ATTENTE avant le bloc RCS -> NON éligible (rien ne part au lancement)', () => {
    const attente = g(
      [n('w', 'wait', { delay: 2, unit: 'hours' }), n('r', 'rcs_message', { text: 'Bonjour' })],
      [{ id: 'e', source: 'w', target: 'r' }],
    );
    expect(isCampaignEligible(attente)).toBe(false);
  });

  it('entrée formulaire / message rapide -> NON éligible (une campagne part hors fenêtre 24 h)', () => {
    expect(isCampaignEligible(g([n('a', 'flow', { flowId: 'fl1' })]))).toBe(false);
    expect(isCampaignEligible(g([n('a', 'quick_message', { body: 'Salut', quickReplies: ['Oui'] })]))).toBe(false);
  });

  it('template pas en entrée mais rien n’envoie avant lui (tag -> template) -> ÉLIGIBLE', () => {
    // RÈGLE CHANGÉE le 2026-08-15, sur décision de Julien. Avant, on exigeait que l'ENTRÉE soit un template et
    // ce cas était refusé : trop strict, un tag n'envoie rien donc l'ouverture reste bien le template. La garde
    // SERVEUR a été alignée dans le même lot (`scanOpening`) et le test de parité plus bas le prouve : ce n'est
    // pas un test affaibli pour faire passer la boucle, c'est la spécification qui a changé des deux côtés.
    const graph = g([n('a', 'tag', { tag: 'vip' }), n('b', 'template', { templateName: 'promo' })], [{ id: 'e', source: 'a', target: 'b' }]);
    expect(isCampaignEligible(graph)).toBe(true);
  });

  it('graphe vide -> NON éligible (rien à envoyer)', () => {
    expect(isCampaignEligible(g([]))).toBe(false);
  });
});

/**
 * Éligibilité élargie (2026-08-15) : ce qui compte est ce qui OUVRE le scénario, pas le type du 1er bloc.
 * Un tag / une action / une condition avant le template n'envoient rien et ne disqualifient donc plus rien.
 */
const TPL = (id: string, nom = 'promo') => n(id, 'template', { templateName: nom, language: 'fr' });
const QM = (id: string) => n(id, 'quick_message', { body: 'Salut', quickReplies: ['Oui', 'Non'] });
const e = (source: string, target: string, sourceHandle?: string) => ({ id: `${source}-${target}`, source, target, ...(sourceHandle ? { sourceHandle } : {}) });

describe('éligibilité : on juge sur ce qui OUVRE, pas sur le bloc d’entrée', () => {
  it('action PUIS template -> éligible (le cas que Julien voulait débloquer)', () => {
    const graph = g([n('a', 'action', { actionKind: 'add_tag', tag: 'vip' }), TPL('t')], [e('a', 't')]);
    expect(isCampaignEligible(graph)).toBe(true);
    expect(firstTemplateOf(graph)?.id).toBe('t');
  });

  it('deux actions puis template -> éligible ; template seul -> toujours éligible (non-régression)', () => {
    expect(isCampaignEligible(g([n('a', 'tag', { tag: 'x' }), n('b', 'action', { actionKind: 'remove_tag', tag: 'y' }), TPL('t')], [e('a', 'b'), e('b', 't')]))).toBe(true);
    expect(isCampaignEligible(g([TPL('t')]))).toBe(true);
  });

  it('ouverture par message rapide -> inéligible, même précédée d’une action', () => {
    expect(isCampaignEligible(g([QM('q')]))).toBe(false);
    expect(isCampaignEligible(g([n('a', 'action', { actionKind: 'add_tag', tag: 'v' }), QM('q')], [e('a', 'q')]))).toBe(false);
  });

  it('message rapide NON configuré -> n’ouvre rien, mais il n’y a pas de template non plus -> inéligible', () => {
    expect(isCampaignEligible(g([n('q', 'quick_message', {}), TPL('t')], [e('q', 't')]))).toBe(false);
  });

  it('condition dont UNE branche ouvre par un message rapide -> inéligible', () => {
    const graph = g([n('c', 'condition', {}), TPL('t'), QM('q')], [e('c', 't', 'true'), e('c', 'q', 'false')]);
    expect(isCampaignEligible(graph)).toBe(false);
  });

  it('condition vers DEUX templates différents -> ambigu, donc inéligible (quel template paramétrer ?)', () => {
    const graph = g([n('c', 'condition', {}), TPL('t1', 'promo_a'), TPL('t2', 'promo_b')], [e('c', 't1', 'true'), e('c', 't2', 'false')]);
    expect(scanOpening(graph).ambiguousTemplate).toBe(true);
    expect(firstTemplateOf(graph)).toBeNull();
    expect(isCampaignEligible(graph)).toBe(false);
  });

  it('condition vers le MÊME template des deux côtés -> pas ambigu, éligible', () => {
    const graph = g([n('c', 'condition', {}), TPL('t1', 'promo'), TPL('t2', 'promo')], [e('c', 't1', 'true'), e('c', 't2', 'false')]);
    expect(isCampaignEligible(graph)).toBe(true);
  });

  it('ATTENTE avant le 1er template -> inéligible (rien ne partirait au lancement)', () => {
    const graph = g([n('w', 'wait', { delay: 2, unit: 'hours' }), TPL('t')], [e('w', 't')]);
    expect(scanOpening(graph).waitBeforeTemplate).toBe(true);
    expect(isCampaignEligible(graph)).toBe(false);
  });

  it('template PUIS attente -> éligible (l’attente est après l’ouverture)', () => {
    expect(isCampaignEligible(g([TPL('t'), n('w', 'wait', { delay: 1, unit: 'days' })], [e('t', 'w')]))).toBe(true);
  });
});

/**
 * Un message de SESSION branche derriere un bloc RCS. Mesure du 2026-08-24 : ce montage ne part QUE si le
 * contact a ecrit sur WHATSAPP dans les 24 h, et repondre a un RCS ne rouvre pas cette fenetre. On le
 * SIGNALE dans le builder au lieu de l'interdire : il reste legitime quand le contact vient d'ecrire.
 */
describe('sessionMessageAfterRcs', () => {
  /**
   * 🔴 Un MESSAGE RAPIDE n'est plus signale depuis le multicanal : il part sur le canal du PARCOURS, donc en
   * RCS derriere un bloc RCS. Un texte avec des reponses en un tap existe des deux cotes.
   */
  it('message rapide juste apres un bloc RCS -> rien a signaler (il partira en RCS)', () => {
    const graph = g(
      [n('r', 'rcs_message', { text: 'Bonjour' }), n('q', 'quick_message', { body: 'Ca vous va ?', quickReplies: ['Oui'] })],
      [{ id: 'e', source: 'r', target: 'q', sourceHandle: 'sent' }],
    );
    expect(sessionMessageAfterRcs(graph)).toBeNull();
  });

  it('formulaire juste apres un bloc RCS -> signale (un Flow n existe pas en RCS)', () => {
    const graph = g(
      [n('r', 'rcs_message', { text: 'Bonjour' }), n('f', 'flow', { flowId: 'fl1' })],
      [{ id: 'e', source: 'r', target: 'f', sourceHandle: 'btn:0' }],
    );
    expect(sessionMessageAfterRcs(graph)?.messageNodeId).toBe('f');
  });

  it('TEMPLATE apres un bloc RCS -> rien a signaler (un template n a pas besoin de la fenetre)', () => {
    const graph = g(
      [n('r', 'rcs_message', { text: 'Bonjour' }), n('t', 'template', { templateName: 'suite' })],
      [{ id: 'e', source: 'r', target: 't', sourceHandle: 'sent' }],
    );
    expect(sessionMessageAfterRcs(graph)).toBeNull();
  });

  it('formulaire NON configure -> rien a signaler (il n envoie rien)', () => {
    const graph = g(
      [n('r', 'rcs_message', { text: 'Bonjour' }), n('f', 'flow', {})],
      [{ id: 'e', source: 'r', target: 'f', sourceHandle: 'sent' }],
    );
    expect(sessionMessageAfterRcs(graph)).toBeNull();
  });

  it('agent configure juste apres un bloc RCS -> signale (sa session est WhatsApp, aucun equivalent RCS)', () => {
    // Meme famille que le formulaire et la question, PAS que le message rapide : le bloc agent tient sa
    // session sur le numero WhatsApp du contact, son premier message part donc forcement par WhatsApp. Un
    // contact qui vient de cliquer un bouton RCS n'y a jamais ecrit : Meta refuse (131047).
    const graph = g(
      [n('r', 'rcs_message', { text: 'Bonjour' }), n('a', 'agent', { agentId: 'ag1' })],
      [{ id: 'e', source: 'r', target: 'a', sourceHandle: 'sent' }],
    );
    expect(sessionMessageAfterRcs(graph)?.messageNodeId).toBe('a');
  });

  it('agent NON configure apres un bloc RCS -> rien a signaler (il n envoie rien, il est traverse)', () => {
    const graph = g(
      [n('r', 'rcs_message', { text: 'Bonjour' }), n('a', 'agent', {})],
      [{ id: 'e', source: 'r', target: 'a', sourceHandle: 'sent' }],
    );
    expect(sessionMessageAfterRcs(graph)).toBeNull();
  });

  it('formulaire LOIN derriere (apres un template) -> rien a signaler', () => {
    const graph = g(
      [n('r', 'rcs_message', { text: 'Bonjour' }), n('t', 'template', { templateName: 'suite' }), n('f', 'flow', { flowId: 'fl1' })],
      [{ id: 'e1', source: 'r', target: 't', sourceHandle: 'sent' }, { id: 'e2', source: 't', target: 'f' }],
    );
    expect(sessionMessageAfterRcs(graph)).toBeNull();
  });
});

describe('parité front / serveur du parcours d’ouverture', () => {
  // Les deux implémentations vivent de part et d'autre d'une frontière de build (Next / API) et ne partagent
  // aucun module. Si elles divergent, le sélecteur propose un scénario que le serveur refuse au clic, ou cache
  // un scénario parfaitement valide. Ce test compare les DEUX sur les mêmes graphes.
  const cas: Array<[string, GraphLike]> = [
    ['template seul', g([TPL('t')])],
    ['action puis template', g([n('a', 'action', { actionKind: 'add_tag', tag: 'v' }), TPL('t')], [e('a', 't')])],
    ['message rapide seul', g([QM('q')])],
    ['action puis message rapide', g([n('a', 'tag', { tag: 'v' }), QM('q')], [e('a', 'q')])],
    ['condition -> template / message rapide', g([n('c', 'condition', {}), TPL('t'), QM('q')], [e('c', 't', 'true'), e('c', 'q', 'false')])],
    ['condition -> deux templates différents', g([n('c', 'condition', {}), TPL('t1', 'a'), TPL('t2', 'b')], [e('c', 't1', 'true'), e('c', 't2', 'false')])],
    ['attente puis template', g([n('w', 'wait', { delay: 3, unit: 'hours' }), TPL('t')], [e('w', 't')])],
    ['template puis attente', g([TPL('t'), n('w', 'wait', {})], [e('t', 'w')])],
    ['graphe vide', g([])],
    ['message rapide non configuré', g([n('q', 'quick_message', {}), TPL('t')], [e('q', 't')])],
    ['inbox seul', g([n('i', 'inbox', {})])],
    // Cas ajoutés après revue : le test ne couvrait ni le FORMULAIRE (qui est pourtant l'objet de l'arbitrage
    // A), ni le repli d'une condition SANS sortie typée, ni un template d'ouverture SANS NOM.
    ['formulaire configuré en ouverture', g([n('f', 'flow', { flowId: 'fl1' })])],
    ['formulaire NON configuré puis template', g([n('f', 'flow', {}), TPL('t')], [e('f', 't')])],
    ['action puis formulaire', g([n('a', 'action', { actionKind: 'add_tag', tag: 'v' }), n('f', 'flow', { flowId: 'fl1' })], [e('a', 'f')])],
    ['condition SANS sortie typée -> repli sur la 1re arête', g([n('c', 'condition', {}), TPL('t')], [e('c', 't')])],
    ['template d ouverture SANS nom', g([n('t', 'template', {})])],
    ['condition -> template nommé / template sans nom', g([n('c', 'condition', {}), TPL('t1', 'promo'), n('t2', 'template', {})], [e('c', 't1', 'true'), e('c', 't2', 'false')])],
    ['deux attentes en cycle', g([n('w1', 'wait', { delay: 1, unit: 'hours' }), n('w2', 'wait', { delay: 1, unit: 'hours' })], [e('w1', 'w2'), e('w2', 'w1')])],
    // Ouverture RCS : le canal n'a pas de fenetre de 24 h, donc un bloc RCS configure ouvre a froid. Les deux
    // cotes doivent le voir pareil, y compris la CASCADE dont le template de repli reste a parametrer.
    ['bloc RCS seul', g([n('r', 'rcs_message', { text: 'Bonjour' })])],
    ['bloc RCS vide', g([n('r', 'rcs_message', { text: '  ' })])],
    ['RCS puis repli template sur « non joignable »', g([n('r', 'rcs_message', { text: 'Bonjour' }), TPL('t')], [e('r', 't', 'unreachable')])],
    ['RCS puis suite sur « envoye »', g([n('r', 'rcs_message', { text: 'Bonjour' }), n('a', 'tag', { tag: 'v' })], [e('r', 'a', 'sent')])],
    ['attente puis RCS', g([n('w', 'wait', { delay: 2, unit: 'hours' }), n('r', 'rcs_message', { text: 'Bonjour' })], [e('w', 'r')])],
    ['condition -> RCS / template', g([n('c', 'condition', {}), n('r', 'rcs_message', { text: 'Bonjour' }), TPL('t')], [e('c', 'r', 'true'), e('c', 't', 'false')])],
    // Bloc QUESTION : message de SESSION (donc jamais une ouverture de campagne), et PASSE-PLAT tant
    // qu'il n'a pas de texte. Les deux cotes doivent voir exactement le meme parcours.
    ['question configuree seule', g([n('q', 'question', { body: 'Ca va ?', rows: [{ title: 'Oui' }] })])],
    ['question SANS menu', g([n('q', 'question', { body: 'Ton code postal ?' })])],
    ['question NON configuree puis template', g([n('q', 'question', {}), TPL('t')], [e('q', 't')])],
    ['action puis question', g([n('a', 'tag', { tag: 'v' }), n('q', 'question', { body: 'Q' })], [e('a', 'q')])],
    ['attente puis question', g([n('w', 'wait', { delay: 2, unit: 'days' }), n('q', 'question', { body: 'Q' })], [e('w', 'q')])],
    // Bloc AGENT : message de SESSION (donc jamais une ouverture de campagne), et PASSE-PLAT tant qu'aucun
    // agent n'y est rattache. « agent puis template » est le cas qui compte : sans le garde, le template
    // serait vu comme ouverture, la campagne le ferait parametrer, et rien ne partirait au lancement.
    ['agent configure seul', g([n('a', 'agent', { agentId: 'ag1' })])],
    ['agent configure puis template', g([n('a', 'agent', { agentId: 'ag1' }), TPL('t')], [e('a', 't')])],
    ['agent NON configure puis template', g([n('a', 'agent', {}), TPL('t')], [e('a', 't')])],
    ['action puis agent', g([n('x', 'tag', { tag: 'v' }), n('a', 'agent', { agentId: 'ag1' })], [e('x', 'a')])],
    ['attente puis agent', g([n('w', 'wait', { delay: 2, unit: 'days' }), n('a', 'agent', { agentId: 'ag1' })], [e('w', 'a')])],
  ];

  it('même verdict des deux côtés sur chaque graphe', () => {
    for (const [nom, graph] of cas) {
      const web = scanOpening(graph);
      const api = scanServeur(graph as unknown as WorkflowGraph);
      expect(web.sessionOpen, `sessionOpen sur « ${nom} »`).toBe(api.sessionOpen);
      expect(web.rcsOpen, `rcsOpen sur « ${nom} »`).toBe(api.rcsOpen);
      expect(web.ambiguousTemplate, `ambiguousTemplate sur « ${nom} »`).toBe(api.ambiguousTemplate);
      expect(web.waitBeforeTemplate, `waitBeforeTemplate sur « ${nom} »`).toBe(api.waitBeforeTemplate);
      expect(web.unnamedOpeningTemplate, `unnamedOpeningTemplate sur « ${nom} »`).toBe(api.unnamedOpeningTemplate);
      expect(web.firstTemplate?.id ?? null, `firstTemplate sur « ${nom} »`).toBe(api.firstTemplate?.id ?? null);
    }
  });
});

describe('parité de la détection « attente >= 24 h puis message de session »', () => {
  const cas: Array<[string, GraphLike]> = [
    ['attente 2 j puis message rapide', g([n('w', 'wait', { delay: 2, unit: 'days' }), QM('q')], [e('w', 'q')])],
    ['attente 2 h puis message rapide', g([n('w', 'wait', { delay: 2, unit: 'hours' }), QM('q')], [e('w', 'q')])],
    ['12 h + 13 h puis message rapide', g([n('w1', 'wait', { delay: 12, unit: 'hours' }), n('w2', 'wait', { delay: 13, unit: 'hours' }), QM('q')], [e('w1', 'w2'), e('w2', 'q')])],
    ['attente puis template puis message rapide', g([n('w', 'wait', { delay: 3, unit: 'days' }), TPL('t'), QM('q')], [e('w', 't'), e('t', 'q')])],
    ['attente 2 j puis formulaire', g([n('w', 'wait', { delay: 2, unit: 'days' }), n('f', 'flow', { flowId: 'fl1' })], [e('w', 'f')])],
    ['cycle d attentes sans message', g([n('w1', 'wait', { delay: 1, unit: 'hours' }), n('w2', 'wait', { delay: 1, unit: 'hours' })], [e('w1', 'w2'), e('w2', 'w1')])],
    ['aucune attente', g([QM('q')])],
    // Depuis qu'un message rapide SANS bouton ne bloque plus le parcours, il doit être TRAVERSÉ par l'analyse :
    // sinon le message final, lui bien mort-né, ne serait jamais signalé. Cas construit exprès.
    ['attente, message sans bouton, attente, message rapide', g(
      [n('w1', 'wait', { delay: 12, unit: 'hours' }), n('qm', 'quick_message', { body: 'un mot' }),
       n('w2', 'wait', { delay: 13, unit: 'hours' }), QM('q')],
      [e('w1', 'qm'), e('qm', 'w2'), e('w2', 'q')],
    )],
    // Bloc AGENT : son premier message est un message de SESSION, donc mort-ne apres 24 h d'attente cumulee.
    // Non configure, il est traverse, et c'est le message d'apres qui doit etre signale.
    ['attente 2 j puis agent configure', g([n('w', 'wait', { delay: 2, unit: 'days' }), n('a', 'agent', { agentId: 'ag1' })], [e('w', 'a')])],
    ['attente 2 h puis agent configure', g([n('w', 'wait', { delay: 2, unit: 'hours' }), n('a', 'agent', { agentId: 'ag1' })], [e('w', 'a')])],
    ['attente 2 j puis agent NON configure puis message rapide', g(
      [n('w', 'wait', { delay: 2, unit: 'days' }), n('a', 'agent', {}), QM('q')],
      [e('w', 'a'), e('a', 'q')],
    )],
  ];

  it('front et serveur désignent le MÊME montage fautif (ou aucun)', () => {
    for (const [nom, graph] of cas) {
      const web = waitBeforeSessionMessage(graph);
      const api = waitBeforeSessionMessageServeur(graph as unknown as WorkflowGraph);
      expect(web?.messageNodeId ?? null, `messageNodeId sur « ${nom} »`).toBe(api?.messageNodeId ?? null);
      expect(web?.waitNodeId ?? null, `waitNodeId sur « ${nom} »`).toBe(api?.waitNodeId ?? null);
    }
  });
});
