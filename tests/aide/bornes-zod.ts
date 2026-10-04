/**
 * CE QUE ZOD REFUSE, LE SCHÉMA D'UN OUTIL MCP L'ANNONCE (règle du dépôt, 2026-09-17) : un modèle ne respecte que ce
 * qu'on lui a dit, et une borne tue ne se découvre qu'au refus.
 *
 * Sorti de `tests/mcp-widgets.test.ts` quand les outils de l'agent IA l'ont repris (lot 8a), et élargi à ce qu'ils
 * portent en plus : des LISTES (`minItems`, `maxItems`) et des OBJETS dans ces listes (une fiche, un message, une règle
 * d'arrêt), lus chemin par chemin (`sorties[].code`).
 *
 * ⚠️ IL LIT LES INTERNES DE ZOD : il pourrait devenir MUET à la prochaine version majeure. D'où le compte plancher que
 * chaque appelant pose sur `bornesDesChamps`, et toute forme de borne qu'il ne connaît pas, qu'il rend comme une
 * borne muette au lieu de passer à vide.
 */

/** Une borne appliquée : le chemin du champ, la clé JSON Schema qui l'annonce, et sa valeur. */
export type Borne = [chemin: string, cle: string, valeur: unknown];

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Les bornes qu'un schéma Zod applique, chemin par chemin. */
export function bornesZod(chemin: string, s: any, out: Borne[] = []): Borne[] {
  const d = s?._zod?.def;
  if (!d) return out;
  for (const c of d.checks ?? []) {
    const cd = c?._zod?.def ?? c;
    const liste = d.type === 'array';
    if (cd.check === 'overwrite') continue; // le `trim`, une transformation et pas une borne
    else if (cd.check === 'min_length') { if (cd.minimum > 0) out.push([chemin, liste ? 'minItems' : 'minLength', cd.minimum]); }
    else if (cd.check === 'max_length') out.push([chemin, liste ? 'maxItems' : 'maxLength', cd.maximum]);
    else if (cd.check === 'string_format' && cd.format === 'regex') out.push([chemin, 'pattern', cd.pattern.source]);
    else if (cd.check === 'string_format' && cd.format === 'uuid') out.push([chemin, 'format', 'uuid']);
    else if (cd.check === 'number_format' && cd.format === 'safeint') out.push([chemin, 'type', 'integer']);
    else if (cd.check === 'greater_than' && cd.inclusive) out.push([chemin, 'minimum', cd.value]);
    else if (cd.check === 'less_than' && cd.inclusive) out.push([chemin, 'maximum', cd.value]);
    // Un raffinement : sa valeur est le type qu'il raffine, qui décide de la façon de l'annoncer (voir `muettes`).
    else if (cd.check === 'custom') out.push([chemin, 'raffinement', d.type]);
    else out.push([chemin, `forme inconnue de l’extracteur : ${String(cd.check)}/${String(cd.format)}`, null]);
  }
  if (['optional', 'nonoptional', 'default'].includes(d.type)) return bornesZod(chemin, d.innerType, out);
  if (d.type === 'nullable') { out.push([chemin, 'null', true]); return bornesZod(chemin, d.innerType, out); }
  if (d.type === 'pipe') return bornesZod(chemin, d.in, out);
  if (d.type === 'enum') out.push([chemin, 'enum', Object.values(d.entries)]);
  if (d.type === 'boolean') out.push([chemin, 'type', 'boolean']);
  if (d.type === 'array') return bornesZod(`${chemin}[]`, d.element, out);
  if (d.type === 'object') for (const [k, v] of Object.entries<any>(d.shape)) bornesZod(`${chemin}.${k}`, v, out);
  return out;
}

/** Les champs d'un objet Zod, pour les comparer à la racine d'un schéma d'entrée. */
export function champsDe(objet: any): Record<string, unknown> {
  return objet._zod.def.shape;
}

/** Les bornes de plusieurs champs, chacun sous le nom de la propriété qui l'annonce dans l'outil. */
export function bornesDesChamps(champs: Record<string, unknown>): Borne[] {
  return Object.entries(champs).flatMap(([nom, s]) => bornesZod(nom, s));
}

/** La propriété annoncée à ce chemin (`fiches[].titre` : `properties.fiches.items.properties.titre`), ou `undefined`. */
function annonce(schema: any, chemin: string): any {
  let p: any = schema;
  for (const segment of chemin.split('.')) {
    const [nom, ...listes] = segment.split('[]');
    p = p?.properties?.[nom!];
    for (let i = 0; i < listes.length; i++) p = p?.items;
  }
  return p;
}

/**
 * Les bornes appliquées que le schéma d'entrée n'annonce pas, ou pas avec la même valeur. Vide = tout est dit.
 * - une énumération annoncée doit être INCLUSE dans celle que Zod accepte : plus stricte, jamais plus large ; et une
 *   énumération annoncée couvre une longueur ou un motif, qu'elle rend inatteignables ;
 * - un raffinement d'un texte s'annonce par un motif, celui d'une liste (l'unicité de ses codes) dans sa description.
 */
export function muettes(appliquees: readonly Borne[], schema: unknown): string[] {
  const types = (p: any): string[] => (Array.isArray(p?.type) ? p.type : [p?.type]);
  return appliquees.filter(([chemin, cle, valeur]) => {
    const p = annonce(schema, chemin);
    if (!p) return true;
    if (Array.isArray(p.enum) && ['minLength', 'maxLength', 'pattern'].includes(cle)) return false;
    switch (cle) {
      case 'null': return !types(p).includes('null');
      case 'type': return !types(p).includes(valeur as string);
      case 'enum': {
        const proposees = (p.enum ?? []).filter((v: unknown) => v !== null);
        return proposees.length === 0 || proposees.some((v: string) => !(valeur as string[]).includes(v));
      }
      case 'raffinement':
        return valeur === 'array' ? !/unique/i.test(String(p.description ?? '')) : typeof p.pattern !== 'string';
      default: return p[cle] !== valeur;
    }
  }).map(([chemin, cle, valeur]) => `${chemin}/${cle}=${JSON.stringify(valeur)}`);
}
