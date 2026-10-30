import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PRIX_NUMERO_HT_CENTIMES } from '../src/stripe/abonnement';
import { DROITS, PRIX_BUSINESS_HT_CENTIMES } from '../src/offres/offres';
import { MAGASINS, PRIX_NUMERO_AFFICHE_HT_CENTIMES, TEXTES_TUNNEL, demandeDe, type Origine } from '../scripts/vitrine/tunnel-textes';
import { DEMARRER, TEXTES_DEMARRER, profondeurTunnel } from '../scripts/vitrine/tunnel';
import { TEXTES_CARREFOUR, type Langue } from '../scripts/vitrine/cas-textes';
import { JUMELLES } from '../scripts/vitrine/anglais';
import { ENTREES } from '../web/lib/registre-vitrine';
import { fichierDe } from '../scripts/vitrine/cas';
import { DEPOT_PLUGIN } from '../web/lib/demarrer';
import { FAQ } from '../scripts/plugin/faq';
import { lire, pagesHtml, texte } from './vitrine-lecture';

/**
 * LE TUNNEL DU NUMÉRO WHATSAPP (l'arbre de Julien du 2026-10-30, plan `docs/superpowers/plans/2026-10-30-tunnel-numero-generique.md`) :
 * le même sur la page « Démarrer », Boutiques Shopify et SaaS et app builders. Que chaque page soit égale à sa génération,
 * `tests/vitrine-cas.test.ts` le tient ; ici, ce que le tunnel PROMET et ce qu'il ne dit plus.
 *
 * 🔴 Plus aucune voie qui ne fait que répondre (le numéro relié par code) : Julien, 2026-10-30, « on supprime une bonne
 * fois pour toutes l'option QR code ». Chaque issue mène à un numéro de l'API officielle.
 */
const shopify = ENTREES.find((e) => e.cle === 'shopify')!;
/** Chaque page qui porte le tunnel, sa langue et la page d'origine que sa demande à coller reprend. */
const PAGES: ReadonlyArray<{ adresse: string; langue: Langue; origine: Origine }> = [
  { adresse: DEMARRER.fr, langue: 'fr', origine: 'generique' },
  { adresse: DEMARRER.en, langue: 'en', origine: 'generique' },
  { adresse: shopify.fr.adresse, langue: 'fr', origine: 'shopify' },
  { adresse: shopify.en.adresse, langue: 'en', origine: 'shopify' },
  { adresse: TEXTES_CARREFOUR.fr.adresse, langue: 'fr', origine: 'saas' },
  { adresse: TEXTES_CARREFOUR.en.adresse, langue: 'en', origine: 'saas' },
];
const corps = (html: string): string => texte(html
  .replace(/<header class="cadre entete">[\s\S]*?<\/header>/, '')
  .replace(/<footer class="pied">[\s\S]*?<\/footer>/, '')
  .replace(/<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<!--[\s\S]*?-->/g, ''));
const guide = (html: string): string => html.match(/<div class="bt-guide" data-guide-numero>[\s\S]*?<\/details>\n {6}<\/div>/)?.[0] ?? '';
/** Le texte que le HTML affiche, entités décodées : une demande se compare à ce que « Copier » met dans le presse-papiers. */
const affiche = (h: string): string => h.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

