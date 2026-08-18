import { describe, it, expect } from 'vitest';
import {
  extensionCoherente as apiFichier,
  tailleFichierOk as apiTaille,
  titreSkillValide as apiTitre,
  MAX_FICHIER,
  TITRE_SKILL_MAX,
  DESCRIPTION_SKILL_MAX,
  CORPS_SKILL_MAX,
} from '../src/http/mba';
import { mbaFileExtensionOk as webFichier, mbaFileSizeOk as webTaille, MBA_FILE_MAX_BYTES } from '../web/lib/mba-files';
import {
  isValidSkillTitle as webTitre,
  slugSkillTitle,
  SKILL_TITLE_MAX,
  SKILL_DESCRIPTION_MAX,
  SKILL_BODY_MAX,
} from '../web/lib/mba-skills';

/**
 * Les deux builds (Next et API) ne partagent aucun module : les règles d'acceptation d'un fichier de
 * connaissance et d'un titre de compétence sont écrites DEUX FOIS. Ce test casse dès qu'elles divergent.
 *
 * Même forme que `web-button-url-parity.test.ts` : une TABLE DE CAS, et chaque cas est posé aux DEUX
 * implémentations. Comparer des constantes ne suffirait pas, c'est la façon de s'en servir qui diverge en
 * pratique (une borne oubliée dans un handler, une équivalence d'extension retirée d'un seul côté).
 */

describe('parité front / back : fichiers de connaissance', () => {
  it('même verdict sur chaque couple (nom, type)', () => {
    const CAS: Array<[string, string, boolean]> = [
      ['guide.pdf', 'application/pdf', true],
      ['GUIDE.PDF', 'application/pdf', true],
      ['note.doc', 'application/msword', true],
      ['note.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', true],
      ['plan.png', 'image/png', true],
      ['photo.jpg', 'image/jpeg', true],
      ['photo.jpeg', 'image/jpeg', true], // équivalence jpg/jpeg, retirée d'un seul côté = divergence
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
      expect(webFichier(nom, mime), `front sur « ${nom} » (${mime})`).toBe(attendu);
      expect(apiFichier(nom, mime), `back sur « ${nom} » (${mime})`).toBe(attendu);
    }
  });

  it('même verdict sur chaque taille, y compris aux bornes', () => {
    expect(MBA_FILE_MAX_BYTES).toBe(MAX_FICHIER);
    for (const [octets, attendu] of [[0, false], [1, true], [MAX_FICHIER, true], [MAX_FICHIER + 1, false]] as Array<[number, boolean]>) {
      expect(webTaille(octets), `front sur ${octets}`).toBe(attendu);
      expect(apiTaille(octets), `back sur ${octets}`).toBe(attendu);
    }
  });
});

describe('parité front / back : titre de compétence', () => {
  it('même verdict sur chaque titre, longueur comprise', () => {
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
      ['a'.repeat(TITRE_SKILL_MAX + 1), false], // la borne, oubliée d'un seul côté = le front ment
    ];
    for (const [titre, attendu] of CAS) {
      expect(webTitre(titre), `front sur « ${titre.slice(0, 20)} » (${titre.length})`).toBe(attendu);
      expect(apiTitre(titre), `back sur « ${titre.slice(0, 20)} » (${titre.length})`).toBe(attendu);
    }
  });

  it('les trois plafonds de saisie sont les mêmes des deux côtés', () => {
    // Ils pilotent les `maxLength` du formulaire : un resserrement côté serveur non répercuté donnerait un
    // champ qui accepte, affiche « valide », et part en 400.
    expect(SKILL_TITLE_MAX).toBe(TITRE_SKILL_MAX);
    expect(SKILL_DESCRIPTION_MAX).toBe(DESCRIPTION_SKILL_MAX);
    expect(SKILL_BODY_MAX).toBe(CORPS_SKILL_MAX);
  });

  it('🔴 tout ce que le slug produit est accepté par le SERVEUR', () => {
    // La vraie garantie recherchée : l'écran met en forme la saisie, et cette mise en forme ne doit JAMAIS
    // produire quelque chose que le serveur refuserait. Sinon l'utilisateur voit un champ « valide » partir
    // en 400. L'assertion porte donc sur l'implémentation SERVEUR, pas sur celle du front.
    // Le tiret cadratin de « Ligne 3 — samedi » est voulu : c'est ce que produit la correction automatique
    // de Word, donc ce que les gens collent réellement dans un champ.
    const SAISIES = [
      'Politique de retour !', 'Horaires  d’ouverture', '  Ligne 3 — samedi  ', 'ÉCHANGES & remboursements',
      '---', 'a', 'Ça va ?', 'X'.repeat(200), 'fin-', '-début',
    ];
    for (const brut of SAISIES) {
      const slug = slugSkillTitle(brut);
      if (slug === '') continue; // une saisie sans aucun caractère utile ne donne pas de titre, c'est correct
      expect(apiTitre(slug), `le serveur doit accepter « ${slug} » (issu de « ${brut.slice(0, 24)} »)`).toBe(true);
    }
  });
});
