import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * 🔴 L'ISOLATION DE LA PURGE D'UN ESPACE (RC8), LUE DANS LE CODE. La connexion passe par le pooler en rôle superuser :
 * la RLS est contournée, et `tenant_id = $1` est le SEUL contrôle entre clients. Une écriture de la purge qui perdrait
 * son filtre effacerait les données de TOUS les espaces. L'effet réel (un espace voisin intact) est tenu par
 * `tests/integration/suppression-espace.integration.test.ts`, qui ne tourne qu'en CI ; ce test tourne partout, et se
 * mute en local.
 */
const SOURCE = readFileSync(new URL('../src/ops/suppression-espace.pg.ts', import.meta.url), 'utf8');

/** Chaque requête du fichier, sur une ligne : le premier gabarit (`...` ou '...') passé à un `query(`. */
const requetes = [...SOURCE.matchAll(/\.query(?:<[\s\S]*?>)?\(\s*(`[\s\S]*?`|'[^']*')/g)]
  .map((m) => m[1]!.slice(1, -1).replace(/\s+/g, ' ').trim());
const ecritures = requetes.filter((r) => /^(delete|update|insert)\b/i.test(r));

describe('la purge d’un espace ne touche que cet espace', () => {
  it('garde de la garde : le balayage voit les écritures de la purge', () => {
    // Le filet du numéro fourni, quatre `delete` aux clés fragiles, celui de l'espace, celui des identités, la trace.
    expect(ecritures.length, 'une écriture échappe au balayage : c’est le test qui est cassé').toBe(8);
  });

  it('🔴 chaque écriture porte l’espace, sauf les identités (relues pour CET espace) et la trace', () => {
    const autres = ecritures.filter((r) => !/\bwhere (tenant_id|id) = \$1\b/.test(r));
    expect(autres).toHaveLength(2);
    // Les identités : seulement celles relevées sur les comptes de cet espace, et qui n'ont plus aucun compte.
    const identites = autres.find((r) => /^delete from identities\b/.test(r));
    expect(identites).toMatch(/where i\.id = any\(\$1::uuid\[\]\) and not exists \(select 1 from users u where u\.identity_id = i\.id\)/);
    expect(SOURCE).toMatch(/'select distinct identity_id from users where tenant_id = \$1 and identity_id is not null'/);
    expect(autres.find((r) => /^insert into espaces_supprimes\b/.test(r))).toBeDefined();
  });

  it('🔴 chaque lecture porte l’espace, sauf UNE : la recherche d’un objet Meta partagé, qui ne rend qu’un booléen', () => {
    const lectures = requetes.filter((r) => /^select\b/i.test(r));
    expect(lectures.length).toBeGreaterThan(8);
    const autres = lectures.filter((r) => !/\b(tenant_id|id) = \$1\b/.test(r));
    // Elle regarde les AUTRES espaces (`tenant_id <> $1`) pour savoir si le compte WhatsApp ou le numéro y sont nommés.
    expect(autres).toHaveLength(1);
    expect(autres[0]).toMatch(/^select exists \(.*\) as partage$/);
    expect(autres[0]!.match(/tenant_id <> \$1/g)).toHaveLength(6);
  });

  it('🔴 `credits_offerts` n’est jamais nommée : la mémoire « jamais deux offres pour un numéro » reste', () => {
    expect(SOURCE.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')).not.toMatch(/credits_offerts/);
  });
});