describe('le tunnel du numéro WhatsApp', () => {
  it('le numéro fourni cite le prix du code', () => {
    expect(PRIX_NUMERO_AFFICHE_HT_CENTIMES).toBe(PRIX_NUMERO_HT_CENTIMES);
    expect(corps(lire(fichierDe(DEMARRER.fr)))).toContain('3,50 € HT par mois en formule Free, inclus en formule Pro');
    expect(corps(lire(fichierDe(DEMARRER.en)))).toContain('€3.50 excl. VAT a month with the Free plan, included in Pro');
  });

  it('est posé, une seule fois, sur chaque page qui le porte, et nulle part ailleurs', () => {
    for (const p of PAGES) expect(lire(fichierDe(p.adresse)).split('data-guide-numero').length - 1, p.adresse).toBe(1);
    const avec = pagesHtml().filter((x) => lire(x).includes('data-guide-numero')).sort();
    expect(avec).toEqual(PAGES.map((p) => fichierDe(p.adresse)).sort());
  });

  it('est un arbre : chaque réponse mène quelque part, tout se rejoint, rien ne boucle, et les deux langues ont le même', () => {
    for (const langue of ['fr', 'en'] as const) {
      const { questions, issues } = TEXTES_TUNNEL[langue];
      const qIds = questions.map((q) => q.id);
      const iIds = issues.map((x) => x.id);
      expect(new Set([...qIds, ...iIds]).size, `${langue} : identifiants uniques`).toBe(qIds.length + iIds.length);
      const atteints = new Set<string>();
      const parcourir = (id: string, chemin: readonly string[]): void => {
        expect(chemin, `${langue} : boucle sur ${id}`).not.toContain(id);
        atteints.add(id);
        const q = questions.find((x) => x.id === id);
        if (!q) {
          expect(iIds, `${langue} : ${id} n'est ni une question ni une issue`).toContain(id);
          return;
        }
        // Une seule réponse sans destination, et seulement si la question a une aide à déplier.
        expect(q.reponses.filter((r) => !r.vers).length, `${langue} : ${id}`).toBeLessThanOrEqual(q.aide ? 1 : 0);
        for (const r of q.reponses) if (r.vers) parcourir(r.vers, [...chemin, id]);
      };
      parcourir(qIds[0]!, []);
      expect([...atteints].sort(), `${langue} : une question ou une issue que rien n'atteint`).toEqual([...qIds, ...iIds].sort());
      // Le lien d'une issue vers une autre mène à une issue.
      for (const x of issues) if (x.autre) expect(iIds, `${langue} : ${x.id}`).toContain(x.autre.vers);
    }
    const forme = (l: Langue) => TEXTES_TUNNEL[l].questions.map((q) => `${q.id}:${q.reponses.map((r) => `${r.vers ?? '?'}${r.offre ?? ''}${r.note ? '+' : ''}`).join(',')}`);
    expect(forme('en')).toEqual(forme('fr'));
    expect(TEXTES_TUNNEL.en.issues.map((x) => `${x.id}>${x.autre?.vers ?? ''}`)).toEqual(TEXTES_TUNNEL.fr.issues.map((x) => `${x.id}>${x.autre?.vers ?? ''}`));
  });

  it('🔴 suit l’arbre de Julien du 2026-10-30 : l’offre, le compte Meta Business, puis l’application WhatsApp Business', () => {
    for (const langue of ['fr', 'en'] as const) {
      const { questions } = TEXTES_TUNNEL[langue];
      const q = (id: string) => questions.find((x) => x.id === id)!;
      expect(questions.map((x) => x.id), langue).toEqual(['offre', 'compte', 'application']);
      // Free ou Pro, les deux vers la même question : l'offre ne change pas le chemin du numéro, seulement le bout.
      // Business et Entreprise mènent à la démo et au contact, jamais aux questions du numéro (Julien, 2026-10-30).
      expect(q('offre').reponses.filter((r) => r.vers).map((r) => `${r.offre}>${r.vers}`), langue)
        .toEqual(['free>compte', 'pro>compte', 'business>echange', 'entreprise>echange']);
      // Oui : le numéro API ; Non et « Je ne sais pas » : l'application, et « Je ne sais pas » dit où vérifier.
      expect(q('compte').reponses.map((r) => r.vers), langue).toEqual(['api', 'application', 'application']);
      expect(q('compte').reponses[2]!.note, langue).toContain('business.facebook.com');
      expect(q('compte').reponses[2]!.note, langue).toMatch(/Facebook ou Instagram|Facebook or Instagram/);
      expect(q('application').reponses.map((r) => r.vers), langue).toEqual(['garder', 'telecharger']);
    }
  });

  it('🔴 « Je ne sais pas » à la question de l’offre dit que Free ne marche qu’avec un agent IA, et sinon Pro (Julien, 2026-10-30)', () => {
    for (const [langue, agent, sans] of [
      ['fr', /uniquement depuis un agent IA comme Claude Code ou Codex/, /Sans agent IA, choisissez Pro/],
      ['en', /only from an AI agent such as Claude Code or Codex/, /Without an AI agent, choose Pro/],
    ] as const) {
      const offre = TEXTES_TUNNEL[langue].questions.find((x) => x.id === 'offre')!;
      expect(offre.reponses.some((r) => !r.vers), langue).toBe(true);
      expect(offre.aide, langue).toMatch(agent);
      expect(offre.aide, langue).toMatch(sans);
    }
  });

  it('une question répondue reste affichée, sa réponse en évidence, et une autre réponse change le chemin (Julien, 2026-10-30)', () => {
    const js = lire('site.js');
    const css = lire('site.css');
    // Plus de repli en une ligne ni de « Modifier » : on change d'avis en recliquant.
    expect(js).not.toMatch(/data-modifier|data-resume/);
    for (const p of PAGES) expect(lire(fichierDe(p.adresse)), p.adresse).not.toMatch(/data-modifier|data-resume/);
    expect(js).toContain("b.getAttribute('aria-pressed') !== 'true'");
    expect(css).toContain('.bt-voie-choix:has([aria-pressed="true"]) .bt-voie{');
    // Les cartes et les réponses d'une question répondue ne se cachent plus.
    expect(css).not.toMatch(/\.bt-question\.repondue :is\([^)]*\.bt-(voies|reponses)\b[^)]*\)\{display:none/);
  });

  it('🔴 le plus long parcours fait trois questions, et le chapeau, l’étape et la page « Démarrer » le disent', () => {
    for (const [langue, trois] of [['fr', 'trois question'], ['en', 'three question']] as const) {
      const max = profondeurTunnel(TEXTES_TUNNEL[langue].questions);
      expect(max).toBe(3);
      expect(TEXTES_TUNNEL[langue].chapeau, langue).toContain(trois);
      expect(TEXTES_DEMARRER[langue].h1.join(' '), langue).toContain(trois);
      expect(TEXTES_DEMARRER[langue].titre, langue).toContain(trois);
      for (const p of PAGES.filter((x) => x.langue === langue)) {
        const html = lire(fichierDe(p.adresse));
        expect(html, p.adresse).toContain(`data-max="${max}"`);
        expect(html, p.adresse).toContain(langue === 'fr' ? `Question 1 sur ${max} au plus` : `Question 1 of ${max} at most`);
      }
    }
  });

  it('🔴 ne dit ni « QR code », ni « coexistence », ni « appareils liés », et aucune voie ne fait seulement répondre', () => {
    for (const p of PAGES) {
      const g = texte(guide(lire(fichierDe(p.adresse))));
      expect(g.length, p.adresse).toBeGreaterThan(1000);
      expect(g, p.adresse).not.toMatch(/QR|coexist|appareils? liés?|linked devices?|scann|code à scanner|pour répondre\b|to answer\b|rien ne part en premier|nothing goes out first/i);
    }
    // Ni la page Shopify entière (sa FAQ comprise), ni la FAQ du plugin, ni son README ne parlent de coexistence.
    for (const a of [shopify.fr.adresse, shopify.en.adresse]) expect(corps(lire(fichierDe(a))), a).not.toMatch(/QR|coexist/i);
    expect(readFileSync(join(process.cwd(), 'plugin/README.md'), 'utf8')).not.toMatch(/coexist/i);
    for (const q of FAQ) expect(`${q.question.fr} ${q.question.en} ${q.reponse.fr} ${q.reponse.en}`, q.id).not.toMatch(/coexist/i);
  });

  it('🔴 les questions et les cartes ne parlent jamais de boutique : elles servent à tous les métiers', () => {
    for (const langue of ['fr', 'en'] as const) {
      const t = TEXTES_TUNNEL[langue];
      const tout = [
        t.chapeau, ...t.questions.flatMap((q) => [q.texte, q.precision ?? '', q.aide ?? '', ...q.reponses.map((r) => `${r.libelle} ${r.note ?? ''}`),
          ...(q.voies ?? []).flatMap((v) => [v.titre, ...v.plus, ...v.moins])]),
        ...t.issues.flatMap((x) => [x.titre, x.situation, ...x.textes, ...Object.values(x.numero ?? {})]),
        ...t.lexique.termes.flatMap((x) => [x.terme, x.court, x.detail]),
      ].join(' ');
      expect(tout, langue).not.toMatch(/boutique|shopify|\bstore\b|checkout/i);
    }
  });

  it('🔴 la voie de l’application dit que le compte Meta Business se crée en chemin, et le numéro neuf, sans aucun chiffre', () => {
    for (const [langue, enChemin, neuf] of [
      ['fr', /Pas de compte Meta Business \? La fenêtre de Meta le crée en chemin/, /Meta refuse parfois un numéro trop neuf/],
      ['en', /No Meta Business account\? Meta’s window creates it along the way/, /Meta sometimes refuses a number that is too new/],
    ] as const) {
      const { issues } = TEXTES_TUNNEL[langue];
      for (const id of ['garder', 'telecharger']) expect(issues.find((x) => x.id === id)!.textes.join(' '), `${langue} : ${id}`).toMatch(enChemin);
      const telecharger = issues.find((x) => x.id === 'telecharger')!;
      expect(telecharger.textes.join(' '), langue).toMatch(neuf);
      // Meta ne publie aucun seuil : jamais un nombre de jours ni d'heures.
      expect([...telecharger.textes, ...Object.values(telecharger.numero ?? {})].join(' '), langue).not.toMatch(/\d+\s*(jours?|days?|heures?|hours?|semaines?|weeks?)/i);
      // Le numéro API rappelle qu'on peut garder son application.
      expect(issues.find((x) => x.id === 'api')!.autre?.vers, langue).toBe('garder');
    }
  });

  it('chaque note de réponse est reliée à son bouton, et seulement sur une réponse qui mène quelque part', () => {
    for (const p of PAGES) {
      const html = lire(fichierDe(p.adresse));
      for (const q of TEXTES_TUNNEL[p.langue].questions) {
        q.reponses.forEach((r, k) => {
          if (!r.note) return;
          expect(r.vers, `${p.adresse} : ${q.id}`).toBeTruthy();
          expect(html, p.adresse).toContain(`data-note="note-${q.id}-${k}"`);
          expect(html, p.adresse).toContain(`<p class="bt-note-reponse" id="note-${q.id}-${k}" role="status" hidden>`);
        });
      }
    }
  });

  it('se lit sans script : les questions cachées, chaque issue avec sa situation, le lexique replié', () => {
    for (const p of PAGES) {
      const html = lire(fichierDe(p.adresse));
      expect(html, p.adresse).toContain('<details class="bt-lexique">');
      expect(html, p.adresse).toMatch(/<div class="bt-questions" hidden>/);
      expect(html, p.adresse).toMatch(/<div class="bt-progression"[^>]*\shidden>/);
      for (const x of TEXTES_TUNNEL[p.langue].issues) {
        expect(html, p.adresse).toMatch(new RegExp(`data-chemin="${x.id}" id="numero-${x.id}">\\s*<p class="bt-situation">`));
        // Le lien vers une autre issue est une ancre qui marche aussi sans script.
        if (x.autre) expect(html, p.adresse).toContain(`<a href="#numero-${x.autre.vers}" data-vers-chemin="${x.autre.vers}">`);
      }
    }
    expect(lire('site.js')).toContain("querySelectorAll('[data-guide-numero]')");
    expect(lire('site.js')).toContain('[data-vers-chemin]');
    expect(lire('site.css')).toContain('.bt-guide [hidden]{display:none}');
  });

  it('la question de l’offre porte, sous chaque carte, le bouton de même rang (Julien, 2026-10-27)', () => {
    for (const p of PAGES) {
      const html = lire(fichierDe(p.adresse));
      const aCartes = TEXTES_TUNNEL[p.langue].questions.filter((q) => q.voies);
      expect(aCartes.map((q) => q.id), p.adresse).toEqual(['offre']);
      for (const q of aCartes) {
        const menent = q.reponses.filter((r) => r.vers);
        const fieldset = html.match(new RegExp(`<fieldset class="bt-question" data-question="${q.id}"[\\s\\S]*?</fieldset>`))?.[0] ?? '';
        const cartes = fieldset.split('<div class="bt-voie-choix">').slice(1);
        expect(cartes.length, p.adresse).toBe(q.voies!.length);
        cartes.forEach((c, i) => expect(c.match(/data-vers="([^"]+)" data-offre="([^"]+)"/)?.slice(1), `${p.adresse}, carte ${i + 1}`).toEqual([menent[i]!.vers, menent[i]!.offre]));
      }
    }
  });

  it('🔴 chaque issue finit sur les boutons de chaque offre, et sa demande reprend l’offre, les réponses et la page d’origine', () => {
    for (const p of PAGES) {
      const html = lire(fichierDe(p.adresse));
      const t = TEXTES_TUNNEL[p.langue];
      const plugin = p.langue === 'fr' ? '/developpeurs/installer-le-plugin/' : '/en/developers/install-the-plugin/';
      for (const x of t.issues) {
        if (x.contact) continue;
        const article = html.match(new RegExp(`<article class="bt-chemin" data-chemin="${x.id}"[\\s\\S]*?</article>`))?.[0] ?? '';
        const blocs = new Map(article.split('<div class="bt-appels" data-offre="').slice(1).map((b) => [b.slice(0, b.indexOf('"')), b] as const));
        expect([...blocs.keys()], `${p.adresse} : ${x.id}`).toEqual(['free', 'pro']);
        const free = blocs.get('free')!;
        const pro = blocs.get('pro')!;
        // En Free, le plugin et son dépôt ; en Pro, l'inscription qui mène à la souscription du Pro, et le pas-à-pas.
        expect(free, `${p.adresse} : ${x.id}`).toContain(`href="${plugin}"`);
        expect(free, `${p.adresse} : ${x.id}`).toContain(`href="${DEPOT_PLUGIN}"`);
        expect(pro, `${p.adresse} : ${x.id}`).toContain(`href="https://console.messagingme.app/signup?offre=pro${p.langue === 'en' ? '&amp;lang=en' : ''}"`);
        expect(pro, `${p.adresse} : ${x.id}`).toContain(`href="${x.pasAPas}"`);
        expect(existsSync(join(process.cwd(), 'site', x.pasAPas, 'index.html')), x.pasAPas).toBe(true);
        for (const [offre, bloc] of [['free', free], ['pro', pro]] as const) {
          const id = `demande-${x.id}-${offre}`;
          expect(bloc, `${p.adresse} : ${id}`).toContain(`data-copier="${id}"`);
          const demande = affiche(bloc.match(new RegExp(`<p id="${id}">([^]*?)</p>`))?.[1] ?? '');
          expect(demande, `${p.adresse} : ${id}`).toBe(affiche(demandeDe(t, x, offre, p.origine)).replace(/ ([:;?!])/g, p.langue === 'fr' ? ' $1' : ' $1'));
          // L'offre la première, la page d'origine ensuite.
          expect(demande, `${p.adresse} : ${id}`).toMatch(offre === 'free' ? /(formule|the Messaging Me) Free/ : /(formule|the Messaging Me) Pro/);
          if (p.origine === 'shopify') expect(demande, `${p.adresse} : ${id}`).toMatch(/Shopify/);
          if (p.origine === 'saas') expect(demande, `${p.adresse} : ${id}`).toMatch(/mon app|my app/);
          if (p.origine === 'generique') expect(demande, `${p.adresse} : ${id}`).not.toMatch(/Shopify|boutique|store|mon app\b|my app\b/);
        }
      }
    }
  });

  it('la page « Démarrer » existe dans les deux langues, déclarée, au plan du site et dans llms.txt', () => {
    expect(JUMELLES[DEMARRER.fr]).toBe(DEMARRER.en);
    expect(lire(fichierDe(DEMARRER.fr))).toContain('<html lang="fr"');
    expect(lire(fichierDe(DEMARRER.en))).toContain('<html lang="en"');
    for (const a of Object.values(DEMARRER)) {
      expect(lire('sitemap.xml'), a).toContain(`<loc>https://app.messagingme.fr${a}</loc>`);
      expect(lire('llms.txt'), a).toContain(`(https://app.messagingme.fr${a})`);
    }
  });

  it('🔴 l’en-tête de chaque page mène à « Démarrer », et les offres de la page Tarifs ouvrent le tunnel, l’offre choisie', () => {
    for (const p of pagesHtml().filter((x) => lire(x).includes('<header class="cadre entete">'))) {
      const entete = lire(p).match(/<header class="cadre entete">[\s\S]*?<\/header>/)![0];
      const adresse = p.startsWith('en/') ? DEMARRER.en : DEMARRER.fr;
      // Une fois dans la barre du téléphone, une fois à droite sur le bureau.
      expect(entete.split(`href="${adresse}"`).length - 1, p).toBe(2);
    }
    for (const [fichier, demarrer] of [['tarifs/index.html', DEMARRER.fr], ['en/pricing/index.html', DEMARRER.en]] as const) {
      const html = lire(fichier);
      const offres = html.match(/<ul class="cadre tarifs-grille">[\s\S]*?<\/ul>\n {2}<\/section>/)?.[0] ?? '';
      const boutons = [...offres.matchAll(/<h2 class="tarif-nom">([^<]+)<\/h2>[\s\S]*?<a class="bouton [^"]+" href="([^"]+)">/g)].map((m) => [m[1], m[2]]);
      expect(boutons.slice(0, 2), fichier).toEqual([['Free', `${demarrer}?offre=free`], ['Pro', `${demarrer}?offre=pro`]]);
      // L'appel du bas de page aussi, pour la Free.
      expect(html.match(/<section class="f-appel">[\s\S]*?<\/section>/)?.[0], fichier).toContain(`href="${demarrer}?offre=free"`);
    }
    // Et l'accueil y mène depuis sa une.
    expect(lire('index.html').match(/<section class="cadre une">[\s\S]*?<div class="scene-cadre">/)?.[0]).toContain(`href="${DEMARRER.fr}"`);
    expect(lire('en/index.html').match(/<section class="cadre une">[\s\S]*?<div class="scene-cadre">/)?.[0]).toContain(`href="${DEMARRER.en}"`);
    // `site.js` ne répond qu'à `?offre=free` ou `?offre=pro`, les valeurs que les réponses portent.
    expect(lire('site.js')).toContain('offre=(free|pro|business|entreprise)');
  });
});

