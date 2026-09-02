import { describe, it, expect } from 'vitest';
import { construireCorps, construireParametres, variablesUtilisees, champsVersJson, type GabaritCorps } from '../src/agent/requete-http';

/** Raccourci de lisibilité : la grande majorité des cas éprouve le mode JSON brut. */
const json = (gabarit: string): GabaritCorps => ({ mode: 'json', gabarit });
/** Le corps produit, décodé. Échoue clairement si l'appel a été refusé. */
function corpsDe(r: ReturnType<typeof construireCorps>): unknown {
  if (!r.ok) throw new Error(`refusé : ${r.raison}`);
  return r.corps === null ? null : JSON.parse(r.corps);
}

/**
 * Le corps et les paramètres d'URL d'un connecteur.
 *
 * 🔴 LE PREMIER BLOC EST LE PLUS IMPORTANT DU FICHIER. Une valeur de variable peut venir du MODÈLE, ou de la
 * dernière phrase écrite par le CONTACT, donc d'un inconnu. Si la substitution était textuelle, il suffirait
 * d'écrire un guillemet pour ajouter un champ au corps envoyé au système du client, ou pour casser le JSON.
 * La substitution étant STRUCTURELLE (on parse, on remplace dans l'arbre, on ré-encode), c'est impossible par
 * construction, et ces tests le prouvent plutôt que de le dire.
 */
describe('corps de requête : la substitution ne peut pas devenir de la structure', () => {
  it('🔴 une valeur qui tente d’ajouter un champ reste UNE CHAÎNE', () => {
    // Ce que le contact écrirait pour s'octroyer un droit dans l'appel au système du client.
    const corps = corpsDe(construireCorps(json('{"ville": "{{ville}}"}'), { ville: 'Paris", "admin": true' })) as Record<string, unknown>;
    expect(Object.keys(corps)).toEqual(['ville']); // aucun champ n'a été ajouté
    expect(corps.ville).toBe('Paris", "admin": true'); // la valeur est passée telle quelle, échappée
  });

  it('🔴 un guillemet seul ne casse pas le JSON produit', () => {
    expect(() => corpsDe(construireCorps(json('{"note": "{{n}}"}'), { n: 'il a dit "oui"' }))).not.toThrow();
  });

  it('🔴 les CLÉS ne sont jamais substituées : la forme du corps ne dépend pas d’une valeur', () => {
    // Seule une VALEUR peut varier, jamais la structure.
    expect(corpsDe(construireCorps(json('{"{{cle}}": "x"}'), { cle: 'injecte' }))).toEqual({ '{{cle}}': 'x' });
  });

  it('🔴 et la même garantie vaut en mode LISTE DE CHAMPS, parce que c’est le même moteur', () => {
    // C'est tout l'intérêt de compiler la liste vers le même arbre : la sûreté n'est pas à réimplémenter,
    // donc elle ne peut pas manquer d'un côté.
    const corps = corpsDe(construireCorps(
      { mode: 'champs', champs: [{ cle: 'ville', valeur: '{{v}}' }] },
      { v: 'Paris", "admin": true' },
    )) as Record<string, unknown>;
    expect(Object.keys(corps)).toEqual(['ville']);
    expect(corps.ville).toBe('Paris", "admin": true');
  });
});

describe('corps de requête : les types et les absences', () => {
  it('une chaîne qui vaut EXACTEMENT une variable prend son type', () => {
    // C'est la différence entre une API qui répond et une API qui rend 400 : `{"n": 42}` et non `{"n": "42"}`.
    expect(corpsDe(construireCorps(json('{"n": "{{n}}", "actif": "{{a}}"}'), { n: 42, a: true }))).toEqual({ n: 42, actif: true });
  });

  it('une variable AU MILIEU d’un texte est interpolée, donc rendue en chaîne', () => {
    expect(corpsDe(construireCorps(json('{"m": "Bonjour {{prenom}} !"}'), { prenom: 'Léa' }))).toEqual({ m: 'Bonjour Léa !' });
  });

  it('une valeur NULLE devient null quand la variable est seule, vide quand elle est interpolée', () => {
    expect(corpsDe(construireCorps(json('{"a": "{{v}}", "b": "x{{v}}y"}'), { v: null }))).toEqual({ a: null, b: 'xy' });
  });

  it('les tableaux et les objets imbriqués sont parcourus', () => {
    expect(corpsDe(construireCorps(json('{"l": [{"v": "{{a}}"}, "{{b}}"]}'), { a: 1, b: 'deux' }))).toEqual({ l: [{ v: 1 }, 'deux'] });
  });

  it('pas de corps du tout, le cas normal d’un GET', () => {
    expect(construireCorps({ mode: 'aucun' }, {})).toEqual({ ok: true, corps: null });
    expect(construireCorps(json('  '), {})).toEqual({ ok: true, corps: null });
    expect(construireCorps({ mode: 'champs', champs: [] }, {})).toEqual({ ok: true, corps: null });
  });

  it('🔴 un gabarit ILLISIBLE refuse, il n’envoie pas un corps vide', () => {
    // Partir avec un corps que personne n'a voulu est pire que ne pas partir : le système du client
    // répondrait à une question qui n'a pas été posée.
    const r = construireCorps(json('{ceci n est pas du json'), {});
    expect(r.ok).toBe(false);
    expect((r as { raison: string }).raison).toContain('JSON');
  });

  it('🔴 une variable SANS VALEUR refuse, et les nomme TOUTES d’un coup', () => {
    const r = construireCorps(json('{"a": "{{x}}", "b": "{{y}}"}'), {});
    expect(r.ok).toBe(false);
    // Les donner une par une ferait corriger le connecteur autant de fois qu'il manque de variables.
    expect((r as { raison: string }).raison).toContain('x, y');
  });
});

