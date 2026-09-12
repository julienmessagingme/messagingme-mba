import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { etageAuRang, rangSuivant, RANG_INITIAL, RANG_MAX, type Etage } from '../src/campaign/etages';

const CHAINE: Etage[] = [
  { rang: 1, canal: 'whatsapp', templateName: 'promo', templateLanguage: 'fr' },
  { rang: 2, canal: 'rcs' },
  { rang: 3, canal: 'email', emailTemplateId: 'mod-1' },
];

describe('la chaine d etages', () => {
  it('resout le canal d un rang', () => {
    expect(etageAuRang(CHAINE, 2)?.canal).toBe('rcs');
  });

  it('rend null au-dela du dernier rang, ce qui veut dire terminal', () => {
    expect(rangSuivant(CHAINE, 3)).toBeNull();
    expect(etageAuRang(CHAINE, 4)).toBeNull();
  });

  // 🔴 LE CAS MONO-CANAL : une chaine a un seul etage n a pas de suivant, donc aucune bascule. C est
  // l invariant qui rend ce lot deployable AVANT le moteur de bascule : tout le parc existant est repris
  // au rang 1, donc tout le parc existant repond null ici, donc rien ne bouge.
  it('une chaine a un seul etage ne bascule jamais', () => {
    expect(rangSuivant([{ rang: 1, canal: 'whatsapp' }], 1)).toBeNull();
  });

  // ⚠️ Une chaine dont les rangs sautent (1 puis 3) ne doit pas rendre 2 : le rang suivant est le
  // prochain qui EXISTE, pas rang + 1. Un etage retire au milieu ne doit pas arreter la chaine.
  it('le rang suivant est le prochain qui existe, pas rang + 1', () => {
    expect(rangSuivant([{ rang: 1, canal: 'whatsapp' }, { rang: 3, canal: 'email' }], 1)).toBe(3);
  });

  // 🔴 NE SUPPOSE PAS QUE LE TABLEAU EST TRIE. Rien ne garantit l ordre : une lecture SQL sans `order by`
  // rend les lignes dans l ordre ou Postgres les trouve, et un appelant peut construire sa chaine a la
  // main. Une implementation par index (`chaine[i + 1]`) passerait les cas du dessus et rendrait ici 1,
  // c est-a-dire une chaine declaree terminale des le premier etage : plus aucune bascule, en silence.
  it('trouve le suivant meme si la chaine arrive dans le desordre', () => {
    // ⚠️ LA CHAINE EST A L ENVERS, ET CE N EST PAS UN DETAIL DE MISE EN SCENE. Une premiere version de ce
    // test melangeait les rangs sans les inverser (3, 1, 2) : l implementation fautive par index y rendait
    // la BONNE reponse par hasard, donc le test passait sur elle. Mesure a l appui, cf. le rapport du lot.
    // A l envers, l element qui suit le rang 1 dans le TABLEAU n existe pas, la faute devient visible.
    const desordre: Etage[] = [
      { rang: 3, canal: 'email' },
      { rang: 2, canal: 'rcs' },
      { rang: 1, canal: 'whatsapp' },
    ];
    expect(rangSuivant(desordre, 1)).toBe(2);
    expect(rangSuivant(desordre, 2)).toBe(3);
    expect(rangSuivant(desordre, 3)).toBeNull();
    expect(etageAuRang(desordre, 3)?.canal).toBe('email');
  });

  // ⚠️ Une chaine VIDE est le cas d une campagne dont la reprise n a rien ecrit. Elle ne doit rien rendre
  // plutot que planter : l appelant lit deja `null` comme « terminal ».
  it('une chaine vide est terminale, pas une erreur', () => {
    expect(rangSuivant([], 1)).toBeNull();
    expect(etageAuRang([], 1)).toBeNull();
  });
});

/**
 * 🔴 LES DEUX BORNES SONT ECRITES A DEUX ENDROITS, ET CE TEST EST LEUR SEUL LIEN. Le code les porte en
 * constantes, la migration 0134 les porte dans un CHECK (`rang between 1 and 3`) et dans le defaut de
 * `campaign_recipients.etage_courant`. Les elargir d un cote seulement ne produit AUCUNE erreur de
 * compilation : la faute sort a l ecriture en base, en production, sur le premier etage hors borne.
 *
 * ⚠️ Le test LIT LE FICHIER SQL, il ne recopie pas ses valeurs. Une copie aurait teste la copie, et
 * aurait donc continue de passer apres la modification qu elle est censee attraper. C est la meme
 * doctrine que le test qui lit le SQL de 0127 pour verifier la forme d une cle.
 */
describe('les bornes de rang, cote code et cote migration', () => {
  const sql = readFileSync(new URL('../db/migrations/0134_campagne_chaine.sql', import.meta.url), 'utf8');

  it('le CHECK de 0134 borne le rang exactement comme RANG_INITIAL et RANG_MAX', () => {
    expect(sql).toContain(`check (rang between ${RANG_INITIAL} and ${RANG_MAX})`);
  });

  it('le defaut de etage_courant est RANG_INITIAL', () => {
    expect(sql).toContain(`add column if not exists etage_courant smallint not null default ${RANG_INITIAL}`);
  });
});
