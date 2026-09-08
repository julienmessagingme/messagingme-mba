import { describe, it, expect } from 'vitest';
import {
  PAGES_MAX, PROFONDEUR_MAX, dansLaPortee, liensDeLaPage, normaliserUrl, porteeParDefaut, visiter,
} from '../src/agent/crawl';

/**
 * Le parcours d'un site pour remplir une base de connaissance.
 *
 * 🔴 CE QUE CES TESTS PROTÈGENT. L'import ne prenait qu'UNE page : Julien a donné `ganprevoyance.fr`, on a
 * importé la vitrine, et son agent ne savait rien. Mais l'excès inverse coûte tout aussi cher : suivre un
 * lien sortant importerait le contenu d'un tiers dans la base d'un client, donc dans les réponses faites à
 * ses contacts EN SON NOM.
 */
const A = (href: string): string => `<a href="${href}">x</a>`;

describe('porteeParDefaut', () => {
  it('🔴 la RACINE d’un domaine veut dire « ce site »', () => {
    expect(porteeParDefaut('https://ganprevoyance.fr')).toBe('site');
    expect(porteeParDefaut('https://www.ganprevoyance.fr/')).toBe('site');
  });

  it('🔴 une adresse avec un CHEMIN veut dire « cette page »', () => {
    // Deviner l'inverse importerait cinquante pages quand on en demandait une.
    expect(porteeParDefaut('https://ganprevoyance.fr/nos-contrats')).toBe('page');
    expect(porteeParDefaut('https://ganprevoyance.fr/pro/sante/')).toBe('page');
  });

  it('une adresse illisible retombe sur le choix le plus PRUDENT', () => {
    expect(porteeParDefaut('pas une url')).toBe('page');
  });
});

describe('normaliserUrl', () => {
  it('retire le fragment et la barre finale : deux fois la même page, c’est une page', () => {
    expect(normaliserUrl('https://x.fr/a/#section')).toBe('https://x.fr/a');
    expect(normaliserUrl('https://x.fr/')).toBe('https://x.fr/');
  });

  it('🔴 GARDE la query : sur beaucoup de sites elle porte la page réelle', () => {
    // La retirer ramènerait tout un site à une seule adresse.
    expect(normaliserUrl('https://x.fr/p?id=12')).toBe('https://x.fr/p?id=12');
  });
});

describe('dansLaPortee', () => {
  const dep = 'https://x.fr/pro';

  it('🔴 un lien SORTANT n’est jamais suivi, quelle que soit la portée', () => {
    // Il importerait le contenu d'un tiers dans la base d'un client.
    for (const p of ['site', 'sous-arbre', 'page'] as const) {
      expect(dansLaPortee('https://autre.fr/a', dep, p)).toBe(false);
    }
  });

  it('« page » n’accepte QUE l’adresse de départ', () => {
    expect(dansLaPortee('https://x.fr/pro', dep, 'page')).toBe(true);
    expect(dansLaPortee('https://x.fr/pro/sante', dep, 'page')).toBe(false);
  });

  it('🔴 « sous-arbre » compare des SEGMENTS, jamais des caractères', () => {
    // Sur un préfixe de chaîne, `/pro` laisserait entrer `/professionnels-autre-chose`, qui n'est pas dessous.
    expect(dansLaPortee('https://x.fr/pro/sante', dep, 'sous-arbre')).toBe(true);
    expect(dansLaPortee('https://x.fr/pro', dep, 'sous-arbre')).toBe(true);
    expect(dansLaPortee('https://x.fr/professionnels', dep, 'sous-arbre')).toBe(false);
  });

  it('« site » accepte tout le domaine', () => {
    expect(dansLaPortee('https://x.fr/tout-autre-chose', dep, 'site')).toBe(true);
  });
});

