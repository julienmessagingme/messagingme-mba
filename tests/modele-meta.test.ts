import { describe, it, expect } from 'vitest';
import { BORNES_MODELE, schemaModeleMeta, versModeleConsole } from '../src/api/modele-meta';
import { messageDeForme } from '../src/api/forme';

/**
 * LA CRÉATION D'UN MODÈLE AU FORMAT DE META (lot 13, domaine 3, spec § 5) : le corps de Meta (`name`, `language`,
 * `category`, `components`), traduit vers la création de la console. Ce qui est refusé l'est ici, avec le champ fautif,
 * plutôt que par un 400 de Meta sans contexte.
 */
const IMG = 'https://exemple.fr/entete.jpg';
const corpsVariable = { type: 'BODY', text: 'Bonjour {{1}}, votre commande {{2}} est prête.', example: { body_text: [['Marie', 'A123']] } };
const base = (components: unknown[], o: Record<string, unknown> = {}) => ({
  name: 'commande_prete', language: 'fr', category: 'UTILITY', components, ...o,
});
const lire = (b: unknown) => schemaModeleMeta.safeParse(b);
const valide = (b: unknown) => lire(b).success;
const refus = (b: unknown): string => {
  const r = lire(b);
  return r.success ? '' : messageDeForme(r.error);
};

