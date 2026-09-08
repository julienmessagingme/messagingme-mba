import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { filtersActive, filtresRepris } from './contact-filters';

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

  /**
   * 🔴 LA LISTE DES MEMBRES EST TENUE À LA MAIN, ET RIEN DANS LE LANGAGE NE LA TIENT ALIGNÉE.
   *
   * Tous les membres de `ContactFilters` sont OPTIONNELS : en oublier un dans `filtresRepris` reste un
   * `ContactFilters` parfaitement valide pour le compilateur. Le symptôme serait muet et lointain : le
   * nouveau filtre s'enregistrerait dans le brouillon et disparaîtrait à la reprise, donc la campagne
   * viserait une autre population que celle qu'on a laissée à l'écran.
   *
   * Ce test DÉRIVE la liste de l'interface elle-même, il ne la recopie pas : recopier ne ferait que déplacer
   * la dérive d'un fichier à l'autre. Même idiome que `web/lib/manques-cablage.test.ts`.
   */
  it('🔴 CHAQUE membre de ContactFilters est repris, la liste ne peut pas dériver', async () => {
    const source = await readFile(new URL('./contact-filters.ts', import.meta.url), 'utf8');
    const interfaceContactFilters = source.slice(
      source.indexOf('export interface ContactFilters {'),
      source.indexOf('}', source.indexOf('export interface ContactFilters {')),
    );
    const membres = [...interfaceContactFilters.matchAll(/^\s{2}(\w+)\?:/gm)].map((m) => m[1]!);
    expect(membres.length, 'l’interface n’a pas été lue : ce test ne garde plus rien').toBeGreaterThan(5);

    // ⚠️ LES COMMENTAIRES SONT RETIRÉS AVANT DE CHERCHER. Sans ça, un membre seulement CITÉ dans une note
    // (« on ne reprend pas encore X ») passerait pour repris, et le garde-fou annoncerait une garantie qu'il
    // n'apporte pas. Et on cherche le NOM, pas une forme précise : les membres à valeurs fermées se lisent
    // `o.tagMode`, les autres passent par une aide `texte('nameSearch')`. Imposer une écriture unique serait
    // contraindre le code pour arranger son test.
    const corps = source
      .slice(source.indexOf('export function filtresRepris'), source.indexOf('/** Encode des ContactFilters'))
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/.*/g, ' ');
    for (const membre of membres) {
      expect(corps, `« ${membre} » n’est pas repris : il se perdra à la reprise d’un brouillon de campagne, en silence`)
        .toMatch(new RegExp(`\\b${membre}\\b`));
    }
  });

  it('une chaîne VIDE ne devient pas un filtre : elle n’en est pas un', () => {
    // `filtersActive` la traiterait comme absente de toute façon ; la garder ferait seulement grossir le
    // brouillon et afficher un champ rempli de rien.
    expect(filtresRepris({ nameSearch: '', phonePrefix: '' })).toEqual({});
  });
});
