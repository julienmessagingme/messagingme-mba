import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { adresseCapture, adressesAide, fichierCommentFaire, llmsAvecAide, motsDeRecherche, pagesAide, sitemapAvecAide } from '../scripts/vitrine/aide';
import { pagesDuCentre } from '../scripts/vitrine/aide-pages';
import { structureFiche } from '../src/aide/structure';
import { PAGES_CLAUDE } from '../scripts/vitrine/aide-claude-textes';
import { FILMS_AIDE } from '../scripts/vitrine/aide-films';
import { CATALOGUE_MCP } from '../web/lib/partage/catalogue-mcp';
import { page } from '../scripts/vitrine/cas';
import { OUTILS } from '../src/mcp/outils';
import { DROITS, ESSAI_PRO_JOURS, PRIX_PRO_HT_CENTIMES, PRIX_SIEGE_HT_CENTIMES } from '../src/offres/offres';
import { OFFRE_PRO, PRIX_DEMO } from '../web/e2e/captures/offre-demo';
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
    expect(centre.length).toBe(18);
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

  it('🔴 un film de page a ses quatre fichiers, sa vraie durée et aucune piste son (tâche 11)', () => {
    // La durée se lit dans la boîte `mvhd` du MP4, la piste son dans `moov` (un `hdlr` de type `soun`) : rien n'est
    // recopié de l'atelier sans être vérifié sur le fichier publié.
    const boite = (b: Buffer, type: string): Buffer => {
      for (let i = 0; i + 8 <= b.length;) {
        const taille = b.readUInt32BE(i);
        if (b.toString('latin1', i + 4, i + 8) === type) return b.subarray(i + 8, i + taille);
        if (taille < 8) break;
        i += taille;
      }
      throw new Error(`boîte ${type} absente`);
    };
    const secondes = (moov: Buffer): number => {
      const mvhd = boite(moov, 'mvhd');
      return mvhd[0] === 1
        ? Number(mvhd.readBigUInt64BE(24)) / mvhd.readUInt32BE(20)
        : mvhd.readUInt32BE(16) / mvhd.readUInt32BE(12);
    };
    const avecFilm = centre.filter((p) => p.publication.video).map((p) => p.cle);
    expect(avecFilm.sort()).toEqual(Object.keys(FILMS_AIDE).sort());
    expect(avecFilm.length).toBeGreaterThan(0);
    for (const cle of avecFilm) {
      for (const langue of ['fr', 'en'] as const) {
        const base = join(SITE, 'films', `aide-${cle}${langue === 'en' ? '-en' : ''}`);
        expect(existsSync(`${base}.webp`), `${base}.webp`).toBe(true);
        const moov = boite(readFileSync(`${base}.mp4`), 'moov');
        expect(moov.includes('soun'), `${cle} ${langue} : une piste son`).toBe(false);
        expect(Math.round(secondes(moov)), `${cle} ${langue}`).toBe(FILMS_AIDE[cle]!.secondes[langue]);
        // La spec : une minute trente au plus, en 16:9 (largeur et hauteur en 16.16, à la fin de `tkhd`).
        expect(FILMS_AIDE[cle]!.secondes[langue], `${cle} ${langue} : plus d’une minute trente`).toBeLessThanOrEqual(90);
        const tkhd = boite(boite(moov, 'trak'), 'tkhd');
        const largeur = tkhd.readUInt32BE(tkhd.length - 8) / 65536, hauteur = tkhd.readUInt32BE(tkhd.length - 4) / 65536;
        expect(largeur / hauteur, `${cle} ${langue} : ${largeur} × ${hauteur}`).toBeCloseTo(16 / 9, 2);
      }
    }
    // Et rien d'autre sous ce nom : un film retiré d'une page, ou renommé, ne traîne pas dans `site/films/`.
    const publies = readdirSync(join(SITE, 'films')).filter((f) => f.startsWith('aide-'));
    const attendus = avecFilm.flatMap((c) => ['', '-en'].flatMap((s) => [`aide-${c}${s}.mp4`, `aide-${c}${s}.webp`]));
    expect(publies.sort()).toEqual(attendus.sort());
  });

  it('deux étapes d’une même page ne montrent jamais la même image', () => {
    // Relecture du lot 4 : la capture « en bas » d'une zone proche du haut retombait en haut de page, et l'étape 2 de
    // « Choisir mon offre » répétait l'étape 1.
    for (const { chemin, contenu } of generees) {
      const empreintes = [...contenu.matchAll(/<img src="\/img\/aide\/[^"?]+\?v=([^"]+)"/g)].map((m) => m[1]);
      expect(new Set(empreintes).size, chemin).toBe(empreintes.length);
    }
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
    expect(vues).toBe(92);
  });

  it('chaque page de la vitrine mène au centre d’aide et au blog par « Ressources », au bureau et dans le burger, et à l’aide en pied de page', () => {
    // Le lien « Aide » de l'en-tête est passé dans le menu « Ressources », avec le blog du site principal (2026-10-22).
    const pages = pagesHtml();
    expect(pages.length).toBeGreaterThan(40);
    const blog = 'https://www.messagingme.fr/blog-messaging-me-agence-conversationelle/';
    for (const chemin of pages) {
      const html = lire(chemin);
      const [adresse, nom, ressources] = chemin.startsWith('en/') ? ['/en/help/', 'Help', 'Resources'] : ['/aide/', 'Aide', 'Ressources'];
      const entete = html.match(/<header class="cadre entete">[\s\S]*?<\/header>/)?.[0] ?? '';
      const pied = html.match(/<footer class="pied">[\s\S]*?<\/footer>/)?.[0] ?? '';
      const bureau = entete.match(new RegExp(`<details class="menu">\\s*<summary class="lien"><span class="menu-bureau">${ressources}</span>[\\s\\S]*?</details>`))?.[0] ?? '';
      const burger = entete.match(new RegExp(`<details class="burger-groupe"( open)?>\\s*<summary>${ressources}<[\\s\\S]*?</details>`))?.[0] ?? '';
      for (const [ou, menu] of [['menu de bureau', bureau], ['burger', burger]] as const) {
        expect(menu, `${chemin} : ${ou}`).toMatch(new RegExp(`<a href="${adresse}"( aria-current="page")?>.*?<strong>${nom}</strong>`));
        expect(menu, `${chemin} : ${ou}`).toContain(`<a href="${blog}"`);
      }
      expect(pied, `${chemin} : pied`).toContain(`<li><a href="${adresse}">${nom}</a></li>`);
    }
  });

  it('site.js : le filtre normalise comme les mots indexés, et le contact ne recopie qu’un nom de page (Review Focus 3 et 4)', () => {
    // Relecture du lot 3 : les autres tests de ce fichier restaient verts si l'on retirait le filtre du préremplissage,
    // passait par innerHTML, ou si la normalisation du filtre divergeait de `motsDeRecherche`.
    const js = lire('site.js');
    const source = js.match(/var normaliser = (function \(t\) \{[\s\S]*?\n {2}\});/)?.[1];
    expect(source, 'la fonction normaliser de site.js').toBeDefined();
    const normaliser = new Function(`return ${source}`)() as (t: string) => string;
    for (const t of ['Faire approuver un modèle', 'Fenêtre de 24 heures', 'Ça, c’est « l’Inbox » !', 'ÉTÉ À NOËL']) {
      expect(normaliser(t), t).toBe(motsDeRecherche(t));
    }
    const contact = js.slice(js.indexOf('.get(\'aide\')'), js.indexOf('form.addEventListener(\'input\''));
    expect(contact).toContain('/^[a-z0-9-]{1,80}$/.test(aide)');
    expect(contact).toContain('message.value =');
    expect(js).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  });

  it('en français, aucune ponctuation haute ni guillemet ne peut partir seul à la ligne', () => {
    // Le texte visible du <main> de chaque page française générée : une espace ordinaire avant « : ; ? ! » » ou après
    // « « » laisserait le signe seul en début de ligne (relecture du lot 3 : « Précédent : », « D’abord : »).
    for (const { chemin, contenu } of generees.filter((g) => !g.chemin.startsWith('en/'))) {
      const visible = (contenu.match(/<main>[\s\S]*<\/main>/)?.[0] ?? '').replace(/<[^>]+>/g, ' ');
      expect(visible.match(/.{0,30}(?: [:;?!»]|« ).{0,10}/g), chemin).toBeNull();
    }
  });

  it('les captures montrent les vrais prix, le vrai essai et la vraie grille (sinon : npm run aide:captures)', () => {
    // Les captures de « Choisir mon offre » sont des images publiques : un prix changé dans le code sans elles les
    // laisserait fausses, sans un rouge (relecture du lot 3). Les valeurs de démo se confrontent ici à celles qui font foi.
    expect(PRIX_DEMO.pro).toEqual({ moisCentimes: PRIX_PRO_HT_CENTIMES.mois, anCentimes: PRIX_PRO_HT_CENTIMES.an });
    expect(PRIX_DEMO.siege).toEqual({ moisCentimes: PRIX_SIEGE_HT_CENTIMES.mois, anCentimes: PRIX_SIEGE_HT_CENTIMES.an });
    expect(PRIX_DEMO.essaiJours).toBe(ESSAI_PRO_JOURS);
    for (const [demo, vraie] of [['free', 'base'], ['pro', 'pro'], ['entreprise', 'entreprise']] as const) {
      const g = OFFRE_PRO.grille[demo];
      expect(new Set(g.fonctions), demo).toEqual(DROITS[vraie].fonctions);
      // Dans les deux sens : une limite que la page Offre affiche mais que la démo n'aurait pas disparaîtrait de la grille.
      expect(Object.keys(g.limites).sort(), demo).toEqual(Object.keys(DROITS[vraie].limites).sort());
      for (const [cle, valeur] of Object.entries(g.limites)) {
        expect(valeur, `${demo}.${cle}`).toBe(DROITS[vraie].limites[cle as keyof typeof DROITS.base.limites]);
      }
    }
  });

  it('une fiche publique sans sa version anglaise est refusée par un message qui dit quoi faire', () => {
    const dossier = mkdtempSync(join(tmpdir(), 'aide-sans-anglais-'));
    try {
      copyFileSync(join(SITE, '..', 'docs', 'aide', 'fiches', 'la-fenetre-de-24-heures.md'), join(dossier, 'la-fenetre-de-24-heures.md'));
      expect(() => pagesDuCentre(dossier)).toThrow('docs/aide/fiches/en/la-fenetre-de-24-heures.md manquante');
    } finally {
      rmSync(dossier, { recursive: true, force: true });
    }
  });

  it('un guillemet droit dans un titre ou un chapeau ne ferme pas l’attribut de la tête de page', () => {
    // Les titres et chapeaux des fiches, écrits librement, alimentent la description et les balises og: ; en anglais
    // `Click "Add"` est naturel (relecture du lot 3).
    const html = page('en', {
      adresse: '/en/help/', jumelle: '/aide/', titre: 'Click "Add"', description: 'Then "Save" & go', ldJson: {},
    }, '<main></main>', 'essai');
    expect(html).toContain('<meta name="description" content="Then &quot;Save&quot; &amp; go">');
    expect(html).toContain('<meta property="og:title" content="Click &quot;Add&quot;">');
    expect(html).toContain('<meta property="og:description" content="Then &quot;Save&quot; &amp; go">');
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
    expect(centre.filter((p) => !p.publication.offre).map((p) => p.cle).sort())
      .toEqual(['ce-qu-il-faut-chez-meta', 'choisir-mon-offre', 'connecter-mon-numero-whatsapp',
        'garder-mon-application-whatsapp-business', 'la-fenetre-de-24-heures']);
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
        // La carte est un accordéon depuis le 2026-10-22 : la mention Pro vit dans son lien, avant les étapes.
        const carte = section.match(new RegExp(`<li class="aide-carte" data-mots="[^"]*"><a class="aide-carte-lien" href="${p.adresse[langue]}">[\\s\\S]*?</a>`))?.[0];
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
