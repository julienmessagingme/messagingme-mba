// tests/livre-blanc-page.test.ts
// Le formulaire de la page du livre blanc (site/) et la route qui le reçoit (src/http/livre-blanc-vitrine.ts). La page part
// chez Vercel au push, la route avec l'API : rien d'autre ne les tient égaux. Un champ renommé d'un seul côté rendrait
// chaque envoi « invalide » et renverrait le visiteur au formulaire, sans erreur nulle part. On remplit donc le formulaire
// tel que la page le DÉCLARE, on le poste à la vraie route, et on suit la redirection jusqu'à un fichier de site/.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import Fastify from 'fastify';
import { VITRINE } from '../src/http/contact-vitrine';
import { registerLivreBlancVitrine, PAGES_LIVRE_BLANC } from '../src/http/livre-blanc-vitrine';
import type { DemandeLivreBlanc } from '../src/http/livre-blanc-vitrine';

const SITE = new URL('../site/', import.meta.url);
const fichier = (adresse: string) => new URL(`${adresse.slice(1)}${adresse.endsWith('/') ? 'index.html' : ''}`, SITE);
const page = (adresse: string) => readFileSync(fichier(adresse), 'utf8');

interface Champ { name: string; type: string; value: string | undefined; requis: boolean; coche: boolean }

function formulaire(html: string): { action: string; champs: Champ[] } {
  const f = /<form class="c-form" id="formulaire" action="([^"]+)" method="post">([\s\S]*?)<\/form>/.exec(html);
  if (!f) throw new Error('formulaire introuvable');
  const attribut = (a: string, nom: string) => new RegExp(`\\s${nom}="([^"]*)"`).exec(` ${a}`)?.[1];
  const champs = [...f[2]!.matchAll(/<input\s([^>]*)>/g)].map(([, a]) => ({
    name: attribut(a!, 'name') ?? '', type: attribut(a!, 'type') ?? 'text', value: attribut(a!, 'value'),
    requis: /\srequired\b/.test(` ${a}`), coche: /\schecked\b/.test(` ${a}`),
  }));
  return { action: f[1]!, champs };
}

// Ce qu'un visiteur tape : un champ de la page absent d'ici fait échouer le test, c'est voulu.
const SAISIES: Record<string, string> = {
  prenom: 'Léa', nom: 'Martin', email: 'lea@ecole.fr', etablissement: 'École Horizon', fonction: 'Directrice des admissions',
  mobile: '06 12 34 56 78', site: '',
};

function rempli(champs: Champ[], { caseCochee = true } = {}): string {
  const p = new URLSearchParams();
  for (const c of champs) {
    // Une case décochée n'est pas envoyée du tout par le navigateur.
    if (c.type === 'checkbox') { if (caseCochee) p.set(c.name, c.value ?? ''); }
    else if (c.type === 'hidden') p.set(c.name, c.value ?? '');
    else if (c.name in SAISIES) p.set(c.name, SAISIES[c.name]!);
    else throw new Error(`champ inconnu du test : ${c.name}`);
  }
  return p.toString();
}

