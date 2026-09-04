import { describe, it, expect } from 'vitest';
import { PREFIXE_JETON, nouveauJeton, estJetonChaine, textePreRempli } from '../src/channels-me/jeton';
import { normalizeText, keywordsOf } from '../src/automation/match';

/**
 * Le jeton d'un lien de chaine WhatsApp (Channels Me), et le texte que l'abonne ENVOIE en appuyant sur le
 * bouton dessine par WhatsApp.
 *
 * Ce que ces tests protegent, et qui ne se voit pas a la lecture :
 *  1. Le jeton n'est pas devinable. C'est lui, et lui seul, qui demarre le scenario d'un client : il pose des
 *     tags, remplit des champs et envoie des messages factures. Une suite previsible (compteur, graine figee)
 *     laisserait n'importe qui declencher tout cela chez ce client.
 *  2. Aucun caractere ambigu dans la partie tiree. Un abonne peut recopier le texte a la main : un i, un l, un
 *     o ou un u recopie de travers donnerait un message qui ne declenche rien, sans que personne ne comprenne
 *     pourquoi, et le post, lui, est deja parti.
 *  3. `estJetonChaine` est STRICT (chaine entiere). C'est un controle de forme sur NOS jetons, jamais le detecteur
 *     d'un message entrant : la reconnaissance d'un message passe par `normalizeText` puis `contains` dans
 *     `matchesTrigger`, ce que le second bloc de ce fichier verifie.
 *  4. 🔴 LE JETON SURVIT A `normalizeText`. C'est l'invariant qui porte toute la feature : le corps du message
 *     entrant est normalise avant comparaison, donc un jeton qui ne serait pas invariant (majuscule, accent,
 *     espace) ne serait jamais retrouve. Le symptome serait muet : les boutons de tous les posts deja publies
 *     cesseraient de declencher quoi que ce soit, sans erreur, sans journal, et un post publie circule pour
 *     toujours.
 *  5. Le jeton survit AUSSI cote configuration : `keywordsOf` normalise les mots cles stockes. Les deux cotes
 *     de la comparaison doivent aboutir a la meme chaine, sinon on compare deux choses differentes.
 */

const TIRAGES = 200;

describe('forme du jeton de chaine', () => {
  it('« cm- » suivi de 8 caracteres, sur 200 tirages', () => {
    for (let i = 0; i < TIRAGES; i += 1) {
      const jeton = nouveauJeton();
      expect(jeton.startsWith(PREFIXE_JETON), `jeton sans prefixe : ${jeton}`).toBe(true);
      expect(jeton).toHaveLength(PREFIXE_JETON.length + 8);
    }
  });

  it('aucun caractere ambigu dans la partie tiree : ni i, ni l, ni o, ni u', () => {
    for (let i = 0; i < TIRAGES; i += 1) {
      const tire = nouveauJeton().slice(PREFIXE_JETON.length);
      expect(/^[0-9a-hjkmnp-tv-z]{8}$/.test(tire), `alphabet viole : ${tire}`).toBe(true);
      expect(/[ilou]/.test(tire), `caractere ambigu tire : ${tire}`).toBe(false);
    }
  });

  it('estJetonChaine REFUSE tout ce qui n est pas exactement un jeton', () => {
    // Jeton FICTIF (aucun secret) : valeur figee pour rendre les assertions lisibles.
    expect(estJetonChaine('cm-a7k2m9p3')).toBe(true);
    expect(estJetonChaine(nouveauJeton())).toBe(true);
    expect(estJetonChaine('Ma newsletter (cm-a7k2m9p3)')).toBe(false); // une phrase qui CONTIENT un jeton
    expect(estJetonChaine('CM-A7K2M9P3')).toBe(false); // majuscules : nos jetons sont produits et stockes minuscules
    expect(estJetonChaine('cm-a7k2m9p')).toBe(false); // 7 caracteres tires
    expect(estJetonChaine('cm-a7k2m9p33')).toBe(false); // 9 caracteres tires
    expect(estJetonChaine('cm-a7k2m9pi')).toBe(false); // « i » hors alphabet
    expect(estJetonChaine(' cm-a7k2m9p3 ')).toBe(false); // espaces autour
    expect(estJetonChaine('')).toBe(false);
    expect(estJetonChaine('test-a7k2m9p3')).toBe(false); // le jeton de TEST d un scenario, autre prefixe
  });

  it('200 tirages donnent 200 jetons distincts', () => {
    const vus = new Set<string>();
    for (let i = 0; i < TIRAGES; i += 1) vus.add(nouveauJeton());
    // L'index unique de la migration 0114 exige l'unicite GLOBALE du jeton (il circule dans des messages
    // publics et il est cherche sur le chemin chaud). 40 bits de hasard la rendent pratiquement acquise ;
    // un generateur qui se repeterait se verrait ici.
    expect(vus.size).toBe(TIRAGES);
  });
});

describe('texte pre-rempli', () => {
  // Jeton FICTIF (aucun secret) : valeur figee pour rendre les assertions lisibles.
  const JETON = 'cm-a7k2m9p3';

  it('rend « <phrase> (<jeton>) »', () => {
    expect(textePreRempli('Je veux recevoir la newsletter', JETON))
      .toBe('Je veux recevoir la newsletter (cm-a7k2m9p3)');
  });

  it('detoure la phrase, et une phrase vide ne laisse pas d espace de tete', () => {
    expect(textePreRempli('  Je veux la newsletter  ', JETON)).toBe('Je veux la newsletter (cm-a7k2m9p3)');
    // La route de creation d'un lien refuse deja une phrase vide, mais une fonction pure doit rester totale :
    // mieux vaut le jeton seul qu'un texte qui commence par une espace.
    expect(textePreRempli('', JETON)).toBe('(cm-a7k2m9p3)');
    expect(textePreRempli('   ', JETON)).toBe('(cm-a7k2m9p3)');
  });

  it('🔴 le jeton SURVIT a normalizeText : accents, majuscules et espaces multiples', () => {
    const normalise = normalizeText(textePreRempli('Ça   m INTERESSE, à bientôt !', JETON));
    // La phrase, elle, est bien rabotee : c'est la preuve que normalizeText a reellement travaille ce texte,
    // et que le jeton n'est pas passe entre les gouttes d'une normalisation qui n'aurait rien fait.
    expect(normalise).toBe('ca m interesse, a bientot ! (cm-a7k2m9p3)');
    expect(normalise).toContain(JETON);
  });

  it('le jeton reste intact en MOT-CLE d automation (keywordsOf)', () => {
    // L'autre moitie de la correspondance. `matchesTrigger` normalise le CORPS du message, mais `keywordsOf`
    // normalise aussi les MOTS CLES stockes : un jeton doit etre invariant des deux cotes, sans quoi la
    // comparaison porterait sur deux chaines differentes et le bouton ne declencherait jamais rien.
    expect(keywordsOf({ keywords: [JETON], mode: 'contains' })).toEqual([JETON]);
    const tire = nouveauJeton();
    expect(keywordsOf({ keywords: [tire] })).toEqual([tire]);
  });

  it('200 jetons tires au hasard survivent tous a normalizeText', () => {
    for (let i = 0; i < TIRAGES; i += 1) {
      const jeton = nouveauJeton();
      const normalise = normalizeText(textePreRempli('Notre newsletter du mois', jeton));
      expect(normalise, `jeton perdu a la normalisation : ${jeton}`).toContain(jeton);
    }
  });
});
