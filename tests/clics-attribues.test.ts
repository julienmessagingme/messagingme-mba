import { describe, it, expect } from 'vitest';
import { fabriquerJeton, estJeton, JETON_RE } from '../src/links/jeton-contact';
import { suffixesPourDestinataire } from '../src/campaign/engine';
import { buildTemplateComponents } from '../src/meta/template-components';
import { lienDe, lienTraceAvecJeton } from '../src/links/rewrite';
import { estAttribuable } from '../src/http/templates';

/**
 * SAVOIR QUI A CLIQUÉ (migration 0106).
 *
 * Julien, le 2026-09-02 : « je veux qu'on mesure le nombre d'occurrence certes mais je veux aussi savoir QUI
 * a réagi, c'est la base de l'engagement ».
 *
 * 🔴 L'obstacle était PHYSIQUE : le lien tracé est le même pour tous les destinataires, donc au moment du clic
 * l'information « qui » n'existe nulle part dans la requête. Elle doit voyager DANS l'URL. D'où un suffixe
 * variable dans le lien soumis, et un jeton par contact qui le remplit à chaque envoi.
 */
describe('le jeton public d’un contact', () => {
  it('est du hasard pur, et ne porte AUCUNE information', () => {
    // Le dériver du numéro (un hachage) le rendrait VÉRIFIABLE : quelqu'un qui soupçonne un numéro pourrait
    // confirmer qu'il est dans la base en recalculant son jeton. Le hasard ne se vérifie pas.
    const jetons = new Set(Array.from({ length: 500 }, () => fabriquerJeton()));
    expect(jetons.size).toBe(500);
  });

  it('n’utilise que des caractères qu’on ne confond pas à la lecture', () => {
    // Un jeton finit parfois recopié à la main dans un ticket de support. `0`/`o`, `1`/`l`/`i` en sont exclus.
    for (let i = 0; i < 200; i += 1) expect(fabriquerJeton()).not.toMatch(/[01loiu]/);
  });

  it('a une forme reconnaissable, vérifiée AVANT toute requête', () => {
    // Un lien public reçoit des robots et des scans : il n'y a aucune raison de leur offrir un aller-retour
    // en base par essai. Même doctrine que le code du redirecteur.
    expect(estJeton(fabriquerJeton())).toBe(true);
    expect(estJeton('trop-court')).toBe(false);
    expect(estJeton('AAAAAAAAAAAAAAAA')).toBe(false); // majuscules hors alphabet
    expect(estJeton('0000000000000000')).toBe(false); // caractères écartés
    expect(estJeton(42)).toBe(false);
    expect(estJeton(null)).toBe(false);
    expect(JETON_RE.test(fabriquerJeton())).toBe(true);
  });
});

describe('l’adresse soumise à Meta', () => {
  it('porte le suffixe variable, seule forme de variable qu’une URL de bouton accepte', () => {
    expect(lienTraceAvecJeton('https://mba.test', 'ab12cd34ef56')).toBe('https://mba.test/r/ab12cd34ef56/{{1}}');
  });

  it('🔴 l’ancienne forme existe toujours, et elle ne disparaîtra jamais', () => {
    // Elle circule dans des messages DÉJÀ LIVRÉS, portés par des templates dont Meta a figé l'URL. La retirer
    // les casserait tous, sans recours. C'est la porte à sens unique du CLAUDE.md.
    expect(lienDe('https://mba.test', 'ab12cd34ef56')).toBe('https://mba.test/r/ab12cd34ef56');
  });

  it('le suffixe se pose APRÈS le code, jamais au milieu', () => {
    // Meta n'accepte une variable qu'à la FIN d'une URL de bouton. Un `{{1}}` ailleurs ferait refuser le
    // template à la soumission, et on le découvrirait sur un template qu'on croyait envoyé.
    const url = lienTraceAvecJeton('https://mba.test/', 'ab12cd34ef56');
    expect(url.endsWith('/{{1}}')).toBe(true);
    expect(url.indexOf('{{1}}')).toBe(url.length - 5);
  });
});

/**
 * 🔴 LE BLOC LE PLUS IMPORTANT DU FICHIER. Meta refuse l'appel dans les DEUX sens : un composant de bouton
 * fourni pour une URL sans variable, comme une variable sans composant. Se tromper ne dégrade pas une mesure,
 * ça empêche le message de partir.
 *
 * ⚠️ CE BLOC A ÉTÉ CORRIGÉ LE 2026-09-02 : il affirmait « sans jeton, aucun composant : on perd la mesure,
 * pas le message ». La production a dit l'inverse. Le template étant déjà approuvé avec `/r/<code>/{{1}}`,
 * ne pas fournir le composant fait refuser l'envoi en 131008, et rien ne part. Ce qui décide, c'est le
 * TEMPLATE (les boutons tracés), jamais l'état du jeton d'un contact.
 */