/**
 * Le mode LISTE DE CHAMPS, demandé par Julien le 2026-09-02 en plus du JSON brut : « il faut qu on puisse
 * avoir les 2, du json brut pour les mecs habitués et une liste de champs ».
 *
 * Ces cas éprouvent surtout UNE chose : que les deux modes produisent le MÊME corps pour la même intention.
 * C'est ce qui justifie de n'avoir qu'un moteur, et ce qui casserait si quelqu'un en rajoutait un second.
 */
describe('corps en liste de champs', () => {
  it('produit exactement le même corps que le JSON équivalent', () => {
    const valeurs = { ville: 'Lyon', n: 3 };
    const parListe = construireCorps({ mode: 'champs', champs: [{ cle: 'ville', valeur: '{{ville}}' }, { cle: 'n', valeur: '{{n}}' }] }, valeurs);
    const parJson = construireCorps(json('{"ville": "{{ville}}", "n": "{{n}}"}'), valeurs);
    expect(corpsDe(parListe)).toEqual(corpsDe(parJson));
    expect(corpsDe(parListe)).toEqual({ ville: 'Lyon', n: 3 });
  });

  it('une ligne SANS CLÉ est ignorée : c’est une ligne pas remplie, pas une erreur', () => {
    const r = construireCorps({ mode: 'champs', champs: [{ cle: '  ', valeur: 'x' }, { cle: 'a', valeur: '1' }] }, {});
    expect(corpsDe(r)).toEqual({ a: '1' });
  });

  it('une variable sans valeur refuse ici aussi', () => {
    const r = construireCorps({ mode: 'champs', champs: [{ cle: 'a', valeur: '{{inconnue}}' }] }, {});
    expect(r.ok).toBe(false);
    expect((r as { raison: string }).raison).toContain('inconnue');
  });

  it('la conversion vers le JSON brut rend un gabarit qui produit le même corps', () => {
    // C'est ce qui rend la bascule « passer en JSON brut » honnête : elle ne doit rien changer au résultat.
    const champs = [{ cle: 'ville', valeur: '{{v}}' }, { cle: 'fixe', valeur: 'oui' }];
    const gabarit = champsVersJson(champs);
    expect(corpsDe(construireCorps(json(gabarit), { v: 'Nice' })))
      .toEqual(corpsDe(construireCorps({ mode: 'champs', champs }, { v: 'Nice' })));
  });
});

describe('paramètres d’URL', () => {
  it('🔴 une valeur contenant & ou = n’ajoute pas de paramètre', () => {
    const r = construireParametres([{ cle: 'ville', valeur: '{{v}}' }], { v: 'Paris&admin=1' });
    expect(r.ok).toBe(true);
    const sp = new URLSearchParams((r as { query: string }).query);
    expect([...sp.keys()]).toEqual(['ville']);
    expect(sp.get('ville')).toBe('Paris&admin=1');
  });

  it('un paramètre dont la valeur est VIDE est omis, pas envoyé vide', () => {
    // `?ville=` est lu par beaucoup d'API comme « filtre sur la chaîne vide », donc zéro résultat : l'agent
    // dirait « je n'ai rien trouvé » là où la vraie réponse est « je n'ai pas cette information ».
    const r = construireParametres([{ cle: 'ville', valeur: '{{v}}' }, { cle: 'p', valeur: 'x' }], { v: null });
    expect((r as { query: string }).query).toBe('p=x');
  });

  it('une ligne sans clé est ignorée : c’est une ligne pas remplie, pas une erreur', () => {
    expect(construireParametres([{ cle: '  ', valeur: 'x' }], {})).toEqual({ ok: true, query: '' });
  });

  it('une variable sans valeur refuse ici aussi', () => {
    const r = construireParametres([{ cle: 'a', valeur: '{{inconnue}}' }], {});
    expect(r.ok).toBe(false);
    expect((r as { raison: string }).raison).toContain('inconnue');
  });

  it('aucun paramètre = pas de chaîne de requête', () => {
    expect(construireParametres([], {})).toEqual({ ok: true, query: '' });
    expect(construireParametres(null, {})).toEqual({ ok: true, query: '' });
  });
});

describe('variables réclamées par un gabarit', () => {
  it('balaye le corps, les paramètres ET le chemin', () => {
    // Les trois portent des variables. N'en lire qu'une ferait mentir à moitié la liste annoncée au client
    // au moment de brancher l'outil sur un agent.
    const v = variablesUtilisees(json('{"a": "{{ville}}"}'), [{ cle: 'q', valeur: '{{depuis}}' }], '/commandes/{numero}');
    expect(v).toEqual(['depuis', 'numero', 'ville']);
  });

  it('🔴 lit AUSSI le mode liste de champs', () => {
    // Sans ce cas, la liste annoncée au client dépendrait de la façon dont il a rempli son corps : elle
    // serait juste en JSON brut et vide en liste de champs, sans que rien ne le signale.
    expect(variablesUtilisees({ mode: 'champs', champs: [{ cle: 'a', valeur: '{{ville}}' }] }, null)).toEqual(['ville']);
  });

  it('dédoublonne et trie', () => {
    expect(variablesUtilisees(json('{"a":"{{x}}","b":"{{x}}"}'), [{ cle: 'c', valeur: '{{a}}' }])).toEqual(['a', 'x']);
  });

  it('rend une liste vide quand rien n’est paramétré', () => {
    expect(variablesUtilisees({ mode: 'aucun' }, null)).toEqual([]);
  });
});
