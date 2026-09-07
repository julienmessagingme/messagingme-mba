import { describe, it, expect } from 'vitest';
import { segmentsMisEnForme, entoure, insere } from './chaine-mise-en-forme';
import { MAX_TEXTE_POST } from './api-chaine';

/**
 * La mise en forme du texte d'un post de chaîne.
 *
 * 🔴 CE QUE CES TESTS PROTÈGENT VRAIMENT. Ce texte part dans un post PUBLIÉ, donc irrattrapable. Une règle
 * de style trop gourmande ne se voit pas à l'écriture, elle se voit après la diffusion : une adresse coupée
 * en deux, un bouton mort, et aucun recours.
 */
const brut = (contenu: string) => ({ styles: [], contenu });

describe('segmentsMisEnForme', () => {
  it('rend le gras, l’italique et le barré', () => {
    expect(segmentsMisEnForme('un *mot* gras')).toEqual([
      brut('un '),
      { styles: ['gras'], contenu: 'mot' },
      brut(' gras'),
    ]);
    expect(segmentsMisEnForme('_penché_')).toEqual([{ styles: ['italique'], contenu: 'penché' }]);
    expect(segmentsMisEnForme('~rayé~')).toEqual([{ styles: ['barre'], contenu: 'rayé' }]);
  });

  it('🔴 les styles s’IMBRIQUENT, parce que c’est ce que deux clics de la barre produisent', () => {
    // `entoure` existe pour enchaîner gras puis italique : le résultat est `*_mot_*`, et il DOIT rendre les
    // deux styles. Avec un style unique, l'aperçu montrait « `_mot_` en gras », soulignés apparents, quand
    // WhatsApp compose les deux. Le client corrigeait alors un aperçu qui avait tort.
    expect(segmentsMisEnForme('*_mot_*')).toEqual([{ styles: ['gras', 'italique'], contenu: 'mot' }]);
    expect(segmentsMisEnForme('_~a~_')).toEqual([{ styles: ['italique', 'barre'], contenu: 'a' }]);
    // Un style intérieur PARTIEL laisse cohabiter les deux niveaux.
    expect(segmentsMisEnForme('*gros _et penché_ fin*')).toEqual([
      { styles: ['gras'], contenu: 'gros ' },
      { styles: ['gras', 'italique'], contenu: 'et penché' },
      { styles: ['gras'], contenu: ' fin' },
    ]);
  });

  it('🔴 C5 : une ADRESSE contenant des soulignés reste ENTIÈRE', () => {
    // Le lien du bouton est un morceau séparé de l'aperçu, il ne passe pas ici. Mais un client peut coller
    // une adresse DANS son texte, et un souligné entre deux lettres n'est pas une intention de style.
    const texte = 'Voir https://exemple.fr/mon_super_lien_2026 pour la suite';
    expect(segmentsMisEnForme(texte)).toEqual([brut(texte)]);
  });

  it('🔴 C8, preuve inverse de C5 : sur la MÊME adresse, la mise en forme fonctionne encore', () => {
    // Sans ce sens-là, C5 passerait aussi sur une fonction qui ne style plus jamais rien : « l'adresse est
    // intacte » serait vrai pour la pire des raisons. Ici l'italique s'ouvre et se ferme AUTOUR de l'adresse
    // (les soulignés de bordure sont précédés d'une espace), et il emporte l'adresse entière, ses soulignés
    // internes compris.
    expect(segmentsMisEnForme('Voir _https://exemple.fr/mon_super_lien_ ici')).toEqual([
      brut('Voir '),
      { styles: ['italique'], contenu: 'https://exemple.fr/mon_super_lien' },
      brut(' ici'),
    ]);
  });

  it('🔴 C4 : un marqueur ISOLÉ reste un caractère ordinaire', () => {
    // Le client qui tape « 5 * 3 » doit voir « 5 * 3 ». Une mise en forme qui avale un caractere isole fait
    // douter de tout le reste.
    expect(segmentsMisEnForme('5 * 3 = 15')).toEqual([brut('5 * 3 = 15')]);
    expect(segmentsMisEnForme('le fichier _brouillon')).toEqual([brut('le fichier _brouillon')]);
    // Ouvert puis jamais ferme : rien ne doit etre stylé.
    expect(segmentsMisEnForme('*promo sans fin')).toEqual([brut('*promo sans fin')]);
  });

  it('l’apostrophe TYPOGRAPHIQUE est une bordure, comme la droite', () => {
    // Toute l'interface écrit « l’ », pas « l' » : sans cette bordure, le style le plus naturel du français
    // ne partait jamais, et rien ne disait pourquoi.
    expect(segmentsMisEnForme('l’*offre*')).toEqual([brut('l’'), { styles: ['gras'], contenu: 'offre' }]);
    expect(segmentsMisEnForme("l'*offre*")).toEqual([brut("l'"), { styles: ['gras'], contenu: 'offre' }]);
  });

  it('un style ne traverse pas une ligne', () => {
    // Sinon une etoile en debut de liste stylerait tout le paragraphe suivant.
    expect(segmentsMisEnForme('*debut\nfin*')).toEqual([brut('*debut\nfin*')]);
  });

  it('plusieurs styles se suivent, et la ponctuation ne les empêche pas', () => {
    expect(segmentsMisEnForme('*Promo* : _-20%_ !')).toEqual([
      { styles: ['gras'], contenu: 'Promo' },
      brut(' : '),
      { styles: ['italique'], contenu: '-20%' },
      brut(' !'),
    ]);
  });

  it('texte vide -> aucun segment', () => {
    expect(segmentsMisEnForme('')).toEqual([]);
  });

  it('au-delà du plafond de publication, le texte est rendu BRUT sans être analysé', () => {
    // Garde de coût : l'analyse est quadratique dans son pire cas, l'aperçu recalcule à chaque frappe, et le
    // textarea n'a pas de maxLength. Un collage adversaire figerait l'onglet. Ce texte n'est de toute façon
    // pas publiable, donc son aperçu n'a plus rien à promettre.
    const enorme = ' *x'.repeat(MAX_TEXTE_POST);
    expect(segmentsMisEnForme(enorme)).toEqual([brut(enorme)]);
    // Et juste EN DESSOUS du plafond, on met bien en forme : la garde ne doit pas manger le cas nominal.
    // (L'espace après `*a*` est indispensable : une fermeture collée à une lettre n'en est pas une, cf. C5.)
    const juste = `*a* ${'b'.repeat(MAX_TEXTE_POST - 4)}`;
    expect(juste.length).toBe(MAX_TEXTE_POST);
    expect(segmentsMisEnForme(juste)[0]).toEqual({ styles: ['gras'], contenu: 'a' });
  });
});

