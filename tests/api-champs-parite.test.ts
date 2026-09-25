// tests/api-champs-parite.test.ts
import { describe, it, expect } from 'vitest';
import type { z } from 'zod';
import {
  CHAMPS, CIBLES, SOURCES_PARAM, type CibleDoc, type NomDeTable, type SourceDoc, type TableDeChamps, type TypeChamp,
} from '../web/lib/api-champs';
import { EXEMPLES_CORPS } from '../web/lib/api-exemples';
import {
  schemaContactV1 as schemaCorpsContact, schemaRechercheContactV1 as schemaCorpsRecherche,
  schemaPatchContactV1 as schemaCorpsModification,
} from '../src/api/contacts-v1';
import { conteneurDuLot as schemaCorpsLot } from '../src/http/v1-contacts';
import { schemaCorps as schemaCorpsEnvoi, schemaDestinataire as schemaDestinataireEnvoi } from '../src/http/v1-sends';
import { schemaMessageWhatsapp } from '../src/http/v1-messages';
import { schemaMessageRcs } from '../src/http/v1-messages-rcs';
import { validateParamMapping, type ParamSource, type TemplateParam } from '../src/crm/template';

/**
 * LES TABLEAUX DE CHAMPS DE LA DOC SONT CEUX DES SCHÉMAS DU SERVEUR (lot 2 de la refonte de la doc, 2026-09-25).
 *
 * 🔴 DANS LES DEUX SENS : un champ que la route accepte et que la doc tait, ou un champ que la doc annonce et que
 * la route ne connaît pas, fait tomber ce fichier. Et pour chaque champ : son obligation (dérivée du schéma : une
 * clé que `undefined` ne passe pas est obligatoire), son type, les valeurs d'une énumération, les clés que la
 * route REFUSE (`z.never()`), et ce qu'elle fait d'une clé inconnue (essayée pour de vrai sur un exemple valide).
 *
 * ⚠️ `params` n'a pas de schéma zod : la route le valide par `validateParamMapping`. Son tableau est donc éprouvé
 * par CETTE fonction (la même, avec les mêmes options que la route), et ses clés comparées au type qu'elle rend.
 */

/** La définition interne d'un schéma zod 4 : ce que la suite lit pour en dériver type et obligation. */
interface Def {
  type: string;
  innerType?: z.ZodType;
  in?: z.ZodType;
  out?: z.ZodType;
  element?: z.ZodType;
  options?: z.ZodType[];
  entries?: Record<string, string>;
  format?: string;
}
const def = (s: z.ZodType): Def => (s as unknown as { def: Def }).def;
const format = (s: z.ZodType): string | undefined => (s as unknown as { format?: string }).format ?? def(s).format;

/** Retire les enveloppes : optionnel, nullable, `preprocess` (le vrai type est en sortie), `transform` (en entrée). */
function deballer(s: z.ZodType): z.ZodType {
  const d = def(s);
  if ((d.type === 'optional' || d.type === 'nullable' || d.type === 'default') && d.innerType) return deballer(d.innerType);
  if (d.type === 'pipe' && d.in && d.out) return deballer(def(d.out).type === 'transform' ? d.in : d.out);
  return s;
}

/** Le type affiché d'un schéma, dans le vocabulaire fermé de la doc (`TypeChamp`). `null` : non classable. */
function typeDe(s: z.ZodType): TypeChamp | null {
  const u = deballer(s);
  const d = def(u);
  switch (d.type) {
    case 'string': return format(u) === 'guid' || format(u) === 'uuid' ? 'uuid' : 'string';
    case 'enum': return 'string';
    case 'number': return format(u) === 'safeint' || format(u) === 'int32' ? 'integer' : null;
    case 'record': case 'object': return 'object';
    case 'union': {
      const types = (d.options ?? []).filter((o) => def(o).type !== 'null').map((o) => typeDe(o));
      if (types.length > 0 && types.every((x) => x === 'object')) return 'object';
      return types.includes('string') ? 'string' : null;
    }
    case 'array': {
      const el = def(deballer(d.element!)).type;
      if (el === 'unknown' || el === 'object' || el === 'record') return 'object[]';
      return typeDe(d.element!) === 'string' ? 'string[]' : null;
    }
    default: return null;
  }
}

const estRefusee = (s: z.ZodType): boolean => def(s).type === 'optional' && def(def(s).innerType!).type === 'never';
function valeursEnum(s: z.ZodType): string[] | null {
  const u = def(deballer(s));
  return u.type === 'enum' && u.entries ? Object.values(u.entries).sort() : null;
}

