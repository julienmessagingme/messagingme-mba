import { describe, it, expect } from 'vitest';
import { PREFIXE_JETON, motCleDepuisPhrase, nouveauJeton, estJetonChaine, textePreRempli } from '../src/channels-me/jeton';
import { normalizeText, keywordsOf, matchesTrigger } from '../src/automation/match';
import { POSSESSEUR_LIEN_CHAINE } from '../src/automation/match';
import type { AutomationRow, AutomationEvent } from '../src/automation/match';

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
  // Jeton FICTIF (aucun secret) : il ne route plus rien, mais il vit encore dans les posts DEJA PUBLIES.
  const JETON = 'cm-a7k2m9p3';

  it('rend la PHRASE SEULE, sans jeton', () => {
    // 🔴 Le texte etait `phrase (cm-xxxx)` jusqu au 2026-09-07. C est ce suffixe qui allongeait l URL
    // `wa.me`, dont le parametre `text=` porte tout le message.
    expect(textePreRempli('Je veux recevoir la newsletter')).toBe('Je veux recevoir la newsletter');
  });

  it('detoure la phrase, et une phrase vide rend une chaine vide', () => {
    expect(textePreRempli('  Je veux la newsletter  ')).toBe('Je veux la newsletter');
    // La route de creation refuse deja une phrase vide ; une fonction pure reste totale et n en juge pas.
    expect(textePreRempli('')).toBe('');
    expect(textePreRempli('   ')).toBe('');
  });

  it('🔴 la PHRASE survit a normalizeText des DEUX cotes (c est elle qui route desormais)', () => {
    // Meme souci qu avant, deplace sur la nouvelle cle : la comparaison normalise le CORPS du message ET le
    // MOT-CLE stocke. Si les deux ne donnaient pas la meme chaine, le bouton ne declencherait jamais rien.
    const phrase = 'Ça   m INTERESSE, à bientôt !';
    const corps = normalizeText(textePreRempli(phrase));
    expect(corps).toBe('ca m interesse, a bientot !');
    expect(keywordsOf({ keywords: [phrase], mode: 'contains' })).toEqual([corps]);
  });

  it('🔴 B1 : un post DEJA PUBLIE continue de declencher, quel que soit le jeton tire', () => {
    // LE critere qui rend ce lot possible. Un post distribue avant le 2026-09-07 envoie `phrase (cm-xxxx)`,
    // et le mode de comparaison est `contains` : le corps normalise doit donc CONTENIR la phrase
    // normalisee, pour les 32^8 jetons possibles et pas seulement pour celui qu on aurait choisi comme
    // exemple. Un post publie ne peut plus etre modifie : si ceci tombe, tout ce qui circule est mort.
    const phrase = 'Notre newsletter du mois';
    const cle = normalizeText(phrase);
    for (let i = 0; i < TIRAGES; i += 1) {
      const jeton = nouveauJeton();
      const ancienTexte = `${phrase} (${jeton})`;
      expect(normalizeText(ancienTexte), `post casse par le jeton ${jeton}`).toContain(cle);
    }
    // Et le cas figé, pour que l echec soit lisible quand il arrive.
    expect(normalizeText(`${phrase} (${JETON})`)).toContain(cle);
  });

  it('🔴 B1, l autre moitie : le VRAI comparateur fait matcher un ancien post, et `equals` le tuerait', () => {
    // Le test ci-dessus prouve que le texte CONTIENT la phrase. Il ne prouve pas que la comparaison est en
    // mode `contains` : c'est le cablage qui le decide, et un cablage n'a par construction aucun dependant.
    // On exerce donc le vrai `matchesTrigger`, avec la vraie automation.
    const phrase = 'Je veux mon code promo !';
    const auto = (mode: string): AutomationRow => ({
      id: 'a1', tenantId: 't1', name: 'Chaine', enabled: true,
      triggerKind: 'keyword', triggerConfig: { keywords: [phrase], mode }, conditionGroup: null,
      workflowId: 'wf1', startNodeId: null, cooldownSeconds: null, maxFiresPerHour: null,
      // C est bien une automation NEE D UN LIEN DE CHAINE : la fixture le dit, sinon elle cesserait de
      // representer le cas reel le jour ou ce champ decide de quelque chose. Il decide depuis le
      // 2026-09-08 de la reprise de main sur le fil.
      possedePar: POSSESSEUR_LIEN_CHAINE,
    });
    const ancienPost = (b: string): AutomationEvent =>
      ({ kind: 'message', waId: '33611', body: b, isNewContact: false, channel: 'whatsapp' });

    // Un post publie AVANT la bascule : son bouton envoie la phrase ET le jeton.
    expect(matchesTrigger(auto('contains'), ancienPost(`${phrase} (${JETON})`))).toBe(true);
    // Un post publie APRES : la phrase seule.
    expect(matchesTrigger(auto('contains'), ancienPost(phrase))).toBe(true);
    // 🔴 LA PREUVE INVERSE, DANS LE TEST : en `equals`, l ancien post ne matche plus. C est-a-dire que tous
    // les posts deja distribues auraient un bouton mort, sans aucun recours. C est la raison pour laquelle
    // le mode ne doit jamais changer, et elle est ici plutot que dans un commentaire.
    expect(matchesTrigger(auto('equals'), ancienPost(`${phrase} (${JETON})`))).toBe(false);
  });
});

describe('motCleDepuisPhrase', () => {
  /**
   * 🔴 LE DEFAUT VECU LE 2026-09-08 : un bouton dont la phrase finissait par « ! » ne demarrait AUCUN
   * scenario. Le message recu etait ampute de sa ponctuation finale (l auto-detection de liens de WhatsApp
   * l exclut de l adresse qu elle ouvre), et en mode `contains` un message plus COURT que le mot-cle ne
   * correspond a rien.
   */
  it('🔴 retire la ponctuation FINALE, celle que le lien perd en route', () => {
    expect(motCleDepuisPhrase('je veux mon de code promo!')).toBe('je veux mon de code promo');
    expect(motCleDepuisPhrase('Je veux mon code promo !')).toBe('Je veux mon code promo');
    expect(motCleDepuisPhrase('Deja pret ?')).toBe('Deja pret');
  });

  it('🔴 preuve inverse : la ponctuation du MILIEU est du texte, elle reste', () => {
    // La retirer changerait le sens de la correspondance.
    expect(motCleDepuisPhrase('-20%, c est maintenant')).toBe('-20%, c est maintenant');
    expect(motCleDepuisPhrase('Je veux en savoir plus')).toBe('Je veux en savoir plus');
  });

  it('les DEUX formes du message correspondent alors, l ancienne comme la nouvelle', () => {
    // C est tout l objet de la regle : un post DEJA PUBLIE envoie la forme amputee et ne peut plus etre
    // modifie, un post neuf enverra la forme complete. Le mot-cle doit attraper les deux, en mode contains.
    const cle = motCleDepuisPhrase('je veux mon de code promo!');
    expect('je veux mon de code promo'.includes(cle)).toBe(true);
    expect('je veux mon de code promo!'.includes(cle)).toBe(true);
  });

  it('une phrase faite QUE de ponctuation rend une chaine vide, pas un mot-cle attrape-tout', () => {
    // Un mot-cle vide est ecarte par `keywordsOf` : l automation ne declenche JAMAIS, au lieu de declencher
    // sur TOUT, ce qui serait le pire des deux.
    expect(motCleDepuisPhrase('!!!')).toBe('');
  });
});