describe('entoure', () => {
  it('🔴 C1 : entoure la sélection ET la rend, pour pouvoir enchaîner gras puis italique', () => {
    const r = entoure('un mot gras', 3, 6, '*');
    expect(r.texte).toBe('un *mot* gras');
    // La selection porte toujours sur « mot », pas sur les etoiles, et pas a la fin du texte.
    expect(r.texte.slice(r.debut, r.fin)).toBe('mot');
  });

  it('🔴 C2 : sélection VIDE -> les deux marqueurs, curseur entre les deux', () => {
    const r = entoure('avant apres', 6, 6, '_');
    expect(r.texte).toBe('avant __apres');
    expect(r.debut).toBe(r.fin);
    // Le curseur est ENTRE les deux marqueurs : un marqueur juste avant lui, un juste apres.
    expect(r.texte[r.debut - 1]).toBe('_');
    expect(r.texte[r.debut]).toBe('_');
  });

  it('🔴 une sélection qui emporte l’espace FINALE se rétrécit, sinon le bouton semble mort', () => {
    // Double-clic sous Windows : la sélection emporte l'espace suivante. `*promo *` n'est un gras NI pour
    // nous NI pour WhatsApp (la fermeture est précédée d'une espace), donc rien ne se met en forme.
    const r = entoure('a promo b', 2, 8, '*');
    expect(r.texte).toBe('a *promo* b');
    expect(segmentsMisEnForme(r.texte)).toContainEqual({ styles: ['gras'], contenu: 'promo' });
    expect(r.texte.slice(r.debut, r.fin)).toBe('promo');
  });

  it('🔴 une sélection qui emporte le PASSAGE À LA LIGNE se rétrécit aussi', () => {
    // Triple-clic : la ligne entière, saut de ligne compris. Sans rétrécissement on écrivait `*ligne\n*`,
    // qu'aucun style ne traverse, et l'étoile orpheline atterrissait en tête de la ligne suivante.
    const r = entoure('ligne\nsuite', 0, 6, '*');
    expect(r.texte).toBe('*ligne*\nsuite');
    expect(segmentsMisEnForme(r.texte)).toContainEqual({ styles: ['gras'], contenu: 'ligne' });
  });

  it('une sélection faite QUE d’espaces retombe sur le cas « sélection vide »', () => {
    // Le rétrécissement consomme les deux bords jusqu'à les faire se rejoindre : les marqueurs se posent
    // au bout de ce qui était sélectionné, curseur entre les deux, prêt à taper. Les espaces sont rendues
    // au texte, elles ne sont pas avalées.
    const r = entoure('a   b', 1, 4, '~');
    expect(r.debut).toBe(r.fin);
    expect(r.texte).toBe('a   ~~b');
    expect(r.texte[r.debut - 1]).toBe('~');
    expect(r.texte[r.debut]).toBe('~');
  });

  it('entourer deux fois donne bien le second marqueur autour du premier', () => {
    const gras = entoure('mot', 0, 3, '*');
    const italique = entoure(gras.texte, gras.debut, gras.fin, '_');
    expect(italique.texte).toBe('*_mot_*');
    // Et ce que ces deux clics produisent se REND, avec les deux styles. C'est le lien entre les deux
    // moitiés du lot : la barre écrit, l'aperçu montre, et les deux doivent dire la même chose.
    expect(segmentsMisEnForme(italique.texte)).toEqual([{ styles: ['gras', 'italique'], contenu: 'mot' }]);
  });
});

describe('insere', () => {
  it('🔴 C3 : insère au CURSEUR, pas à la fin', () => {
    const r = insere('bonjour tout le monde', 7, 7, ' 👍');
    expect(r.texte).toBe('bonjour 👍 tout le monde');
    // Le curseur suit le caractere insere, pour pouvoir en poser un second.
    expect(r.debut).toBe(r.fin);
    expect(r.texte.slice(0, r.debut)).toBe('bonjour 👍');
  });

  it('une sélection non vide est REMPLACÉE, comme le ferait une frappe', () => {
    expect(insere('bonjour monde', 8, 13, '🌍').texte).toBe('bonjour 🌍');
  });
});
