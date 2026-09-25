import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { modeleLuDe, raisonNonEnvoyable, verdictModele } from '../src/api/modele-envoi';
import type { TemplateSummary } from '../src/meta/templates';

/**
 * CE QU'UN ENVOI PAR L'API SAIT D'UN TEMPLATE (spec 2026-09-24, § 3 « Catégorie, numéro, débit », défaut 2).
 *
 * 🔴 La catégorie était DÉCLARÉE par l'appelant : un template marketing annoncé « utility » partait aux
 * contacts dont le consentement est inconnu. Elle est désormais lue chez Meta, comme dans l'Inbox.
 */
describe('verdictModele', () => {
  it('approuvé, dans la langue demandée : sa catégorie, lue chez Meta, et le nombre de variables de son corps', () => {
    expect(verdictModele({ statut: 'APPROVED', langue: 'fr', category: 'marketing', count: 2, nonEnvoyable: null }, 'fr')).toEqual({ statut: 'approuve', categorie: 'marketing', variables: 2 });
    expect(verdictModele({ statut: 'APPROVED', langue: 'fr', category: 'utility', count: 0, nonEnvoyable: null }, 'fr')).toEqual({ statut: 'approuve', categorie: 'utility', variables: 0 });
  });

  it('🔴 défaut 2 : introuvable, non approuvé, ou d’une AUTRE langue -> absent', () => {
    expect(verdictModele(null, 'fr')).toEqual({ statut: 'absent' });
    expect(verdictModele({ statut: 'PENDING', langue: 'fr', category: 'utility', count: 0, nonEnvoyable: null }, 'fr')).toEqual({ statut: 'absent' });
    expect(verdictModele({ statut: 'REJECTED', langue: 'fr', category: 'utility', count: 0, nonEnvoyable: null }, 'fr')).toEqual({ statut: 'absent' });
    // La lecture partagée retombe sur le NOM SEUL quand la langue ne correspond pas : pour l'API c'est un autre
    // template, et l'envoi échouerait chez Meta pour chaque destinataire.
    expect(verdictModele({ statut: 'APPROVED', langue: 'en', category: 'utility', count: 0, nonEnvoyable: null }, 'fr')).toEqual({ statut: 'absent' });
  });

  it('catégorie ABSENTE -> illisible, jamais « utility » par défaut', () => {
    expect(verdictModele({ statut: 'APPROVED', langue: 'fr', count: 0, nonEnvoyable: null }, 'fr')).toEqual({ statut: 'illisible' });
    expect(verdictModele({ statut: 'APPROVED', langue: 'fr', category: '', count: 0, nonEnvoyable: null }, 'fr')).toEqual({ statut: 'illisible' });
  });

  it('⚠️ catégorie LUE mais hors des deux admises -> categorie_non_admise, qui la nomme : réessayer n’y changerait rien', () => {
    expect(verdictModele({ statut: 'APPROVED', langue: 'fr', category: 'authentication', count: 0, nonEnvoyable: null }, 'fr'))
      .toEqual({ statut: 'categorie_non_admise', categorie: 'authentication' });
  });

  it('🔴 approuvé, catégorie admise, mais un envoi impossible -> non_envoyable, avec sa raison', () => {
    expect(verdictModele({ statut: 'APPROVED', langue: 'fr', category: 'utility', count: 0, nonEnvoyable: 'son en-tête texte porte une variable' }, 'fr'))
      .toEqual({ statut: 'non_envoyable', raison: 'son en-tête texte porte une variable' });
    // Non approuvé ou d'une catégorie non admise : ce verdict-là prime, il se corrige autrement.
    expect(verdictModele({ statut: 'PENDING', langue: 'fr', category: 'utility', count: 0, nonEnvoyable: 'x' }, 'fr')).toEqual({ statut: 'absent' });
    expect(verdictModele({ statut: 'APPROVED', langue: 'fr', category: 'authentication', count: 0, nonEnvoyable: 'x' }, 'fr'))
      .toEqual({ statut: 'categorie_non_admise', categorie: 'authentication' });
  });
});

describe('raisonNonEnvoyable et modeleLuDe', () => {
  const t = (over: Partial<TemplateSummary> = {}): TemplateSummary => ({
    id: 'x', name: 'confirmation', status: 'APPROVED', category: 'UTILITY', language: 'fr', body: 'Bonjour {{1}}',
    headerFormat: null, isCarousel: false, editable: true, ...over,
  });

  it('un template ordinaire peut partir ; chaque obstacle a sa raison lisible', () => {
    expect(raisonNonEnvoyable(t())).toBeNull();
    expect(raisonNonEnvoyable(t({ headerFormat: 'LOCATION' }))).toMatch(/location/);
    expect(raisonNonEnvoyable(t({ headerFormat: 'TEXT', headerText: 'Commande {{1}}' }))).toMatch(/en-tête texte/);
    expect(raisonNonEnvoyable(t({ headerFormat: 'TEXT', headerText: 'Commande' }))).toBeNull();
    expect(raisonNonEnvoyable(t({ headerFormat: 'IMAGE' }))).toMatch(/image/);
    expect(raisonNonEnvoyable(t({ buttons: [{ type: 'URL', text: 'Voir', url: 'https://exemple.test/p/{{1}}' }] }))).toMatch(/Voir/);
  });

  it('🔴 modeleLuDe : statut, langue et catégorie (en minuscules) du template TROUVÉ, et sa raison de ne pas partir', () => {
    expect(modeleLuDe(t({ body: 'A {{1}} B {{3}}' }))).toEqual({ count: 3, statut: 'APPROVED', langue: 'fr', category: 'utility', nonEnvoyable: null });
    // Une catégorie VIDE est absente : illisible, jamais « utility ».
    expect(modeleLuDe(t({ category: '' }))).not.toHaveProperty('category');
    expect(modeleLuDe(t({ headerFormat: 'IMAGE' })).nonEnvoyable).toMatch(/image/);
  });
});

describe('la lecture partagée du template est construite par `modeleLuDe`', () => {
  // Sans les commentaires : une explication qui CITE le bon code ne doit pas faire passer un câblage fautif.
  const source = readFileSync(new URL('../src/workflow/wiring.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  /**
   * 🔴 `templateVarInfo` rend le statut, la langue et la raison de ne pas partir du template TROUVÉ, par la MÊME
   * construction que le catalogue (`modeleLuDe`, tenue par les cas ci-dessus). Le type exige `nonEnvoyable` ;
   * ce cas exige que ce soit CETTE fonction qui le calcule, sur le template trouvé.
   */
  it('🔴 `templateVarInfo` construit sa lecture par `modeleLuDe(tpl)`', () => {
    expect(source).toMatch(/\.\.\.modeleLuDe\(tpl\),/);
  });
});
