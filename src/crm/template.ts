export type ParamSource =
  | { type: 'field'; key: string }
  | { type: 'attribute'; key: 'name' | 'phone' }
  | { type: 'literal'; value: string };

export interface TemplateParam {
  /** Position de la variable dans le template ({{1}} -> 1). */
  position: number;
  source: ParamSource;
  /** Valeur de repli si la source est vide/absente. */
  fallback?: string;
}

export interface ResolvableContact {
  phone_e164?: string | null;
  profile_name?: string | null;
  fields?: Record<string, unknown>;
}

function valueOf(source: ParamSource, c: ResolvableContact): unknown {
  switch (source.type) {
    case 'literal':
      return source.value;
    case 'attribute':
      return source.key === 'name' ? c.profile_name : c.phone_e164;
    case 'field':
      return c.fields?.[source.key];
  }
}

/**
 * Résout les variables d'un template pour un contact : renvoie les valeurs ordonnées
 * par position. Valeur manquante -> fallback -> chaîne vide. C'est la glue « coller les
 * infos du CRM dans les templates ».
 */
export function resolveTemplateParams(params: TemplateParam[], contact: ResolvableContact): string[] {
  const sorted = [...params].sort((a, b) => a.position - b.position);
  // Les params WhatsApp sont positionnels : on exige 1..N contigus et uniques,
  // sinon l'array résolu (indexé par ordre) désalignerait les variables.
  sorted.forEach((p, i) => {
    if (p.position !== i + 1) {
      throw new Error('positions de template invalides (attendu 1..N contigu, sans doublon)');
    }
  });
  return sorted.map((p) => {
    const v = valueOf(p.source, contact);
    const s = v === null || v === undefined || v === '' ? undefined : String(v);
    return s ?? p.fallback ?? '';
  });
}
