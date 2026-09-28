import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eurosDepuisMicro, microEurosDepuisDollars, dollarsDepuisMicroEuros, prixClientMicroEur, PLAFOND_GATEWAY_MIN_DOLLARS } from '../src/agent/devise';
import { prixParMillion } from '../src/agent/modeles';
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

/**
 * LE PRIX CLIENT (2026-09-28) : ce que le crédit d'un espace paie pour un appel, commission comprise.
 *
 * 🔴 Le débit était le coût BRUT, alors que la liste des modèles annonçait le prix majoré de la commission : le
 * client lisait un tarif et en payait un autre. Une seule fonction calcule désormais le montant débité, et la
 * commission y est la même variable que celle de l'affichage.
 */
describe('prixClientMicroEur', () => {
  it('à 0 %, c’est exactement le coût brut', () => {
    expect(prixClientMicroEur(0.01, 0.92, 0)).toBe(microEurosDepuisDollars(0.01, 0.92));
    expect(prixClientMicroEur(0.01, 0.92, 0)).toBe(9200);
  });

  it('🔴 à 10 %, le coût brut majoré de la commission', () => {
    // 0,01 $ à 0,92 = 9200 micro-euros, + 10 % = 10 120.
    expect(prixClientMicroEur(0.01, 0.92, 10)).toBe(10_120);
    expect(prixClientMicroEur(1, 0.92, 10)).toBe(1_012_000);
  });

  it('🔴 arrondit UNE seule fois, après la commission', () => {
    // 1,4 micro-euro brut : arrondi d'abord, il vaudrait 1, puis 1,1, donc 1 ; la commission serait perdue sur
    // tous les petits appels, qui sont justement la majorité (un tour coûte quelques dizaines de micro-euros).
    expect(prixClientMicroEur(0.0000014, 1, 10)).toBe(2);
    expect(Number.isInteger(prixClientMicroEur(0.0000123, 0.92, 10))).toBe(true);
  });

  it('🔴 un taux aberrant retombe sur 1, jamais sur zéro', () => {
    for (const taux of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(prixClientMicroEur(1, taux, 10), String(taux)).toBe(1_100_000);
    }
  });

  it('🔴 une commission illisible ou négative vaut 0, jamais une remise', () => {
    for (const pct of [-50, Number.NaN, Number.NEGATIVE_INFINITY]) {
      expect(prixClientMicroEur(1, 1, pct), String(pct)).toBe(1_000_000);
    }
  });

  it('un coût nul, négatif ou illisible rend zéro', () => {
    for (const cout of [0, -0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(prixClientMicroEur(cout, 0.92, 10), String(cout)).toBe(0);
    }
  });

  it('🔴 le prix AFFICHÉ est le prix PAYÉ : un million de jetons coûte au crédit ce que la liste annonce', () => {
    // La liste des modèles (`prixParMillion`) et le débit lisent la même commission et le même taux. Un écart
    // entre les deux ferait lire un tarif et payer un autre, ce que ce lot corrige.
    const dollarsParJeton = 0.00000007;
    const annonceEuros = prixParMillion(dollarsParJeton, 0.92, 10)!;
    const payeEuros = prixClientMicroEur(dollarsParJeton * 1_000_000, 0.92, 10) / 1_000_000;
    expect(payeEuros).toBeCloseTo(annonceEuros, 6);
  });
});

/**
 * 🔴 L'INVENTAIRE, parce qu'un nouveau chemin qui débite un client l'oubliera. `microEurosDepuisDollars` rend le
 * coût BRUT : c'est notre dépense, et seuls les deux assistants de configuration (sur notre clé) la mesurent
 * ainsi. Tout le reste débite le crédit d'un espace, donc au prix client.
 */
describe('inventaire du coût brut', () => {
  const RACINE = fileURLToPath(new URL('../src/', import.meta.url));
  const AUTORISES = ['agent/devise.ts', 'http/agent-setup.ts', 'http/mba-assistant.ts'];

  function fichiers(dossier: string): string[] {
    return readdirSync(dossier, { withFileTypes: true }).flatMap((e) => {
      const chemin = join(dossier, e.name);
      if (e.isDirectory()) return fichiers(chemin);
      return e.name.endsWith('.ts') ? [chemin] : [];
    });
  }

  it('🔴 `microEurosDepuisDollars` n’est nommée que par devise.ts et les deux assistants', () => {
    const usagers = fichiers(RACINE)
      .filter((f) => readFileSync(f, 'utf8').includes('microEurosDepuisDollars'))
      .map((f) => f.slice(RACINE.length).split('\\').join('/'));
    // Un inventaire vide ne prouverait rien : la définition, au moins, doit être trouvée.
    expect(usagers).toContain('agent/devise.ts');
    expect(usagers.filter((u) => !AUTORISES.includes(u))).toEqual([]);
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

/**
 * LE CHEMIN INVERSE, pour le plafond d'une clé du Gateway (2026-09-09).
 *
 * 🔴 LE SENS DE L'ARRONDI EST L'INVERSE DE CELUI QU'ON CROIT, ET ÇA A ÉTÉ LIVRÉ FAUX. Il y a deux barrières :
 * la nôtre (`run-turn.ts`, `solde <= 0`, en euros, avant l'appel) est la GARDE ; celle de Vercel est le
 * FILET. Arrondi vers le BAS, le filet mordait le premier : 10 € donnaient 10 $, atteints à 9,20 € consommés,
 * donc 8 % du crédit payé devenaient inatteignables et la garde ne servait plus jamais. Un filet qui se
 * déclenche avant sa garde n'est pas un filet.
 */
describe('Micro-euros vers le plafond en dollars', () => {
  it('🔴 arrondit VERS LE HAUT, pour que le filet reste plus large que la garde', () => {
    // 10 € au taux de 0,92 valent 10,87 $. On envoie 11 : notre garde bloquera à 10 € pile, et le filet ne
    // se déclenchera que si notre comptage est cassé.
    expect(dollarsDepuisMicroEuros(10_000_000, 0.92)).toBe(11);
    expect(dollarsDepuisMicroEuros(30_000_000, 0.92)).toBe(33);
  });

  it('🔴 le crédit payé reste TOUJOURS atteignable, à tous les montants', () => {
    // La propriété qui compte, et que l'arrondi vers le bas violait : le plafond en dollars doit couvrir la
    // totalité du crédit. Sans elle, le client est coupé avant d'avoir consommé ce qu'il a acheté.
    for (const euros of [1, 2, 5, 10, 23, 50, 99, 100, 137]) {
      const plafond = dollarsDepuisMicroEuros(euros * 1_000_000, 0.92)!;
      expect(plafond, `${euros} EUR`).toBeGreaterThanOrEqual(euros / 0.92);
    }
  });

  it('🔴 sous le minimum de Vercel, rend `null` : le minimum se juge AVANT l’arrondi', () => {
    // Le piège de l'arrondi au supérieur : `ceil(0,217)` vaut 1, donc juger APRÈS ferait qu'un centime de
    // crédit ouvrirait un agent à 1 $. « Pas de crédit, pas de clé, donc pas d'agent » cesserait de tenir.
    expect(dollarsDepuisMicroEuros(200_000, 0.92)).toBeNull();
    expect(dollarsDepuisMicroEuros(900_000, 0.92)).toBeNull();
    expect(dollarsDepuisMicroEuros(0, 0.92)).toBeNull();
    expect(dollarsDepuisMicroEuros(-5, 0.92)).toBeNull();
    // Juste au-dessus du minimum en revanche, ça passe : 1 € vaut 1,087 $, donc un plafond de 2.
    expect(dollarsDepuisMicroEuros(1_000_000, 0.92)).toBe(2);
    expect(PLAFOND_GATEWAY_MIN_DOLLARS).toBe(1);
  });

  it('🔴 un taux aberrant retombe sur 1, jamais sur une division par zéro', () => {
    // Un plafond infini serait exactement la panne que ce plafond existe pour empêcher.
    for (const taux of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(dollarsDepuisMicroEuros(10_000_000, taux), String(taux)).toBe(10);
    }
  });

  it('fait l’aller-retour avec la conversion du coût, à l’arrondi près', () => {
    // Les deux fonctions vivent dans le même fichier précisément pour que le taux ne puisse pas diverger.
    const dollars = 25;
    const micro = microEurosDepuisDollars(dollars, 0.92);
    expect(dollarsDepuisMicroEuros(micro, 0.92)).toBe(dollars);
  });
});