type Objet = z.ZodObject<z.ZodRawShape>;
/**
 * Le schéma de chaque tableau, et un corps VALIDE pour essayer une clé inconnue. `Record` sur les noms de tableau :
 * un tableau ajouté sans son schéma ne compile pas. `param` n'en a pas (cf. l'en-tête).
 */
const SCHEMAS: Record<Exclude<NomDeTable, 'param'>, { schema: Objet; valide: unknown }> = {
  contact: { schema: schemaCorpsContact, valide: EXEMPLES_CORPS.contactCreer.corps },
  lot: { schema: schemaCorpsLot as unknown as Objet, valide: EXEMPLES_CORPS.contactsLot.corps },
  recherche: { schema: schemaCorpsRecherche, valide: EXEMPLES_CORPS.contactRechercher.corps },
  modification: { schema: schemaCorpsModification, valide: EXEMPLES_CORPS.contactModifier.corps },
  messageWhatsapp: { schema: schemaMessageWhatsapp, valide: EXEMPLES_CORPS.messageWhatsapp.corps },
  messageRcs: { schema: schemaMessageRcs, valide: EXEMPLES_CORPS.messageRcs.corps },
  envoi: { schema: schemaCorpsEnvoi, valide: EXEMPLES_CORPS.envoiTemplate.corps },
  destinataire: { schema: schemaDestinataireEnvoi, valide: EXEMPLES_CORPS.envoiTemplate.corps.recipients[0] },
};
const TABLES = Object.entries(SCHEMAS).map(([nom, s]) => ({ nom, ...s, table: CHAMPS[nom as keyof typeof SCHEMAS] as TableDeChamps }));

describe('🔴 chaque tableau de champs est le schéma de sa route', () => {
  it('garde de la garde : huit tableaux adossés à un schéma, chacun avec des champs', () => {
    expect(TABLES).toHaveLength(8);
    for (const t of TABLES) expect(t.table.champs.length, t.nom).toBeGreaterThan(0);
    expect(Object.keys(CHAMPS).sort()).toEqual([...Object.keys(SCHEMAS), 'param'].sort());
  });

  it.each(TABLES)('$nom : mêmes clés, dans les deux sens (les clés refusées à part)', ({ schema, table }) => {
    const cles = Object.keys(schema.shape);
    const refusees = cles.filter((k) => estRefusee(schema.shape[k] as z.ZodType)).sort();
    expect(table.champs.map((c) => c.nom).sort()).toEqual(cles.filter((k) => !refusees.includes(k)).sort());
    expect([...(table.refusees?.noms ?? [])].sort()).toEqual(refusees);
  });

  it.each(TABLES)('$nom : obligation, type et valeurs de chaque champ', ({ schema, table }) => {
    for (const c of table.champs) {
      const s = schema.shape[c.nom] as z.ZodType;
      // Obligatoire = le schéma refuse son absence. Une condition (« une clé au moins ») est optionnelle au schéma.
      expect(s.safeParse(undefined).success, `${c.nom} : obligation`).toBe(c.obligatoire !== 'oui');
      expect(typeDe(s), `${c.nom} : type`).toBe(c.type);
      expect(c.valeurs ? [...c.valeurs].sort() : null, `${c.nom} : valeurs`).toEqual(valeursEnum(s));
    }
  });

  it.each(TABLES)('$nom : ce que la route fait d’une clé inconnue', ({ schema, table, valide }) => {
    // Le corps valide passe seul : c'est donc bien la clé ajoutée qui décide du verdict.
    expect(schema.safeParse(valide).success).toBe(true);
    const avec = schema.safeParse({ ...(valide as object), cleInventeeParLaSuite: 'x' }).success;
    expect(avec ? 'ignorees' : 'refusees').toBe(table.inconnues);
  });
});

