import { describe, expect, it } from 'vitest';
import {
  audienceEnFiltres, audienceInitiale, auFilDeLEau, cibleDeCreation, estRetenu, filtresDesImportes,
  libelleAudience, nbRetenus, selectionTout, selectionVide,
} from './audience';

/**
 * QUI REÇOIT UNE CAMPAGNE.
 *
 * 🔴 CE QUE CES CAS SÉPARENT. Les deux modes se ressemblent et se confondent en un caractère : une
 * implémentation qui lirait `selected` en mode « tout ce qui correspond » annoncerait ZÉRO destinataire
 * sur une campagne qui vise tout l'espace, et une qui lirait `exclus` hors de ce mode retirerait des
 * gens qu'on n'a jamais décochés. Chaque fonction est donc exercée DANS LES DEUX MODES.
 */

describe('ce qui est retenu, ligne par ligne', () => {
  it('en mode liste, seules les lignes cochees le sont', () => {
    const sel = { ...selectionVide(), selected: new Set(['a', 'b']) };
    expect(estRetenu(sel, 'a')).toBe(true);
    expect(estRetenu(sel, 'z')).toBe(false);
  });

  // 🔴 L'AUTRE SENS, ET IL EST INVERSE : en mode « tout ce qui correspond », une ligne est retenue SAUF
  // si elle a été décochée. Une implémentation qui lirait `selected` ici ne retiendrait personne.
  it('en mode « tout ce qui correspond », tout est retenu sauf les exclusions', () => {
    const sel = { ...selectionTout(), exclus: new Set(['b']) };
    expect(estRetenu(sel, 'a')).toBe(true);
    expect(estRetenu(sel, 'b')).toBe(false);
  });
});

describe('combien de destinataires', () => {
  it('en mode liste, c est le nombre de cases cochees, et le total ne compte pas', () => {
    const sel = { ...selectionVide(), selected: new Set(['a', 'b', 'c']) };
    expect(nbRetenus(sel, 9999)).toBe(3);
    expect(nbRetenus(sel, null)).toBe(3);
  });

  it('en mode « tout », c est le total SERVEUR moins les exclusions', () => {
    const sel = { ...selectionTout(), exclus: new Set(['a', 'b']) };
    expect(nbRetenus(sel, 1000)).toBe(998);
  });

  // ⚠️ LES DEUX COMPTES VIENNENT DE DEUX INSTANTS : un total pas encore lu, ou des exclusions plus
  // nombreuses que ce que le dernier comptage a vu, ne doivent pas produire « -3 destinataires », qui
  // serait lu comme un bug par celui qui appuie sur le bouton.
  it('jamais un nombre negatif, et un total inconnu vaut zero', () => {
    expect(nbRetenus({ ...selectionTout(), exclus: new Set(['a', 'b']) }, 1)).toBe(0);
    expect(nbRetenus(selectionTout(), null)).toBe(0);
  });
});

describe('ce que la creation emporte', () => {
  it('le mode « tout » part en FILTRES, avec ses exclusions', () => {
    const sel = { ...selectionTout(), exclus: new Set(['x']) };
    expect(cibleDeCreation(sel, { tags: ['vip'] })).toEqual({
      contactTarget: { filters: { tags: ['vip'] }, excludeIds: ['x'] },
    });
  });

  // 🔴 LES DEUX FORMES SONT EXCLUSIVES, LE SERVEUR REFUSE DE RECEVOIR LES DEUX. C'est ce qui rend cette
  // traduction dangereuse à recopier : une moitié recopiée fait partir une campagne à une population que
  // l'écran n'a jamais montrée.
  it('le mode liste part en IDENTIFIANTS, et jamais les deux a la fois', () => {
    const sel = { ...selectionVide(), selected: new Set(['c1']) };
    const cible = cibleDeCreation(sel, { tags: ['vip'] });
    expect(cible).toEqual({ contactIds: ['c1'] });
    expect('contactTarget' in cible).toBe(false);
  });

  // ⚠️ Une liste VIDE reste une liste vide : la rendre en « tous les contacts » ferait partir une
  // campagne à tout l'espace là où l'opérateur n'a coché personne. C'est l'appelant qui refuse d'avancer.
  it('une liste vide ne devient pas « tout le monde »', () => {
    expect(cibleDeCreation(selectionVide(), {})).toEqual({ contactIds: [] });
  });
});

describe('ce qui se compte a l avance', () => {
  // 🔴 `countContacts` N'INTERROGE QUE DES FILTRES : hors de cette forme, la prévision du récapitulatif
  // doit dire « je ne sais pas » plutôt que rendre un chiffre voisin, qui serait cru.
  it('seul « tout ce qui correspond » SANS exclusion se compte par filtres', () => {
    expect(audienceEnFiltres(selectionTout())).toBe(true);
    expect(audienceEnFiltres({ ...selectionTout(), exclus: new Set(['a']) })).toBe(false);
    expect(audienceEnFiltres({ ...selectionVide(), selected: new Set(['a']) })).toBe(false);
  });
});

