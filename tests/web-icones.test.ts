import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * LES ICÔNES DE LA CONSOLE : UNE FAMILLE (Phosphor), UNE ÉPAISSEUR, UNE TAILLE PAR CONTEXTE (passe 2 de la
 * refonte, 2026-09-25). La console mélangeait des emojis posés comme icônes, des tracés SVG écrits à la main
 * en six épaisseurs et des flèches Unicode. `web/components/Icone.tsx` est désormais le seul point d'entrée.
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
const code = (f: string): string =>
  readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('Les icônes de la console', () => {
  it('🔴 seul `components/Icone.tsx` importe Phosphor : c’est lui qui tient l’épaisseur et les tailles', () => {
    const fautifs = SOURCES.filter((f) => rel(f) !== 'components/Icone.tsx' && /@phosphor-icons\/react/.test(code(f))).map(rel);
    expect(fautifs).toEqual([]);
    const icone = readFileSync(join(RACINE, 'components', 'Icone.tsx'), 'utf8');
    // Une seule épaisseur, écrite une fois.
    expect([...icone.matchAll(/weight="([a-z]+)"/g)].map((m) => m[1])).toEqual(['regular']);
  });

  it('🔴 aucun emoji utilisé comme icône dans le code de la console', () => {
    // Les emojis qui restent sont du CONTENU : la table du sélecteur d'emojis, et des exemples de message
    // (un placeholder, une réponse d'agent montrée dans un aperçu) que le destinataire verrait tels quels.
    const CONTENU = new Set([
      'lib/emojis.ts', 'components/SelecteurEmojis.tsx', 'components/CarouselForm.tsx', 'components/TemplateForm.tsx',
      'components/PubApercu.tsx',
    ]);
    const fautifs: string[] = [];
    for (const f of SOURCES) {
      if (CONTENU.has(rel(f))) continue;
      for (const m of code(f).matchAll(/\p{Extended_Pictographic}/gu)) fautifs.push(`${rel(f)} : ${m[0]}`);
    }
    expect(fautifs).toEqual([]);
  });

  it('🔴 aucun tracé d’icône écrit à la main : un `<svg>` n’est plus qu’un logo, un graphique ou un aperçu', () => {
    const PERMIS = new Set([
      // Logos de marque.
      'components/Logo.tsx', 'components/LogosCanaux.tsx', 'lib/logos-llm.ts',
      // Graphiques de données.
      'components/DailyChart.tsx', 'components/NuageQualitatifCard.tsx', 'components/TableauHistogramme.tsx',
      'components/ConversationAnalysisCard.tsx',
      // Maquettes de ce que le destinataire verra.
      'components/WhatsAppPreview.tsx', 'components/PubApercu.tsx',
    ]);
    const fautifs = SOURCES.filter((f) => !PERMIS.has(rel(f)) && /<svg\b/.test(code(f))).map(rel);
    expect(fautifs).toEqual([]);
    // La barre de navigation désigne ses icônes par leur NOM, plus par un tracé.
    expect(readFileSync(join(RACINE, 'lib', 'nav.ts'), 'utf8')).not.toMatch(/:\s*'M[\d.]/);
  });
});