describe.each(['fr', 'en'] as const)('la page du livre blanc (%s) et sa route', (langue) => {
  const pages = PAGES_LIVRE_BLANC[langue];
  const { action, champs } = formulaire(page(pages.formulaire));

  it('poste vers la route de l’API, et chaque champ visible est obligatoire, la case non', () => {
    expect(action).toBe('https://api.messagingme.app/vitrine/livre-blanc');
    const noms = champs.map((c) => c.name).sort();
    expect(noms).toEqual(['email', 'etablissement', 'fonction', ...(langue === 'en' ? ['langue'] : []), 'mobile', 'nom', 'prenom', 'site', 'whatsapp']);
    for (const c of champs.filter((x) => ['prenom', 'nom', 'email', 'etablissement', 'fonction', 'mobile'].includes(x.name))) {
      expect(c.requis, c.name).toBe(true);
    }
    const caseWhatsapp = champs.find((c) => c.name === 'whatsapp')!;
    expect(caseWhatsapp).toMatchObject({ type: 'checkbox', value: 'oui', requis: false, coche: false });
    expect(champs.find((c) => c.name === 'mobile')!.type).toBe('tel');
  });

  async function envoyer(corps: string, ip: string) {
    const soumis: DemandeLivreBlanc[] = [];
    const deposes: unknown[] = [];
    const app = Fastify({ logger: false });
    registerLivreBlancVitrine(app, {
      hubspot: { soumettre: async (d) => { soumis.push(d); } },
      sandbox: { deposer: async (d) => { deposes.push(d); } },
      secours: { enabled: true, envoyer: async () => {} },
    });
    const res = await app.inject({
      method: 'POST', url: new URL(action).pathname, payload: corps,
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': ip },
    });
    return { res, soumis, deposes };
  }

  it('rempli tel que la page le déclare, il est accepté et mène à une page « merci » qui existe', async () => {
    const { res, soumis, deposes } = await envoyer(rempli(champs), '203.0.113.9');
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(`${VITRINE}${pages.merci}`);
    expect(soumis).toHaveLength(1);
    expect(soumis[0]).toMatchObject({ mobile: '+33612345678', whatsapp: 'oui' });
    expect(deposes).toHaveLength(1);
    expect(existsSync(fichier(pages.merci))).toBe(true);
  });

  it('la case laissée décochée : le PDF quand même, HubSpot sans WhatsApp, personne dans SANDBOX', async () => {
    const { res, soumis, deposes } = await envoyer(rempli(champs, { caseCochee: false }), '203.0.113.11');
    expect(res.headers.location).toBe(`${VITRINE}${pages.merci}`);
    expect(soumis).toHaveLength(1);
    expect(soumis[0]!.whatsapp).toBeUndefined();
    expect(deposes).toHaveLength(0);
  });

  // Chaque langue a son PDF (le livre blanc anglais depuis le 2026-10-28), et c'est un vrai PDF : un patch qui l'aurait
  // converti en texte (Git for Windows, `diff=astextplain`) passerait le seul test d'existence.
  it('la page « merci » porte le PDF de sa langue, et le PDF existe', () => {
    const lien = /<a class="bouton bouton-plein" href="([^"]+\.pdf)" download>/.exec(page(pages.merci));
    expect(lien).not.toBeNull();
    expect(lien![1]).toBe(langue === 'fr'
      ? '/livre-blanc/whatsapp-education/livre-blanc-recruter-sur-whatsapp.pdf'
      : '/livre-blanc/whatsapp-education/white-paper-recruiting-on-whatsapp.pdf');
    expect(readFileSync(fichier(lien![1]!)).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('un envoi refusé revient sur ce formulaire, que site.js sait signaler', async () => {
    const app = Fastify({ logger: false });
    registerLivreBlancVitrine(app, { hubspot: null, sandbox: null, secours: { enabled: false, envoyer: async () => {} } });
    const res = await app.inject({
      method: 'POST', url: '/vitrine/livre-blanc', payload: langue === 'en' ? 'langue=en' : '',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': '203.0.113.10' },
    });
    expect(res.headers.location).toBe(`${VITRINE}${pages.formulaire}?erreur=champs#formulaire`);
    expect(page(pages.formulaire)).toContain('<p class="c-erreur" role="alert" hidden></p>');
  });
});

describe('autour du formulaire', () => {
  const siteJs = readFileSync(new URL('site.js', SITE), 'utf8');

  // site.js n'a pas de test qui l'exécute : on tient les deux décisions par leur texte.
  it('site.js garde un brouillon par formulaire, et la case par son état coché', () => {
    expect(siteJs).toContain("var CLES = ['engageme-contact', 'engageme-livre-blanc'];");
    expect(siteJs).toMatch(/\/\\\/vitrine\\\/livre-blanc\$\/\.test\(form\.getAttribute\('action'\)/);
    expect(siteJs).toContain("b[c.name] = c.type === 'checkbox' ? c.checked : c.value;");
    expect(siteJs).toContain("if (typeof brouillon[c.name] === 'boolean') c.checked = brouillon[c.name];");
  });

  it('le PDF n’est pas indexé (on le donne contre le formulaire), et la page qui le présente l’est', () => {
    const vercel = JSON.parse(readFileSync(new URL('vercel.json', SITE), 'utf8')) as {
      headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
    };
    const regle = vercel.headers.find((h) => h.headers.some((x) => x.key === 'X-Robots-Tag'));
    expect(regle).toEqual({ source: '/livre-blanc/(.*).pdf', headers: [{ key: 'X-Robots-Tag', value: 'noindex' }] });
    const pdf = /href="(\/livre-blanc\/[^"]+\.pdf)"/.exec(page(PAGES_LIVRE_BLANC.fr.merci))![1]!;
    expect(pdf.startsWith('/livre-blanc/') && pdf.endsWith('.pdf')).toBe(true);
    expect(page(PAGES_LIVRE_BLANC.fr.formulaire)).not.toContain('noindex');
  });
});
