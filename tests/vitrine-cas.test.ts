import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DROITS } from '../src/offres/offres';
import { TYPES_ABONNABLES } from '../src/evenements/types';
import { CATALOGUE_MCP } from '../web/lib/partage/catalogue-mcp';
import { PAGES_DOC } from '../web/lib/doc-api-pages';
import { ENTREES } from '../web/lib/registre-vitrine';
import { extraitDe, fichierDe, llmsAvecCas, pagesGenerees } from '../scripts/vitrine/cas';
import { TEXTES_CARREFOUR, TEXTES_CAS } from '../scripts/vitrine/cas-textes';
import { OUTILS } from '../src/mcp/outils';
import { SITE, lire, parAttribut, texte } from './vitrine-lecture';

/**
 * LES PAGES DE CAS D'USAGE DISENT CE QUE LE PRODUIT FAIT (lots 6 et 6 bis). Générées par `npm run vitrine:cas`
 * (`scripts/vitrine/cas.ts`), depuis leurs textes, le registre et le code compilé des cas : ce test exige chaque page
 * égale à sa génération, et chaque nom qu'elle cite, chaque chiffre qu'elle marque, réel.
 */
const OPENAPI = JSON.parse(readFileSync(resolve(__dirname, '..', 'sdk', 'openapi.json'), 'utf8')) as { paths: Record<string, Record<string, unknown>> };
const ATTENDU: Record<string, number> = {
  'base.envois-modeles-mois': DROITS.base.limites.envoisModelesMois ?? NaN,
  'base.contacts': DROITS.base.limites.contacts ?? NaN,
};
const enLigne = ENTREES.filter((e) => e.enLigne && e.nature === 'cas');
const pagesDe = (e: (typeof ENTREES)[number]) => [['fr', fichierDe(e.fr.adresse)], ['en', fichierDe(e.en.adresse)]] as const;

describe('les pages de cas d’usage', () => {
  it('🔴 chaque page est égale à sa génération (npm run vitrine:cas), et llms.txt porte la section des cas', () => {
    expect(enLigne.length).toBeGreaterThan(0);
    // Deux pages par cas, par secteur et par boutique en ligne, plus la page chapeau et la page Solutions (plan SEO,
    // lot 5) dans chaque langue : une génération vide ne passe pas.
    const secteurs = ENTREES.filter((e) => e.enLigne && e.nature === 'secteur');
    const boutiques = ENTREES.filter((e) => e.enLigne && e.nature === 'boutique');
    expect(secteurs.length).toBeGreaterThan(0);
    expect(boutiques.length).toBeGreaterThan(0);
    expect(pagesGenerees().length).toBe(enLigne.length * 2 + secteurs.length * 2 + boutiques.length * 2 + 2 + 2);
    for (const { chemin, contenu } of pagesGenerees()) expect(lire(chemin), chemin).toBe(contenu);
    expect(llmsAvecCas(lire('llms.txt'))).toBe(lire('llms.txt'));
  });

  for (const e of enLigne) {
    for (const [langue, chemin] of pagesDe(e)) {
      describe(chemin, () => {
        const html = lire(chemin);

        it('🔴 chaque nom cité existe : outil du catalogue MCP, route du contrat, type d’événement abonnable', () => {
          // Les noms cités dans le texte ; les blocs <pre> (la phrase à taper, l'extrait) sont vérifiés à part.
          const sansBlocs = html.replace(/<pre[\s\S]*?<\/pre>/g, '');
          const codes = [...sansBlocs.matchAll(/<code>([^<]+)<\/code>/g)].map((m) => m[1]!.trim());
          expect(codes.length).toBeGreaterThan(0);
          for (const c of codes) {
            const route = /^(GET|POST|PATCH|PUT|DELETE) (\/v1\/\S+)$/.exec(c);
            if (route) { expect(OPENAPI.paths[route[2]!]?.[route[1]!.toLowerCase()], c).toBeDefined(); continue; }
            if (/^[a-z]+(\.[a-z_]+)+$/.test(c)) { expect(TYPES_ABONNABLES as readonly string[], c).toContain(c); continue; }
            expect(Object.keys(CATALOGUE_MCP), c).toContain(c);
          }
        });

        it('🔴 chaque chiffre marqué data-offre vaut ce que dit le code', () => {
          const marques = parAttribut(html, 'data-offre');
          // Chaque page de cas dit ce que comprend la Free, au moins le nombre de contacts.
          expect(marques.map((m) => m.valeur)).toContain('base.contacts');
          for (const { valeur, contenu } of marques) {
            expect(Object.keys(ATTENDU), `clé inconnue ${valeur}`).toContain(valeur);
            expect(Number(texte(contenu).replace(/\D/g, '')), valeur).toBe(ATTENDU[valeur]);
          }
        });

        it('l’extrait de code est celui que la suite compile, et le guide est une page déclarée de la doc', () => {
          const t = TEXTES_CAS[e.cle]![langue];
          const ex = extraitDe(e.cle, t.extrait.partie);
          const bloc = parAttribut(html, 'data-exemple').find((b) => b.valeur === `cas.${e.cle}.${t.extrait.partie}`);
          const decode = (h: string) => h.replace(/<\/?code>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
          expect(decode(bloc?.contenu ?? '')).toBe(ex.code);
          if (e.guide) {
            expect(PAGES_DOC.map((p) => p.href), e.guide).toContain(`/developers/api/guides/${e.guide}`);
            expect(html).toContain(`data-guide="${e.guide}"`);
          }
        });

        it('le titre et la description dans leurs bornes, un seul H1, un JSON-LD lisible, les fichiers du film présents', () => {
          const titre = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '';
          const description = /<meta name="description" content="([^"]*)">/.exec(html)?.[1] ?? '';
          expect(texte(titre).length, titre).toBeGreaterThan(10);
          expect(texte(titre).length, titre).toBeLessThanOrEqual(60);
          expect(texte(description).length, description).toBeGreaterThan(50);
          expect(texte(description).length, description).toBeLessThanOrEqual(155);
          expect(html.split('<h1').length - 1).toBe(1);
          for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) expect(() => JSON.parse(m[1]!)).not.toThrow();
          for (const m of html.matchAll(/(?:src|poster|data-vertical|data-affiche-verticale)="(\/films\/[^"?]+)/g)) {
            expect(existsSync(join(SITE, m[1]!.slice(1))), m[1]).toBe(true);
          }
        });
      });
    }
  }
});

