import { describe, it, expect } from 'vitest';
import { noeudsTemplate, compteursDeClics, handleDuBouton } from '../src/links/mesures';
import type { LienTrace } from '../src/links/tracked-links.pg';

const lien = (over: Partial<LienTrace> = {}): LienTrace => ({
  code: 'ab12cd34ef56',
  templateName: 'promo',
  templateLanguage: 'fr',
  cardIndex: null,
  buttonIndex: 1,
  destination: 'https://client.fr/promo',
  ...over,
});

describe('noeudsTemplate', () => {
  it('retient les blocs template, avec leur nom et leur langue', () => {
    const graph = {
      nodes: [
        { id: 'n1', type: 'template', data: { templateName: 'promo', language: 'fr' } },
        { id: 'n2', type: 'quick_message', data: { body: 'Salut' } },
        { id: 'n3', type: 'action', data: {} },
      ],
    };
    expect(noeudsTemplate(graph)).toEqual([{ nodeId: 'n1', templateName: 'promo', templateLanguage: 'fr' }]);
  });

  it('🔴 ignore un bloc sans LANGUE : apparier sur le seul nom compterait toutes les langues', () => {
    // Un même template existe souvent en fr et en en. Un appariement au nom gonflerait le chiffre sans que
    // personne ne s'en aperçoive, ce qui est pire qu'une mesure absente.
    const graph = { nodes: [{ id: 'n1', type: 'template', data: { templateName: 'promo' } }] };
    expect(noeudsTemplate(graph)).toEqual([]);
  });

  it('ne suppose AUCUNE forme du graphe (c’est un jsonb)', () => {
    expect(noeudsTemplate(null)).toEqual([]);
    expect(noeudsTemplate({})).toEqual([]);
    expect(noeudsTemplate({ nodes: 'pas un tableau' })).toEqual([]);
    expect(noeudsTemplate({ nodes: [null, 42, { type: 'template' }] })).toEqual([]);
  });
});

describe('handleDuBouton', () => {
  it('suit la convention du graphe', () => {
    expect(handleDuBouton(null, 0)).toBe('btn:0');
    expect(handleDuBouton(2, 1)).toBe('card:2:btn:1');
  });
});

describe('compteursDeClics', () => {
  const noeuds = [{ nodeId: 'n1', templateName: 'promo', templateLanguage: 'fr' }];

  it('rend un compteur par bouton tracé du bloc', () => {
    expect(compteursDeClics(noeuds, [lien()], { ab12cd34ef56: 12 })).toEqual([
      { nodeId: 'n1', kind: 'url_click', handle: 'btn:1', count: 12, contacts: null },
    ]);
  });

  it('🔴 rend une ligne MÊME À ZÉRO clic', () => {
    // C'est elle qui rend la mesure cochable avant le premier clic. Sans ligne, l'opérateur ne pourrait pas
    // préparer son tableau avant de lancer sa campagne.
    expect(compteursDeClics(noeuds, [lien()], {})).toEqual([
      { nodeId: 'n1', kind: 'url_click', handle: 'btn:1', count: 0, contacts: null },
    ]);
  });

  it('🔴 `contacts` est TOUJOURS null : un lien statique n’identifie personne', () => {
    // Mettre 0 dirait « personne n'a cliqué » à côté de 40 clics ; mettre `count` dirait « une personne par
    // clic ». Les deux sont faux, seul l'aveu est juste.
    const [c] = compteursDeClics(noeuds, [lien()], { ab12cd34ef56: 40 });
    expect(c!.contacts).toBeNull();
  });

  it('n’apparie pas un template d’une AUTRE langue', () => {
    expect(compteursDeClics(noeuds, [lien({ templateLanguage: 'en' })], { ab12cd34ef56: 5 })).toEqual([]);
  });

  it('n’apparie pas un AUTRE template', () => {
    expect(compteursDeClics(noeuds, [lien({ templateName: 'relance' })], { ab12cd34ef56: 5 })).toEqual([]);
  });

  it('deux boutons tracés du même template -> deux compteurs distincts', () => {
    const liens = [lien({ buttonIndex: 0, code: 'aaaaaaaaaaaa' }), lien({ buttonIndex: 1, code: 'bbbbbbbbbbbb' })];
    const out = compteursDeClics(noeuds, liens, { aaaaaaaaaaaa: 3, bbbbbbbbbbbb: 7 });
    expect(out.map((c) => [c.handle, c.count])).toEqual([['btn:0', 3], ['btn:1', 7]]);
  });

  it('un carousel rend le handle carte/bouton', () => {
    const out = compteursDeClics(noeuds, [lien({ cardIndex: 1, buttonIndex: 0 })], { ab12cd34ef56: 4 });
    expect(out[0]!.handle).toBe('card:1:btn:0');
  });

  it('🔴 DEUX blocs qui envoient le MÊME template affichent le même total', () => {
    // Conséquence assumée d'un lien par template : le compteur est celui du LIEN, pas des envois de ce bloc.
    // Ce test fige la réalité pour qu'elle soit dite à l'écran plutôt que découverte par un client.
    const deux = [
      { nodeId: 'n1', templateName: 'promo', templateLanguage: 'fr' },
      { nodeId: 'n2', templateName: 'promo', templateLanguage: 'fr' },
    ];
    const out = compteursDeClics(deux, [lien()], { ab12cd34ef56: 12 });
    expect(out.map((c) => [c.nodeId, c.count])).toEqual([['n1', 12], ['n2', 12]]);
  });
});
