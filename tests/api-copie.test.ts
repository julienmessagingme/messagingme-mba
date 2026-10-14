import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { schema } from '../src/config';
import { nomDeCopie } from '../src/ops/nom-copie';

/**
 * LE NOM D'UNE COPIE DE L'API (`API_COPIE`, second banc du 2026-10-03). Deux copies qui écrivent le même nom
 * s'additionnent dans la même courbe d'attentes de `/ops` (clé primaire `(process, minute)`, cumul à
 * l'insertion), et leurs alertes se ressemblent : on ne saurait plus laquelle sature.
 */
const SOURCE = readFileSync(resolve(__dirname, '..', 'src', 'index.ts'), 'utf8');
const copie = (v?: string): unknown => schema.shape.API_COPIE.safeParse(v).data;

describe('API_COPIE', () => {
  it('vide par défaut : une copie unique garde le nom `api`, rien ne change', () => {
    expect(copie(undefined)).toBe('');
    expect(SOURCE).toContain('const NOM_API = nomDeCopie(config.API_COPIE, hostname());');
    expect(nomDeCopie('', 'mba-api')).toBe('api');
    expect(nomDeCopie('b', 'peu-importe')).toBe('api-b');
  });

  // Lot 2c de la bascule : chez Scaleway, toutes les copies d'un autoscaling reçoivent la même configuration ;
  // seul le nom d'hôte les distingue.
  it('🔴 `auto` tire le nom de la FIN du nom d’hôte, au format de API_COPIE, distinct d’une copie à l’autre', () => {
    expect(copie('auto')).toBe('auto');
    const a = nomDeCopie('auto', 'mba-api-00003-deployment-7d9c8b6f5-k2x9q');
    const b = nomDeCopie('auto', 'mba-api-00003-deployment-7d9c8b6f5-p4z7m');
    expect(a).not.toBe(b);
    for (const nom of [a, b, nomDeCopie('auto', 'Hôte_Bizarre.Avec.Points'), nomDeCopie('auto', 'x'.repeat(80))]) {
      expect(nom).toMatch(/^api-[a-z0-9-]{1,20}$/);
      expect(nom).not.toMatch(/-$/);
    }
    expect(nomDeCopie('auto', 'k2x9q')).toBe('api-k2x9q');
    expect(nomDeCopie('auto', '___')).toBe('api');
  });

  it('un nom lisible ou rien : minuscules, chiffres, tirets', () => {
    expect(copie('b')).toBe('b');
    expect(copie('copie-2')).toBe('copie-2');
    expect(schema.shape.API_COPIE.safeParse('B 2').success).toBe(false);
    expect(schema.shape.API_COPIE.safeParse('x'.repeat(21)).success).toBe(false);
  });

  it('🔴 les attentes de pool et les alertes de l’API passent par ce nom, jamais par un nom en dur', () => {
    expect(SOURCE).toContain('viderVersLaBase(poolAttentesStore, mesureAttentePool, NOM_API,');
    expect(SOURCE).not.toContain("mesureAttentePool, 'api',");
    expect(SOURCE).not.toContain('[mba-api]');
    expect(SOURCE).toContain('sendTelegram(`[mba-${NOM_API}] ${m}`)');
  });
});
