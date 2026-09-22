import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { estimateCoutParCampagne } from '../src/stats/cost';
import { GRILLE_DEFAUT, coutRcsEuros } from '../src/stats/prix';

/**
 * LE RCS A UN PRIX, ET LE TABLEAU DU COUT PAR ENGAGEMENT LE COMPTE.
 *
 * 🔴 CE QUE CES TESTS FERMENT, ET QUI ETAIT UNE AFFIRMATION FAUSSE INSCRITE DANS LE CODE. Le tableau
 * annoncait « ce tableau ne chiffre que les tarifs Meta, une campagne RCS garde sa case vide ». C'etait vrai
 * avant la migration 0154 ; depuis, l'espace SAISIT ses deux prix RCS (6 cts, 8 cts en conversationnel) et
 * la ligne « cout des messages envoyes » les applique deja. Une campagne RCS affichait donc « on ne sait
 * pas » la ou on savait. Releve par Julien le 2026-09-23, sur ses propres campagnes.
 *
 * 🔴 ET LE CABLAGE SE LIT DANS LA SOURCE, parce que le calcul pur passerait tout aussi bien sans lui. Un
 * `estimateCoutParCampagne` appele sans son lot de RCS rend exactement ce qu'il rendait avant, sans erreur
 * de type (le parametre est optionnel, et il doit l'etre : une instance qui ne sait pas encore rattacher
 * ses RCS ne doit pas inventer un zero). C'est le motif « une garde qu'on peut debrancher sans qu'aucun
 * test ne tombe n'est pas une garde », que ce depot a deja paye.
 */
const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
/** Sans les commentaires : sinon une explication qui CITE le bon code ferait passer un cablage absent. */
const sansCommentaires = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('cablage du RCS dans le cout par campagne', () => {
  it('🔴 la route du cout par engagement LIT les envois RCS de la periode', () => {
    expect(sansCommentaires, 'getCoutParCampagne doit demander les envois RCS et leurs reactions')
      .toMatch(/getCoutParCampagne[\s\S]{0,900}statsStore\.envoisEtReactionsRcs\(tenant, range, FENETRE_BASCULE_MS\)/);
  });

  it('🔴 elle PASSE le lot de RCS au calcul, avec la grille de l espace', () => {
    expect(sansCommentaires, 'estimateCoutParCampagne doit recevoir parCampagne + grille')
      .toMatch(/estimateCoutParCampagne\([\s\S]{0,400}\{ parCampagne: rcsParCampagne, grille: grilleDepuisLigne\(ligne\) \}\)/);
  });

  it('🔴 la BASCULE est calculee sur TOUS les envois, pas sur ceux d une campagne', () => {
    // La regle fait passer l'ECHANGE entier a 8 cts des qu'une reaction suit l'un de ses envois dans les
    // sept jours : un RCS envoye hors campagne peut donc faire basculer les RCS de campagne du meme
    // echange. Filtrer sur la campagne AVANT `basculesRcs` sous-facturerait ce cas, en silence.
    const i = sansCommentaires.indexOf('getCoutParCampagne');
    const bloc = sansCommentaires.slice(i, i + 2500);
    const posBascule = bloc.indexOf('basculesRcs(envoisRcs, rcs.reactions)');
    const posFiltre = bloc.indexOf('c.campaignId === null');
    expect(posBascule, 'la bascule doit etre calculee dans cette route').toBeGreaterThan(-1);
    expect(posFiltre, 'l imputation doit ecarter les envois sans campagne').toBeGreaterThan(-1);
    expect(posFiltre, 'le filtre par campagne vient APRES la bascule').toBeGreaterThan(posBascule);
  });

  it('les deux ecrans appliquent LA MEME formule de prix RCS', () => {
    // `coutRcsEuros` vit dans `prix.ts` et sert la ligne « cout des messages » comme ce tableau. La formule
    // tenait en une ligne, ce qui est exactement pourquoi elle allait etre recopiee.
    expect(coutRcsEuros(1, 2, GRILLE_DEFAUT)).toBeCloseTo(0.22, 6);
    expect(coutRcsEuros(0, 0, GRILLE_DEFAUT)).toBe(0);
  });

  it('🔴 sans lot de RCS, le calcul rend EXACTEMENT ce qu il rendait avant', () => {
    // Le parametre est optionnel, et c'est voulu : une instance qui ne sait pas encore rattacher ses RCS
    // doit laisser la case vide, jamais afficher un zero qui se lirait « gratuit ».
    const rcs = { campaignId: 'rc', nom: 'gr sentis', template: null, canal: 'rcs', category: null, count: 0, envois: 1 };
    const r = estimateCoutParCampagne([rcs], { marketing: 0.1431, utility: 0.05, currency: 'EUR' }, new Map(), new Map());
    expect(r.lignes[0]!.cout).toBeNull();
  });
});
