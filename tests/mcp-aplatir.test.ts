import { describe, it, expect } from 'vitest';
import { aplatirSchema } from '../src/agent/mcp/aplatir';

/**
 * L'aplatissement d'un schéma MCP en FEUILLES.
 *
 * 🔴 CE MODULE EST CE QUI PERMET À LA GARDE D'IDENTITÉ DE DESCENDRE DANS LES SOUS-OBJETS. Nos paramètres
 * sont plats et scalaires ; un `inputSchema` MCP est du JSON Schema quelconque. Sans l'énumération des
 * feuilles, un paramètre imbriqué serait forcément rempli par le MODÈLE, donc influençable par le contact :
 * un `filtres.client_id` deviendrait un IDOR.
 *
 * 🔴 IL REFUSE PLUTÔT QUE DE DEVINER. Trois formes n'ont pas de jeu de feuilles fixe, et les aplatir
 * demanderait d'inventer une convention que le serveur distant ne connaît pas.
 */
describe('aplatir un schema MCP : ce qui passe', () => {
  it('descend dans les sous-objets et garde le CHEMIN, qui est ce qui permet de recomposer', () => {
    const r = aplatirSchema({
      type: 'object',
      properties: {
        filtres: { type: 'object', properties: { ville: { type: 'string' }, date: { type: 'string' } }, required: ['ville'] },
        limite: { type: 'integer' },
      },
      required: ['filtres'],
    });
    expect(r.raisonNonActivable).toBeNull();
    expect(r.feuilles.map((f) => [f.name, f.cheminMcp, f.type, f.required])).toEqual([
      ['filtres_ville', 'filtres.ville', 'string', true],
      ['filtres_date', 'filtres.date', 'string', false],
      ['limite', 'limite', 'integer', false],
    ]);
  });

  it('une feuille n est REQUISE que si TOUS les maillons de son chemin le sont', () => {
    // `ville` est requis DANS `filtres`, mais `filtres` lui-meme est facultatif : l objet peut ne pas
    // etre envoye du tout. Annoncer la feuille comme requise ferait exiger du modele une valeur pour un
    // objet qui n a pas lieu d etre.
    const r = aplatirSchema({
      type: 'object',
      properties: { filtres: { type: 'object', properties: { ville: { type: 'string' } }, required: ['ville'] } },
      required: [],
    });
    expect(r.feuilles[0]!.required).toBe(false);
  });

  it('un outil SANS parametre est activable, avec zero feuille', () => {
    expect(aplatirSchema({ type: 'object', properties: {} })).toEqual({ feuilles: [], raisonNonActivable: null });
    expect(aplatirSchema({ type: 'object' })).toEqual({ feuilles: [], raisonNonActivable: null });
  });

  it('garde une enumeration de chaines : elle empeche le modele d inventer une valeur hors domaine', () => {
    const r = aplatirSchema({ type: 'object', properties: { canal: { type: 'string', enum: ['sms', 'email'] } } });
    expect(r.feuilles[0]!.enum).toEqual(['sms', 'email']);
  });

  it('lit une enumeration de chaines SANS type declare comme une chaine', () => {
    // JSON Schema autorise `enum` seul. Le refuser rendrait non activables des outils parfaitement
    // representables, pour une information qu on a sous les yeux.
    const r = aplatirSchema({ type: 'object', properties: { canal: { enum: ['sms', 'email'] } } });
    expect(r.raisonNonActivable).toBeNull();
    expect(r.feuilles[0]!.type).toBe('string');
  });

  it('accepte « ce type OU null », qui n est pas une alternative mais UNE forme plus l absence', () => {
    // 🔴 LA NUANCE DECIDE, et elle n est pas un assouplissement : `anyOf: [T, null]` decrit UNE seule
    // forme de valeur. Deux formes reelles resteraient refusees. C est l idiome que produisent la plupart
    // des generateurs de schema pour un parametre facultatif.
    const r = aplatirSchema({
      type: 'object',
      properties: {
        a: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        b: { type: ['integer', 'null'] },
      },
    });
    expect(r.raisonNonActivable).toBeNull();
    expect(r.feuilles.map((f) => [f.name, f.type])).toEqual([['a', 'string'], ['b', 'integer']]);
  });

  it('desambigue deux feuilles dont le nom normalise se collisionne', () => {
    // `a.b_c` et `a.b.c` donnent tous deux `a_b_c`. Sans suffixe, la seconde ecraserait la premiere dans
    // le schema envoye au modele, et une valeur partirait dans le mauvais champ.
    const r = aplatirSchema({
      type: 'object',
      properties: {
        a: { type: 'object', properties: { b_c: { type: 'string' }, b: { type: 'object', properties: { c: { type: 'string' } } } } },
      },
    });
    expect(r.raisonNonActivable).toBeNull();
    const noms = r.feuilles.map((f) => f.name);
    expect(new Set(noms).size).toBe(noms.length);
    expect(r.feuilles.map((f) => f.cheminMcp).sort()).toEqual(['a.b.c', 'a.b_c']);
  });

  it('normalise un nom hors charset et le borne a 64 caracteres', () => {
    const long = 'T'.repeat(80);
    const r = aplatirSchema({ type: 'object', properties: { 'Filtres.Ville-2': { type: 'string' }, [long]: { type: 'string' } } });
    expect(r.feuilles[0]!.name).toBe('filtres_ville_2');
    // Le chemin d origine est conserve TEL QUEL : c est lui qu on renvoie au serveur.
    expect(r.feuilles[0]!.cheminMcp).toBe('Filtres.Ville-2');
    expect(r.feuilles[1]!.name).toHaveLength(64);
  });
});

