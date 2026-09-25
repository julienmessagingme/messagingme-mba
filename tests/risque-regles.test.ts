import { describe, it, expect } from 'vitest';
import {
  ALLEGEMENT_POINTS, GRILLE_RISQUE, NIVEAUX_RISQUE, RAISONS_RISQUE, SEUILS_PAR_DEFAUT, calculerRisque, debutFenetre,
  niveauDuScore, passeEnEleve, type FaitsRisque, type MessageDelivre,
} from '../src/engagement/risque';

/**
 * LES RÈGLES DU RISQUE DE DÉSENGAGEMENT (spec § 19), règle par règle, sur une fonction PURE.
 *
 * Chaque cas isole UNE règle : le contact de base (`vivant`) ne marque aucun point, et un cas n'ajoute que ce
 * qu'il mesure. Un cas qui passerait sans sa règle (le « témoin ») est écrit à côté quand l'absence est
 * possible.
 */

const MAINTENANT = new Date('2026-09-25T03:00:00.000Z');
const JOUR = 86_400_000;
const ilYa = (jours: number): Date => new Date(MAINTENANT.getTime() - jours * JOUR);
const delivre = (jours: number, lu = false): MessageDelivre => ({ envoyeLe: ilYa(jours), lu, luLe: lu ? ilYa(jours - 0.01) : null });

/** Un contact sollicité, qui lit et répond : zéro point. */
function faits(over: Partial<FaitsRisque> = {}): FaitsRisque {
  return {
    desabonne: false,
    bloque: false,
    delivres: [delivre(20, true), delivre(10, true), delivre(5, true)],
    derniereReactionLe: ilYa(4),
    derniereAnalyse: null,
    joignableWhatsapp: true,
    joignableRcs: null,
    ...over,
  };
}
const risque = (over: Partial<FaitsRisque> = {}) => calculerRisque(faits(over), MAINTENANT);
/** Une réaction assez ancienne pour ne rien alléger (plus de 14 jours), assez récente pour ne rien juger d'autre. */
const sansAllegement = { derniereReactionLe: ilYa(15) };

describe('la grille', () => {
  it('le contact de base ne marque aucun point : faible, 0, aucune raison', () => {
    expect(risque()).toEqual({ niveau: 'faible', score: 0, raisons: [] });
  });

  it('les points sont ceux de la spec, validés tels quels', () => {
    expect(GRILLE_RISQUE).toEqual({
      silence_60j: 40, silence_30j: 25, sans_reponse: 15, non_lu: 15, reclamation: 20, negatif: 10, insatisfait: 10, injoignable: 10,
    });
    expect(ALLEGEMENT_POINTS).toBe(25);
    expect(SEUILS_PAR_DEFAUT).toEqual({ fenetreJours: 90, silenceJours: 30, silenceFortJours: 60, allegementJours: 14 });
  });

  it('les niveaux : faible 0 à 29, moyen 30 à 59, élevé 60 à 100', () => {
    expect([0, 29, 30, 59, 60, 100].map(niveauDuScore)).toEqual(['faible', 'faible', 'moyen', 'moyen', 'eleve', 'eleve']);
    expect(NIVEAUX_RISQUE).toEqual(['inconnu', 'faible', 'moyen', 'eleve']);
  });
});

describe('STOP, blocage, inconnu', () => {
  it('🔴 STOP : élevé à 100, MÊME SANS HISTORIQUE', () => {
    expect(risque({ desabonne: true, delivres: [], derniereReactionLe: null })).toEqual({ niveau: 'eleve', score: 100, raisons: ['stop'] });
  });

  it('🔴 blocage : élevé à 100, même sans historique ; les deux ensemble se disent tous les deux', () => {
    expect(risque({ bloque: true, delivres: [], derniereReactionLe: null })).toEqual({ niveau: 'eleve', score: 100, raisons: ['bloque'] });
    expect(risque({ desabonne: true, bloque: true })).toEqual({ niveau: 'eleve', score: 100, raisons: ['stop', 'bloque'] });
  });

  it('🔴 aucun message délivré sur la fenêtre : inconnu, SANS score, même avec une analyse négative', () => {
    const negatif = { intent: 'reclamation', sentiment: 'negatif', resolved: false, satisfaction: 1, le: ilYa(3) };
    expect(risque({ delivres: [], derniereAnalyse: negatif, joignableWhatsapp: false })).toEqual({ niveau: 'inconnu', score: null, raisons: [] });
  });

  it('un message délivré HORS de la fenêtre ne compte pas : inconnu', () => {
    expect(risque({ delivres: [delivre(91), delivre(120)], derniereReactionLe: null })).toEqual({ niveau: 'inconnu', score: null, raisons: [] });
  });
});

