import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EXEMPLES_CAS, EXEMPLES_SDK, RECETTE_NEXTJS, VERSION_SDK, type ExempleCode } from '../web/lib/exemples-code';

/**
 * 🔴 LE CODE QUE LA DOC MONTRE COMPILE CONTRE LE SDK QUE LA DOC FAIT INSTALLER (lot 17 ; ferme le jaune « exemples non
 * compilés » du lot 16).
 *
 * Les exemples de la page SDK et la recette Next.js sont écrits dans un projet temporaire, puis `tsc` les compile en
 * strict contre les déclarations de la version PUBLIÉE (`tests/sdk-publie/`, recopiées du dépôt `messagingme-sdk` à son
 * étiquette), pas contre `sdk/src` : `sdk/src` peut avoir un temps d'avance (la livraison A du lot 17 y a ajouté
 * `ApiError.metaCode` avant toute publication), et une recette qui l'utiliserait ne compilerait pas chez l'intégrateur,
 * qui installe l'étiquette. La relecture de B l'a trouvé ; ce test le fait tenir.
 *
 * ⚠️ À CHAQUE PUBLICATION du SDK : recopier `dist/index.d.ts` et `dist/schema.d.ts` de l'étiquette dans
 * `tests/sdk-publie/`, mettre sa version dans `version.txt`, et monter `VERSION_SDK` (`web/lib/exemples-code.ts`).
 */
const racine = fileURLToPath(new URL('..', import.meta.url));
const tsc = join(racine, 'node_modules', 'typescript', 'bin', 'tsc');

function compiler(exemples: readonly ExempleCode[]): string {
  const dossier = mkdtempSync(join(tmpdir(), 'doc-exemples-'));
  try {
    for (const e of exemples) {
      const chemin = join(dossier, e.fichier);
      mkdirSync(dirname(chemin), { recursive: true });
      writeFileSync(chemin, e.contexte ? `${e.contexte}\n${e.code}\n` : `${e.code}\n`);
    }
    writeFileSync(join(dossier, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler',
        lib: ['ES2022', 'DOM'], skipLibCheck: true, types: ['node'], typeRoots: [join(racine, 'node_modules', '@types')],
        paths: { '@messagingme/sdk': [join(racine, 'tests', 'sdk-publie', 'index.d.ts')] },
      },
      include: ['**/*.ts'],
    }));
    try {
      execFileSync(process.execPath, [tsc, '-p', join(dossier, 'tsconfig.json')], { stdio: 'pipe' });
      return '';
    } catch (e) {
      const err = e as { stdout?: Buffer };
      return err.stdout?.toString() ?? String(e);
    }
  } finally {
    rmSync(dossier, { recursive: true, force: true });
  }
}

/**
 * Les cas d'usage (lots 6 et 6 bis), chacun dans SON dossier : deux cas qui reçoivent un webhook écrivent le même
 * chemin (`app/api/webhooks/messagingme/route.ts`), et compilés ensemble, le dernier écrit masquerait le premier.
 */
function compilerChaqueCas(cas: Readonly<Record<string, Readonly<Record<string, ExempleCode>>>>): Record<string, string> {
  return Object.fromEntries(Object.entries(cas).map(([cle, parties]) => [cle, compiler(Object.values(parties))]));
}

describe('le code montré par la doc compile contre le SDK publié', () => {
  it('🔴 les déclarations recopiées sont celles de la version que la doc fait installer', () => {
    expect(readFileSync(join(racine, 'tests', 'sdk-publie', 'version.txt'), 'utf8').trim()).toBe(VERSION_SDK);
  });

  it('le README du SDK reprend les exemples compilés, mot pour mot', () => {
    // Le README part avec chaque version publiée : un exemple qu'il réécrirait à côté du module échapperait à la
    // compilation ci-dessous (la 0.1.0 publiée envoyait un modèle à deux variables sans params).
    const readme = readFileSync(join(racine, 'sdk', 'README.md'), 'utf8').replace(/\r\n/g, '\n');
    for (const [cle, e] of Object.entries(EXEMPLES_SDK)) expect(readme, cle).toContain(e.code);
  });

  it('les exemples de la page SDK', () => {
    expect(compiler(Object.values(EXEMPLES_SDK))).toBe('');
  }, 60_000);

  it('la recette Next.js', () => {
    expect(compiler(Object.values(RECETTE_NEXTJS))).toBe('');
  }, 60_000);

  it('chaque cas d’usage, dans son propre dossier', () => {
    for (const [cle, erreurs] of Object.entries(compilerChaqueCas(EXEMPLES_CAS))) expect(erreurs, cle).toBe('');
  }, 120_000);

  it('garde de la garde : deux cas qui écrivent le même fichier ne se masquent pas', () => {
    const faux: ExempleCode = { ...RECETTE_NEXTJS.envoi, code: RECETTE_NEXTJS.envoi.code.replace('envoi.sendId', 'envoi.sendIdentifiant') };
    const resultats = compilerChaqueCas({
      casFaux: { client: RECETTE_NEXTJS.client, envoi: faux },
      casJuste: { client: RECETTE_NEXTJS.client, envoi: RECETTE_NEXTJS.envoi },
    });
    expect(resultats.casFaux).toMatch(/sendIdentifiant/);
    expect(resultats.casJuste).toBe('');
  }, 120_000);

  it('garde de la garde : un champ inventé ne compile pas', () => {
    const faux: ExempleCode = { ...RECETTE_NEXTJS.envoi, code: RECETTE_NEXTJS.envoi.code.replace('envoi.sendId', 'envoi.sendIdentifiant') };
    expect(faux.code).not.toBe(RECETTE_NEXTJS.envoi.code);
    expect(compiler([RECETTE_NEXTJS.client, faux])).toMatch(/sendIdentifiant/);
  }, 60_000);
});