describe('le suffixe d’un destinataire : c’est le template qui décide', () => {
  it('🔴 sans JETON, les composants sont TOUT DE MÊME produits, avec un suffixe anonyme', () => {
    // Contact inconnu, ou lecture des jetons en échec. Le lien reste valide (`/r/<code>/anon` redirige),
    // le clic est compté, il n'est simplement rattaché à personne.
    const r = suffixesPourDestinataire([0], undefined);
    expect(Object.keys(r.suffixesBoutons ?? {})).toEqual(['0']);
    expect(r.suffixesBoutons?.[0]).toBeTruthy();
  });

  it('sans BOUTON tracé, aucun composant : le template n’a pas de variable à remplir', () => {
    expect(suffixesPourDestinataire([], 'abcdefghjkmnpqrs')).toEqual({});
  });

  it('avec les deux, un suffixe par bouton tracé', () => {
    expect(suffixesPourDestinataire([0, 2], 'abcdefghjkmnpqrs'))
      .toEqual({ suffixesBoutons: { 0: 'abcdefghjkmnpqrs', 2: 'abcdefghjkmnpqrs' } });
  });
});

describe('les composants envoyés à Meta', () => {
  it('un template SANS suffixe ne produit aucun composant de bouton, exactement comme avant', () => {
    // C'est ce qui garantit que les templates déjà approuvés continuent de partir. Leur URL n'a pas de
    // variable ; leur envoyer un composant les ferait tous échouer d'un coup.
    const c = buildTemplateComponents({ bodyParams: ['Léa'] }) as Array<{ type: string }>;
    expect(c.some((x) => x.type === 'button')).toBe(false);
  });

  it('🔴 un template AVEC suffixe produit un composant `url` portant le jeton', () => {
    const c = buildTemplateComponents({ bodyParams: [], suffixesBoutons: { 1: 'abcdefghjkmnpqrs' } });
    expect(c).toContainEqual({
      type: 'button', sub_type: 'url', index: '1',
      parameters: [{ type: 'text', text: 'abcdefghjkmnpqrs' }],
    });
  });

  it('l’index est celui du BOUTON, en chaîne, comme Meta l’attend', () => {
    // Un index numérique est refusé par l'API : elle veut une chaîne, comme pour les quick-replies de carte.
    const c = buildTemplateComponents({ bodyParams: [], suffixesBoutons: { 0: 'abcdefghjkmnpqrs' } }) as Array<{ index?: unknown }>;
    expect(c.find((x) => x.index !== undefined)?.index).toBe('0');
  });

  it('plusieurs boutons tracés produisent plusieurs composants', () => {
    const c = buildTemplateComponents({ bodyParams: [], suffixesBoutons: { 0: 'aaaaaaaaaaaaaaaa', 2: 'aaaaaaaaaaaaaaaa' } }) as Array<{ type: string }>;
    expect(c.filter((x) => x.type === 'button')).toHaveLength(2);
  });
});

/**
 * 🔴 LE BOUTON D'UNE CARTE DE CAROUSEL N'EST PAS ATTRIBUABLE, et c'est une contrainte, pas un choix.
 *
 * Quatrième défaut de la même famille que le 131008 du 2026-09-02, trouvé en corrigeant les trois autres.
 * `boutonsTracables` trace AUSSI les boutons portés par les cartes d'un carousel (`rewrite.ts`), mais
 * `buildTemplateComponents` ne sait produire qu'un composant `{ type: 'button', index }`, qui adresse un
 * bouton DU TEMPLATE. Un bouton de carte se désigne autrement, et rien ne sait le faire.
 *
 * Soumettre `{{1}}` sur un bouton de carte l'aurait donc condamné au **131008 à CHAQUE ENVOI, définitivement**,
 * l'URL étant figée chez Meta une fois le template approuvé. Zéro occurrence en base au moment du correctif :
 * le piège était armé, il n'avait pas encore servi.
 */
describe('quel bouton peut porter le suffixe variable', () => {
  it('🔴 un bouton DU TEMPLATE est attribuable, un bouton de CARTE ne l’est pas', () => {
    expect(estAttribuable(null)).toBe(true);
    expect(estAttribuable(0)).toBe(false);
    expect(estAttribuable(3)).toBe(false);
  });

  it('🔴 le constructeur de composants ne sait PAS adresser un bouton de carte', () => {
    // C'est CE fait qui justifie la règle : les composants produits portent un `index` de bouton et rien qui
    // désigne une carte. Si ce test casse un jour, c'est que le constructeur a appris à le faire, et alors
    // seulement la règle ci-dessus pourra s'ouvrir.
    const c = buildTemplateComponents({ bodyParams: [], suffixesBoutons: { 1: 'abcdefghjkmnpqrs' } }) as Array<Record<string, unknown>>;
    const bouton = c.find((x) => x.type === 'button');
    expect(bouton).toBeDefined();
    expect(Object.keys(bouton!)).toEqual(['type', 'sub_type', 'index', 'parameters']);
    expect(Object.keys(bouton!)).not.toContain('card_index');
  });

  it('un bouton de carte reste TRACÉ, sous sa forme anonyme : on dégrade la mesure, jamais l’envoi', () => {
    // Le clic est toujours compté, il n'est simplement rattaché à personne. C'est exactement le comportement
    // d'avant l'attribution, et il n'exige aucun composant à l'envoi.
    expect(lienDe('https://mba.test', 'ab12cd34ef56')).toBe('https://mba.test/r/ab12cd34ef56');
    expect(lienDe('https://mba.test', 'ab12cd34ef56')).not.toContain('{{');
  });
});
