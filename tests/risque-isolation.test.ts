import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * 🔴 L'ISOLATION ENTRE CLIENTS DU RISQUE DE DÉSENGAGEMENT, lue dans le CODE (tâche 3 du plan du lot 7).
 *
 * La connexion passe par le pooler en rôle superuser, la RLS est contournée : `tenant_id = $1` est le SEUL
 * contrôle. `tests/integration/risque.integration.test.ts` le prouve contre une vraie base, mais seulement en CI,
 * donc jamais dans le sens ROUGE. Ce test-ci tourne partout et se MUTE en local : chaque table qui porte un
 * `tenant_id` a son filtre sur son alias, et les trois qui n'en portent pas n'entrent que par une jointure qui
 * filtre.
 */
function requetes(): string[] {
  const source = readFileSync(new URL('../src/engagement/risque.pg.ts', import.meta.url), 'utf8');
  return [...source.matchAll(/this\.pool\.query(?:<[^>]*>)?\(\s*`([\s\S]*?)`/g)].map((m) => m[1]!);
}

/** Les tables du schéma qui portent un `tenant_id`, parmi celles que ce fichier lit. */
const AVEC_ESPACE = ['contacts', 'conversations', 'campaigns', 'tracked_link_clicks', 'conversation_analysis', 'rcs_agents'];

describe('isolation du risque de désengagement', () => {
  const rs = requetes();

  it('le balayage trouve toutes les requêtes du dépôt', () => {
    // espaces, espaceExiste, contactsAEvaluer, faits, ecrire. Moins : une requête échappe au balayage.
    expect(rs).toHaveLength(5);
  });

  it('🔴 chaque table à `tenant_id` est filtrée SUR SON ALIAS par `= $1`', () => {
    let vues = 0;
    for (const r of rs) {
      for (const m of r.matchAll(/\b(?:from|join)\s+([a-z_]+)\s+([a-z]{1,3})\b/g)) {
        const [, table, alias] = m;
        if (!AVEC_ESPACE.includes(table!)) continue;
        vues += 1;
        expect(r, `${table} ${alias} sans son filtre d’espace`).toContain(`${alias}.tenant_id = $1`);
      }
    }
    // contacts x3, conversations x2, campaigns x2, tracked_link_clicks, conversation_analysis, rcs_agents.
    expect(vues).toBe(10);
  });

  it('🔴 les tables SANS `tenant_id` n’entrent que par une jointure qui filtre', () => {
    const tout = rs.join('\n');
    // Un destinataire de campagne, par SA campagne, filtrée sur l'espace.
    expect(tout.match(/campaign_recipients r join campaigns k on k\.id = r\.campaign_id/g)).toHaveLength(2);
    // Un message, par les fils de l'espace (le CTE `fils`, dont les deux moitiés filtrent `conversations`).
    expect(tout).toMatch(/from fils f join conversation_messages m on m\.conversation_id = f\.conversation_id/);
    expect(tout).not.toMatch(/from conversation_messages/);
    // Le cache RCS, par l'agent DE L'ESPACE.
    expect(tout).toMatch(/cc\.agent_id = \(select agent_id from agent\)/);
  });

  it('🔴 l’écriture ne touche que des fiches de l’espace, et relit leur niveau sous verrou', () => {
    const ecriture = rs.find((r) => /update contacts c/.test(r))!;
    expect(ecriture).toMatch(/where c\.tenant_id = \$1 and c\.deleted_at is null\s+for update of c/);
    expect(ecriture).toMatch(/where c\.tenant_id = \$1 and c\.id = v\.id/);
  });

  it('une seule lecture transverse, documentée : la liste des espaces du balayage de nuit', () => {
    const sansFiltre = rs.filter((r) => !/tenant_id = \$1|where id = \$1/.test(r));
    expect(sansFiltre).toEqual([`select id from tenants where status <> 'locked' order by created_at asc`]);
  });
});
