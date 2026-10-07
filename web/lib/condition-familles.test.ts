import { describe, it, expect } from 'vitest';
import {
  ecrireFamilles, estPoigneeDeFamille, famillesDeCondition, libelleSortieDeCondition, nomDeFamille, nouveauCodeDeFamille,
  sortiesDeCondition, type FamilleLike,
} from './condition-familles';

/**
 * CE QUE L'ÉCRAN ÉCRIT ET AFFICHE D'UN BLOC CONDITION À FAMILLES (RC5). La lecture elle-même est tenue pour
 * conforme au moteur par `tests/web-condition-familles-parity.test.ts` ; ici, ce que seule la console fait.
 */

const groupe = (tag: string) => ({ match: 'all' as const, clauses: [{ kind: 'tag', op: 'has', tag }] });
const f = (code: string, nom = '', tag = 'x'): FamilleLike => ({ code, nom, groupe: groupe(tag) });

describe('ecrireFamilles : la forme écrite dans le graphe', () => {
  it('🔴 une seule famille d’origine, sans nom : l’ANCIENNE forme, sans `familles`', () => {
    // Un bloc qu'on ne fait que retoucher garde la forme que tout lecteur connaît (e2e, moteur d'avant).
    expect(ecrireFamilles([f('true', '', 'vip')])).toEqual({ match: 'all', clauses: groupe('vip').clauses, familles: undefined });
    expect(ecrireFamilles([f('true', '   ', 'vip')])).toMatchObject({ familles: undefined });
  });

  it('dès une deuxième famille, ou un nom : la liste fait foi, et l’ancienne forme est effacée', () => {
    const deux = [f('true'), f('k2', 'Gold')];
    expect(ecrireFamilles(deux)).toEqual({ familles: deux, match: undefined, clauses: undefined });
    expect(ecrireFamilles([f('true', 'VIP')])).toMatchObject({ match: undefined, clauses: undefined });
    // La famille d'origine retirée : il n'en reste qu'une, ajoutée, qui ne se « replie » pas sur l'ancienne forme
    // (sa poignée est `famille:k2`, l'ancienne forme la renommerait en `true` et décrocherait son arête).
    expect(ecrireFamilles([f('k2')])).toMatchObject({ familles: [f('k2')] });
  });

  it('🔴 ce qui est écrit se RELIT à l’identique : aucune poignée ne change à l’aller-retour', () => {
    for (const liste of [[f('true')], [f('true'), f('k2', 'Gold'), f('k3')], [f('k3'), f('true', 'VIP')], [f('k2')]]) {
      const data = JSON.parse(JSON.stringify(ecrireFamilles(liste))) as Record<string, unknown>;
      expect(sortiesDeCondition({ data })).toEqual([...liste.map((x) => (x.code === 'true' ? 'true' : `famille:${x.code}`)), 'false']);
    }
  });
});

describe('le nom d’une famille à l’écran', () => {
  it('le nom donné, sinon « Si réunie » pour la famille d’origine, sinon « Famille N »', () => {
    expect(nomDeFamille(f('true', '  VIP '), 0, 'fr')).toBe('VIP');
    expect(nomDeFamille(f('true'), 0, 'fr')).toBe('Si réunie');
    expect(nomDeFamille(f('true'), 0, 'en')).toBe('If met');
    expect(nomDeFamille(f('k3'), 2, 'fr')).toBe('Famille 3');
    expect(nomDeFamille(f('k3'), 2, 'en')).toBe('Group 3');
  });

  it('🔴 le nom se lit TEL QU’IL EST SAISI : un espace en fin de frappe ne disparaît pas', () => {
    expect(famillesDeCondition({ familles: [{ code: 'k2', nom: 'Pays ', groupe: {} }] })[0]!.nom).toBe('Pays ');
  });

  it('le libellé d’une flèche du canevas : la famille, « Sinon », ou rien pour une poignée étrangère', () => {
    const data = { familles: [f('true', 'VIP'), f('k2')] };
    expect(libelleSortieDeCondition({ data }, 'true', 'fr')).toBe('VIP');
    expect(libelleSortieDeCondition({ data }, 'famille:k2', 'fr')).toBe('Famille 2');
    expect(libelleSortieDeCondition({ data }, 'false', 'fr')).toBe('Sinon');
    expect(libelleSortieDeCondition({ data }, 'btn:0', 'fr')).toBeNull();
    // Un bloc d'avant : ses deux sorties d'hier.
    expect(libelleSortieDeCondition({ data: { clauses: [] } }, 'true', 'fr')).toBe('Si réunie');
  });
});

describe('les poignées', () => {
  it('une poignée de famille se reconnaît, « Sinon » et les autres non', () => {
    expect(['true', 'famille:k2'].every(estPoigneeDeFamille)).toBe(true);
    expect(['false', 'btn:0', 'libre', ''].some(estPoigneeDeFamille)).toBe(false);
  });

  it('un code neuf ne reprend jamais un code du bloc', () => {
    const tirages = [0.5, 0.5, 0.25];
    const code = nouveauCodeDeFamille([nouveauCodeDeFamille([], () => 0.5)], () => tirages.shift()!);
    expect(code).toBe(nouveauCodeDeFamille([], () => 0.25));
    expect(code).toMatch(/^f[0-9a-z]{6}$/);
    expect(nouveauCodeDeFamille([])).not.toBe('true');
  });
});
