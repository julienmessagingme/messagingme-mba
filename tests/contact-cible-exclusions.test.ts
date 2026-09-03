import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { PgContactStore, buildBulkSelector } from '../src/crm/contact-store.pg';

/**
 * L'ORDRE DES DEUX FILTRES D'UNE CIBLE DE CAMPAGNE (contre-audit du 2026-09-03).
 *
 * 🔴 LE DÉFAUT FERMÉ ICI, ET POURQUOI IL ÉTAIT INVISIBLE. La résolution d'une cible se faisait en deux temps :
 * SQL tranchait à `limite`, puis le code retirait `excludeIds` EN MÉMOIRE. Sur 30 000 contacts correspondants,
 * un plafond de 20 000 et 5 000 exclus parmi les 20 001 premiers, la fonction rendait ~15 001 identifiants.
 * La campagne était acceptée, et les 10 000 contacts éligibles situés APRÈS la fenêtre n'étaient jamais
 * atteints. **Elle sous-envoyait en silence** : le nombre affiché à l'opérateur est celui qu'on vient de
 * calculer, donc rien ne clochait à l'écran.
 *
 * La règle : quand une opération enchaîne un filtre en BASE et un filtre en MÉMOIRE, l'ordre décide du
 * résultat, et le second ne peut jamais rattraper ce que le premier a coupé.
 *
 * ⚠️ Ce chemin n'a pas de test d'intégration exécutable en local (le `DATABASE_URL` local vise la
 * production). On capture donc le SQL avec un faux pool : ça ne prouve pas que Postgres l'accepte, la CI s'en
 * charge, mais ça prouve la seule chose qui manquait, l'ORDRE.
 */
function poolQuiCapture() {
  const requetes: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      requetes.push({ sql, params });
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  return { pool, requetes };
}

describe('cible de campagne : exclusions et plafond', () => {
  it('🔴 les exclusions sont dans le WHERE, et le LIMIT vient APRÈS', async () => {
    const { pool, requetes } = poolQuiCapture();
    await new PgContactStore(pool).contactIdsForTarget(
      't1',
      { filters: { tags: ['vip'] }, excludeIds: ['c9'] },
      20_001,
    );
    expect(requetes).toHaveLength(1);
    const { sql, params } = requetes[0]!;
    // L'exclusion doit être un prédicat SQL, pas un filtre appliqué ensuite en mémoire.
    expect(sql, 'l’exclusion doit être poussée dans le prédicat').toMatch(/not \(id = any\(\$\d+::uuid\[\]\)\)/);
    // Et le LIMIT doit venir APRÈS, donc plus loin dans la requête que l'exclusion.
    expect(sql.indexOf('not (id = any('), 'l’exclusion doit précéder le limit').toBeLessThan(sql.indexOf('limit'));
    expect(params).toContain(20_001);
    expect(params).toContainEqual(['c9']);
  });

  it('sans exclusion, la requête reste simple et bornée', async () => {
    const { pool, requetes } = poolQuiCapture();
    await new PgContactStore(pool).contactIdsForTarget('t1', { filters: {} }, 500);
    const { sql, params } = requetes[0]!;
    expect(sql).not.toMatch(/not \(id = any/);
    expect(sql).toMatch(/limit \$\d+/);
    expect(params).toContain(500);
  });

  it('sans limite, le plafond technique du store s’applique quand même', async () => {
    // Une cible non bornée ne doit pas pouvoir matérialiser la table entière : c'était déjà le cas avant, et
    // la réécriture ne devait pas le perdre.
    const { pool, requetes } = poolQuiCapture();
    await new PgContactStore(pool).contactIdsForTarget('t1', { filters: {} });
    expect(requetes[0]!.params).toContain(100_000);
  });

  it('une cible par IDENTIFIANTS explicites n’est pas bornée : ce n’est pas une sélection', async () => {
    // L'appelant a déjà la liste en main ; la tronquer ici ferait partir une campagne vers un sous-ensemble
    // silencieux de ce qu'il a demandé. Son plafond est le refus qui suit.
    const { pool, requetes } = poolQuiCapture();
    await new PgContactStore(pool).contactIdsForTarget('t1', { ids: ['a', 'b'] }, 1);
    expect(requetes[0]!.sql).not.toMatch(/limit/);
  });

  it('le sélecteur partagé met bien les exclusions dans le prédicat', () => {
    // La brique réutilisée. Elle existait déjà, utilisée par les actions en masse du mini-CRM : le défaut
    // n'était pas qu'elle manquait, c'est que la résolution de cible ne s'en servait pas.
    const sel = buildBulkSelector('t1', { filters: { tags: ['vip'] }, excludeIds: ['x'] });
    expect(sel.where).toMatch(/not \(id = any/);
    expect(sel.params).toContainEqual(['x']);
  });
});
