import { describe, it, expect } from 'vitest';
import { construireCorps, construireParametres, variablesUtilisees, assemblerAppel, type GabaritCorps } from '../src/agent/requete-http';
import { construireCible } from '../src/agent/http-cible';

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

/**
 * L'assemblage complet, avec la VRAIE garde d'adresse (`construireCible`) plutôt qu'un faux : c'est le seul
 * moyen de prouver que les morceaux tiennent ensemble, et cette fonction est partagée par l'exécution réelle
 * et par le bouton « Test » de la console. Un test qui dirait « ça marche » d'un appel que l'exécution ne
 * sait pas faire serait pire qu'aucun test.
 */
describe('assemblage de l’appel complet', () => {
  const base = { baseUrl: 'https://api.exemple.com/v1', construireCible };

  it('compose l’adresse, les paramètres d’URL et le corps', () => {
    const r = assemblerAppel({
      ...base, methode: 'POST', chemin: '/commandes/{numero}',
      parametres: [{ cle: 'ville', valeur: '{{ville}}' }],
      corps: json('{"note": "{{note}}"}'),
      valeurs: { numero: 'A42', ville: 'Lyon', note: 'urgent' },
    });
    expect(r.ok).toBe(true);
    const a = r as { url: string; methode: string; entetes: Record<string, string>; corps: string };
    expect(a.url).toBe('https://api.exemple.com/v1/commandes/A42?ville=Lyon');
    expect(a.methode).toBe('POST');
    expect(JSON.parse(a.corps)).toEqual({ note: 'urgent' });
  });

  it('🔴 un en-tête RÉSERVÉ saisi est ignoré : l’authentification ne peut pas être recouverte', () => {
    // Le champ « en-têtes » d'un mini-Postman est l'endroit le plus naturel pour coller un jeton en clair.
    // La route le refuse déjà ; cette garde-ci tient même si celle-là tombe.
    const r = assemblerAppel({
      ...base, methode: 'GET', chemin: '/x',
      entetes: [{ nom: 'Authorization', valeur: 'Bearer vole' }, { nom: 'X-Client', valeur: 'mba' }],
      corps: { mode: 'aucun' }, valeurs: {},
    });
    const e = (r as { entetes: Record<string, string> }).entetes;
    expect(e.authorization).toBeUndefined();
    expect(e['x-client']).toBe('mba'); // les en-têtes ordinaires, eux, passent
  });

  it('content-type est posé d’après ce qui part RÉELLEMENT, pas d’après une déclaration', () => {
    const sans = assemblerAppel({ ...base, methode: 'GET', chemin: '/x', corps: { mode: 'aucun' }, valeurs: {} });
    expect((sans as { entetes: Record<string, string> }).entetes['content-type']).toBeUndefined();
    const avec = assemblerAppel({ ...base, methode: 'POST', chemin: '/x', corps: json('{"a":1}'), valeurs: {} });
    expect((avec as { entetes: Record<string, string> }).entetes['content-type']).toBe('application/json');
  });

  it('🔴 une adresse refusée court-circuite : la garde anti-SSRF passe avant tout le reste', () => {
    const r = assemblerAppel({
      baseUrl: 'http://localhost:8095', construireCible, methode: 'GET', chemin: '/x',
      corps: { mode: 'aucun' }, valeurs: {},
    });
    expect(r.ok).toBe(false);
  });

  it('un refus du corps remonte tel quel, avec sa raison', () => {
    const r = assemblerAppel({ ...base, methode: 'POST', chemin: '/x', corps: json('{"a": "{{manquante}}"}'), valeurs: {} });
    expect(r.ok).toBe(false);
    expect((r as { raison: string }).raison).toContain('manquante');
  });

  it('🔴 les en-têtes sont SUBSTITUÉS comme les paramètres d’URL (2026-09-23)', () => {
    const r = assemblerAppel({
      ...base, methode: 'GET', chemin: '/x', entetes: [{ nom: 'X-Client-Id', valeur: 'id-{{client}}' }],
      corps: { mode: 'aucun' }, valeurs: { client: '42' },
    });
    expect((r as { entetes: Record<string, string> }).entetes['x-client-id']).toBe('id-42');
    const manque = assemblerAppel({
      ...base, methode: 'GET', chemin: '/x', entetes: [{ nom: 'X-Client-Id', valeur: '{{client}}' }],
      corps: { mode: 'aucun' }, valeurs: {},
    });
    expect(manque).toEqual({ ok: false, raison: 'variable(s) sans valeur dans les en-têtes : client' });
  });

  it('🔴 une valeur à retour à la ligne ne fabrique pas un second en-tête : refusée', () => {
    // La valeur peut venir du modèle, donc d'un texte qu'un contact influence.
    const r = assemblerAppel({
      ...base, methode: 'GET', chemin: '/x', entetes: [{ nom: 'X-Note', valeur: '{{note}}' }],
      corps: { mode: 'aucun' }, valeurs: { note: 'a\r\nX-Admin: 1' },
    });
    expect(r.ok).toBe(false);
    expect((r as { raison: string }).raison).toContain('X-Note');
  });

  it('🔴 un caractère qu’un en-tête ne peut pas porter est refusé LISIBLEMENT, pas levé par fetch (revue du 2026-09-23)', () => {
    // `fetch` lève sur un caractère au-delà de 0xFF : l'erreur passait pour une panne réseau et notait la SOURCE
    // « injoignable ». L'apostrophe typographique et l'emoji sont ce qu'un modèle ou un nom de profil produisent.
    for (const note of ['l’adresse', 'Julien 🚀', 'a\u0000b', 'cœur']) {
      const r = assemblerAppel({
        ...base, methode: 'GET', chemin: '/x', entetes: [{ nom: 'X-Note', valeur: '{{note}}' }],
        corps: { mode: 'aucun' }, valeurs: { note },
      });
      expect(r.ok, JSON.stringify(note)).toBe(false);
      expect((r as { raison: string }).raison).toContain('X-Note');
    }
    // Le latin-1 passe : `fetch` l'accepte.
    const ok = assemblerAppel({
      ...base, methode: 'GET', chemin: '/x', entetes: [{ nom: 'X-Note', valeur: '{{note}}' }],
      corps: { mode: 'aucun' }, valeurs: { note: 'Zoë' },
    });
    expect((ok as { entetes: Record<string, string> }).entetes['x-note']).toBe('Zoë');
    expect(() => new Headers((ok as { entetes: Record<string, string> }).entetes)).not.toThrow();
  });

  it('les paramètres s’ajoutent avec & quand le chemin en porte déjà', () => {
    const r = assemblerAppel({
      ...base, methode: 'GET', chemin: '/x?deja=1', parametres: [{ cle: 'p', valeur: '2' }],
      corps: { mode: 'aucun' }, valeurs: {},
    });
    expect((r as { url: string }).url).toBe('https://api.exemple.com/v1/x?deja=1&p=2');
  });
});

describe('variables réclamées par un gabarit', () => {
  it('balaye le corps, les paramètres ET le chemin', () => {
    // Les trois portent des variables. N'en lire qu'une ferait mentir à moitié la liste annoncée au client
    // au moment de brancher l'outil sur un agent.
    const v = variablesUtilisees(json('{"a": "{{ville}}"}'), [{ cle: 'q', valeur: '{{depuis}}' }], '/commandes/{numero}');
    expect(v).toEqual(['depuis', 'numero', 'ville']);
  });

  it('🔴 lit AUSSI les en-têtes, et le chemin sous ses deux formes (2026-09-23)', () => {
    expect(variablesUtilisees({ mode: 'aucun' }, null, '/a/{{x.y}}/b/{z}', [{ nom: 'X-T', valeur: '{{jeton}}' }]))
      .toEqual(['jeton', 'x.y', 'z']);
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