describe('le silence', () => {
  it('silence_60j : aucun signe de vie depuis plus de 60 jours, deux messages délivrés depuis', () => {
    expect(risque({ delivres: [delivre(80), delivre(70)], derniereReactionLe: null })).toEqual({ niveau: 'moyen', score: 40, raisons: ['silence_60j'] });
  });

  it('silence_30j : plus de 30 jours, moins de 60', () => {
    expect(risque({ delivres: [delivre(45), delivre(40)], derniereReactionLe: null })).toEqual({ niveau: 'faible', score: 25, raisons: ['silence_30j'] });
  });

  it('🔴 les deux silences sont EXCLUSIFS : le plus fort s’applique, jamais 65', () => {
    const r = risque({ delivres: [delivre(80), delivre(70)], derniereReactionLe: null });
    expect(r.raisons).toEqual(['silence_60j']);
    expect(r.score).toBe(40);
  });

  it('🔴 le silence se compte depuis le signe de vie, qui peut être une LECTURE', () => {
    // Une réponse il y a 65 jours, puis deux messages délivrés sans rien : 65 jours de silence.
    expect(risque({ delivres: [delivre(62), delivre(61)], derniereReactionLe: ilYa(65) }).raisons).toEqual(['silence_60j']);
    // Le même contact a LU un message il y a 40 jours : le silence ne compte que depuis, donc 30 jours.
    expect(risque({ delivres: [delivre(62), delivre(41, true), delivre(35), delivre(33)], derniereReactionLe: ilYa(65) }).raisons)
      .toContain('silence_30j');
  });

  it('🔴 on ne juge pas un silence qu’on n’a pas observé : deux messages cette semaine sans réponse ne font pas 60 jours', () => {
    expect(risque({ delivres: [delivre(7), delivre(3)], derniereReactionLe: null })).toEqual({ niveau: 'faible', score: 0, raisons: [] });
  });

  it('🔴 un contact à qui l’on n’écrit plus depuis sa réponse n’est pas silencieux : il faut DEUX messages délivrés après le signe', () => {
    // Deux messages il y a 85 jours, une réponse il y a 83 jours, plus rien envoyé depuis.
    expect(risque({ delivres: [delivre(85), delivre(84)], derniereReactionLe: ilYa(83) })).toEqual({ niveau: 'faible', score: 0, raisons: [] });
    // Un seul message resté sans réponse : toujours pas.
    expect(risque({ delivres: [delivre(85), delivre(70)], derniereReactionLe: ilYa(80) }).raisons).not.toContain('silence_60j');
  });

  it('les seuils se passent en paramètre, pour les tests seulement', () => {
    const court = { ...SEUILS_PAR_DEFAUT, silenceJours: 1, silenceFortJours: 2 };
    expect(calculerRisque(faits({ delivres: [delivre(1.5), delivre(1.4)], derniereReactionLe: null }), MAINTENANT, court).raisons).toEqual(['silence_30j']);
    expect(calculerRisque(faits({ delivres: [delivre(3), delivre(2.5)], derniereReactionLe: null }), MAINTENANT, court).raisons).toEqual(['silence_60j']);
  });
});

