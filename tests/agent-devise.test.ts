import { describe, it, expect } from 'vitest';
import { eurosDepuisMicro, microEurosDepuisDollars } from '../src/agent/devise';
import { eurosDepuisMicro as eurosFront } from '../web/lib/agent-solde';

/**
 * La conversion du coût d'un appel de modèle.
 *
 * 🔴 C'ÉTAIT LA DETTE D1, ET C'ÉTAIT UN BUG D'UNITÉ SILENCIEUX. Le Gateway rend le coût en DOLLARS, tous nos
 * compteurs et tous nos plafonds sont en micro-euros : on additionnait des dollars dans une colonne d'euros,
 * et le plafond réglé par le client était comparé à une autre monnaie que la sienne. Faux d'un facteur de
 * change : trop haut on dépasse, trop bas l'agent se coupe tout seul.
 */
describe('microEurosDepuisDollars', () => {
  it('applique le taux, et rend des micro-euros', () => {
    // 0,01 $ à 0,92 € par dollar = 0,0092 €, soit 9200 micro-euros.
    expect(microEurosDepuisDollars(0.01, 0.92)).toBe(9200);
    expect(microEurosDepuisDollars(1, 0.92)).toBe(920_000);
  });

  it('🔴 un taux ABSENT, nul ou aberrant retombe sur 1, JAMAIS sur zéro', () => {
    // Un zéro rendrait toute consommation gratuite, donc désarmerait tous les plafonds en silence. Facturer
    // un dollar pour un euro coûte quelques pour cent ; ne rien facturer coûte le compte prépayé entier.
    for (const taux of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(microEurosDepuisDollars(1, taux), String(taux)).toBe(1_000_000);
    }
  });

  it('un coût nul, négatif ou illisible rend zéro', () => {
    for (const cout of [0, -0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(microEurosDepuisDollars(cout, 0.92), String(cout)).toBe(0);
    }
  });

  it('arrondit au micro-euro, sans jamais rendre de décimale', () => {
    // Le compteur est un `bigint` en base : une fraction y serait tronquée en silence, et le cumul dériverait.
    expect(Number.isInteger(microEurosDepuisDollars(0.0000123, 0.92))).toBe(true);
  });

  it('un très petit coût n’est pas perdu, sauf s’il est vraiment sous le micro-euro', () => {
    // Un appel de modèle bon marché coûte de l'ordre du dix-millième de dollar : il DOIT compter, sinon un
    // agent bavard consomme sans que le solde bouge.
    expect(microEurosDepuisDollars(0.0001, 0.92)).toBe(92);
  });
});

describe('eurosDepuisMicro', () => {
  it('rend deux décimales', () => {
    expect(eurosDepuisMicro(9200)).toBe(0.01);
    expect(eurosDepuisMicro(1_234_567)).toBe(1.23);
    expect(eurosDepuisMicro(0)).toBe(0);
  });

  it('🔴 le navigateur applique EXACTEMENT la même règle', () => {
    // Les deux builds ne partagent aucun module : un affichage qui divergerait du serveur ferait lire au
    // client un solde différent de celui qu'on décompte.
    for (const micro of [0, 1, 9200, 500_000, 1_234_567, 30_000_000]) {
      expect(eurosFront(micro), String(micro)).toBe(eurosDepuisMicro(micro));
    }
  });
});