describe('liensDeLaPage', () => {
  const base = 'https://x.fr/';

  it('résout les liens relatifs, dédoublonne, et écarte ce qui n’est pas une page', () => {
    const html = [
      A('/a'), A('a'), A('/a#bas'), // la même page, trois écritures
      A('mailto:x@y.fr'), A('tel:+33'), A('javascript:void(0)'),
      A('/doc.pdf'), A('/img.jpg'),
      A('https://autre.fr/b'),
      A('/b'),
    ].join('');
    expect(liensDeLaPage(html, base, 'site').sort()).toEqual(['https://x.fr/a', 'https://x.fr/b']);
  });

  it('en portée « page », aucun lien n’est retenu hors la page elle-même', () => {
    expect(liensDeLaPage(A('/autre'), base, 'page')).toEqual([]);
  });
});

describe('visiter', () => {
  /** Un faux site : une carte d'adresses vers du HTML. Aucun réseau. */
  const site = (pages: Record<string, string>) => async (url: string) => (
    pages[url] === undefined ? { erreur: 'page injoignable' } : { html: pages[url] }
  );

  it('🔴 parcourt EN LARGEUR : les pages proches de l’accueil passent en premier', () => {
    // Avec un plafond, un parcours en profondeur dépenserait tout dans une seule branche (les archives) et
    // n'atteindrait jamais « nos contrats », pourtant lié depuis l'accueil.
    expect(PROFONDEUR_MAX).toBe(2);
    expect(PAGES_MAX).toBe(50);
  });

  it('suit les liens jusqu’à la profondeur, et pas au-delà', async () => {
    const r = await visiter('https://x.fr/', 'site', site({
      'https://x.fr/': A('/n1'),
      'https://x.fr/n1': A('/n2'),
      'https://x.fr/n2': A('/n3'),
      'https://x.fr/n3': '',
    }), { profondeurMax: 2 });
    // n3 est à trois sauts : lu par personne. n2 est LU mais ses liens ne sont pas suivis.
    expect(r.pages.map((p) => p.url)).toEqual(['https://x.fr/', 'https://x.fr/n1', 'https://x.fr/n2']);
  });

  it('🔴 le plafond COUPE, et il le DIT', async () => {
    // « 50 pages » n'est pas « tout le site » : un écran qui ne le dirait pas laisserait croire à une base
    // complète alors qu'il en manque la moitié.
    const pages: Record<string, string> = { 'https://x.fr/': [A('/a'), A('/b'), A('/c')].join('') };
    for (const p of ['a', 'b', 'c']) pages[`https://x.fr/${p}`] = '';
    const r = await visiter('https://x.fr/', 'site', site(pages), { pagesMax: 2 });
    expect(r.pages).toHaveLength(2);
    expect(r.plafondAtteint).toBe(true);
  });

  it('🔴 preuve inverse : sous le plafond, il ne prétend PAS avoir coupé', async () => {
    const r = await visiter('https://x.fr/', 'site', site({ 'https://x.fr/': '' }));
    expect(r.plafondAtteint).toBe(false);
  });

  it('une page injoignable est ÉCARTÉE et dite, elle n’arrête pas le parcours', async () => {
    const r = await visiter('https://x.fr/', 'site', site({
      'https://x.fr/': [A('/mort'), A('/vivant')].join(''),
      'https://x.fr/vivant': '',
    }));
    expect(r.pages.map((p) => p.url)).toEqual(['https://x.fr/', 'https://x.fr/vivant']);
    expect(r.ecartees).toEqual([{ url: 'https://x.fr/mort', raison: 'page injoignable' }]);
  });

  it('🔴 une boucle de liens ne fait pas tourner le parcours sans fin', async () => {
    const r = await visiter('https://x.fr/', 'site', site({
      'https://x.fr/': A('/a'),
      'https://x.fr/a': [A('/'), A('/a')].join(''),
    }));
    expect(r.pages.map((p) => p.url)).toEqual(['https://x.fr/', 'https://x.fr/a']);
  });

  it('en portée « page », une seule page est lue même si elle pointe partout', async () => {
    const r = await visiter('https://x.fr/nos-contrats', 'page', site({
      'https://x.fr/nos-contrats': [A('/a'), A('/b')].join(''),
      'https://x.fr/a': '', 'https://x.fr/b': '',
    }));
    expect(r.pages.map((p) => p.url)).toEqual(['https://x.fr/nos-contrats']);
  });
});
