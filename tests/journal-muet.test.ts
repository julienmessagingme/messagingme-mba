import { describe, it, expect, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { journaliser } from '../src/lib/journal';

/**
 * LE JOURNAL DE FASTIFY EST MUET, ET PERSONNE NE LE VOIT (2026-09-22).
 *
 * `src/server.ts` construit Fastify en `logger: false` : `req.log` et `app.log` sont alors des fonctions vides.
 * Des appels s'en servaient sous des commentaires qui affirmaient la trace, et aucun test ne pouvait le voir :
 * un appel muet ne lève rien. Ce test inventorie le SOURCE, parce que c'est le seul endroit où le défaut se lit.
 *
 * 🔴 SUR L'ARBRE SYNTAXIQUE, PAS SUR LE TEXTE. Sa première version cherchait `req.log.x(` ligne par ligne : elle
 * n'a pas vu `reglagePrise(tenant, acteur, req.log)`, le journal passé EN VALEUR, ni `this.log.x(`,
 * `_req.log.x(`, `req.log?.x(`, un appel coupé sur deux lignes. Le relecteur les a posés les quatre dans un
 * fichier : quatre verts. Ici, tout accès à `.log` compte, quelle que soit sa forme, sauf sur `console`, `Math`
 * et `deps` (un `deps.log` est une fonction INJECTÉE, et son câblage, s'il prenait le journal de Fastify, serait
 * lui-même un accès à `.log`, donc vu).
 */
const RACINE = resolve(__dirname, '../src');
const PERMIS = new Set(['console', 'Math', 'deps']);

/** Les accès au journal d'un objet autre que ceux permis, avec leur ligne. */
function accesAuJournal(texte: string, nom = 'sonde.ts'): string[] {
  const source = ts.createSourceFile(nom, texte, ts.ScriptTarget.Latest, true);
  const trouves: string[] = [];
  const noter = (n: ts.Node, quoi: string) => {
    trouves.push(`${nom}:${source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1} ${quoi}`);
  };
  const objetPermis = (e: ts.Expression) => ts.isIdentifier(e) && PERMIS.has(e.text);
  const visiter = (n: ts.Node): void => {
    if (ts.isPropertyAccessExpression(n) && n.name.text === 'log' && !objetPermis(n.expression)) {
      noter(n, `${n.expression.getText(source)}.log`);
    }
    if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression)
      && n.argumentExpression.text === 'log' && !objetPermis(n.expression)) {
      noter(n, `${n.expression.getText(source)}['log']`);
    }
    // `const { log } = req` : le journal sorti par déstructuration.
    if (ts.isBindingElement(n) && (n.propertyName ?? n.name).getText(source) === 'log') noter(n, '{ log }');
    ts.forEachChild(n, visiter);
  };
  visiter(source);
  return trouves;
}

function fichiersTs(dossier: string): string[] {
  return readdirSync(dossier, { withFileTypes: true }).flatMap((e) => {
    const chemin = join(dossier, e.name);
    if (e.isDirectory()) return fichiersTs(chemin);
    return e.name.endsWith('.ts') ? [chemin] : [];
  });
}

describe('journal', () => {
  it('🔴 aucun accès au journal de Fastify dans src/ : il est muet, passer par `journaliser`', () => {
    const fautifs = fichiersTs(RACINE).flatMap((f) => accesAuJournal(readFileSync(f, 'utf8'), f.slice(RACINE.length + 1)));
    expect(fautifs).toEqual([]);
  });

  it('🔴 la garde voit TOUTES les formes, y compris celles qui passaient la version texte', () => {
    // Sans ce cas, une garde cassée rendrait le test précédent vert pour toujours. Chaque forme est testée
    // SEULE : une liste globale compterait juste même si l'une d'elles n'était plus vue.
    const formes = [
      'req.log.warn({ a: 1 }, "x");',
      'app.log.error({ err }, msg);',
      'this.log.info("x");',
      '_req.log.warn("x");',
      'req.log?.error("x");',
      'req\n  .log\n  .error("coupe sur trois lignes");',
      'const enfant = req.log.child({ a: 1 });',
      'reglagePrise(tenant, acteur, req.log);',
      "req['log'].warn('x');",
      'const { log } = req;',
      'const { log: journal } = request;',
    ];
    for (const forme of formes) expect(accesAuJournal(forme), forme).toHaveLength(1);
  });

  it('et elle laisse passer ce qui écrit vraiment', () => {
    for (const sain of ['console.log("x");', 'Math.log(2);', 'deps.log("x");', 'journaliser("error", "x", {});', '// req.log.warn("commentaire")']) {
      expect(accesAuJournal(sain), sain).toEqual([]);
    }
  });

  it('une Error garde son message, sa CAUSE sur un niveau, et sa pile au niveau error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const coupure = new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND ai-gateway.vercel.sh'), { code: 'ENOTFOUND' }) });
    journaliser('error', 'sonde', { err: coupure, tenant: 't1' });
    const ligne = JSON.parse(String(spy.mock.calls[0]![0])) as Record<string, unknown>;
    spy.mockRestore();
    // `JSON.stringify(new Error('x'))` rend `{}` : c'est précisément ce que cette fonction évite.
    expect(ligne).toMatchObject({ lvl: 'error', msg: 'sonde', err: 'fetch failed', tenant: 't1' });
    expect(ligne.errCause).toBe('ENOTFOUND getaddrinfo ENOTFOUND ai-gateway.vercel.sh');
    expect(String(ligne.stack)).toContain('fetch failed');
  });

  it('🔴 elle ne lève jamais, et un champ illisible n’emporte pas ses voisins', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const circulaire: Record<string, unknown> = {};
    circulaire.moi = circulaire;
    // Une pile dont la LECTURE lève : ce qu'on obtient quand `Error.prepareStackTrace` casse.
    const piege = new Error('piege');
    Object.defineProperty(piege, 'stack', { get() { throw new Error('prepareStackTrace a levé'); } });
    expect(() => journaliser('warn', 'sonde', { circulaire, grand: 10n, tenant: 't1', err: new Error('vraie cause') })).not.toThrow();
    expect(JSON.parse(String(spy.mock.calls[0]![0]))).toEqual({
      lvl: 'warn', msg: 'sonde', circulaire: '[illisible]', grand: '[illisible]', tenant: 't1', err: 'vraie cause',
    });
    spy.mockRestore();
    const spyErreur = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => journaliser('error', 'sonde', { err: piege, tenant: 't1' })).not.toThrow();
    // La pile se perd, pas le message : c'est lui que l'on cherche en lisant le journal.
    expect(JSON.parse(String(spyErreur.mock.calls[0]![0]))).toEqual({ lvl: 'error', msg: 'sonde', err: 'piege', stack: '[illisible]', tenant: 't1' });
    spyErreur.mockRestore();
  });
});
