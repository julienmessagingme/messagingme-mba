import { describe, it, expect } from 'vitest';
import {
  cleQuestion,
  extraireDepuisCsv,
  extraireDepuisHtml,
  extraireDepuisJson,
  normaliser,
  planifierImport,
} from '../src/mba/faq-import';

describe('extraction CSV', () => {
  it('reconnaît les colonnes par leur nom, en français comme en anglais', () => {
    const fr = extraireDepuisCsv('Question;Réponse\nLes chiens sont-ils admis ?;Oui, tenus en laisse.\n');
    expect(fr).toEqual([{ question: 'Les chiens sont-ils admis ?', answer: 'Oui, tenus en laisse.' }]);
    const en = extraireDepuisCsv('answer,question\nYes.,Are dogs allowed?\n');
    expect(en).toEqual([{ question: 'Are dogs allowed?', answer: 'Yes.' }]);
  });

  it('sans en-tête reconnu, retombe sur les DEUX PREMIÈRES colonnes', () => {
    // Le cas courant : un export client dont les colonnes s'appellent « Intitulé » et « Texte ».
    const rows = extraireDepuisCsv('Sujet,Texte,Auteur\nHoraires ?,De 6h à 21h,Marie\n');
    expect(rows).toEqual([{ question: 'Horaires ?', answer: 'De 6h à 21h' }]);
  });

  it('réduit les espaces des exports Excel (retours et insécables)', () => {
    const rows = extraireDepuisCsv('question,answer\n"Tarif ?","2,00 €\n  le ticket"\n');
    expect(rows[0]).toEqual({ question: 'Tarif ?', answer: '2,00 € le ticket' });
  });
});

describe('extraction JSON', () => {
  it('tableau d’objets, clés en français ou en anglais', () => {
    expect(extraireDepuisJson([{ question: 'Q1', answer: 'R1' }, { demande: 'Q2', reponse: 'R2' }]))
      .toEqual([{ question: 'Q1', answer: 'R1' }, { question: 'Q2', answer: 'R2' }]);
  });

  it('descend dans l’objet qui enveloppe le tableau', () => {
    expect(extraireDepuisJson({ meta: 1, faqs: [{ q: 'Q', a: 'R' }] })).toEqual([{ question: 'Q', answer: 'R' }]);
  });
});

describe('extraction HTML', () => {
  it('lit le JSON-LD FAQPage de schema.org (la forme des CMS)', () => {
    const html = `<html><head><script type="application/ld+json">
      {"@context":"https://schema.org","@type":"FAQPage","mainEntity":[
        {"@type":"Question","name":"Les vélos sont-ils accept&eacute;s ?","acceptedAnswer":{"@type":"Answer","text":"<p>Oui, pliants uniquement.</p>"}}]}
    </script></head><body></body></html>`;
    expect(extraireDepuisHtml(html)).toEqual([
      { question: 'Les vélos sont-ils acceptés ?', answer: 'Oui, pliants uniquement.' },
    ]);
  });

  it('lit un accordéon <details><summary>', () => {
    const html = '<details><summary>Où acheter un ticket ?</summary><p>En agence ou à bord.</p></details>';
    expect(extraireDepuisHtml(html)).toEqual([{ question: 'Où acheter un ticket ?', answer: 'En agence ou à bord.' }]);
  });

  it('lit une liste de définitions <dt>/<dd>', () => {
    expect(extraireDepuisHtml('<dl><dt>Horaires ?</dt><dd>6h-21h</dd></dl>'))
      .toEqual([{ question: 'Horaires ?', answer: '6h-21h' }]);
  });

  it('🔴 page sans structure reconnue -> AUCUNE ligne, pas une invention', () => {
    // Deviner « ce paragraphe répond à ce titre » produirait des réponses fausses présentées comme sûres.
    // Mieux vaut rendre vide et demander un CSV que d'alimenter l'agent avec des appariements inventés.
    const html = '<h2>Les chiens</h2><p>Nos bus acceptent les chiens tenus en laisse.</p><h2>Les vélos</h2><p>Non.</p>';
    expect(extraireDepuisHtml(html)).toEqual([]);
  });

  it('n’aspire pas le contenu des balises script dans une réponse', () => {
    const html = '<details><summary>Q</summary><script>var x = "secret";</script><p>R</p></details>';
    expect(extraireDepuisHtml(html)).toEqual([{ question: 'Q', answer: 'R' }]);
  });
});

describe('normalisation', () => {
  it('jette les lignes incomplètes et dédoublonne dans le lot', () => {
    const out = normaliser([
      { question: 'Les chiens sont-ils admis ?', answer: 'Oui.' },
      { question: 'les chiens sont ils admis', answer: 'Non.' }, // même question pour un humain
      { question: 'Sans réponse ?', answer: '   ' },
      { question: '', answer: 'Orpheline' },
    ]);
    expect(out).toEqual([{ question: 'Les chiens sont-ils admis ?', answer: 'Oui.' }]);
  });

  it('la clé de comparaison ignore accents, casse et ponctuation', () => {
    expect(cleQuestion('Où ? Le TARIF...')).toBe(cleQuestion('ou le tarif'));
  });
});

describe('plan d’import', () => {
  const existantes = [
    { id: '1', question: 'Les chiens sont-ils admis ?', answer: 'Oui, tenus en laisse.', metadata: { src: 'keolis' } },
    { id: '2', question: 'Horaires ?', answer: '6h-21h' },
  ];

  it('🔴 rejouer le MÊME lot n’écrit rien (l’API Meta ne déduplique pas)', () => {
    const plan = planifierImport(existantes, existantes.map((f) => ({ question: f.question, answer: f.answer })));
    expect(plan.aCreer).toHaveLength(0);
    expect(plan.aMettreAJour).toHaveLength(0);
    expect(plan.inchangees).toBe(2);
  });

  it('sépare création, mise à jour et inchangé', () => {
    const plan = planifierImport(existantes, [
      { question: 'Les chiens sont-ils admis ?', answer: 'Oui, tenus en laisse.' },
      { question: 'horaires', answer: '6h-22h en été' }, // même question, réponse différente
      { question: 'Les vélos ?', answer: 'Pliants uniquement.' },
    ]);
    expect(plan.inchangees).toBe(1);
    expect(plan.aCreer).toEqual([{ question: 'Les vélos ?', answer: 'Pliants uniquement.' }]);
    expect(plan.aMettreAJour).toEqual([{ id: '2', question: 'horaires', answer: '6h-22h en été' }]);
  });

  it('🔴 repasse les metadata existantes sur une mise à jour', () => {
    // Le PUT de MBA est un remplacement complet : omettre `metadata` effacerait le rattachement de l’entrée.
    const plan = planifierImport(existantes, [{ question: 'Les chiens sont-ils admis ?', answer: 'Oui, en cage.' }]);
    expect(plan.aMettreAJour[0]).toEqual({ id: '1', question: 'Les chiens sont-ils admis ?', answer: 'Oui, en cage.', metadata: { src: 'keolis' } });
  });

  it('ne propose JAMAIS de suppression, même si l’existant déborde du lot', () => {
    const plan = planifierImport(existantes, [{ question: 'Les vélos ?', answer: 'Non.' }]);
    expect(Object.keys(plan)).toEqual(['aCreer', 'aMettreAJour', 'inchangees']);
    expect(plan.aCreer).toHaveLength(1);
  });
});
