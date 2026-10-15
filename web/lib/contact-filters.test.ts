import { describe, it, expect } from 'vitest';
import { filtersActive, filtresRepris, type ContactFilters } from './contact-filters';

/**
 * `filtresRepris` : des filtres reconstruits depuis une source OPAQUE.
 *
 * 🔴 CE QU'IL PROTÈGE (2026-09-08). Le brouillon de campagne enregistre ses filtres dans un `jsonb` que le
 * serveur ne valide pas, par contrat : c'est « l'état d'un écran ». Ils reviennent donc du RÉSEAU, et les
 * caster était un `as` sur un payload externe, ce que les conventions du dépôt interdisent.
 *
 * Le danger est précis, pas théorique : `filtersActive` appelle `ff.value.trim()` PENDANT LE RENDU. Une
 * entrée de filtre sans `value` y jette, et une exception pendant le rendu démonte tout l'écran de création
 * de campagne, pas seulement la ligne fautive. Le dépôt a déjà vécu exactement ce scénario avec un champ
 * absent d'une réponse 200.
 */
describe('filtresRepris', () => {
  it('garde ce qu’il reconnaît, et rend le même objet utilisable', () => {
    const repris = filtresRepris({
      tags: ['vip', 'ete'], tagMode: 'or', tagsExclude: ['desabonne'],
      optIn: 'opted_in', phonePrefix: '+336', phoneContains: '42', nameSearch: 'dupont',
      fieldFilters: [{ key: 'ville', op: 'eq', value: 'Auxerre' }],
    });
    expect(repris).toEqual({
      tags: ['vip', 'ete'], tagMode: 'or', tagsExclude: ['desabonne'],
      optIn: 'opted_in', phonePrefix: '+336', phoneContains: '42', nameSearch: 'dupont',
      fieldFilters: [{ key: 'ville', op: 'eq', value: 'Auxerre' }],
    });
  });

  it('🔴 une entrée de filtre SANS `value` est jetée, au lieu de faire tomber l’écran au rendu', () => {
    // C'est LE cas qui compte : sans le tri, la ligne suivante jetterait `TypeError: ff.value.trim is not a
    // function`, pendant le rendu, donc en emportant tout l'écran.
    const repris = filtresRepris({ fieldFilters: [{ key: 'ville', op: 'eq' }, { key: 'age', op: 'eq', value: 12 }] });
    expect(repris.fieldFilters).toBeUndefined();
    expect(() => filtersActive(repris)).not.toThrow();
    expect(filtersActive(repris)).toBe(false);
  });

  it('🔴 preuve inverse : SANS le tri, le même objet fait bien jeter `filtersActive`', () => {
    // Sans ce cas, on ne saurait pas si le tri sert à quelque chose : peut-être que `filtersActive` tolérait
    // déjà l'entrée mal formée, et le coerceur serait alors de la cérémonie.
    const brut = { fieldFilters: [{ key: 'ville', op: 'eq' }] } as unknown as Parameters<typeof filtersActive>[0];
    expect(() => filtersActive(brut)).toThrow();
  });

  it('un opérateur INCONNU est jeté, jamais deviné', () => {
    // Un filtre à moitié compris viserait la mauvaise population, ce qui est pire que de repartir sans filtre
    // et de le voir tout de suite à l'écran.
    expect(filtresRepris({ fieldFilters: [{ key: 'ville', op: 'commence_par', value: 'Aux' }] }).fieldFilters).toBeUndefined();
  });

  it('les valeurs d’un autre type, les tableaux et les scalaires ne cassent rien', () => {
    for (const entree of [null, undefined, 42, 'des filtres', [], [1, 2], { tags: 'vip' }, { optIn: 'peut-etre' }]) {
      expect(filtresRepris(entree), JSON.stringify(entree)).toEqual({});
    }
  });

  it('un tableau de tags à moitié bon ne garde que les textes, et disparaît s’il n’en reste aucun', () => {
    expect(filtresRepris({ tags: ['vip', 3, null, 'ete'] }).tags).toEqual(['vip', 'ete']);
    expect(filtresRepris({ tags: [3, null] }).tags).toBeUndefined();
  });

  it('🔴 reprend chaque critère du contrat partagé depuis un brouillon', () => {
    // Required force à compléter ce cas lorsqu'un nouveau critère entre dans le contrat.
    const tous: Required<ContactFilters> = {
      tags: ['vip'], tagMode: 'or', tagsExclude: ['spam'], optIn: 'opted_in',
      phonePrefix: '+336', phoneContains: '42', nameSearch: 'Marc',
      joignabiliteWhatsApp: 'connu_injoignable', risque: 'eleve',
      fieldFilters: [{ key: 'ville', op: 'eq', value: 'Lyon' }],
    };
    expect(filtresRepris(tous)).toEqual(tous);
    for (const [critere, valeur] of Object.entries(tous)) {
      if (critere === 'tagMode') continue; // modifie les tags, ne filtre pas seul
      expect(filtersActive({ [critere]: valeur }), critere).toBe(true);
    }
  });

  it('un champ vide ou sans clé ne rend pas le ciblage actif', () => {
    expect(filtersActive({ fieldFilters: [{ key: 'ville', op: 'eq', value: '' }] })).toBe(false);
    expect(filtersActive({ fieldFilters: [{ key: '', op: 'eq', value: 'Lyon' }] })).toBe(false);
    expect(filtersActive({ fieldFilters: [{ key: 'ville', op: 'empty', value: '' }] })).toBe(true);
  });

  it('🔴 le niveau de risque d’un brouillon est repris, un niveau inconnu est jeté (l’écran le montre absent)', () => {
    // Perdu à la reprise, le filtre ferait viser à la campagne TOUT ce que les autres filtres décrivent.
    expect(filtresRepris({ risque: 'eleve' })).toEqual({ risque: 'eleve' });
    expect(filtersActive(filtresRepris({ risque: 'eleve' }))).toBe(true);
    for (const risque of ['élevé', 'high', 3, null]) expect(filtresRepris({ risque }), String(risque)).toEqual({});
  });

  it('une chaîne VIDE ne devient pas un filtre : elle n’en est pas un', () => {
    // `filtersActive` la traiterait comme absente de toute façon ; la garder ferait seulement grossir le
    // brouillon et afficher un champ rempli de rien.
    expect(filtresRepris({ nameSearch: '', phonePrefix: '' })).toEqual({});
  });
});