describe('la page « SaaS et app builders » : ce que Claude fait sans code (plan `2026-10-28-vitrine-cas-mcp.md`)', () => {
  for (const langue of ['fr', 'en'] as const) {
    it(`🔴 ${langue} : chaque colonne a son volet Free puis son volet Pro, repliés, et chaque ligne est dans le volet de son offre`, () => {
      const c = TEXTES_CARREFOUR[langue];
      const section = lire(fichierDe(c.adresse)).match(/<section class="f-bloc" id="claude">[\s\S]*?<\/section>/)?.[0] ?? '';
      const colonnes = section.split('<span class="dev-ic').slice(1);
      expect(colonnes.length).toBe(c.claude.colonnes.length);
      // L'offre relue ici sans le module de la page : la plus petite qui ouvre la fonction de chaque outil (`null` = la Free).
      const rangs = ['base', 'pro', 'business', 'entreprise'] as const;
      const offreDe = (outils: readonly string[]) => rangs[Math.max(...outils.map((o) => {
        expect(Object.keys(CATALOGUE_MCP), o).toContain(o);
        const f = OUTILS.find((x) => x.nom === o)!.fonction;
        return rangs.findIndex((r) => f === null || DROITS[r].fonctions.has(f));
      }))]!;
      c.claude.colonnes.forEach((col, i) => {
        // Les deux volets, dans cet ordre, fermés, avec leur titre littéral (Julien, 2026-10-29).
        const volets = [...colonnes[i]!.matchAll(/<details class="hub-offre" data-etiquette="([a-z]+)">\s*<summary>([^<]*)<span class="bt-nombre">(\d+)<\/span><\/summary>([\s\S]*?)<\/details>/g)];
        expect(volets.map((v) => [v[1], v[2]!.trim()]), col.titre).toEqual([['base', c.claude.free], ['pro', c.claude.pro]]);
        expect(colonnes[i], col.titre).not.toMatch(/<details[^>]*\sopen/);
        expect(c.claude.free).toBe(langue === 'fr' ? 'Avec la Free' : 'With the Free plan');
        expect(c.claude.pro).toBe(langue === 'fr' ? 'Et en plus, avec le Pro' : 'And on top, with the Pro plan');
        for (const [, offre, , nombre, corps] of volets) {
          const attendues = col.lignes.filter((l) => offreDe(l.outils) === offre);
          const lignes = corps!.split('<li>').slice(1);
          expect(lignes.length, `${col.titre}, ${offre}`).toBe(attendues.length);
          expect(Number(nombre), `${col.titre}, ${offre}`).toBe(attendues.length);
          attendues.forEach((l, k) => {
            expect(lignes[k], l.texte).toContain(l.texte);
            for (const o of l.outils) expect(lignes[k], `${l.texte} : ${o}`).toContain(`<code>${o}</code>`);
          });
        }
        // Aucune ligne au-delà du Pro : elle n'aurait pas de volet.
        for (const l of col.lignes) expect(['base', 'pro'], l.texte).toContain(offreDe(l.outils));
      });
    });
  }
});
