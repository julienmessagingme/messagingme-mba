import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * LES FORMES DE LA CONSOLE (passe 2 de la refonte « anti-slop », 2026-09-25), GARDÉES PAR LE CODE.
 *
 * Chaque règle ci-dessous a été ramenée à la main sur toute la console ; sans garde, la première page écrite
 * par réflexe la défait. Les listes d'exceptions sont COURTES et NOMMÉES : une exception ajoutée ici se voit
 * dans le diff et se justifie.
 */

const RACINE = join(__dirname, '..', 'web');

function fichiers(dossier: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dossier)) {
    const p = join(dossier, e);
    if (statSync(p).isDirectory()) out.push(...fichiers(p));
    else if (/\.(ts|tsx)$/.test(e) && !/\.test\.ts$/.test(e)) out.push(p);
  }
  return out;
}

const SOURCES = ['app', 'components', 'lib'].flatMap((d) => fichiers(join(RACINE, d)));
const rel = (f: string): string => f.slice(RACINE.length + 1).split('\\').join('/');
/** Le code sans ses commentaires : une règle porte sur ce qui est RENDU, pas sur ce qu'une explication cite. */
const code = (f: string): string =>
  readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('Les formes de la console', () => {
  it('🔴 trois rayons déclarés, et aucun autre n’est généré', () => {
    const config = readFileSync(join(RACINE, 'tailwind.config.ts'), 'utf8');
    const bloc = config.slice(config.indexOf('borderRadius: {'), config.indexOf('}', config.indexOf('borderRadius: {')));
    const cles = [...bloc.matchAll(/^\s*([a-z]+):/gm)].map((m) => m[1]);
    // `none` n'est pas un rayon, c'est son absence (le coin d'une bulle de message).
    expect(cles).toEqual(['none', 'controle', 'carte', 'full']);
    // ⚠️ REMPLACÉ, PAS ÉTENDU : sous `extend`, les rayons de Tailwind resteraient générés à côté des nôtres.
    expect(config.indexOf('borderRadius: {')).toBeLessThan(config.indexOf('extend: {'));
  });

  it('🔴 aucune classe de rayon hors des trois (elle ne ferait rien, en silence)', () => {
    const motif = /(?<![\w:-])rounded(?:-(?:t|b|l|r|tl|tr|bl|br|s|e))?(?:-([a-z0-9]+|\[[^\]]+\]))?(?![\w\[-])/g;
    // Garde de la garde : le motif attrape les formes interdites, et laisse passer les permises.
    expect([...'rounded rounded-lg rounded-t-xl rounded-carte rounded-bl-none rounded-full'.matchAll(motif)].map((m) => m[1] ?? ''))
      .toEqual(['', 'lg', 'xl', 'carte', 'none', 'full']);
    const PERMIS = new Set(['controle', 'carte', 'full', 'none']);
    // La seule exception : le cadre d'un TÉLÉPHONE dessiné dans l'aperçu d'un formulaire WhatsApp. Son
    // arrondi est celui de l'appareil qu'il représente, pas un rayon de la console.
    const EXCEPTIONS = new Set(['components/FlowScreen.tsx : rounded-[28px]']);
    const fautifs: string[] = [];
    for (const f of SOURCES) {
      for (const lit of code(f).match(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g) ?? []) {
        for (const m of lit.matchAll(motif)) {
          if (m[1] !== undefined && PERMIS.has(m[1])) continue;
          const cle = `${rel(f)} : ${m[0]}`;
          if (!EXCEPTIONS.has(cle)) fautifs.push(cle);
        }
      }
    }
    expect(fautifs).toEqual([]);
  });

  it('🔴 deux largeurs de contenu, et seulement elles', () => {
    const fautifs: string[] = [];
    for (const f of SOURCES) {
      // La Modale a ses propres largeurs de fenêtre : ce ne sont pas des largeurs de page.
      if (rel(f) === 'components/Modale.tsx') continue;
      for (const m of code(f).matchAll(/(?<![\w-])max-w-(2xl|3xl|4xl|5xl|6xl|7xl)(?![\w-])/g)) fautifs.push(`${rel(f)} : ${m[0]}`);
    }
    expect(fautifs, 'une page prend `max-w-liste` ou `max-w-formulaire`').toEqual([]);
  });

  it('🔴 une seule modale : aucun voile `fixed inset-0` posé à la main', () => {
    // La Modale porte le voile des fenêtres, `Flottant` celui des menus (`VoileMenu`), `AppShell` le tiroir
    // de navigation sur mobile. Tout autre voile est une vingt-et-unième copie.
    const PERMIS = new Set(['components/Modale.tsx', 'components/Flottant.tsx', 'components/AppShell.tsx']);
    const fautifs = SOURCES.filter((f) => !PERMIS.has(rel(f)) && /\bfixed inset-0\b/.test(code(f))).map(rel);
    expect(fautifs).toEqual([]);
  });

  it('🔴 plus aucun `window.confirm` : la confirmation passe par la page', () => {
    const fautifs = SOURCES.filter((f) => /\bwindow\.confirm\(|(?<![.\w])confirm\(/.test(code(f))).map(rel);
    expect(fautifs).toEqual([]);
  });

  it('🔴 le pointillé est réservé aux zones de dépôt et d’ajout', () => {
    // Chaque fichier nommé porte une zone où l'on dépose un fichier ou ajoute un élément ; `analytics/cartes`
    // dessine une colonne SANS MESURE dans un graphique, et le pointillé y dit « inconnu », pas « vide ».
    const PERMIS = new Set([
      'components/CanauxServices.tsx', 'components/CarouselForm.tsx', 'components/ChampImageHebergee.tsx',
      'components/CsvImport.tsx', 'components/FlowBuilder.tsx', 'components/MbaFaqImportPanel.tsx',
      'components/MbaFilesPanel.tsx', 'components/RcsCarouselForm.tsx', 'components/analytics/cartes.tsx',
    ]);
    const fautifs = SOURCES.filter((f) => !PERMIS.has(rel(f)) && /\bborder-dashed\b/.test(code(f))).map(rel);
    expect(fautifs).toEqual([]);
  });

  it('🔴 le tiret long n’est plus une valeur : une valeur absente s’écrit « n/d »', () => {
    const fautifs: string[] = [];
    for (const f of SOURCES) {
      for (const m of code(f).matchAll(/['"`]—['"`]|>—</g)) fautifs.push(`${rel(f)} : ${m[0]}`);
    }
    expect(fautifs).toEqual([]);
  });
});
