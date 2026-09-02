import { describe, it, expect } from 'vitest';
import { construireCorps, construireParametres, variablesUtilisees } from '../src/agent/requete-http';

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
    const r = construireCorps('{"ville": "{{ville}}"}', { ville: 'Paris", "admin": true' });
    expect(r.ok).toBe(true);
    const corps = JSON.parse((r as { corps: string }).corps) as Record<string, unknown>;
    expect(Object.keys(corps)).toEqual(['ville']); // aucun champ n'a été ajouté
    expect(corps.ville).toBe('Paris", "admin": true'); // la valeur est passée telle quelle, échappée
  });

  it('🔴 un guillemet seul ne casse pas le JSON produit', () => {
    const r = construireCorps('{"note": "{{n}}"}', { n: 'il a dit "oui"' });
    expect(r.ok).toBe(true);
    expect(() => JSON.parse((r as { corps: string }).corps)).not.toThrow();
  });

  it('🔴 les CLÉS ne sont jamais substituées : la forme du corps ne dépend pas d’une valeur', () => {
    const r = construireCorps('{"{{cle}}": "x"}', { cle: 'injecte' });
    expect(r.ok).toBe(true);
    // La clé reste le littéral : seule une VALEUR peut varier, jamais la structure.
    expect(JSON.parse((r as { corps: string }).corps)).toEqual({ '{{cle}}': 'x' });
  });
});

describe('corps de requête : les types et les absences', () => {
  it('une chaîne qui vaut EXACTEMENT une variable prend son type', () => {
    // C'est la différence entre une API qui répond et une API qui rend 400 : `{"n": 42}` et non `{"n": "42"}`.
    const r = construireCorps('{"n": "{{n}}", "actif": "{{a}}"}', { n: 42, a: true });
    expect(JSON.parse((r as { corps: string }).corps)).toEqual({ n: 42, actif: true });
  });

  it('une variable AU MILIEU d’un texte est interpolée, donc rendue en chaîne', () => {
    const r = construireCorps('{"m": "Bonjour {{prenom}} !"}', { prenom: 'Léa' });
    expect(JSON.parse((r as { corps: string }).corps)).toEqual({ m: 'Bonjour Léa !' });
  });

  it('une valeur NULLE devient null quand la variable est seule, vide quand elle est interpolée', () => {
    const r = construireCorps('{"a": "{{v}}", "b": "x{{v}}y"}', { v: null });
    expect(JSON.parse((r as { corps: string }).corps)).toEqual({ a: null, b: 'xy' });
  });

  it('les tableaux et les objets imbriqués sont parcourus', () => {
    const r = construireCorps('{"l": [{"v": "{{a}}"}, "{{b}}"]}', { a: 1, b: 'deux' });
    expect(JSON.parse((r as { corps: string }).corps)).toEqual({ l: [{ v: 1 }, 'deux'] });
  });

  it('pas de gabarit = pas de corps (le cas normal d’un GET)', () => {
    expect(construireCorps('', {})).toEqual({ ok: true, corps: null });
    expect(construireCorps(null, {})).toEqual({ ok: true, corps: null });
  });

  it('🔴 un gabarit ILLISIBLE refuse, il n’envoie pas un corps vide', () => {
    // Partir avec un corps que personne n'a voulu est pire que ne pas partir : le système du client
    // répondrait à une question qui n'a pas été posée.
    const r = construireCorps('{ceci n est pas du json', {});
    expect(r.ok).toBe(false);
    expect((r as { raison: string }).raison).toContain('JSON');
  });

  it('🔴 une variable SANS VALEUR refuse, et les nomme TOUTES d’un coup', () => {
    const r = construireCorps('{"a": "{{x}}", "b": "{{y}}"}', {});
    expect(r.ok).toBe(false);
    // Les donner une par une ferait corriger le connecteur autant de fois qu'il manque de variables.
    expect((r as { raison: string }).raison).toContain('x, y');
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
    const r = construireParametres([{ cle: '  ', valeur: 'x' }], {});
    expect(r).toEqual({ ok: true, query: '' });
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
    const v = variablesUtilisees('{"a": "{{ville}}"}', [{ cle: 'q', valeur: '{{depuis}}' }], '/commandes/{numero}');
    expect(v).toEqual(['depuis', 'numero', 'ville']);
  });

  it('dédoublonne et trie', () => {
    expect(variablesUtilisees('{"a":"{{x}}","b":"{{x}}"}', [{ cle: 'c', valeur: '{{a}}' }])).toEqual(['a', 'x']);
  });

  it('rend une liste vide quand rien n’est paramétré', () => {
    expect(variablesUtilisees(null, null)).toEqual([]);
  });
});
