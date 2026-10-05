import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  CAUSE_AMORCAGE, CLE_REPLI_DETAIL, ecrireRepliDetail, libelleEvenement, lireDetail, lireRepliDetail,
  origineEvenement, type EvenementConversation,
} from './inbox-detail';

const fr = (f: string): string => f;

const DETAIL = {
  conversationId: 'c1',
  identite: {
    contactId: 'ct1', waId: '33611', nom: 'Durand', prenom: 'Léa', telephone: '+33611', email: null,
    tags: ['vip'], desabonne: true, bloque: false,
  },
  resume: null,
  assignation: { userId: 'u1', nom: 'Marie' },
  historique: [
    { id: '2', type: 'assignee', at: '2026-09-28T10:00:00Z', acteur: { nom: 'Alice' }, cible: { nom: 'Marie' }, cause: null, reassignation: true, prise: false },
    { id: '1', type: 'archivee', at: '2026-09-27T10:00:00Z', acteur: null, cible: null, cause: 'automatique : test', reassignation: false, prise: false },
  ],
};

const ev = (e: Partial<EvenementConversation>): EvenementConversation => ({
  id: '1', type: 'archivee', at: '2026-09-28T10:00:00Z', acteur: null, cible: null, cause: null, reassignation: false, prise: false, ...e,
});

describe('la réponse du serveur, vérifiée et jamais castée', () => {
  it('une réponse bien formée passe telle quelle', () => {
    expect(lireDetail(DETAIL)).toEqual(DETAIL);
  });

  it('🔴 un corps qui n’a pas la forme (route inconnue d’une API plus ancienne, `{}`) donne null : le panneau se replie', () => {
    expect(lireDetail({})).toBeNull();
    expect(lireDetail(null)).toBeNull();
    expect(lireDetail({ ...DETAIL, identite: { ...DETAIL.identite, waId: 3 } })).toBeNull();
    expect(lireDetail({ ...DETAIL, historique: 'x' })).toBeNull();
  });

  it('un événement mal formé est écarté SEUL, la frise garde les autres', () => {
    const d = lireDetail({ ...DETAIL, historique: [...DETAIL.historique, { id: '0', type: 'inconnu', at: 'x', acteur: null, cible: null, cause: null }] });
    expect(d?.historique.map((e) => e.id)).toEqual(['2', '1']);
  });
});

describe('les phrases de la frise', () => {
  it('assignée, réassignée, désassignée : la cible est nommée', () => {
    expect(libelleEvenement(ev({ type: 'assignee', cible: { nom: 'Marie' } }), fr)).toBe('Assignée à Marie');
    expect(libelleEvenement(ev({ type: 'assignee', cible: { nom: 'Jean' }, reassignation: true }), fr)).toBe('Réassignée à Jean');
    expect(libelleEvenement(ev({ type: 'desassignee', cible: { nom: 'Jean' } }), fr)).toBe('Désassignée (était à Jean)');
  });

  it('🔴 un collaborateur supprimé se dit « ancien collaborateur », comme acteur et comme cible', () => {
    expect(libelleEvenement(ev({ type: 'assignee', cible: { ancien: true } }), fr)).toBe('Assignée à ancien collaborateur');
    expect(origineEvenement(ev({ acteur: { ancien: true } }), fr)).toBe('par ancien collaborateur');
  });

  it('🔴 une PRISE (acteur = cible) se dit « Prise en charge », par qui ; une assignation par un autre, non', () => {
    // Relecture du 2026-09-29 : le dépôt annonçait « a pris la conversation », et l'écran disait « Assignée à Marie ».
    const prise = ev({ type: 'assignee', acteur: { nom: 'Marie' }, cible: { nom: 'Marie' }, prise: true });
    expect(libelleEvenement(prise, fr)).toBe('Prise en charge');
    expect(origineEvenement(prise, fr)).toBe('par Marie');
    expect(libelleEvenement(ev({ type: 'assignee', acteur: { nom: 'Alice' }, cible: { nom: 'Marie' } }), fr)).toBe('Assignée à Marie');
  });

  it('une API plus ancienne, sans `prise` : faux, et la ligne se lit comme avant', () => {
    const sansPrise: Record<string, unknown> = { ...DETAIL.historique[0]! };
    delete sansPrise.prise;
    expect(lireDetail({ ...DETAIL, historique: [sansPrise] })?.historique[0]?.prise).toBe(false);
  });

  it('🔴 une ligne amorcée ne prétend pas savoir à qui le fil a été pris', () => {
    expect(libelleEvenement(ev({ type: 'prise_mba', cause: CAUSE_AMORCAGE }), fr)).toBe('Tenue par l’équipe');
    expect(libelleEvenement(ev({ type: 'prise_mba', acteur: { nom: 'Alice' } }), fr)).toBe('Prise à l’agent de Meta');
  });

  it('qui ou quoi : l’auteur, la cause d’un changement automatique, ou les deux', () => {
    expect(origineEvenement(ev({ acteur: { nom: 'Alice' } }), fr)).toBe('par Alice');
    expect(origineEvenement(ev({ cause: 'automatique : campagne Rentrée' }), fr)).toBe('automatique : campagne Rentrée');
    expect(origineEvenement(ev({ acteur: { nom: 'Alice' }, cause: CAUSE_AMORCAGE }), fr)).toBe(`par Alice · ${CAUSE_AMORCAGE}`);
  });

  it('chaque type a sa phrase, dans les deux langues', () => {
    const en = (_f: string, e?: string): string => e ?? '';
    for (const type of ['assignee', 'desassignee', 'prise_mba', 'rendue_mba', 'passee_par_mba', 'traitee', 'non_traitee',
      'archivee', 'desarchivee', 'signalee', 'designalee', 'rouverte', 'escaladee', 'rendue_scenario', 'sortie_agent'] as const) {
      expect(libelleEvenement(ev({ type }), fr), type).not.toBe('');
      expect(libelleEvenement(ev({ type }), en), type).not.toBe('');
    }
  });
});

describe('le repli, retenu par navigateur', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('🔴 sans stockage lisible, le panneau reste déplié et rien ne lève', () => {
    vi.stubGlobal('window', { localStorage: { getItem: () => { throw new Error('bloqué'); }, setItem: () => { throw new Error('plein'); } } });
    expect(lireRepliDetail()).toBe(false);
    expect(() => ecrireRepliDetail(true)).not.toThrow();
  });

  it('le choix fait l’aller-retour', () => {
    const memoire = new Map<string, string>();
    vi.stubGlobal('window', { localStorage: { getItem: (k: string) => memoire.get(k) ?? null, setItem: (k: string, v: string) => { memoire.set(k, v); } } });
    ecrireRepliDetail(true);
    expect(memoire.get(CLE_REPLI_DETAIL)).toBe('1');
    expect(lireRepliDetail()).toBe(true);
    ecrireRepliDetail(false);
    expect(lireRepliDetail()).toBe(false);
  });
});