describe('🔴 le tableau de params est la règle de validateParamMapping', () => {
  const base = { position: 1, source: { type: 'now' } };
  const valide = (entree: unknown): boolean => validateParamMapping([entree], { accepterVariables: true }) !== null;
  type ClesDoc = (typeof CHAMPS.param.champs)[number]['nom'];
  // Au typage : les clés documentées sont celles de `TemplateParam`, dans les deux sens.
  const parite: [Exclude<keyof TemplateParam, ClesDoc>, Exclude<ClesDoc, keyof TemplateParam>] extends [never, never] ? true : false = true;

  it('les clés (au typage) et l’obligation de chacune (à l’exécution)', () => {
    expect(parite).toBe(true);
    expect(valide(base)).toBe(true);
    for (const c of CHAMPS.param.champs) {
      const sans = Object.fromEntries(Object.entries({ ...base, fallback: 'x' }).filter(([k]) => k !== c.nom));
      expect(valide(sans), `${c.nom} : obligation`).toBe(c.obligatoire !== 'oui');
    }
  });

  it('les types : position entière, fallback texte', () => {
    expect(valide({ ...base, position: 1.5 })).toBe(false);
    expect(valide({ ...base, fallback: 3 })).toBe(false);
    expect(valide({ ...base, fallback: 'x' })).toBe(true);
  });

  it('une clé inconnue est ignorée', () => {
    expect(CHAMPS.param.inconnues).toBe('ignorees');
    expect(valide({ ...base, cleInventeeParLaSuite: 'x' })).toBe(true);
  });
});

describe('🔴 les sources de params sont celles du serveur', () => {
  type TypesDoc = (typeof SOURCES_PARAM)[number]['type'];
  const typesParite: [Exclude<ParamSource['type'], TypesDoc>, Exclude<TypesDoc, ParamSource['type']>] extends [never, never] ? true : false = true;
  type AttributsServeur = Extract<ParamSource, { type: 'attribute' }>['key'];
  type AttributsDoc = Extract<(typeof SOURCES_PARAM)[number], { type: 'attribute' }>['valeurs'][number];
  const attributsParite: [Exclude<AttributsServeur, AttributsDoc>, Exclude<AttributsDoc, AttributsServeur>] extends [never, never] ? true : false = true;
  const attributs: readonly string[] = SOURCES_PARAM.find((s) => s.type === 'attribute')!.valeurs;

  const avecSource = (source: unknown): boolean =>
    validateParamMapping([{ position: 1, source }], { accepterVariables: true }) !== null;
  const exemple = (s: SourceDoc): Record<string, string> =>
    ({ type: s.type, ...(s.cle ? { [s.cle]: s.valeurs?.[0] ?? 'prenom' } : {}) });

  it('mêmes types, dans les deux sens (au typage), et chacun accepté avec sa clé', () => {
    expect(typesParite).toBe(true);
    expect(new Set(SOURCES_PARAM.map((s) => s.type)).size).toBe(SOURCES_PARAM.length);
    for (const s of SOURCES_PARAM) expect(avecSource(exemple(s)), s.type).toBe(true);
    expect(avecSource({ type: 'inventee' })).toBe(false);
  });

  it('la clé d’une source est obligatoire quand la doc l’annonce', () => {
    const avecCle = SOURCES_PARAM.filter((x: SourceDoc) => x.cle !== undefined);
    expect(avecCle.length).toBeGreaterThan(0);
    for (const s of avecCle) expect(avecSource({ type: s.type }), s.type).toBe(false);
  });

  it('les attributs : ceux du serveur, dans les deux sens (au typage), chacun accepté, un autre refusé', () => {
    expect(attributsParite).toBe(true);
    expect(attributs.length).toBeGreaterThan(0);
    for (const a of attributs) expect(avecSource({ type: 'attribute', key: a }), a).toBe(true);
    expect(avecSource({ type: 'attribute', key: 'email' })).toBe(false);
  });
});

describe('🔴 les cibles documentées sont celles du schéma de l’envoi', () => {
  const cible = schemaCorpsEnvoi.shape.target as unknown as z.ZodType;

  it('une cible par option du schéma, avec ses clés', () => {
    const options = def(cible).options ?? [];
    expect(options.length).toBeGreaterThan(0);
    const cles = options.map((o) => Object.keys((o as Objet).shape));
    // Chaque option porte exactement une clé : c'est ce que la doc annonce (« target porte exactement une clé »).
    for (const c of cles) expect(c).toHaveLength(1);
    expect(CIBLES.map((c) => c.nom).sort()).toEqual(cles.map((c) => c[0]!).sort());
    const template = options.find((o) => 'template' in (o as Objet).shape) as Objet;
    expect([...CIBLES.find((c) => c.nom === 'template')!.cles!].sort())
      .toEqual(Object.keys((template.shape.template as unknown as Objet).shape).sort());
    for (const c of CIBLES.filter((x: CibleDoc) => x.nom !== 'template') as readonly CibleDoc[]) expect(c.cles, c.nom).toBeUndefined();
  });
});
