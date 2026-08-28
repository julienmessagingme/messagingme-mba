import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Parité des bornes entre la migration 0086 et le schéma Zod de la route.
 *
 * 🔴 CE QUI SE PASSE SI ELLES DIVERGENT. La base porte de vrais `check` : elle refusera de toute façon, mais
 * en 500, dont Cloudflare remplace le corps par sa propre page. Le client verrait une panne là où il a juste
 * saisi 30 tours au lieu de 20. Le schéma Zod existe pour transformer ce refus en un 400 qui dit quoi
 * corriger, et il ne le peut que s'il dit EXACTEMENT la même chose que la base.
 *
 * ⚠️ L'assertion est DÉRIVÉE des deux fichiers, jamais recopiée à la main : une liste écrite ici serait
 * décorative, exactement le défaut que `tests/queue-names.test.ts` a déjà eu à corriger.
 */
const migration = readFileSync(new URL('../db/migrations/0086_agent_ia.sql', import.meta.url), 'utf8');
const route = readFileSync(new URL('../src/http/agents.ts', import.meta.url), 'utf8');

/** `col int not null default N check (col between A and B)` -> [A, B]. */
function borneSql(colonne: string): [number, number] {
  const m = new RegExp(`${colonne}\\s+[^\\n]*check\\s*\\(${colonne} between (\\d+) and (\\d+)\\)`).exec(migration);
  if (!m) throw new Error(`borne SQL introuvable pour ${colonne}`);
  return [Number(m[1]), Number(m[2])];
}

/** `champ: z.number().int().min(A).max(B)` -> [A, B]. */
function borneZod(champ: string): [number, number] {
  const m = new RegExp(`${champ}: z\\.number\\(\\)\\.int\\(\\)\\.min\\((\\d+)\\)\\.max\\((\\d+)\\)`).exec(route);
  if (!m) throw new Error(`borne Zod introuvable pour ${champ}`);
  return [Number(m[1]), Number(m[2])];
}

/** `col text not null ... check (col in ('a','b'))` -> ['a','b']. */
function enumSql(colonne: string): string[] {
  const m = new RegExp(`check\\s*\\(${colonne} in\\s*\\(([^)]+)\\)\\)`).exec(migration);
  if (!m) throw new Error(`énumération SQL introuvable pour ${colonne}`);
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

/** `champ: z.enum(['a', 'b'])` -> ['a','b']. */
function enumZod(champ: string): string[] {
  const m = new RegExp(`${champ}: z\\.enum\\(\\[([^\\]]+)\\]\\)`).exec(route);
  if (!m) throw new Error(`énumération Zod introuvable pour ${champ}`);
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

describe('bornes des agents : la route dit la même chose que la base', () => {
  it('🔴 les trois plafonds numériques ont les MÊMES bornes des deux côtés', () => {
    expect(borneZod('maxTours')).toEqual(borneSql('max_tours'));
    expect(borneZod('maxAppelsOutils')).toEqual(borneSql('max_appels_outils'));
    expect(borneZod('inactiviteMinutes')).toEqual(borneSql('inactivite_minutes'));
  });

  it('🔴 les deux énumérations ont les MÊMES valeurs des deux côtés', () => {
    expect(enumZod('contactInconnu').sort()).toEqual(enumSql('contact_inconnu').sort());
    expect(enumZod('status').sort()).toEqual(enumSql('status').sort());
  });

  it('le test lit VRAIMENT les deux fichiers (sinon il ne prouve rien)', () => {
    // Une extraction qui rendrait silencieusement une liste vide ferait passer les assertions ci-dessus sans
    // rien comparer. Les helpers lèvent déjà sur l'absence ; ceci ancre qu'ils ont trouvé du contenu.
    expect(borneSql('max_tours')[1]).toBeGreaterThan(0);
    expect(enumSql('status')).toContain('active');
  });
});
