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
 * fichier : quatre verts.
 *
 * CE QU'IL VOIT : toute forme où `log` est NOMMÉ STATIQUEMENT (propriété, `?.`, crochets à clé littérale,
 * `Reflect.get` à clé littérale, déstructuration même à clé écrite en chaîne), sur tout objet sauf `console`,
 * `Math` et `deps` (un `deps.log` est une fonction INJECTÉE, et son câblage, s'il prenait le journal de
 * Fastify, serait lui-même un accès, donc vu). CE QU'IL NE VOIT PAS : une clé calculée (`req[k]`), qu'aucune
 * lecture du source ne peut résoudre. ⚠️ Deux faux positifs possibles, aucun dans `src/` aujourd'hui : un objet
 * qui porte un champ `log` sans être un journal (`rapport.log.push(x)`), et un paramètre déstructuré
 * (`function f({ log }: Deps)`). Le jour où l'un apparaît, renommer le champ vaut mieux qu'élargir `PERMIS`.
 */
const RACINE = resolve(__dirname, '../src');
const PERMIS = new Set(['console', 'Math', 'deps']);
const SOURCE_TS = /\.[cm]?tsx?$/;

/** Le nom d'une clé quand il est écrit en toutes lettres : `log`, `'log'`, `['log']`. Sinon `null`. */
function nomStatique(n: ts.Node | undefined): string | null {
  if (!n) return null;
  if (ts.isIdentifier(n) || ts.isStringLiteralLike(n)) return n.text;
  if (ts.isComputedPropertyName(n) && ts.isStringLiteralLike(n.expression)) return n.expression.text;
  return null;
}

/** Les accès au journal d'un objet autre que ceux permis, avec leur ligne. */
function accesAuJournal(texte: string, nom = 'sonde.ts'): string[] {
  const source = ts.createSourceFile(nom, texte, ts.ScriptTarget.Latest, true, nom.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const trouves: string[] = [];
  const noter = (n: ts.Node, quoi: string) => {
    trouves.push(`${nom}:${source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1} ${quoi}`);
  };
  const objetPermis = (e: ts.Expression) => ts.isIdentifier(e) && PERMIS.has(e.text);
  const visiter = (n: ts.Node): void => {
    if (ts.isPropertyAccessExpression(n) && n.name.text === 'log' && !objetPermis(n.expression)) {
      noter(n, `${n.expression.getText(source)}.log`);
    }
    if (ts.isElementAccessExpression(n) && nomStatique(n.argumentExpression) === 'log' && !objetPermis(n.expression)) {
      noter(n, `${n.expression.getText(source)}['log']`);
    }
    // `Reflect.get(req, 'log')` : la même lecture, écrite autrement.
    if (ts.isCallExpression(n) && n.expression.getText(source) === 'Reflect.get'
      && nomStatique(n.arguments[1]) === 'log' && n.arguments[0] && !objetPermis(n.arguments[0])) {
      noter(n, 'Reflect.get(…, \'log\')');
    }
    // `const { log } = req`, `{ log: j }`, `{ 'log': j }`, `{ ['log']: j }` : le journal sorti par déstructuration.
    if (ts.isBindingElement(n) && nomStatique(n.propertyName ?? n.name) === 'log') noter(n, '{ log }');
    ts.forEachChild(n, visiter);
  };
  visiter(source);
  return trouves;
}

/** Les appels à `journaliser` dont les champs nomment l'espace `tenant` au lieu de `tenantId`. */
function cleDEspaceDivergente(texte: string, nom = 'sonde.ts'): string[] {
  const source = ts.createSourceFile(nom, texte, ts.ScriptTarget.Latest, true);
  const trouves: string[] = [];
  const visiter = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'journaliser') {
      const champs = n.arguments[2];
      if (champs && ts.isObjectLiteralExpression(champs)) {
        for (const p of champs.properties) {
          if ((ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && nomStatique(p.name) === 'tenant') {
            trouves.push(`${nom}:${source.getLineAndCharacterOfPosition(p.getStart(source)).line + 1}`);
          }
        }
      }
    }
    ts.forEachChild(n, visiter);
  };
  visiter(source);
  return trouves;
}

function fichiersSource(dossier: string): string[] {
  return readdirSync(dossier, { withFileTypes: true }).flatMap((e) => {
    const chemin = join(dossier, e.name);
    if (e.isDirectory()) return fichiersSource(chemin);
    return SOURCE_TS.test(e.name) && !e.name.endsWith('.d.ts') ? [chemin] : [];
  });
}

