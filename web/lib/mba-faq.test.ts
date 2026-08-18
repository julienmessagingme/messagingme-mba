import { describe, it, expect } from 'vitest';
import { resumeApercu, resumeImport } from './mba-faq';
import type { MbaFaqPreview, MbaFaqImportResult } from './api-mba';

const apercu = (over: Partial<MbaFaqPreview> = {}): MbaFaqPreview => ({
  source: 'csv', total: 0, aCreer: [], aMettreAJour: [], inchangees: 0, ...over,
});
const resultat = (over: Partial<MbaFaqImportResult> = {}): MbaFaqImportResult => ({
  source: 'csv', created: 0, updated: 0, unchanged: 0, remaining: 0, ids: { created: [], updated: [] }, failed: null, ...over,
});

describe('resumeApercu', () => {
  it('énumère ce qui sera écrit', () => {
    const texte = resumeApercu(apercu({
      total: 5,
      aCreer: [{ question: 'A', answer: '1' }, { question: 'B', answer: '2' }],
      aMettreAJour: [{ id: '1', question: 'C', answer: '3' }],
      inchangees: 2,
    }), 'fr');
    expect(texte).toBe('2 à créer, 1 à mettre à jour, 2 inchangées.');
  });

  it('🔴 dit clairement quand il n’y a RIEN à écrire', () => {
    // Le cas d'un ré-import à l'identique. Sans message explicite, un aperçu à zéro se lit comme un échec de
    // lecture du fichier, alors que c'est exactement le comportement voulu.
    const texte = resumeApercu(apercu({ total: 3, inchangees: 3 }), 'fr');
    expect(texte).toContain('Rien à écrire');
    expect(texte).toContain('3');
    expect(resumeApercu(apercu({ total: 3, inchangees: 3 }), 'en')).toContain('Nothing to write');
  });

  it('n’affiche pas les catégories vides', () => {
    expect(resumeApercu(apercu({ total: 1, aCreer: [{ question: 'A', answer: '1' }] }), 'fr')).toBe('1 à créer.');
  });
});

describe('resumeImport', () => {
  it('succès complet', () => {
    const r = resumeImport(resultat({ created: 3, updated: 1, unchanged: 2 }), 'fr');
    expect(r.kind).toBe('success');
    expect(r.texte).toBe('3 créées, 1 mise à jour, 2 inchangées.');
  });

  it('🔴 import interrompu : AVERTISSEMENT et non erreur, avec le reste et la promesse de non-duplication', () => {
    // Une partie EST écrite. Le peindre en rouge pousse à tout relancer comme si rien n'était passé, et sans
    // la mention « ne sera pas dupliqué », relancer fait peur alors que c'est précisément la marche à suivre.
    const r = resumeImport(resultat({ created: 4, remaining: 6, failed: { question: 'Les vélos ?', error: 'rate limit' } }), 'fr');
    expect(r.kind).toBe('warning');
    expect(r.texte).toContain('Les vélos ?');
    expect(r.texte).toContain('rate limit');
    expect(r.texte).toContain('6 question');
    expect(r.texte).toContain('ne sera pas dupliqué');
  });

  it('traduit le cas interrompu', () => {
    const r = resumeImport(resultat({ created: 1, remaining: 2, failed: { question: 'Q', error: 'boom' } }), 'en');
    expect(r.kind).toBe('warning');
    expect(r.texte).toContain('will not be duplicated');
  });
});