describe('les trois derniers messages', () => {
  it('sans_reponse : les trois derniers délivrés, ni réponse ni clic depuis le plus ancien des trois', () => {
    const r = risque({ delivres: [delivre(20, true), delivre(10, true), delivre(5, true)], derniereReactionLe: ilYa(25) });
    expect(r.raisons).toEqual(['sans_reponse']);
    expect(r.score).toBe(15);
  });

  it('le témoin : une réponse APRÈS le plus ancien des trois efface sans_reponse ; deux messages ne suffisent pas', () => {
    expect(risque({ ...sansAllegement, delivres: [delivre(25, true), delivre(10, true), delivre(5, true)], derniereReactionLe: ilYa(20) }).raisons).toEqual([]);
    expect(risque({ delivres: [delivre(10, true), delivre(5, true)], derniereReactionLe: ilYa(25) }).raisons).not.toContain('sans_reponse');
  });

  it('non_lu : les trois derniers non lus, chez un contact qui LIT d’habitude', () => {
    // La réponse d'il y a 15 jours suit le plus ancien des trois (16 jours) : ni sans_reponse, ni allègement.
    const r = risque({ delivres: [delivre(40, true), delivre(16), delivre(10), delivre(5)], derniereReactionLe: ilYa(15) });
    expect(r.raisons).toEqual(['non_lu']);
    expect(r.score).toBe(15);
  });

  it('🔴 un contact qui RÉPOND sans jamais renvoyer « lu » n’est PAS pénalisé par non_lu : il a coupé ses accusés', () => {
    // Il répond au dernier message (hier) et n'a jamais renvoyé un seul « lu » sur la fenêtre.
    const r = risque({ delivres: [delivre(20), delivre(10), delivre(5)], derniereReactionLe: ilYa(1) });
    expect(r.raisons).not.toContain('non_lu');
    expect(r).toEqual({ niveau: 'faible', score: 0, raisons: [] });
  });
});

describe('la dernière analyse', () => {
  const analyse = (over: Partial<NonNullable<FaitsRisque['derniereAnalyse']>> = {}) => ({
    intent: 'sav', sentiment: 'neutre', resolved: true, satisfaction: null, le: ilYa(8), ...over,
  });

  it('reclamation : une réclamation NON résolue ; résolue, elle ne compte pas', () => {
    expect(risque({ derniereAnalyse: analyse({ intent: 'reclamation', resolved: false }), ...sansAllegement }).raisons).toEqual(['reclamation']);
    expect(risque({ derniereAnalyse: analyse({ intent: 'reclamation', resolved: true }), ...sansAllegement }).raisons).toEqual([]);
  });

  it('negatif : un sentiment négatif', () => {
    expect(risque({ derniereAnalyse: analyse({ sentiment: 'negatif' }), ...sansAllegement })).toEqual({ niveau: 'faible', score: 10, raisons: ['negatif'] });
  });

  it('🔴 insatisfait : 3 sur 10 ou moins ; 4 ne compte pas ; une note ABSENTE n’est pas une note basse', () => {
    expect(risque({ derniereAnalyse: analyse({ satisfaction: 3 }), ...sansAllegement }).raisons).toEqual(['insatisfait']);
    expect(risque({ derniereAnalyse: analyse({ satisfaction: 0 }), ...sansAllegement }).raisons).toEqual(['insatisfait']);
    expect(risque({ derniereAnalyse: analyse({ satisfaction: 4 }), ...sansAllegement }).raisons).toEqual([]);
    expect(risque({ derniereAnalyse: analyse({ satisfaction: null }), ...sansAllegement }).raisons).toEqual([]);
  });

  it('une analyse hors de la fenêtre ne compte pas', () => {
    expect(risque({ derniereAnalyse: analyse({ sentiment: 'negatif', le: ilYa(95) }), ...sansAllegement }).raisons).toEqual([]);
  });
});

