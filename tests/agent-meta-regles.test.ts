import { describe, it, expect } from 'vitest';
import { extensionCoherente, tailleFichierOk, titreSkillValide, MAX_FICHIER, TITRE_SKILL_MAX } from '../web/lib/partage/agent-meta';
import { slugSkillTitle } from '../web/lib/mba-skills';

/**
 * Les règles d'acceptation de l'agent de Meta : un fichier de connaissance, un titre de consigne. Elles sont partagées
 * par la console (qui refuse tout de suite) et le serveur (qui refuse en dernier ressort) ; ces tables de cas éprouvent
 * la règle unique, et la mise en forme de la console contre elle.
 */
describe('fichiers de connaissance', () => {
  it('le verdict sur chaque couple (nom, type)', () => {
    const CAS: Array<[string, string, boolean]> = [
      ['guide.pdf', 'application/pdf', true],
      ['GUIDE.PDF', 'application/pdf', true],
      ['note.doc', 'application/msword', true],
      ['note.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', true],
      ['plan.png', 'image/png', true],
      ['photo.jpg', 'image/jpeg', true],
      ['photo.jpeg', 'image/jpeg', true], // équivalence jpg/jpeg
      ['tarifs.csv', 'text/csv', true],
      ['tarifs.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', true],
      ['guide.docx', 'application/pdf', false], // le nom ment sur le contenu
      ['guide', 'application/pdf', false],
      ['photo.png', 'image/jpeg', false],
      ['notes.txt', 'text/plain', false], // absent du schéma Meta, malgré sa prose
      ['notes.md', 'text/markdown', false],
      ['deck.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', false],
    ];
    for (const [nom, mime, attendu] of CAS) {
      expect(extensionCoherente(nom, mime), `« ${nom} » (${mime})`).toBe(attendu);
    }
  });

  it('le verdict sur chaque taille, y compris aux bornes', () => {
    for (const [octets, attendu] of [[0, false], [1, true], [MAX_FICHIER, true], [MAX_FICHIER + 1, false]] as Array<[number, boolean]>) {
      expect(tailleFichierOk(octets), `${octets} octets`).toBe(attendu);
    }
  });
});

describe('titre de consigne', () => {
  it('le verdict sur chaque titre, longueur comprise', () => {
    const CAS: Array<[string, boolean]> = [
      ['politique-de-retour', true],
      ['horaires', true],
      ['ligne-3-2026', true],
      ['a', true],
      ['Politique', false],
      ['-retours', false],
      ['retours-', false],
      ['deux--tirets', false],
      ['avec_underscore', false],
      ['avec espace', false],
      ['', false],
      ['a'.repeat(TITRE_SKILL_MAX), true],
      ['a'.repeat(TITRE_SKILL_MAX + 1), false],
    ];
    for (const [titre, attendu] of CAS) {
      expect(titreSkillValide(titre), `« ${titre.slice(0, 20)} » (${titre.length})`).toBe(attendu);
    }
  });

  it('🔴 tout ce que la mise en forme de la console produit est accepté par la règle', () => {
    // L'écran met en forme la saisie, et cette mise en forme ne doit JAMAIS produire un titre refusé : sinon
    // l'utilisateur voit un champ « valide » partir en 400. Le tiret cadratin de « Ligne 3 — samedi » est voulu :
    // c'est ce que produit la correction automatique de Word, donc ce que les gens collent réellement.
    const SAISIES = [
      'Politique de retour !', 'Horaires  d’ouverture', '  Ligne 3 — samedi  ', 'ÉCHANGES & remboursements',
      '---', 'a', 'Ça va ?', 'X'.repeat(200), 'fin-', '-début',
    ];
    for (const brut of SAISIES) {
      const slug = slugSkillTitle(brut);
      if (slug === '') continue; // une saisie sans aucun caractère utile ne donne pas de titre, c'est correct
      expect(titreSkillValide(slug), `« ${slug} » (issu de « ${brut.slice(0, 24)} »)`).toBe(true);
    }
  });
});
