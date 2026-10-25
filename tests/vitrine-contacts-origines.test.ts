import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { contactsToutesOrigines } from '../src/offres/offres';
import { FAQ } from '../scripts/plugin/faq';
import { lire, pagesHtml } from './vitrine-lecture';

/**
 * CE QUE COMPTE LA LIMITE DE CONTACTS, DIT COMME LE CODE LE DÉCIDE (décision de Julien du 2026-10-25, plan
 * `docs/superpowers/plans/2026-10-25-free-100-contacts.md`). Un seul endroit le décide, `contactsToutesOrigines` : en
 * Free, ceux qui écrivent les premiers comptent ; au Pro, non. La vitrine est du HTML statique et le plugin un texte
 * publié : rien ne les relie au code, sauf ce test. Une règle qui change rend ces phrases fausses, et ce test rouge.
 */

const FREE = contactsToutesOrigines('base');
const PRO = contactsToutesOrigines('pro');
/** « Ceux qui vous écrivent comptent », dans chaque tournure de la vitrine et du plugin, en français et en anglais. */
const COMPTENT = /ceux qui vous écrivent compris|ceux qui vous écrivent comptent aussi|chaque personne qui vous écrit aussi|including those who write to you|those who write to you count too|so does each person who writes to you/;
const ENTRANTS_ILLIMITES = /contacts entrants (sont )?illimités|unlimited inbound contacts|inbound contacts are unlimited/i;

/** Le morceau d'une page entre deux repères, qui doivent y être tous les deux. */
function entre(html: string, debut: string, fin: string, ou: string): string {
  const i = html.indexOf(debut);
  const j = html.indexOf(fin, i + debut.length);
  expect(i >= 0 && j > i, `${ou} : repères « ${debut} » puis « ${fin} »`).toBe(true);
  return html.slice(i, j);
}

describe('la limite de contacts de la Free et du Pro, dite comme le code la compte', () => {
  for (const [page, nomEntreprise] of [['tarifs/index.html', 'Entreprise'], ['en/pricing/index.html', 'Enterprise']] as const) {
    it(`${page} : la carte Free, la carte Pro et la question des limites`, () => {
      const html = lire(page);
      const free = entre(html, '<h2 class="tarif-nom">Free</h2>', '<h2 class="tarif-nom">Pro</h2>', page);
      const pro = entre(html, '<h2 class="tarif-nom">Pro</h2>', `<h2 class="tarif-nom">${nomEntreprise}</h2>`, page);
      expect(COMPTENT.test(free), 'Free : ceux qui écrivent comptent').toBe(FREE);
      expect(ENTRANTS_ILLIMITES.test(free), 'Free : contacts entrants illimités').toBe(!FREE);
      expect(ENTRANTS_ILLIMITES.test(pro), 'Pro : contacts entrants illimités').toBe(!PRO);
      expect(/ceux qui vous écrivent comptent aussi parmi vos contacts|those who write to you count among your contacts too/.test(html),
        'la question « quand j’atteins une limite »').toBe(FREE);
    });
  }

  for (const page of ['developpeurs/index.html', 'en/developers/index.html']) {
    it(`${page} : le bloc de l’offre`, () => {
      const html = lire(page);
      const free = entre(html, '<ul class="dev-grille">', '</ul>', page);
      const pro = entre(html, '<p class="dev-pro">', '</p>', page);
      expect(COMPTENT.test(free), 'Free : ceux qui écrivent comptent').toBe(FREE);
      expect(ENTRANTS_ILLIMITES.test(free), 'Free : contacts entrants illimités').toBe(!FREE);
      expect(ENTRANTS_ILLIMITES.test(pro), 'Pro : contacts entrants illimités').toBe(!PRO);
    });
  }

  for (const page of ['solutions/shopify/index.html', 'en/solutions/shopify-stores/index.html']) {
    it(`${page} : les deux offres`, () => {
      const html = lire(page);
      const free = entre(html, '<h3>Free</h3>', '<h3>Pro</h3>', page);
      const pro = entre(html, '<h3>Pro</h3>', '</ul>', page);
      expect(COMPTENT.test(free), 'Free : ceux qui écrivent comptent').toBe(FREE);
      expect(ENTRANTS_ILLIMITES.test(pro), 'Pro : contacts entrants illimités').toBe(!PRO);
    });
  }

  it('chaque cas d’usage qui chiffre les contacts de la Free', () => {
    const cas = pagesHtml().filter((p) => /^(cas-d-usage|en\/use-cases)\//.test(p));
    const chiffrent = cas.filter((p) => lire(p).includes('data-offre="base.contacts"'));
    expect(chiffrent.length).toBeGreaterThan(0);
    for (const p of chiffrent) {
      const li = lire(p).split('<li>').find((morceau) => morceau.includes('data-offre="base.contacts"'))!.split('</li>')[0]!;
      expect(COMPTENT.test(li), p).toBe(FREE);
      expect(ENTRANTS_ILLIMITES.test(li), p).toBe(!FREE);
    }
  });

  it('le README du plugin et sa FAQ', () => {
    const readme = readFileSync(resolve(__dirname, '..', 'plugin', 'README.md'), 'utf8').split('\n');
    const free = readme.find((l) => l.startsWith('- **Free**:'))!;
    const pro = readme.find((l) => l.startsWith('- **Pro, '))!;
    expect(COMPTENT.test(free), 'README, Free').toBe(FREE);
    expect(ENTRANTS_ILLIMITES.test(free), 'README, Free').toBe(!FREE);
    expect(ENTRANTS_ILLIMITES.test(pro), 'README, Pro').toBe(!PRO);
    // L'entrée « espace Free plein » ne dit vrai que tant que la Free compte ceux qui écrivent.
    expect(FAQ.some((e) => e.id === 'espace-free-plein')).toBe(FREE);
  });
});
