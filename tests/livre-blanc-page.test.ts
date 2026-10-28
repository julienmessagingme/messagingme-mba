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

function rempli(champs: Champ[]): string {
  const p = new URLSearchParams();
  for (const c of champs) {
    if (c.type === 'checkbox' || c.type === 'hidden') p.set(c.name, c.value ?? '');
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

  it('rempli tel que la page le déclare, il est accepté et mène à une page « merci » qui existe', async () => {
    const soumis: DemandeLivreBlanc[] = [];
    const deposes: unknown[] = [];
    const app = Fastify({ logger: false });
    registerLivreBlancVitrine(app, {
      hubspot: { soumettre: async (d) => { soumis.push(d); } },
      sandbox: { deposer: async (d) => { deposes.push(d); } },
      secours: { enabled: true, envoyer: async () => {} },
    });
    const res = await app.inject({
      method: 'POST', url: new URL(action).pathname, payload: rempli(champs),
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': '203.0.113.9' },
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(`${VITRINE}${pages.merci}`);
    expect(soumis).toHaveLength(1);
    expect(soumis[0]).toMatchObject({ mobile: '+33612345678', whatsapp: 'oui' });
    expect(deposes).toHaveLength(1);
    expect(existsSync(fichier(pages.merci))).toBe(true);
  });

  it('la page « merci » porte le PDF, et le PDF existe', () => {
    const lien = /<a class="bouton bouton-plein" href="([^"]+\.pdf)" download>/.exec(page(pages.merci));
    expect(lien).not.toBeNull();
    expect(existsSync(fichier(lien![1]!))).toBe(true);
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
