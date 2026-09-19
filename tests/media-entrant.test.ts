import { describe, it, expect } from 'vitest';
import {
  DUREE_MEDIA_RECU_JOURS, MEDIA_EXPIRE_SQL, MIMES_AFFICHABLES, enTetesMedia, estMediaExpireChezMeta, nomDeFichierSur, typeNu,
} from '../src/inbox/media-entrant';
import { MetaApiError } from '../src/meta/errors';

/**
 * Les pièces jointes REÇUES (`src/inbox/media-entrant.ts`, 2026-09-19).
 *
 * 🔴 CE QUE CES TESTS PROTÈGENT : une frontière de sécurité et un chiffre mesuré. Un document reçu porte le
 * type que son EXPÉDITEUR annonce ; servi « inline » dans l'origine de la console, un HTML ou un SVG y
 * exécuterait son script et lirait la session de l'opérateur. Et le délai de Meta est de SEPT jours, pas
 * trente : le dépôt l'a affirmé à tort pendant dix jours.
 */
describe('les en-têtes d’une pièce jointe reçue', () => {
  it('une photo s’AFFICHE, avec nosniff', () => {
    const h = enTetesMedia('image/jpeg', null, 'piece');
    expect(h['content-type']).toBe('image/jpeg');
    expect(h['content-disposition']).toMatch(/^inline;/);
    expect(h['x-content-type-options']).toBe('nosniff');
  });

  it('🔴 un HTML, un SVG et un PDF se TÉLÉCHARGENT, jamais ne s’affichent', () => {
    // La frontière elle-même. Le SVG est le piège : c'est une image, et elle peut porter du script.
    for (const mime of ['text/html', 'image/svg+xml', 'application/pdf', 'application/xhtml+xml', 'text/html; charset=utf-8']) {
      expect(enTetesMedia(mime, 'f', 'piece')['content-disposition'], mime).toMatch(/^attachment;/);
    }
    expect(MIMES_AFFICHABLES.has('image/svg+xml')).toBe(false);
  });

  it('un type inconnu ou absent part en octets bruts, à télécharger', () => {
    const h = enTetesMedia(null, null, 'piece-1234');
    expect(h['content-type']).toBe('application/octet-stream');
    expect(h['content-disposition']).toBe(`attachment; filename="piece-1234"; filename*=UTF-8''piece-1234`);
  });

  it('les paramètres du type ne trompent pas la liste : « image/png; x=y » reste une image', () => {
    expect(enTetesMedia('IMAGE/PNG; x=y', null, 'p')['content-disposition']).toMatch(/^inline;/);
    expect(typeNu('audio/ogg; codecs=opus')).toBe('audio/ogg');
    expect(typeNu('  ')).toBeNull();
  });

  it('🔴 un nom de fichier hostile ne casse pas l’en-tête', () => {
    // Le nom vient de l'expéditeur : un guillemet fermerait la valeur, un retour à la ligne ouvrirait un
    // second en-tête, une barre ferait un chemin.
    const nom = 'facture"\r\nSet-Cookie: x=1/../mars.pdf';
    const h = String(enTetesMedia('application/pdf', nom, 'piece')['content-disposition']);
    expect(h).not.toMatch(/[\r\n]/);
    expect(h).not.toContain('Set-Cookie: x=1/');
    expect(h.split('"').length).toBe(3); // une paire de guillemets, pas une de plus
  });

  it('les accents voyagent en UTF-8, le repli ASCII les remplace', () => {
    const h = String(enTetesMedia('application/pdf', 'reçu été.pdf', 'piece')['content-disposition']);
    expect(h).toContain(`filename="re_u _t_.pdf"`);
    expect(h).toContain(`filename*=UTF-8''re%C3%A7u%20%C3%A9t%C3%A9.pdf`);
  });

  it('un nom vide après nettoyage retombe sur le nom neutre', () => {
    expect(nomDeFichierSur('"/\\', 'piece-ab')).toBe('piece-ab');
    expect(nomDeFichierSur(null, 'piece-ab')).toBe('piece-ab');
  });
});

describe('le délai de Meta sur un média reçu', () => {
  it('🔴 SEPT jours, et le fragment SQL le tient de la constante', () => {
    // Mesuré le 2026-09-19 : deux vocaux de 7,9 et 8,9 jours étaient introuvables chez Meta.
    expect(DUREE_MEDIA_RECU_JOURS).toBe(7);
    expect(MEDIA_EXPIRE_SQL).toContain(`days => ${DUREE_MEDIA_RECU_JOURS}`);
  });

  it('🔴 Meta 100/33 veut dire « expiré », et rien d’autre ne le veut', () => {
    expect(estMediaExpireChezMeta(new MetaApiError(400, { code: 100, error_subcode: 33 }))).toBe(true);
    expect(estMediaExpireChezMeta(new MetaApiError(400, { code: 100 }))).toBe(false);
    expect(estMediaExpireChezMeta(new MetaApiError(401, { code: 190 }))).toBe(false);
    expect(estMediaExpireChezMeta(new Error('100 33'))).toBe(false);
  });
});
