import { describe, it, expect } from 'vitest';
import { vueOutilMba, type ContexteVue } from '../src/mba/vue-outils';
import type { OutilComplet, OutilBibliotheque } from '../src/agent/catalog';

/**
 * La ligne d'un outil dans l'onglet « Outils » de l'agent de Meta (spec 2026-09-21-outils-maison-mba, § 9.1).
 * 🔴 CE QUE CE FICHIER PROTÈGE : ce qui manque se DIT (un champ supprimé, un appel supprimé, un outil illisible,
 * un outil désactivé). Un outil dont la cible a disparu refuse à chaque appel ; sans sa ligne rouge, personne
 * ne le saurait.
 */
const outil = (over: Partial<OutilComplet>): OutilComplet => ({
  id: 'o1', tenantId: 't1', origin: 'mba', name: 'n', description: 'd', nePasUtiliser: 'p', gestes: [], params: [],
  binding: {}, sourceId: null, requestId: null, nature: 'integre', outputPaths: [], risk: 'write', timeoutMs: 5000,
  maxBytes: 16384, autonome: false, mcpAnnonce: null, mcpNonActivable: null, mcpIndisponibleLe: null, mcpVuLe: null,
  title: 'T', actif: true, activeLe: null, autonomeLe: null, ...over,
});
const ctx = (over: Partial<ContexteVue> = {}): ContexteVue => ({
  requetes: new Map([['rq1', { label: 'Poser une étiquette' }]]), champs: new Set(['ville']), bibliotheque: new Map(), ...over,
});

describe('la ligne d’un outil dans l’onglet', () => {
  it('un tag : son type et sa cible', () => {
    expect(vueOutilMba(outil({ binding: { handler: 'tag_fixe', tag: 'vip' } }), ctx()))
      .toMatchObject({ type: 'tag', cible: { type: 'tag', tag: 'vip' }, cibleManquante: null, actif: true, risque: 'write' });
  });

  it('🔴 un champ supprimé du mini-CRM est SIGNALÉ', () => {
    const v = vueOutilMba(outil({ binding: { handler: 'champ_fixe', champ: 'code_postal', valeurs: [] } }), ctx());
    expect(v.type).toBe('champ');
    expect(v.cibleManquante).toContain('code_postal');
  });

  it('🔴 un connecteur dont l’appel a été supprimé est SIGNALÉ', () => {
    const v = vueOutilMba(outil({ origin: 'http', requestId: 'rq9' }), ctx());
    expect(v).toMatchObject({ type: 'connecteur', cible: { type: 'connecteur', requeteId: 'rq9', libelle: null } });
    expect(v.cibleManquante).toContain('Connecteurs API');
  });

  it('🔴 un connecteur partagé NOMME les agents IA qui s’en servent, pas l’agent de Meta', () => {
    const entree: OutilBibliotheque = {
      id: 'o1', name: 'n', title: 'T', description: 'd', nePasUtiliser: 'p', origin: 'http', risk: 'write',
      sourceId: 's', mcpNonActivable: null, mcpIndisponibleLe: null,
      consommateurs: [
        { cle: 'agent:a1', actif: true, agentId: 'a1', agentLabel: 'Support' },
        { cle: 'mba:pn1', actif: true, agentId: null, agentLabel: null },
      ],
    };
    const v = vueOutilMba(outil({ origin: 'http', requestId: 'rq1' }), ctx({ bibliotheque: new Map([['o1', entree]]) }));
    expect(v.aussiUtilisePar).toEqual(['Support']);
    expect(v.cible).toEqual({ type: 'connecteur', requeteId: 'rq1', libelle: 'Poser une étiquette' });
  });

  it('🔴 un outil maison illisible est montré comme tel, pas masqué', () => {
    expect(vueOutilMba(outil({ binding: { handler: 'poser_tag' } }), ctx()))
      .toMatchObject({ type: 'inconnu', cible: { type: 'inconnu' }, cibleManquante: expect.stringContaining('supprimez-le') });
  });

  it('🔴 un appel irréversible le DIT : l’agent de Meta l’exécute sans validation humaine', () => {
    expect(vueOutilMba(outil({ origin: 'http', requestId: 'rq1', risk: 'irreversible' }), ctx()).risque).toBe('irreversible');
  });

  it('🔴 un outil désactivé le dit (son auteur a quitté l’espace)', () => {
    expect(vueOutilMba(outil({ binding: { handler: 'tag_fixe', tag: 'vip' }, actif: false }), ctx()).actif).toBe(false);
  });
});
