import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { verdictModele } from '../src/api/modele-envoi';

/**
 * CE QU'UN ENVOI PAR L'API SAIT D'UN TEMPLATE (spec 2026-09-24, § 3 « Catégorie, numéro, débit », défaut 2).
 *
 * 🔴 La catégorie était DÉCLARÉE par l'appelant : un template marketing annoncé « utility » partait aux
 * contacts dont le consentement est inconnu. Elle est désormais lue chez Meta, comme dans l'Inbox.
 */
describe('verdictModele', () => {
  it('approuvé, dans la langue demandée : sa catégorie, lue chez Meta', () => {
    expect(verdictModele({ statut: 'APPROVED', langue: 'fr', category: 'marketing' }, 'fr')).toEqual({ statut: 'approuve', categorie: 'marketing' });
    expect(verdictModele({ statut: 'APPROVED', langue: 'fr', category: 'utility' }, 'fr')).toEqual({ statut: 'approuve', categorie: 'utility' });
  });

  it('🔴 défaut 2 : introuvable, non approuvé, ou d’une AUTRE langue -> absent', () => {
    expect(verdictModele(null, 'fr')).toEqual({ statut: 'absent' });
    expect(verdictModele({ statut: 'PENDING', langue: 'fr', category: 'utility' }, 'fr')).toEqual({ statut: 'absent' });
    expect(verdictModele({ statut: 'REJECTED', langue: 'fr', category: 'utility' }, 'fr')).toEqual({ statut: 'absent' });
    // La lecture partagée retombe sur le NOM SEUL quand la langue ne correspond pas : pour l'API c'est un autre
    // template, et l'envoi échouerait chez Meta pour chaque destinataire.
    expect(verdictModele({ statut: 'APPROVED', langue: 'en', category: 'utility' }, 'fr')).toEqual({ statut: 'absent' });
  });

  it('catégorie ABSENTE -> illisible, jamais « utility » par défaut', () => {
    expect(verdictModele({ statut: 'APPROVED', langue: 'fr' }, 'fr')).toEqual({ statut: 'illisible' });
    expect(verdictModele({ statut: 'APPROVED', langue: 'fr', category: '' }, 'fr')).toEqual({ statut: 'illisible' });
  });

  it('⚠️ catégorie LUE mais hors des deux admises -> categorie_non_admise, qui la nomme : réessayer n’y changerait rien', () => {
    expect(verdictModele({ statut: 'APPROVED', langue: 'fr', category: 'authentication' }, 'fr'))
      .toEqual({ statut: 'categorie_non_admise', categorie: 'authentication' });
  });
});

describe('la lecture partagée du template garde son statut et sa langue', () => {
  // Sans les commentaires : une explication qui CITE le bon code ne doit pas faire passer un câblage fautif.
  const source = readFileSync(new URL('../src/workflow/wiring.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('🔴 `templateVarInfo` rend le statut et la langue du template TROUVÉ, lus chez Meta', () => {
    expect(source).toMatch(/statut: tpl\.status/);
    expect(source).toMatch(/langue: tpl\.language/);
  });
});
