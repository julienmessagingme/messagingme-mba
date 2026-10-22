import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { STATUTS_COMPTE, numeroNormalise, tientLeNumero, reprendAuDemarrage } from '../src/application/comptes';

/**
 * LES COMPTES DE LA FILIÈRE « APPLICATION WHATSAPP BUSINESS » (plan 2026-10-22, tâche 1). Ce qui se juge sans base :
 * les statuts (la liste du code est celle du CHECK de la migration, dérivée, jamais relue à l'œil), le numéro, et ce que
 * chaque statut implique. Ce qui demande une base (l'unicité du numéro entre espaces, la cascade) est dans
 * `tests/integration/application-comptes.integration.test.ts`.
 */
const RACINE = resolve(__dirname, '..');

describe('les statuts d’un compte', () => {
  it('la liste du code est exactement celle du CHECK de la migration', () => {
    const fichier = readdirSync(join(RACINE, 'db', 'migrations')).find((f) => f.endsWith('_comptes_application.sql'));
    expect(fichier, 'la migration des comptes de l’application').toBeDefined();
    const sql = readFileSync(join(RACINE, 'db', 'migrations', fichier!), 'utf8');
    const check = /statut\s+text\s+not null[^\n]*check\s*\(statut in \(([^)]*)\)\)/.exec(sql);
    expect(check, 'le CHECK du statut').not.toBeNull();
    const enBase = check![1]!.split(',').map((s) => s.trim().replace(/'/g, ''));
    expect(new Set(enBase)).toEqual(new Set(STATUTS_COMPTE));
  });

  it('un compte banni ou retiré ne tient plus son numéro : un autre espace peut le relier', () => {
    expect(tientLeNumero('relie')).toBe(true);
    expect(tientLeNumero('en_attente')).toBe(true);
    expect(tientLeNumero('sommeil')).toBe(true);
    expect(tientLeNumero('deconnecte')).toBe(true);
    expect(tientLeNumero('banni')).toBe(false);
    expect(tientLeNumero('retire')).toBe(false);
  });

  it('🔴 au démarrage du service, seul un compte relié reprend sa session : jamais un banni, jamais un déconnecté', () => {
    expect(STATUTS_COMPTE.filter(reprendAuDemarrage)).toEqual(['relie']);
  });
});

describe('le numéro', () => {
  it('garde les chiffres, avec l’indicatif, de 8 à 15', () => {
    expect(numeroNormalise('+44 1555 479304')).toBe('441555479304');
    expect(numeroNormalise('33612345678')).toBe('33612345678');
  });

  it('refuse le reste', () => {
    expect(numeroNormalise('1234567')).toBeNull();
    expect(numeroNormalise('1234567890123456')).toBeNull();
    expect(numeroNormalise('')).toBeNull();
    expect(numeroNormalise('pas un numéro')).toBeNull();
  });
});