/**
 * FREE ET PRO SANS ARTICLE (Julien, 2026-10-30 : « on arrête de dire en français la Free ou le Pro, c'est Free ou Pro, ou
 * formule Free ou formule Pro »). Toute la vitrine française, tournures dérivées comprises. Restent, et leur sort est à
 * Julien : les libellés de la console cités entre guillemets (« Passer en Pro »), que la console affiche encore, et la FAQ
 * du plugin (`scripts/plugin/faq.ts`), publiée entre `faq:debut` et `faq:fin` sur les pages développeurs.
 */
describe('Free et Pro, sans article, sur la vitrine française', () => {
  const ARTICLE = /(?<![\p{L}’'])(?:la|le|au|du|en)\s+(?:Free|Pro)\b/iu;
  it('aucune page française ne dit « la Free », « le Pro », « en Free », « au Pro »', () => {
    const francaises = pagesHtml().filter((p) => !p.startsWith('en/') && p !== '404.html');
    expect(francaises.length).toBeGreaterThan(40);
    for (const p of francaises) {
      // Le texte affiché, sans la FAQ du plugin ni les libellés cités entre guillemets français.
      const lu = corps(lire(p).replace(/<!-- faq:debut[\s\S]*?<!-- faq:fin -->/g, '')).replace(/«[^»]*»/g, '');
      const m = lu.match(new RegExp(`.{0,40}${ARTICLE.source}.{0,40}`, 'iu'));
      expect(m?.[0], p).toBeUndefined();
    }
  });
});

describe('Business et Entreprise, et les mots du guide (Julien, 2026-10-30)', () => {
  it('🔴 Business et Entreprise ont leur carte, aux chiffres du code, et finissent sur la démo et le contact, sans demande', () => {
    for (const [langue, business, utilisateurs, entreprise, contact] of [
      ['fr', `Business, ${PRIX_BUSINESS_HT_CENTIMES.mois / 100}&nbsp;€ HT par mois`, `${DROITS.business.limites.utilisateurs}&nbsp;utilisateurs`, 'Entreprise, sur devis', '/contact/'],
      ['en', `Business, €${PRIX_BUSINESS_HT_CENTIMES.mois / 100} excl. VAT a month`, `${DROITS.business.limites.utilisateurs} users`, 'Enterprise, on quote', '/en/contact/'],
    ] as const) {
      const offre = TEXTES_TUNNEL[langue].questions.find((x) => x.id === 'offre')!;
      expect(offre.voies!.map((v) => v.titre.split(',')[0]), langue).toEqual(['Free', 'Pro', 'Business', langue === 'fr' ? 'Entreprise' : 'Enterprise']);
      expect(offre.voies![2]!.titre, langue).toBe(business);
      expect(offre.voies![2]!.plus.join(' '), langue).toContain(utilisateurs);
      expect(offre.voies![3]!.titre, langue).toBe(entreprise);
      const echange = TEXTES_TUNNEL[langue].issues.find((x) => x.id === 'echange')!;
      expect(echange.contact, langue).toBe(true);
      for (const p of PAGES.filter((x) => x.langue === langue)) {
        const article = lire(fichierDe(p.adresse)).match(/<article class="bt-chemin" data-chemin="echange"[\s\S]*?<\/article>/)?.[0] ?? '';
        expect(article, p.adresse).toContain(`href="${contact}#formulaire"`);
        expect(article, p.adresse).toContain(`href="${contact}"`);
        expect(article, p.adresse).not.toMatch(/data-copier|installer-le-plugin|install-the-plugin|signup/);
        expect(article, p.adresse).not.toContain('data-offre=');
      }
    }
  });

  it('les formules forment un carrousel sur le bureau, avec ses flèches (Julien, 2026-10-30 : « pas 2 rangées »)', () => {
    for (const p of PAGES) {
      const html = lire(fichierDe(p.adresse));
      expect(html, p.adresse).toContain('<div class="bt-voies bt-carrousel" id="voies-offre">');
      expect(html.match(/<button type="button" class="bt-fleche" data-defiler="(-1|1)"/g)?.length, p.adresse).toBe(2);
    }
    expect(lire('site.js')).toContain("closest('[data-defiler]')");
    expect(lire('site.css')).toMatch(/\.bt-voies\.bt-carrousel\{[^}]*grid-auto-flow:column[^}]*overflow-x:auto/);
  });

  it('les mots du guide se déplient un à un, sans nombre au titre, avec les liens de Meta et des magasins', () => {
    for (const langue of ['fr', 'en'] as const) {
      const { lexique, issues } = TEXTES_TUNNEL[langue];
      expect(lexique.titre, langue).not.toMatch(/\d|\b(deux|trois|quatre|cinq|two|three|four|five)\b/i);
      const liens = lexique.termes.flatMap((x) => x.liens ?? []).map((l) => l.href);
      expect(liens, langue).toEqual(expect.arrayContaining([MAGASINS.metaBusiness, MAGASINS.appStore, MAGASINS.googlePlay]));
      // La voie « je n'ai pas l'application » porte les mêmes magasins.
      expect(issues.find((x) => x.id === 'telecharger')!.liens?.map((l) => l.href), langue).toEqual([MAGASINS.appStore, MAGASINS.googlePlay]);
    }
    for (const p of PAGES) {
      const html = lire(fichierDe(p.adresse));
      expect(html.match(/<details class="bt-mot">/g)?.length, p.adresse).toBe(TEXTES_TUNNEL[p.langue].lexique.termes.length);
      for (const href of Object.values(MAGASINS)) expect(html, p.adresse).toContain(`href="${href}" rel="noopener"`);
    }
  });
});
