import { describe, it, expect } from 'vitest';
import { propositionMbaSchema, SCHEMA_PROPOSITION_MBA, TYPES_OPERATION } from '../src/mba/assistant/proposition';

/**
 * 🔴 TOUTE BORNE QUE ZOD APPLIQUE À LA RÉPONSE DE L'ASSISTANT DU MBA EST ANNONCÉE AU MODÈLE (règle du CLAUDE.md du
 * dépôt). Jusqu'au 2026-10-07, l'outil `proposer` n'annonçait que `type` pour chaque opération : aucune longueur,
 * aucune énumération. Le schéma annoncé est écrit à la main (`SCHEMA_PROPOSITION_MBA`), comme celui de l'autre
 * assistant, et ce test le tient à la parité avec Zod, VALEURS comprises : une opération y est un objet à plat, donc
 * deux opérations qui partagent un nom de champ doivent lui donner les mêmes bornes.
 *
 * ⚠️ Il lit les internes de Zod 4 (`_zod.def`), comme `tests/agent-setup-bornes.test.ts` : d'où le compte plancher,
 * qui dit qu'un extracteur muet est cassé au lieu de laisser le test passer à vide.
 */

type Borne = { chemin: string; cle: string; valeur: unknown };

/** Ce que Zod applique, chemin par chemin ; les opérations se lisent toutes sous `operations[]`. */
function bornes(s: any, chemin: string, out: Borne[]): Borne[] {
  const d = s?._zod?.def;
  if (!d) return out;
  if (d.type === 'optional' || d.type === 'nullable' || d.type === 'default' || d.type === 'pipe') return bornes(d.innerType ?? d.in, chemin, out);
  if (d.type === 'object') {
    for (const [k, v] of Object.entries(d.shape)) bornes(v, chemin ? `${chemin}.${k}` : k, out);
    return out;
  }
  if (d.type === 'union') {
    for (const o of d.options) bornes(o, chemin, out);
    return out;
  }
  if (d.type === 'enum') out.push({ chemin, cle: 'enum', valeur: Object.values(d.entries) });
  for (const c of d.checks ?? []) {
    const cd = c?._zod?.def ?? c;
    const tableau = d.type === 'array';
    if (cd.check === 'max_length') out.push({ chemin, cle: tableau ? 'maxItems' : 'maxLength', valeur: cd.maximum });
    if (cd.check === 'min_length' && cd.minimum > 0) out.push({ chemin, cle: tableau ? 'minItems' : 'minLength', valeur: cd.minimum });
    if (cd.format === 'regex') out.push({ chemin, cle: 'pattern', valeur: cd.pattern?.source });
  }
  if (d.type === 'array') return bornes(d.element, `${chemin}[]`, out);
  return out;
}

/** Ce que le schéma annoncé déclare, chemin par chemin. */
function annonces(n: any, chemin: string, out: Map<string, Record<string, unknown>>): Map<string, Record<string, unknown>> {
  if (!n || typeof n !== 'object') return out;
  out.set(chemin, n);
  if (n.properties) for (const [k, v] of Object.entries(n.properties)) annonces(v, chemin ? `${chemin}.${k}` : k, out);
  if (n.items) annonces(n.items, `${chemin}[]`, out);
  return out;
}

describe('assistant du MBA : ce que Zod refuse, le modèle en a été prévenu', () => {
  const appliquees = bornes(propositionMbaSchema, '', []);
  const promis = annonces(SCHEMA_PROPOSITION_MBA, '', new Map());

  it('l’extracteur lit bien les bornes de Zod (sinon c’est lui qu’il faut réparer)', () => {
    expect(appliquees.length).toBeGreaterThanOrEqual(35);
  });

  it('🔴 chaque borne appliquée figure dans le schéma annoncé, avec la MÊME valeur', () => {
    const fautes = appliquees.filter(({ chemin, cle, valeur }) => {
      const n = promis.get(chemin);
      if (!n) return true;
      if (cle === 'enum') {
        const annonce = n.enum as unknown[] | undefined;
        return !annonce || !(valeur as unknown[]).every((v) => annonce.includes(v));
      }
      return n[cle] !== valeur;
    });
    expect(fautes.map((f) => `${f.chemin}/${f.cle}=${String(f.valeur)}`)).toEqual([]);
  });

  it('le type d’opération est une énumération des quatorze, messages interactifs compris', () => {
    expect(promis.get('operations[].type')?.enum).toEqual(TYPES_OPERATION);
    expect(TYPES_OPERATION).toHaveLength(14);
    expect(TYPES_OPERATION).toEqual(expect.arrayContaining(['message_interactif.ajouter', 'message_interactif.modifier', 'message_interactif.supprimer']));
  });

  it('aucun anyOf : tous les fournisseurs ne le lisent pas', () => {
    expect(JSON.stringify(SCHEMA_PROPOSITION_MBA)).not.toContain('anyOf');
  });
});
