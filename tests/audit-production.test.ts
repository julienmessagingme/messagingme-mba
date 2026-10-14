import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { jugerAudit, type ExceptionAudit, type RapportAudit } from '../scripts/audit-production';

/**
 * L'AUDIT BLOQUANT DES DÉPENDANCES DE PRODUCTION (`scripts/audit-production.ts`, lot 6 B2) : ce qui bloque, ce qu'une
 * exception datée excuse, et quand elle cesse de l'excuser.
 */
const avis = (id: string, severity: string, name = 'paquet') => ({
  name, severity, title: `titre ${id}`, url: `https://github.com/advisories/${id}`, range: '<=1.0.0',
});
const rapport = (...via: Array<ReturnType<typeof avis> | string>): RapportAudit => ({ vulnerabilities: { paquet: { via } } });
const exception = (avisId: string, jusquau: string): ExceptionAudit => ({ avis: avisId, dossier: '.', paquet: 'paquet', raison: 'pourquoi', jusquau });

describe('jugerAudit', () => {
  it('🔴 un avis haut ou critique sans exception BLOQUE', () => {
    const v = jugerAudit(rapport(avis('GHSA-aaaa', 'high'), avis('GHSA-bbbb', 'critical')), [], '2026-10-14');
    expect(v.bloquants).toHaveLength(2);
    expect(v.bloquants[0]).toContain('GHSA-aaaa');
  });

  it('une exception valide excuse l’avis, jusqu’à son dernier jour compris', () => {
    const v = jugerAudit(rapport(avis('GHSA-aaaa', 'high')), [exception('GHSA-aaaa', '2026-10-14')], '2026-10-14');
    expect(v.bloquants).toEqual([]);
    expect(v.excuses).toHaveLength(1);
  });

  it('🔴 une exception échue BLOQUE de nouveau, en le disant', () => {
    const v = jugerAudit(rapport(avis('GHSA-aaaa', 'high')), [exception('GHSA-aaaa', '2026-10-13')], '2026-10-14');
    expect(v.bloquants).toHaveLength(1);
    expect(v.bloquants[0]).toContain('exception échue le 2026-10-13');
  });

  it('les gravités moindres et les renvois vers un autre paquet ne bloquent pas', () => {
    const v = jugerAudit(rapport(avis('GHSA-aaaa', 'moderate'), avis('GHSA-bbbb', 'low'), 'autre-paquet'), [], '2026-10-14');
    expect(v.bloquants).toEqual([]);
  });

  it('une exception qui ne sert plus est signalée, sans bloquer', () => {
    const v = jugerAudit(rapport(), [exception('GHSA-zzzz', '2026-12-31')], '2026-10-14');
    expect(v.bloquants).toEqual([]);
    expect(v.inutiles).toEqual(['GHSA-zzzz (paquet)']);
  });

  it('🔴 un rapport illisible (registre injoignable) ne passe pas pour un rapport vide', () => {
    expect(() => jugerAudit({} as RapportAudit, [], '2026-10-14')).toThrow(/illisible/);
  });
});

describe('la CI tient ses seuils', () => {
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  /** Le bloc d'une étape, de sa ligne `- name:` à l'étape suivante. */
  const etape = (nom: string): string => {
    const debut = ci.indexOf(`      - name: ${nom}\n`);
    expect(debut, `étape introuvable : ${nom}`).toBeGreaterThan(0);
    const suite = ci.indexOf('\n      - ', debut + 1);
    return ci.slice(debut, suite < 0 ? undefined : suite);
  };

  it('🔴 les contrôles annoncés bloquants le sont : aucun `continue-on-error`, et ils jouent ce qu’il faut', () => {
    // Un `continue-on-error` ajouté pour faire taire un rouge rendrait le seuil décoratif, en silence.
    const api = etape('Dependances de PRODUCTION de l API (npm audit, bloquant)');
    const console_ = etape('Dependances de PRODUCTION de la console (npm audit, bloquant)');
    const image = etape('Image de l API, failles critiques (trivy, bloquant)');
    const imageConsole = etape('Image de la console, failles critiques (trivy, bloquant)');
    for (const bloc of [api, console_, image, imageConsole]) expect(bloc).not.toContain('continue-on-error');
    expect(api).toContain('npx tsx scripts/audit-production.ts .');
    expect(console_).toContain('npx tsx scripts/audit-production.ts web');
    expect(image).toMatch(/--severity CRITICAL .*--exit-code 1 .*mba-api:ci/);
    expect(imageConsole).toMatch(/--severity CRITICAL .*--exit-code 1 .*mba-web:ci/);
  });
});

describe('le fichier des exceptions', () => {
  const exceptions = JSON.parse(readFileSync(new URL('../scripts/audit-exceptions.json', import.meta.url), 'utf8')) as ExceptionAudit[];

  it('chaque exception nomme son avis, son paquet, sa raison et une échéance réelle', () => {
    for (const e of exceptions) {
      expect(e.avis, JSON.stringify(e)).toMatch(/^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/);
      expect(['.', 'web'], e.avis).toContain(e.dossier);
      expect(e.paquet.trim(), e.avis).not.toBe('');
      expect(e.raison.trim().length, e.avis).toBeGreaterThan(20);
      expect(e.jusquau, e.avis).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(e.jusquau)), e.avis).toBe(false);
    }
  });
});
