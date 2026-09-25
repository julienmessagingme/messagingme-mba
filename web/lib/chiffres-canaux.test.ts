import { describe, it, expect } from 'vitest';
import { fmtNum } from './format';
import { lireVolumesCanaux, phraseVolume, phrasePublications, agentMetaRepond, lireMessagesMba } from './chiffres-canaux';

const REPONSE = { jours: 30, whatsapp: { envoyes: 1234, recus: 567 }, rcs: { envoyes: 12, recus: 0 } };

describe('lireVolumesCanaux', () => {
  it('lit la réponse de la route', () => {
    expect(lireVolumesCanaux(REPONSE)).toEqual(REPONSE);
  });

  it('🔴 aucune réponse lisible : `null`, jamais des zéros', () => {
    // `{}` est ce que rend le support e2e à une route qu'il ne connaît pas, et la forme d'une API d'avant.
    for (const r of [{}, null, undefined, 'x', 42, [], { jours: 30 }, { jours: 30, whatsapp: {}, rcs: null }]) {
      expect(lireVolumesCanaux(r), JSON.stringify(r)).toBeNull();
    }
  });

  it('chaque canal se lit SEUL : un canal mal formé n’efface pas le chiffre de l’autre', () => {
    expect(lireVolumesCanaux({ ...REPONSE, rcs: { envoyes: '12', recus: 0 } }))
      .toEqual({ jours: 30, whatsapp: { envoyes: 1234, recus: 567 }, rcs: null });
    expect(lireVolumesCanaux({ ...REPONSE, whatsapp: { envoyes: 1 } }))
      .toEqual({ jours: 30, whatsapp: null, rcs: { envoyes: 12, recus: 0 } });
  });

  it('refuse un nombre qui n’en est pas un : négatif, décimal, infini, NaN', () => {
    for (const n of [-1, 1.5, Infinity, Number.NaN]) {
      expect(lireVolumesCanaux({ ...REPONSE, whatsapp: { envoyes: n, recus: 0 } })?.whatsapp, String(n)).toBeNull();
    }
  });

  it('sans fenêtre lisible, rien n’est lu : la phrase la cite', () => {
    for (const jours of [undefined, 0, -30, '30', 1.5]) {
      expect(lireVolumesCanaux({ ...REPONSE, jours }), String(jours)).toBeNull();
    }
  });
});

describe('phraseVolume', () => {
  it('le format : milliers groupés selon la langue, envoyés puis reçus, la fenêtre entre parenthèses', () => {
    // Le séparateur de milliers est celui de la langue (espace fine insécable en français), pas un espace tapé.
    expect(fmtNum(1234, 'fr')).toMatch(/^1\s234$/);
    expect(phraseVolume({ envoyes: 1234, recus: 567 }, 30, 'fr')).toBe(`${fmtNum(1234, 'fr')} envoyés · 567 reçus (30 j)`);
    expect(phraseVolume({ envoyes: 1234, recus: 567 }, 30, 'en')).toBe('1,234 sent · 567 received (30 d)');
  });

  it('accorde en français : 0 et 1 au singulier, à partir de 2 au pluriel', () => {
    expect(phraseVolume({ envoyes: 1, recus: 0 }, 30, 'fr')).toBe('1 envoyé · 0 reçu (30 j)');
    expect(phraseVolume({ envoyes: 2, recus: 2 }, 30, 'fr')).toBe('2 envoyés · 2 reçus (30 j)');
  });

  it('un zéro MESURÉ s’affiche : la route a compté, et il n’y a rien eu', () => {
    expect(phraseVolume({ envoyes: 0, recus: 0 }, 30, 'fr')).toBe('0 envoyé · 0 reçu (30 j)');
  });

  it('🔴 on ne sait pas : pas de phrase, donc pas de chiffre', () => {
    expect(phraseVolume(null, 30, 'fr')).toBeNull();
    // De bout en bout : une route absente ne produit AUCUN texte, jamais « 0 envoyé ».
    expect(phraseVolume(lireVolumesCanaux({})?.whatsapp ?? null, 30, 'fr')).toBeNull();
  });
});

describe('phrasePublications', () => {
  it('« au total », accordé', () => {
    expect(phrasePublications(3, 'fr')).toBe('3 publications au total');
    expect(phrasePublications(1, 'fr')).toBe('1 publication au total');
    expect(phrasePublications(0, 'fr')).toBe('0 publication au total');
    expect(phrasePublications(1, 'en')).toBe('1 post in total');
    expect(phrasePublications(1500, 'en')).toBe('1,500 posts in total');
  });

  it('🔴 on ne sait pas : pas de phrase', () => {
    expect(phrasePublications(null, 'fr')).toBeNull();
  });
});

describe('agentMetaRepond', () => {
  const statut = (enabled: unknown, eligible: unknown = true) => ({ eligible, settings: { rollout: { enabled } } });

  it('vrai seulement quand META dit que l’agent est allumé sur un numéro éligible', () => {
    expect(agentMetaRepond(statut(true))).toBe(true);
    expect(agentMetaRepond(statut(false))).toBe(false);
    expect(agentMetaRepond(statut(true, false))).toBe(false);
    expect(agentMetaRepond({ eligible: true, settings: null })).toBe(false);
  });

  it('statut pas encore lu, ou illisible : faux', () => {
    expect(agentMetaRepond(null)).toBe(false);
    expect(agentMetaRepond(statut('true'))).toBe(false);
  });
});

describe('lireMessagesMba', () => {
  it('lit le compte', () => {
    expect(lireMessagesMba({ messages: 412, jours: 30 })).toBe(412);
    expect(lireMessagesMba({ messages: 0, jours: 30 })).toBe(0);
  });

  it('🔴 `messages: null` (le serveur ne sait pas), réponse vide ou absente : `null`, jamais 0', () => {
    for (const r of [{ messages: null, jours: 30 }, {}, null, undefined, { messages: '12' }, { messages: -1 }]) {
      expect(lireMessagesMba(r), JSON.stringify(r)).toBeNull();
    }
  });
});