describe('journal', () => {
  const sources = () => fichiersSource(RACINE).map((f) => ({ nom: f.slice(RACINE.length + 1), texte: readFileSync(f, 'utf8') }));

  it('🔴 aucun accès au journal de Fastify dans src/ : il est muet, passer par `journaliser`', () => {
    expect(sources().flatMap((f) => accesAuJournal(f.texte, f.nom))).toEqual([]);
  });

  it('🔴 la garde voit TOUTES les formes nommées statiquement, y compris celles qui passaient la version texte', () => {
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
      'Reflect.get(req, "log").warn("x");',
      'const { log } = req;',
      'const { log: journal } = request;',
      "const { 'log': journal } = req;",
      "const { ['log']: journal } = req;",
    ];
    for (const forme of formes) expect(accesAuJournal(forme), forme).toHaveLength(1);
    // Et dans un composant `.tsx`, que la version d'avant ne parcourait pas.
    expect(accesAuJournal('export const A = () => { req.log.warn("x"); return <div />; };', 'a.tsx')).toHaveLength(1);
    for (const f of ['a.ts', 'a.tsx', 'a.mts', 'a.cts']) expect(SOURCE_TS.test(f), f).toBe(true);
  });

  it('et elle laisse passer ce qui écrit vraiment', () => {
    for (const sain of ['console.log("x");', 'Math.log(2);', 'deps.log("x");', 'journaliser("error", "x", {});', '// req.log.warn("commentaire")']) {
      expect(accesAuJournal(sain), sain).toEqual([]);
    }
  });

  it('🔴 l’espace s’appelle `tenantId` dans toute ligne de `journaliser`', () => {
    // Deux clés pour la même chose coupaient en deux toute recherche par espace dans les journaux.
    expect(sources().flatMap((f) => cleDEspaceDivergente(f.texte, f.nom))).toEqual([]);
    expect(cleDEspaceDivergente("journaliser('error', 'x', { err, tenant });")).toHaveLength(1);
    expect(cleDEspaceDivergente("journaliser('error', 'x', { err, tenant: t });")).toHaveLength(1);
    expect(cleDEspaceDivergente("journaliser('error', 'x', { err, tenantId: t });")).toEqual([]);
  });

  it('une Error garde son message, sa CAUSE sur un niveau, et sa pile au niveau error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const coupure = new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND ai-gateway.vercel.sh'), { code: 'ENOTFOUND' }) });
    journaliser('error', 'sonde', { err: coupure, tenantId: 't1' });
    const ligne = JSON.parse(String(spy.mock.calls[0]![0])) as Record<string, unknown>;
    spy.mockRestore();
    // `JSON.stringify(new Error('x'))` rend `{}` : c'est précisément ce que cette fonction évite.
    expect(ligne).toMatchObject({ lvl: 'error', msg: 'sonde', err: 'fetch failed', tenantId: 't1' });
    expect(ligne.errCause).toBe('ENOTFOUND getaddrinfo ENOTFOUND ai-gateway.vercel.sh');
    expect(String(ligne.stack)).toContain('fetch failed');
  });

  it('🔴 elle ne lève jamais, et un champ illisible n’emporte pas ses voisins', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const circulaire: Record<string, unknown> = {};
    circulaire.moi = circulaire;
    expect(() => journaliser('warn', 'sonde', { circulaire, grand: 10n, tenantId: 't1', err: new Error('vraie cause') })).not.toThrow();
    expect(JSON.parse(String(spy.mock.calls[0]![0]))).toEqual({
      lvl: 'warn', msg: 'sonde', circulaire: '[illisible]', grand: '[illisible]', tenantId: 't1', err: 'vraie cause',
    });
    spy.mockRestore();
  });

  it('🔴 ni une pile, ni une cause, ni un message illisibles n’emportent le reste de l’erreur', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const lire = (i: number) => JSON.parse(String(spy.mock.calls[i]![0])) as Record<string, unknown>;
    // Une pile dont la LECTURE lève : ce qu'on obtient quand `Error.prepareStackTrace` casse.
    const pile = new Error('pile piegee');
    Object.defineProperty(pile, 'stack', { get() { throw new Error('prepareStackTrace a levé'); } });
    // Une cause sans `toString`, puis une cause dont la LECTURE lève.
    const causeMuette = new Error('message utile', { cause: Object.create(null) as object });
    const causePiegee = new Error('message utile aussi');
    Object.defineProperty(causePiegee, 'cause', { get() { throw new Error('lecture impossible'); } });
    // Un message qui n'est pas une chaîne, et circulaire en plus.
    const messageObjet = new Error('x');
    const boucle: Record<string, unknown> = {};
    boucle.moi = boucle;
    Object.defineProperty(messageObjet, 'message', { value: boucle });
    for (const err of [pile, causeMuette, causePiegee, messageObjet]) {
      expect(() => journaliser('error', 'sonde', { err, tenantId: 't1' })).not.toThrow();
    }
    // La pile se perd, pas le message : c'est lui que l'on cherche en lisant le journal.
    expect(lire(0)).toEqual({ lvl: 'error', msg: 'sonde', err: 'pile piegee', stack: '[illisible]', tenantId: 't1' });
    expect(lire(1)).toMatchObject({ err: 'message utile', errCause: '[illisible]', tenantId: 't1' });
    expect(lire(2)).toMatchObject({ err: 'message utile aussi', errCause: '[illisible]', tenantId: 't1' });
    expect(lire(3)).toMatchObject({ msg: 'sonde', err: '[object Object]', tenantId: 't1' });
    spy.mockRestore();
  });
});
