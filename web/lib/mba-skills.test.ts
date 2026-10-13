import { describe, it, expect } from 'vitest';
import { slugSkillTitle, slugSkillTitleFrappe } from './mba-skills';
import { TITRE_SKILL_MAX, titreSkillValide } from './partage/agent-meta';

describe('slugSkillTitleFrappe : la mise en forme pendant la frappe', () => {
  it('🔴 conserve le séparateur entre deux frappes, sinon les mots se collent', () => {
    // Rejoue une saisie touche par touche, comme le fait le champ. Avec une mise en forme qui retire le tiret
    // final à chaque frappe, l'espace de « politique de retour » disparaissait aussitôt et la lettre suivante
    // se collait : on obtenait « politiquederetour », qui partait tel quel chez Meta.
    let valeur = '';
    for (const touche of 'Politique de retour') valeur = slugSkillTitleFrappe(valeur + touche);
    expect(valeur).toBe('politique-de-retour');
  });

  it('laisse le tiret final visible tant qu’on n’a pas fini de taper', () => {
    expect(slugSkillTitleFrappe('politique ')).toBe('politique-');
    expect(slugSkillTitle('politique ')).toBe('politique'); // la forme définitive, elle, le retire
  });

  it('ne laisse jamais de tiret en TÊTE, même en cours de frappe', () => {
    let valeur = '';
    for (const touche of ' retours') valeur = slugSkillTitleFrappe(valeur + touche);
    expect(valeur).toBe('retours');
  });
});

describe('slugSkillTitle', () => {
  it('met en forme une saisie en français normal', () => {
    expect(slugSkillTitle('Politique de retour !')).toBe('politique-de-retour');
    expect(slugSkillTitle('ÉCHANGES & remboursements')).toBe('echanges-remboursements');
    expect(slugSkillTitle('  Ligne 3 samedi  ')).toBe('ligne-3-samedi');
  });

  it('ne laisse jamais de tiret aux extrémités, même après troncature', () => {
    expect(slugSkillTitle('---')).toBe('');
    expect(slugSkillTitle('-abc-')).toBe('abc');
    // Une saisie longue est coupée à la limite : la coupe ne doit pas laisser un tiret final, qui serait
    // refusé par le serveur alors que l'écran vient d'écrire ce texte lui-même.
    const long = slugSkillTitle(`${'a'.repeat(TITRE_SKILL_MAX - 1)} suite`);
    expect(long.length).toBeLessThanOrEqual(TITRE_SKILL_MAX);
    expect(long.endsWith('-')).toBe(false);
  });
});

describe('titreSkillValide', () => {
  it('accepte le format de Meta et refuse le reste', () => {
    expect(titreSkillValide('politique-de-retour')).toBe(true);
    expect(titreSkillValide('Politique')).toBe(false);
    expect(titreSkillValide('avec espace')).toBe(false);
    expect(titreSkillValide('avec_underscore')).toBe(false);
    expect(titreSkillValide('')).toBe(false);
  });

  it('refuse au-delà de la longueur maximale', () => {
    expect(titreSkillValide('a'.repeat(TITRE_SKILL_MAX))).toBe(true);
    expect(titreSkillValide('a'.repeat(TITRE_SKILL_MAX + 1))).toBe(false);
  });
});
