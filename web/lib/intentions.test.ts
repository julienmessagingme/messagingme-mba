import { describe, it, expect } from 'vitest';
import { INTENTIONS, comptesParIntention, estIntention, libelleIntention } from './intentions';

const T = (fr: string): string => fr;

describe('intentions : ce que la console affiche', () => {
  it('🔴 une API plus ANCIENNE, qui ne connaît pas les intentions neuves, rend des ZÉROS et pas des trous', () => {
    // La réponse exacte d'une API d'avant le 2026-09-24 : six clés. La console part sur Vercel à chaque push,
    // l'API se déploie à la main : cette forme arrive VRAIMENT, le temps d'un déploiement.
    const ancienne = { demande_devis: 2, sav: 1, reclamation: 0, information: 0, prise_rdv: 0, autre: 0 };
    const comptes = comptesParIntention(ancienne);
    expect(comptes.map((c) => c.intention)).toEqual([...INTENTIONS]);
    expect(comptes.find((c) => c.intention === 'achat')?.n).toBe(0);
    expect(comptes.find((c) => c.intention === 'demande_devis')?.n).toBe(2);
    expect(comptes.every((c) => Number.isFinite(c.n))).toBe(true);
  });

  it('un corps sans aucune intention rend des zéros, dans l’ordre d’affichage', () => {
    expect(comptesParIntention(undefined).map((c) => c.n)).toEqual(INTENTIONS.map(() => 0));
  });

  it('⚠️ une intention INCONNUE (API plus récente) s’affiche telle quelle, jamais vide', () => {
    expect(libelleIntention('nouvelle_intention', T)).toBe('nouvelle_intention');
  });

  it('les trois intentions de commerce ont leur libellé', () => {
    expect(libelleIntention('achat', T)).toBe('Achat');
    expect(libelleIntention('suivi_commande', T)).toBe('Suivi de commande');
    expect(libelleIntention('retour', T)).toBe('Retour ou échange');
  });

  it('estIntention refuse une valeur bricolée dans l’adresse', () => {
    expect(estIntention('suivi_commande')).toBe(true);
    expect(estIntention('nawak')).toBe(false);
  });
});