describe('aplatir un schema MCP : ce qui est refuse, et qui le DIT', () => {
  it('refuse un TABLEAU, et NOMME le parametre en cause', () => {
    const r = aplatirSchema({
      type: 'object',
      properties: { lignes: { type: 'array', items: { type: 'object', properties: { sku: { type: 'string' } } } } },
    });
    expect(r.raisonNonActivable).toContain('lignes');
  });

  it('🔴 un outil non activable ne rend AUCUNE feuille, MEME quand certaines etaient valides', () => {
    // 🔴 LE CAS QUI PROUVE QUELQUE CHOSE, et il a fallu une mutation pour s en apercevoir. Sur un schema
    // dont TOUS les parametres sont irreductibles, `feuilles` vaut `[]` de toute facon : l assertion y
    // passe dans les deux sens et ne prouve rien. Il faut donc un schema MIXTE, ou `ville` est
    // parfaitement representable et `lignes` ne l est pas.
    //
    // Ce que ca ferme : un appelant qui recevrait `[ville]` avec une raison de refus pourrait s en servir,
    // et l outil partirait chez le serveur avec la moitie de ses parametres.
    const r = aplatirSchema({
      type: 'object',
      properties: { ville: { type: 'string' }, lignes: { type: 'array', items: { type: 'string' } } },
    });
    expect(r.raisonNonActivable).toContain('lignes');
    expect(r.feuilles).toEqual([]);
  });

  it('refuse un tableau de scalaires aussi : nos parametres n ont pas de type liste', () => {
    const r = aplatirSchema({ type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } } });
    expect(r.raisonNonActivable).toContain('tags');
  });

  it('refuse de VRAIES alternatives', () => {
    const r = aplatirSchema({ type: 'object', properties: { cle: { oneOf: [{ type: 'string' }, { type: 'integer' }] } } });
    expect(r.raisonNonActivable).toContain('cle');
  });

  it('refuse un objet LIBRE, qui n a aucune feuille a enumerer', () => {
    expect(aplatirSchema({ type: 'object', properties: { meta: { type: 'object' } } }).raisonNonActivable).toContain('meta');
    expect(aplatirSchema({ type: 'object', properties: { meta: { type: 'object', properties: {} } } }).raisonNonActivable).toContain('meta');
  });

  it('un objet vide A LA RACINE veut dire « aucun parametre », un objet vide IMBRIQUE veut dire « forme non declaree »', () => {
    // L asymetrie est voulue : a la racine, l absence de proprietes dit que l outil ne prend rien ;
    // imbriquee, elle dit que le serveur attend un objet dont il n a pas declare la forme.
    expect(aplatirSchema({ type: 'object', properties: {} }).raisonNonActivable).toBeNull();
    expect(aplatirSchema({ type: 'object', properties: { x: { type: 'object', properties: {} } } }).raisonNonActivable).not.toBeNull();
  });

  it('refuse un type inconnu plutot que de le prendre pour une chaine', () => {
    const r = aplatirSchema({ type: 'object', properties: { quand: { type: 'date-time' } } });
    expect(r.raisonNonActivable).toContain('quand');
  });

  it('refuse au dela d une profondeur bornee', () => {
    let noyau: unknown = { type: 'string' };
    for (let i = 0; i < 8; i += 1) noyau = { type: 'object', properties: { n: noyau } };
    expect(aplatirSchema(noyau).raisonNonActivable).toContain('profondeur');
  });

  it('nomme TOUS les obstacles, pas seulement le premier', () => {
    const r = aplatirSchema({
      type: 'object',
      properties: { lignes: { type: 'array' }, meta: { type: 'object' } },
    });
    expect(r.raisonNonActivable).toContain('lignes');
    expect(r.raisonNonActivable).toContain('meta');
  });

  it('un inputSchema absent ou qui n est pas un objet est un refus LISIBLE, jamais une exception', () => {
    expect(aplatirSchema(null).raisonNonActivable).not.toBeNull();
    expect(aplatirSchema(undefined).raisonNonActivable).not.toBeNull();
    expect(aplatirSchema({ type: 'string' }).raisonNonActivable).not.toBeNull();
    expect(aplatirSchema('nimporte quoi').raisonNonActivable).not.toBeNull();
    expect(aplatirSchema([1, 2, 3]).raisonNonActivable).not.toBeNull();
  });

  it('ne LEVE sur aucune entree tordue : le schema vient d un TIERS', () => {
    // Une exception ici ferait echouer l import ENTIER a cause d un seul outil mal forme, et le client
    // perdrait les quinze autres.
    const tordus: unknown[] = [
      { type: 'object', properties: null },
      { type: 'object', properties: { a: null } },
      { type: 'object', properties: { a: 42 } },
      { type: 'object', properties: { a: { type: 'string' } }, required: 'pas un tableau' },
      { type: 'object', properties: { '': { type: 'string' } } },
    ];
    for (const t of tordus) expect(() => aplatirSchema(t)).not.toThrow();
  });
});
