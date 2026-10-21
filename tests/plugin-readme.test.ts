import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CONSTRUIRE } from '../scripts/plugin/construire';
import { FAMILLES_OUTILS } from '../scripts/plugin/familles-outils';
import { PAGES_FAQ, blocConstruireVitrine, commandesPubliees, hrefCapacite, pageAvecConstruire, readmeAJour } from '../scripts/plugin/generer';
import { CATALOGUE_MCP } from '../web/lib/partage/catalogue-mcp';
import { PAGES_DOC } from '../web/lib/doc-api-pages';
import { ENTREES } from '../web/lib/registre-vitrine';

/**
 * CE QUE VOUS POUVEZ CONSTRUIRE, ET LE README DU PLUGIN (Julien, 2026-10-21). Une source par bloc
 * (`scripts/plugin/construire.ts`, `familles-outils.ts`, les constantes de l'offre), des copies générées par
 * `npm run plugin:generer` : la page développeurs en français et en anglais, et `plugin/README.md`.
 */
const RACINE = resolve(__dirname, '..');
const lire = (p: string) => readFileSync(resolve(RACINE, p), 'utf8');

describe('la source', () => {
  it('chaque cas d’usage en ligne du registre a sa ligne, et chaque ligne de cas mène à un cas en ligne', () => {
    const cites = CONSTRUIRE.flatMap((f) => f.capacites.flatMap((c) => ('cas' in c.lien ? [c.lien.cas] : [])));
    const enLigne = ENTREES.filter((e) => e.nature === 'cas' && e.enLigne && !e.attente).map((e) => e.cle);
    expect(new Set(cites)).toEqual(new Set(enLigne));
  });

  it('chaque lien mène à une page qui existe : la vitrine dans les deux langues, la documentation de la console', () => {
    for (const langue of ['fr', 'en'] as const) {
      for (const c of CONSTRUIRE.flatMap((f) => f.capacites)) {
        const href = hrefCapacite(c.lien, langue);
        if (href.startsWith('/')) expect(existsSync(join(RACINE, 'site', href, 'index.html')), href).toBe(true);
        else {
          const url = new URL(href);
          expect(url.origin).toBe('https://console.messagingme.app');
          expect(PAGES_DOC.map((p) => p.href)).toContain(url.pathname);
          expect(url.searchParams.get('lang')).toBe(langue === 'en' ? 'en' : null);
        }
      }
    }
  });

  it('chaque outil du catalogue est rangé dans une famille, et une seule', () => {
    const ranges = FAMILLES_OUTILS.flatMap((f) => f.outils);
    expect(ranges.length).toBe(new Set(ranges).size);
    expect(new Set(ranges)).toEqual(new Set(Object.keys(CATALOGUE_MCP)));
  });
});

describe('les copies sont à jour (sinon : npm run plugin:generer)', () => {
  it('les deux pages développeurs portent la section, à jour', () => {
    for (const { chemin, langue } of PAGES_FAQ) {
      const html = lire(chemin);
      expect(html, chemin).toContain(blocConstruireVitrine(langue));
      expect(pageAvecConstruire(html, langue)).toBe(html);
    }
  });

  it('le README du plugin porte ses blocs générés, à jour, et le film en tête', () => {
    const md = lire('plugin/README.md');
    expect(readmeAJour(md)).toBe(md);
    for (const nom of ['construire', 'prix', 'contenu', 'outils']) expect(md, nom).toContain(`<!-- ${nom}:debut`);
    // « What's inside » cite chaque commande de cas publiée, que `plugin/skills/` porte vraiment.
    for (const nom of commandesPubliees()) expect(md).toContain(`\`/messagingme:${nom}\``);
    expect(md).toContain('https://app.messagingme.fr/img/plugin-demo.gif');
    expect(existsSync(join(RACINE, 'site/img/plugin-demo.gif'))).toBe(true);
  });
});
