import { describe, it, expect, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { journaliser } from '../src/lib/journal';

/**
 * LE JOURNAL DE FASTIFY EST MUET, ET PERSONNE NE LE VOIT (2026-09-22).
 *
 * `src/server.ts` construit Fastify en `logger: false` : `req.log` et `app.log` sont alors des fonctions vides.
 * Treize appels s'en servaient, dont la clé Gateway indéchiffrable et les verrous posés depuis `/ops`, sous
 * des commentaires qui affirmaient la trace. Aucun test ne pouvait le voir : un appel muet ne lève rien.
 * Ce test inventorie le SOURCE, pas un comportement, parce que c'est le seul endroit où le défaut se lit.
 */
const RACINE = resolve(__dirname, '../src');
const JOURNAL_FASTIFY = /\b(req|request|reply|app|fastify|server|instance)\.log\.(trace|debug|info|warn|error|fatal)\(/;

function fichiersTs(dossier: string): string[] {
  return readdirSync(dossier, { withFileTypes: true }).flatMap((e) => {
    const chemin = join(dossier, e.name);
    if (e.isDirectory()) return fichiersTs(chemin);
    return e.name.endsWith('.ts') ? [chemin] : [];
  });
}

describe('journal', () => {
  it('🔴 aucun appel au journal de Fastify dans src/ : il est muet, passer par `journaliser`', () => {
    const fautifs = fichiersTs(RACINE).flatMap((f) => readFileSync(f, 'utf8').split(/\r?\n/)
      .map((ligne, i) => ({ ligne, i }))
      .filter(({ ligne }) => JOURNAL_FASTIFY.test(ligne) && !ligne.trim().startsWith('//') && !ligne.trim().startsWith('*'))
      .map(({ i }) => `${f.slice(RACINE.length + 1)}:${i + 1}`));
    expect(fautifs).toEqual([]);
  });

  it('la garde reconnaît bien les formes qu’elle interdit', () => {
    // Sans ce cas, une expression rationnelle cassée rendrait le test précédent vert pour toujours.
    for (const l of ['req.log.warn({ a: 1 }, "x")', '  app.log.error({ err }, msg);', 'request.log.info("x")']) {
      expect(JOURNAL_FASTIFY.test(l), l).toBe(true);
    }
    expect(JOURNAL_FASTIFY.test('journaliser("error", "x", {})')).toBe(false);
  });

  it('une Error garde son message, et sa pile au niveau error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    journaliser('error', 'sonde', { err: new Error('connexion perdue'), tenant: 't1' });
    const ligne = JSON.parse(String(spy.mock.calls[0]![0])) as Record<string, unknown>;
    spy.mockRestore();
    // `JSON.stringify(new Error('x'))` rend `{}` : c'est précisément ce que cette fonction évite.
    expect(ligne).toMatchObject({ lvl: 'error', msg: 'sonde', err: 'connexion perdue', tenant: 't1' });
    expect(String(ligne.stack)).toContain('connexion perdue');
  });

  it('elle ne lève jamais, même sur une valeur que JSON ne sait pas écrire', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const circulaire: Record<string, unknown> = {};
    circulaire.moi = circulaire;
    expect(() => journaliser('warn', 'sonde', { circulaire, grand: 10n })).not.toThrow();
    expect(JSON.parse(String(spy.mock.calls[0]![0]))).toEqual({ lvl: 'warn', msg: 'sonde', champsIllisibles: true });
    spy.mockRestore();
  });
});
