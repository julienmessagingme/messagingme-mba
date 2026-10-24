import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SITE, lire, pagesHtml, texte } from './vitrine-lecture';

/**
 * LA MARQUE SHOPIFY SUR LA VITRINE (conception `2026-10-23-vitrine-shopify-design.md`, § 5). Messaging Me n'est pas
 * Partner de Shopify : la vitrine ne fait que signaler une COMPATIBILITÉ. Les règles de marque de Shopify et les conditions
 * de son API excluent toute affiliation implicite, et un logo en couleur ou sous 80 px de large.
 *
 * Le corps de chaque page est lu sans son en-tête ni son pied (le menu nomme Shopify sur toutes les pages), phrase par
 * phrase : seule une phrase qui nomme Shopify ne peut pas dire « partenaire », « officiel » ou « certifié ».
 */
const corps = (html: string): string => texte(html
  .replace(/<header class="cadre entete">[\s\S]*?<\/header>/, '')
  .replace(/<footer class="pied">[\s\S]*?<\/footer>/, '')
  .replace(/<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<!--[\s\S]*?-->/g, ''));
const INTERDITS = /partenaire|\bpartner|officiel|official|certifi|works with shopify|approuvé par shopify|approved by shopify/i;
const LOGOS = join(SITE, 'img', 'logos');

describe('la marque Shopify sur la vitrine', () => {
  const pages = pagesHtml().filter((p) => /shopify/i.test(corps(lire(p))));

  it('des pages nomment Shopify, sinon ce test ne prouve rien', () => {
    expect(pages).toContain('integrations/index.html');
    expect(pages).toContain('en/integrations/index.html');
  });

  it('🔴 aucune phrase qui nomme Shopify ne laisse croire à une affiliation', () => {
    for (const p of pages) {
      const phrases = corps(lire(p)).split(/(?<=[.!?])\s+|\n/).filter((x) => /shopify/i.test(x));
      for (const x of phrases) expect(x, p).not.toMatch(INTERDITS);
    }
  });

  it('🔴 le logo Shopify est le monochrome du kit, sans couleur', () => {
    const fichiers = readdirSync(LOGOS).filter((f) => /shopify/i.test(f));
    expect(fichiers).toEqual(['shopify-noir.svg']);
    const svg = lire('img/logos/shopify-noir.svg');
    expect(svg).not.toMatch(/fill="#(?!000|fff)/i);
    expect(svg).not.toMatch(/<script|on[a-z]+=/i);
  });

  it('🔴 chaque logo Shopify affiché fait au moins 80 px de large, et rien d’autre ne le remplace', () => {
    let vus = 0;
    for (const p of pagesHtml()) {
      // Un logo, pas une capture de la console (`/img/aide/brancher-ma-boutique-shopify/`) : son nom, ou sa légende.
      for (const [img] of lire(p).matchAll(/<img\b[^>]*(?:alt="Shopify"|\/logos\/[^"]*shopify)[^>]*>/gi)) {
        vus++;
        expect(img, p).toContain('src="/img/logos/shopify-noir.svg"');
        expect(Number(/width="(\d+)"/.exec(img)?.[1]), `${p} : ${img}`).toBeGreaterThanOrEqual(80);
        expect(img, p).toMatch(/alt="Shopify"/);
      }
    }
    expect(vus).toBeGreaterThanOrEqual(4);
    // La feuille de style garde la même largeur que l'attribut : 80 px au moins, partout où le logo est posé.
    for (const [, largeur] of lire('site.css').matchAll(/\.logo-shopify\{[^}]*width:(\d+)px/g)) {
      expect(Number(largeur)).toBeGreaterThanOrEqual(80);
    }
  });
});
