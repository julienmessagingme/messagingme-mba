import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { adresseCapture, adressesAide, fichierCommentFaire, llmsAvecAide, motsDeRecherche, pagesAide, sitemapAvecAide } from '../scripts/vitrine/aide';
import { pagesDuCentre } from '../scripts/vitrine/aide-pages';
import { structureFiche } from '../src/aide/structure';
import { PAGES_CLAUDE } from '../scripts/vitrine/aide-claude-textes';
import { CATALOGUE_MCP } from '../web/lib/partage/catalogue-mcp';
import { OUTILS } from '../src/mcp/outils';
import { DROITS } from '../src/offres/offres';
import { SITE, lire, pagesHtml, parAttribut, texte } from './vitrine-lecture';

/**
 * LE CENTRE D'AIDE DE LA VITRINE (plan du centre d'aide, tâche 5). Ses pages sont GÉNÉRÉES depuis les fiches publiques
 * (`npm run vitrine:aide`) : la fiche est la seule source, le bot d'aide lit la même. Rien ne relie la page publiée à sa
 * fiche sinon ce test.
 */
const generees = pagesAide();
const centre = pagesDuCentre();

describe('le centre d’aide de la vitrine', () => {
  it('l’accueil et une page par fiche publique, dans les deux langues', () => {
    expect(centre.length).toBe(9);
    expect(generees.length).toBe(2 * (1 + centre.length + PAGES_CLAUDE.length));
  });

  for (const { chemin, contenu } of generees) {
    it(`${chemin} est égale à sa génération (npm run vitrine:aide)`, () => {
      expect(existsSync(join(SITE, chemin)), chemin).toBe(true);
      expect(lire(chemin)).toBe(contenu);
    });
  }

  it('rien d’autre sous site/aide/ ni site/en/help/', () => {
    const aide = (p: string) => p.startsWith('aide/') || p.startsWith('en/help/');
    expect(new Set(pagesHtml().filter(aide))).toEqual(new Set(generees.map((g) => g.chemin).filter(aide)));
  });

  it('sous les pages développeurs : l’accueil, le guide Meta et les pages Claude Code, rien d’autre', () => {
    const dev = (p: string) => p.startsWith('developpeurs/') || p.startsWith('en/developers/');
    const attendues = ['developpeurs/index.html', 'developpeurs/compte-meta-business/index.html', 'en/developers/index.html',
      'en/developers/meta-business-account/index.html', ...generees.map((g) => g.chemin).filter(dev)];
    expect(new Set(pagesHtml().filter(dev))).toEqual(new Set(attendues));
  });

  it('chaque page montre autant d’étapes que sa fiche, et replie le détail sous « En détail »', () => {
    for (const p of centre) {
      for (const langue of ['fr', 'en'] as const) {
        const html = lire(`${p[langue].adresse.slice(1)}index.html`);
        const etapes = structureFiche(p[langue].corps, langue).sections.filter((s) => s.type === 'etape');
        expect(html.split('class="aide-etape').length - 1, `${p.cle} ${langue}`).toBe(etapes.length);
        const avecDetail = etapes.filter((e) => e.detail.length > 0).length;
        expect(html.split('<details class="aide-detail">').length - 1, `${p.cle} ${langue}`).toBe(avecDetail);
      }
    }
  });

  it('chaque étape d’une page à captures a la sienne dans les deux langues, et rien d’orphelin sous site/img/aide/', () => {
    // Les captures se refont par `npm run aide:captures` (la console réelle, des données inventées) ; une étape ajoutée
    // à une fiche sans sa capture, ou une capture d’une étape retirée, se voit ici.
    const attendues: string[] = [];
    for (const p of centre) {
      if (!p.publication.captures) continue;
      for (const langue of ['fr', 'en'] as const) {
        for (const s of structureFiche(p[langue].corps, langue).sections) {
          if (s.type === 'etape') attendues.push(adresseCapture(p.cle, s.numero, langue).slice(1));
        }
      }
    }
    expect(attendues.length).toBeGreaterThan(0);
    const dossier = join(SITE, 'img', 'aide');
    const presentes = existsSync(dossier)
      ? readdirSync(dossier, { recursive: true, withFileTypes: true }).filter((f) => f.isFile())
        .map((f) => join(f.parentPath, f.name).slice(SITE.length + 1).split(sep).join('/'))
      : [];
    expect(presentes.sort()).toEqual(attendues.sort());
  });

  it('chaque capture s’ouvre en grand d’un clic, et change d’adresse avec son contenu', () => {
    // Dans la page, une capture fait un tiers de sa taille : le lien mène à l'image entière. Son `?v=` est l'empreinte
    // du fichier, la vitrine gardant les images un jour en cache chez le visiteur (`site/vercel.json`).
    let vues = 0;
    for (const { chemin, contenu } of generees) {
      for (const m of contenu.matchAll(/<img src="(\/img\/aide\/[^"?]+)\?v=([^"]+)"/g)) {
        vues++;
        const empreinte = createHash('sha256').update(readFileSync(join(SITE, m[1]!))).digest('hex').slice(0, 8);
        expect(m[2], `${chemin} ${m[1]}`).toBe(empreinte);
        expect(contenu, `${chemin} ${m[1]}`).toContain(`<a class="aide-capture" href="${m[1]}?v=${empreinte}"`);
      }
    }
    expect(vues).toBe(58);
  });

  it('chaque lien interne d’une page d’aide mène à une page qui existe', () => {
    for (const { chemin } of generees) {
      for (const m of lire(chemin).matchAll(/href="(\/[^"#?]*)/g)) {
        const cible = m[1]!;
        const fichier = cible.endsWith('/') ? join(SITE, cible, 'index.html') : join(SITE, cible);
        expect(existsSync(fichier), `${chemin} -> ${cible}`).toBe(true);
      }
    }
  });

  it('la mention de l’offre est sur chaque page, sauf celles qui ne demandent pas le Pro', () => {
    for (const p of centre) {
      const html = lire(`${p.fr.adresse.slice(1)}index.html`);
      expect(html.includes('class="aide-offre"'), p.cle).toBe(p.publication.offre);
    }
    expect(centre.filter((p) => !p.publication.offre).map((p) => p.cle).sort()).toEqual(['ce-qu-il-faut-chez-meta', 'choisir-mon-offre', 'la-fenetre-de-24-heures']);
  });

  it('le plan du site et llms.txt citent chaque page, et sont à jour', () => {
    expect(lire('sitemap.xml')).toBe(sitemapAvecAide(lire('sitemap.xml')));
    expect(lire('llms.txt')).toBe(llmsAvecAide(lire('llms.txt')));
    for (const a of adressesAide()) {
      expect(lire('sitemap.xml'), a).toContain(`<loc>${a}</loc>`);
      expect(lire('llms.txt'), a).toContain(`(${a})`);
    }
  });

  it('une recherche tapée sans accents trouve la page (Review Focus 3)', () => {
    expect(motsDeRecherche('Faire approuver un **modèle**')).toBe('faire approuver un modele');
    const html = lire('aide/faire-approuver-un-modele/index.html');
    expect(html).toMatch(/data-mots="[^"]*\bmodele\b/);
  });

  it('la console importe la correspondance écran vers page, égale à sa génération, sur les six écrans', () => {
    const fichier = readFileSync(join(SITE, '..', 'web', 'lib', 'aide-pages.ts'), 'utf8');
    expect(fichier).toBe(fichierCommentFaire());
    for (const ecran of ['accueil', 'offre', 'inbox', 'templates', 'contacts', 'campagnes']) expect(fichier).toContain(`"${ecran}":`);
  });

  it('🔴 les pages Claude Code ne citent que de vrais outils, sous leur nom', () => {
    expect(PAGES_CLAUDE.length).toBe(4);
    for (const p of PAGES_CLAUDE) {
      for (const langue of ['fr', 'en'] as const) {
        const html = lire(`${p.adresse[langue].slice(1)}index.html`);
        const marques = parAttribut(html, 'data-outil');
        expect(marques.length, `${p.cle} ${langue}`).toBe(p.etapes.reduce((n, e) => n + e.outils.length, 0));
        for (const { valeur, contenu } of marques) {
          expect(Object.keys(CATALOGUE_MCP), valeur).toContain(valeur);
          expect(texte(contenu)).toBe(valeur);
        }
      }
    }
    const campagne = PAGES_CLAUDE.find((p) => p.cle === 'preparer-une-campagne')!.etapes.flatMap((e) => e.outils);
    expect(campagne.indexOf('prepare_campaign')).toBeLessThan(campagne.indexOf('launch_campaign'));
  });

  it('les pages Claude Code ont leur jumelle, et la page des campagnes dit l’offre Pro', () => {
    for (const p of PAGES_CLAUDE) {
      const fr = lire(`${p.adresse.fr.slice(1)}index.html`);
      expect(fr).toContain(`<link rel="alternate" hreflang="en" href="https://app.messagingme.fr${p.adresse.en}">`);
      expect(fr.includes('class="aide-offre"'), p.cle).toBe(p.offrePro === true);
    }
  });

  it('🔴 une page Claude Code dit l’offre Pro exactement quand l’un de ses outils est fermé en Free', () => {
    // L'outil refuse en Free (`src/mcp/serveur.ts`, `fonction` absente des droits de la Free) : une page qui le cite
    // sans annoncer le Pro promet ce que l'outil refusera. Relecture du lot 3 : l'accueil promettait « tout en Free ».
    const fermes = new Set(OUTILS.filter((o) => o.fonction !== null && !DROITS.base.fonctions.has(o.fonction)).map((o) => o.nom));
    expect(fermes.size).toBeGreaterThan(0);
    for (const p of PAGES_CLAUDE) {
      const cites = p.etapes.flatMap((e) => e.outils).filter((n) => fermes.has(n));
      expect(p.offrePro === true, `${p.cle} cite ${cites.join(', ') || 'aucun outil fermé en Free'}`).toBe(cites.length > 0);
    }
  });

  it('🔴 l’accueil du centre mène à chaque page Claude Code, avec la mention Pro sur celles qui la demandent', () => {
    for (const langue of ['fr', 'en'] as const) {
      const accueil = lire(`${langue === 'fr' ? 'aide' : 'en/help'}/index.html`);
      const section = accueil.slice(accueil.indexOf('id="claude-code"'));
      for (const p of PAGES_CLAUDE) {
        const carte = section.match(new RegExp(`<li><a href="${p.adresse[langue]}">[\\s\\S]*?</li>`))?.[0];
        expect(carte, `${langue} ${p.cle}`).toBeDefined();
        expect(carte!.includes('class="aide-carte-offre"'), `${langue} ${p.cle}`).toBe(p.offrePro === true);
      }
    }
  });

  it('le lien de contact passe le NOM de la page, jamais un texte libre (Review Focus 4)', () => {
    expect(lire('aide/la-fenetre-de-24-heures/index.html')).toContain('href="/contact/?aide=la-fenetre-de-24-heures"');
    expect(lire('en/help/the-24-hour-window/index.html')).toContain('href="/en/contact/?aide=the-24-hour-window"');
  });
});