describe('la joignabilité', () => {
  it('injoignable : un canal connu injoignable, et aucun canal connu joignable', () => {
    expect(risque({ joignableWhatsapp: false, joignableRcs: null, ...sansAllegement })).toEqual({ niveau: 'faible', score: 10, raisons: ['injoignable'] });
    expect(risque({ joignableWhatsapp: null, joignableRcs: false, ...sansAllegement }).raisons).toEqual(['injoignable']);
  });

  it('🔴 joint en RCS après l’échec de son WhatsApp : il a reçu le dernier envoi, il n’est pas injoignable ; inconnu non plus', () => {
    expect(risque({ joignableWhatsapp: false, joignableRcs: true, ...sansAllegement }).raisons).toEqual([]);
    expect(risque({ joignableWhatsapp: null, joignableRcs: null, ...sansAllegement }).raisons).toEqual([]);
  });
});

describe('le total', () => {
  const tout: Partial<FaitsRisque> = {
    delivres: [delivre(85, true), delivre(70), delivre(65), delivre(62)],
    derniereReactionLe: null,
    derniereAnalyse: { intent: 'reclamation', sentiment: 'negatif', resolved: false, satisfaction: 1, le: ilYa(70) },
    joignableWhatsapp: false,
    joignableRcs: null,
  };

  it('🔴 le total est PLAFONNÉ à 100', () => {
    // silence_60j (lu il y a 85 j) + sans_reponse + non_lu + reclamation + negatif + insatisfait + injoignable = 120.
    const r = risque(tout);
    expect(r.score).toBe(100);
    expect(r.niveau).toBe('eleve');
  });

  it('🔴 les TROIS raisons les plus lourdes, dans l’ordre ; à points égaux, l’ordre de la grille', () => {
    expect(risque(tout).raisons).toEqual(['silence_60j', 'reclamation', 'sans_reponse']);
    // sans_reponse et non_lu valent 15 tous les deux : la grille les range dans cet ordre.
    const egaux = risque({ ...sansAllegement, delivres: [delivre(40, true), delivre(20), delivre(10), delivre(5)], derniereReactionLe: ilYa(21), joignableWhatsapp: false });
    expect(egaux.raisons).toEqual(['sans_reponse', 'non_lu', 'injoignable']);
    expect(egaux.score).toBe(40);
  });

  it('🔴 l’allègement : une réponse ou un clic dans les 14 jours retire 25 points', () => {
    // Trois messages envoyés APRÈS une réponse d'il y a 10 jours, aucun lu, chez un lecteur : 30 - 25.
    const r = risque({ delivres: [delivre(30, true), delivre(9), delivre(8), delivre(7)], derniereReactionLe: ilYa(10) });
    expect(r.raisons).toEqual(['sans_reponse', 'non_lu']);
    expect(r.score).toBe(30 - 25);
    // Le témoin : la même réponse il y a 20 jours ne retire rien.
    expect(risque({ delivres: [delivre(30, true), delivre(9), delivre(8), delivre(7)], derniereReactionLe: ilYa(20) }).score).toBe(30);
  });

  it('🔴 l’allègement a un PLANCHER à 0 : jamais de score négatif', () => {
    const r = risque({ derniereAnalyse: { intent: 'sav', sentiment: 'negatif', resolved: true, satisfaction: null, le: ilYa(2) }, derniereReactionLe: ilYa(2) });
    expect(r).toEqual({ niveau: 'faible', score: 0, raisons: ['negatif'] });
  });

  it('les codes rendus appartiennent tous à la liste fermée', () => {
    for (const code of risque(tout).raisons) expect(RAISONS_RISQUE).toContain(code);
  });
});

describe('le passage en élevé, et la fenêtre', () => {
  it('passer en élevé : depuis un autre niveau ou un premier calcul ; y rester n’en est pas un', () => {
    expect(passeEnEleve('moyen', 'eleve')).toBe(true);
    expect(passeEnEleve(null, 'eleve')).toBe(true);
    expect(passeEnEleve('inconnu', 'eleve')).toBe(true);
    expect(passeEnEleve('eleve', 'eleve')).toBe(false);
    expect(passeEnEleve('eleve', 'moyen')).toBe(false);
  });

  it('la fenêtre commence 90 jours avant le calcul', () => {
    expect(debutFenetre(MAINTENANT).toISOString()).toBe(ilYa(90).toISOString());
  });
});