describe('les filtres qui designent un import', () => {
  it('un seul tag, sans mode : le contact doit le porter', () => {
    expect(filtresDesImportes(['lot-a'])).toEqual({ tags: ['lot-a'] });
  });

  // 🔴 `or` DÈS QU'IL Y EN A PLUSIEURS : en `and`, un contact taggé « lot-a » seulement sortirait d'un
  // import à deux tags, et la campagne partirait à une partie du fichier sans que rien ne le dise.
  it('plusieurs tags passent en « au moins un »', () => {
    expect(filtresDesImportes(['lot-a', 'lot-b'])).toEqual({ tags: ['lot-a', 'lot-b'], tagMode: 'or' });
  });
});

describe('comment l audience se dit', () => {
  it('sans filtre ni exclusion, c est tout l espace', () => {
    expect(libelleAudience(audienceInitiale())).toBe('tous les contacts');
  });

  it('avec des filtres, la phrase le dit', () => {
    expect(libelleAudience({ ...audienceInitiale(), filtres: { tags: ['vip'] } }))
      .toBe('tous ceux qui correspondent aux filtres');
  });

  // ⚠️ CE QUI DOIT SE DISTINGUER D'UN COUP D'ŒIL, c'est « tout l'espace » de « une sélection » : les deux
  // n'engagent pas le même argent, et cette parenthèse est à côté du bouton qui envoie.
  it('une selection ligne a ligne, et des exclusions, se disent differemment', () => {
    const a = audienceInitiale();
    expect(libelleAudience({ ...a, selection: { ...selectionVide(), selected: new Set(['x']) } }))
      .toBe('contacts choisis un par un');
    expect(libelleAudience({ ...a, selection: { ...selectionTout(), exclus: new Set(['x', 'y']) } }))
      .toBe('tous les contacts, moins 2 décoché(s)');
  });
});

describe('l audience d une campagne qui demarre', () => {
  // 🔴 `toutFiltre` PLUTÔT QUE LES LIGNES AFFICHÉES : la liste est plafonnée à 500, un défaut en mode
  // liste viserait 500 personnes sur un espace qui en compte 5 000, en affichant « 500 » comme si c'était
  // tout le monde.
  it('vise tout l espace, par intention', () => {
    const a = audienceInitiale();
    expect(a.source).toBe('crm');
    expect(a.filtres).toEqual({});
    expect(a.selection.toutFiltre).toBe(true);
    expect(cibleDeCreation(a.selection, a.filtres)).toEqual({ contactTarget: { filters: {}, excludeIds: [] } });
  });

  // ⚠️ DEUX APPELS DONNENT DEUX OBJETS : les ensembles sont mutables, et un exemplaire partagé entre deux
  // montages de l'assistant ferait fuir la sélection d'une campagne dans la suivante.
  it('chaque appel rend un exemplaire neuf', () => {
    const a = audienceInitiale();
    const b = audienceInitiale();
    expect(a.selection.selected).not.toBe(b.selection.selected);
    expect(a.filtres).not.toBe(b.filtres);
  });
});

/**
 * LA CAMPAGNE AU FIL DE L'EAU : l'absence de liste, pas une quatrieme facon d'en faire une.
 *
 * 🔴 CE QUE CES CAS PROTÈGENT : la sélection RESTE dans l'état quand on passe au fil de l'eau (elle n'est
 * pas vidée, pour ne pas la reperdre à chaque aller-retour). Tout lecteur qui la lirait sans regarder le
 * mode décrirait donc une population à qui cette campagne n'enverra rien.
 */
describe('au fil de l eau', () => {
  it('le predicat ne reconnait que la source webhook', () => {
    expect(auFilDeLEau({ source: 'webhook' })).toBe(true);
    expect(auFilDeLEau({ source: 'crm' })).toBe(false);
    expect(auFilDeLEau({ source: 'fichier' })).toBe(false);
    expect(auFilDeLEau({ source: 'hubspot' })).toBe(false);
  });

  /**
   * 🔴 LE CAS QUI SÉPARE : la sélection résiduelle vaut « tous les contacts », et une implémentation qui
   * la lirait d'abord annoncerait « tous les contacts » sur une campagne qui n'envoie à personne de déjà
   * présent. Le mode se lit AVANT tout le reste.
   */
  it('le libelle dit le MODE, jamais la selection residuelle', () => {
    const a = { ...audienceInitiale(), source: 'webhook' as const };
    expect(a.selection.toutFiltre).toBe(true); // la résiduelle est bien « tous », c'est le piège
    expect(libelleAudience(a)).toMatch(/fil de l/i);
    expect(libelleAudience(a)).not.toMatch(/tous les contacts/i);
  });

  // ⚠️ L'AUTRE SENS : hors de ce mode, le libellé continue de décrire la sélection comme avant.
  it('hors de ce mode, le libelle decrit toujours la selection', () => {
    expect(libelleAudience(audienceInitiale())).toMatch(/tous les contacts/i);
  });

  it('une audience neuve part sans adresse', () => {
    expect(audienceInitiale().webhookId).toBe('');
  });
});