describe('le corps de Meta pour un modèle', () => {
  it('🔴 un modèle complet passe : en-tête texte, corps à variables, pied, boutons', () => {
    expect(valide(base([
      { type: 'HEADER', format: 'TEXT', text: 'Votre commande' },
      corpsVariable,
      { type: 'FOOTER', text: 'Messaging Me' },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Merci' }, { type: 'URL', text: 'Suivre', url: 'https://exemple.fr/suivi' }] },
    ]))).toBe(true);
  });

  it('la casse de la catégorie est libre, parameter_format POSITIONAL est toléré, un corps sans variable n’a pas d’exemple', () => {
    expect(valide(base([{ type: 'BODY', text: 'Bonjour' }], { category: 'marketing', parameter_format: 'POSITIONAL' }))).toBe(true);
  });

  it('🔴 un en-tête image, vidéo ou document se donne par son adresse https dans example.header_url', () => {
    for (const format of ['IMAGE', 'VIDEO', 'DOCUMENT']) {
      expect(valide(base([{ type: 'HEADER', format, example: { header_url: [IMG] } }, { type: 'BODY', text: 'x' }])), format).toBe(true);
    }
    expect(refus(base([{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'x' }]))).toMatch(/header_url/);
    expect(refus(base([{ type: 'HEADER', format: 'IMAGE', example: { header_handle: ['4::aW1h'] } }, { type: 'BODY', text: 'x' }])))
      .toMatch(/adresse https du fichier/);
    expect(valide(base([{ type: 'HEADER', format: 'IMAGE', example: { header_url: ['http://exemple.fr/a.jpg'] } }, { type: 'BODY', text: 'x' }]))).toBe(false);
  });

  it('🔴 hors lot ou mal formé : refusé, avec le champ fautif', () => {
    expect(refus(base([{ type: 'BODY', text: 'x' }], { category: 'AUTHENTICATION' }))).toMatch(/category/);
    expect(refus(base([{ type: 'BODY', text: 'x' }], { name: 'Commande Prête' }))).toMatch(/name/);
    expect(refus(base([{ type: 'BODY', text: 'x' }], { language: 'klingon' }))).toMatch(/language/);
    expect(refus(base([{ type: 'HEADER', format: 'TEXT', text: 'x' }]))).toMatch(/BODY/);
    expect(refus(base([{ type: 'BODY', text: 'a' }, { type: 'BODY', text: 'b' }]))).toMatch(/une seule fois/);
    expect(valide(base([{ type: 'BODY', text: 'x' }, { type: 'CAROUSEL', cards: [] }]))).toBe(false);
    expect(valide(base([{ type: 'BODY', text: 'x' }], { inconnu: 1 }))).toBe(false);
    expect(refus(base([{ type: 'BODY', text: 'x' }, { type: 'BUTTONS', buttons: [{ type: 'PHONE_NUMBER', text: 'Appeler', phone_number: '+33' }] }])))
      .toMatch(/buttons/);
  });

  it('🔴 les variables : positionnelles, contiguës, avec autant d’exemples ; aucune dans l’en-tête, le pied ou une adresse', () => {
    expect(refus(base([{ type: 'BODY', text: 'Bonjour {{prenom}}' }]))).toMatch(/nommées/);
    expect(refus(base([{ type: 'BODY', text: 'Bonjour {{1}} et {{3}}', example: { body_text: [['a', 'b', 'c']] } }]))).toMatch(/contiguës/);
    expect(refus(base([{ type: 'BODY', text: 'Bonjour {{1}}' }]))).toMatch(/example/);
    expect(refus(base([{ ...corpsVariable, example: { body_text: [['Marie']] } }]))).toMatch(/2 exemple/);
    expect(refus(base([{ type: 'BODY', text: 'Bonjour {{1}}', example: { body_text: [['  ']] } }]))).toMatch(/vide/);
    expect(refus(base([{ type: 'HEADER', format: 'TEXT', text: 'Bonjour {{1}}' }, { type: 'BODY', text: 'x' }]))).toMatch(/en-tête/);
    expect(refus(base([{ type: 'BODY', text: 'x' }, { type: 'FOOTER', text: 'Code {{1}}' }]))).toMatch(/pied/);
    expect(refus(base([{ type: 'BODY', text: 'x' }, { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Voir', url: 'https://exemple.fr/{{1}}' }] }])))
      .toMatch(/tracé/);
  });

  it('🔴 les bornes de Meta : corps, en-tête, pied, boutons, liens', () => {
    expect(valide(base([{ type: 'BODY', text: 'a'.repeat(BORNES_MODELE.corps + 1) }]))).toBe(false);
    expect(valide(base([{ type: 'HEADER', format: 'TEXT', text: 'a'.repeat(BORNES_MODELE.enTete + 1) }, { type: 'BODY', text: 'x' }]))).toBe(false);
    expect(valide(base([{ type: 'BODY', text: 'x' }, { type: 'FOOTER', text: 'a'.repeat(BORNES_MODELE.pied + 1) }]))).toBe(false);
    const qr = (i: number) => ({ type: 'QUICK_REPLY', text: `R${i}` });
    expect(valide(base([{ type: 'BODY', text: 'x' }, { type: 'BUTTONS', buttons: Array.from({ length: 11 }, (_, i) => qr(i)) }]))).toBe(false);
    expect(valide(base([{ type: 'BODY', text: 'x' }, { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'a'.repeat(BORNES_MODELE.texteBouton + 1) }] }]))).toBe(false);
    const lien = (i: number) => ({ type: 'URL', text: `L${i}`, url: `https://exemple.fr/${i}` });
    expect(refus(base([{ type: 'BODY', text: 'x' }, { type: 'BUTTONS', buttons: [lien(1), lien(2), lien(3)] }]))).toMatch(/2 boutons lien/);
  });
});

describe('la traduction vers la création de la console', () => {
  it('🔴 les composants deviennent les champs de la console ; l’en-tête média reste à déposer', () => {
    const lu = schemaModeleMeta.parse(base([
      { type: 'HEADER', format: 'IMAGE', example: { header_url: [IMG] } },
      corpsVariable,
      { type: 'FOOTER', text: 'Messaging Me' },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Merci' }, { type: 'URL', text: 'Suivre', url: 'https://exemple.fr/suivi' }] },
    ], { category: 'utility' }));
    expect(versModeleConsole(lu)).toEqual({
      input: {
        name: 'commande_prete', language: 'fr', category: 'UTILITY',
        body: 'Bonjour {{1}}, votre commande {{2}} est prête.', example: ['Marie', 'A123'], footer: 'Messaging Me',
        buttons: [{ type: 'QUICK_REPLY', text: 'Merci' }, { type: 'URL', text: 'Suivre', url: 'https://exemple.fr/suivi' }],
      },
      enteteMedia: { format: 'IMAGE', url: IMG },
    });
  });

  it('un en-tête texte se traduit directement, sans dépôt', () => {
    const lu = schemaModeleMeta.parse(base([{ type: 'HEADER', format: 'TEXT', text: 'Votre commande' }, { type: 'BODY', text: 'x' }]));
    expect(versModeleConsole(lu)).toEqual({
      input: { name: 'commande_prete', language: 'fr', category: 'UTILITY', body: 'x', header: { format: 'TEXT', text: 'Votre commande' } },
    });
  });
});
