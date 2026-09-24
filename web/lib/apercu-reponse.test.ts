import { describe, it, expect } from 'vitest';
import { premiereReponse } from './apercu-reponse';
import type { GraphLike } from './campaign-eligibility';

/**
 * CE QUE L'APERÇU D'UNE PUBLICITÉ ANNONCE COMME PREMIÈRE RÉPONSE.
 *
 * 🔴 CE QUI SE JOUE ICI EST L'HONNÊTETÉ D'UN ÉCRAN QUI FAIT DÉPENSER. Le client valide une publicité en
 * regardant la réponse annoncée : si l'aperçu devine une branche, il valide des mots qui ne partiront pas.
 * D'où la moitié la moins évidente de ces cas, celle qui vérifie que le parcours AVOUE au lieu de choisir.
 */

const n = (id: string, type: string, data: Record<string, unknown> = {}) => ({ id, type, data });
const g = (nodes: GraphLike['nodes'], edges: GraphLike['edges'] = []): GraphLike => ({ nodes, edges });

describe('premiereReponse : ce qu’on sait vraiment', () => {
  it('le bloc d’entrée envoie un message : on rend son texte et ses boutons', () => {
    const graph = g([n('a', 'quick_message', { body: 'Bonjour !', quickReplies: [{ text: 'Un devis' }, { text: 'Un rendez-vous' }] })]);
    expect(premiereReponse(graph)).toEqual({ genre: 'message', texte: 'Bonjour !', boutons: ['Un devis', 'Un rendez-vous'] });
  });

  it('🔴 les lignes d’un bloc QUESTION portent leur libellé dans `title`, pas dans `text`', () => {
    // Une lecture uniforme sur `text` rendrait des boutons vides sur tous les blocs question, et l'aperçu
    // montrerait un menu sans intitulés là où le prospect lira des mots.
    const graph = g([n('a', 'question', { body: 'Que cherchez-vous ?', rows: [{ title: 'Dépannage' }, { title: 'Devis' }] })]);
    expect(premiereReponse(graph)).toEqual({ genre: 'message', texte: 'Que cherchez-vous ?', boutons: ['Dépannage', 'Devis'] });
  });

  it('l’entrée est le bloc SANS arête entrante, pas le premier du tableau', () => {
    const graph = g(
      [n('b', 'quick_message', { body: 'Second' }), n('a', 'quick_message', { body: 'Premier' })],
      [{ source: 'a', target: 'b' }],
    );
    expect(premiereReponse(graph)).toMatchObject({ genre: 'message', texte: 'Premier' });
  });

  it('on traverse les blocs qui n’envoient rien et n’ont qu’une sortie', () => {
    const graph = g(
      [n('a', 'tag', { tag: 'lead' }), n('b', 'field', { champ: 'source' }), n('c', 'quick_message', { body: 'Bien reçu' })],
      [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }],
    );
    expect(premiereReponse(graph)).toMatchObject({ genre: 'message', texte: 'Bien reçu' });
  });

  it('un bloc message NON configuré est un passe-plat, comme dans le moteur', () => {
    // `envoieVraiment` est importé de `campaign-eligibility`, qui est déjà le miroir testé du serveur :
    // s'arrêter sur un corps vide annoncerait un message vide que personne ne recevrait.
    const graph = g(
      [n('a', 'quick_message', { body: '   ' }), n('b', 'quick_message', { body: 'Le vrai' })],
      [{ source: 'a', target: 'b' }],
    );
    expect(premiereReponse(graph)).toMatchObject({ genre: 'message', texte: 'Le vrai' });
  });

  it('un modèle approuvé : on n’a que son nom, son texte vit chez Meta', () => {
    expect(premiereReponse(g([n('a', 'template', { templateName: 'promo_rentree' })]))).toEqual({ genre: 'modele', nom: 'promo_rentree' });
    expect(premiereReponse(g([n('a', 'template', { templateName: '  ' })]))).toEqual({ genre: 'modele', nom: null });
  });

  it('un formulaire et un agent IA sont reconnus pour ce qu’ils sont', () => {
    expect(premiereReponse(g([n('a', 'flow', { flowId: 'f1' })]))).toEqual({ genre: 'formulaire' });
    expect(premiereReponse(g([n('a', 'agent', { agentId: 'ag1' })]))).toEqual({ genre: 'agent_ia' });
  });

  it('un premier envoi hors WhatsApp est nommé, pas maquillé en bulle', () => {
    expect(premiereReponse(g([n('a', 'rcs_message', {})]))).toEqual({ genre: 'autre_canal', type: 'rcs_message' });
    expect(premiereReponse(g([n('a', 'email', {})]))).toEqual({ genre: 'autre_canal', type: 'email' });
  });
});

describe('premiereReponse : ce qu’on AVOUE ne pas savoir', () => {
  it('🔴 une condition dépend du contact, qui n’existe pas encore', () => {
    const graph = g(
      [n('a', 'condition', {}), n('b', 'quick_message', { body: 'Branche vraie' })],
      [{ source: 'a', target: 'b', sourceHandle: 'true' }],
    );
    expect(premiereReponse(graph)).toEqual({ genre: 'indecidable', type: 'condition' });
  });

  it('🔴 deux sorties depuis un bloc muet : on ne choisit pas une branche au hasard', () => {
    const graph = g(
      [n('a', 'tag', { tag: 'x' }), n('b', 'quick_message', { body: 'Gauche' }), n('c', 'quick_message', { body: 'Droite' })],
      [{ source: 'a', target: 'b' }, { source: 'a', target: 'c' }],
    );
    expect(premiereReponse(graph)).toEqual({ genre: 'indecidable', type: 'tag' });
  });

  it('une sortie TYPÉE est déjà un choix : on s’arrête aussi', () => {
    const graph = g(
      [n('a', 'action', {}), n('b', 'quick_message', { body: 'Après succès' })],
      [{ source: 'a', target: 'b', sourceHandle: 'sent' }],
    );
    expect(premiereReponse(graph)).toEqual({ genre: 'indecidable', type: 'action' });
  });

  it('🔴 un scénario qui BOUCLE ne fige pas l’onglet', () => {
    const graph = g(
      [n('a', 'tag', { tag: 'x' }), n('b', 'field', { champ: 'y' })],
      [{ source: 'a', target: 'b' }, { source: 'b', target: 'a' }],
    );
    expect(premiereReponse(graph)).toEqual({ genre: 'aucun_envoi' });
  });

  it('un parcours qui s’arrête sans rien envoyer, et un graphe vide', () => {
    expect(premiereReponse(g([n('a', 'tag', { tag: 'x' })]))).toEqual({ genre: 'aucun_envoi' });
    expect(premiereReponse(g([]))).toEqual({ genre: 'vide' });
  });
});
