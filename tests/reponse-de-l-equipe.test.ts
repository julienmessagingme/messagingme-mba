import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { REPONSE_DE_L_EQUIPE_SQL, vautReponseDeLEquipe } from '../src/inbox/origine';
import { PgPerformanceStore } from '../src/stats/performance.pg';
import { auteurDeLEnvoi } from '../src/inbox/evenements';

/**
 * UNE RÉPONSE DE CLAUDE AU NOM D'UNE PERSONNE VAUT CELLE DE L'INBOX, PARTOUT (lot 3 de la marche arrière). Le fil la
 * comptait depuis le lot 2 (`vautReponseDeLEquipe`, l'escalade levée), les statistiques non : une demande escaladée,
 * répondue par Claude puis rendue par le balayage, passait en « résolue sans réponse ». Une seule règle, en TypeScript
 * pour le fil et en SQL pour les statistiques ; une réaction n'est jamais une réponse.
 */
describe('vautReponseDeLEquipe et son pendant SQL', () => {
  it('l’Inbox, et Claude au nom d’une personne ; ni une clé d’API, ni un robot, ni une réaction', () => {
    expect(vautReponseDeLEquipe('humain', 'u1', 'text')).toBe(true);
    expect(vautReponseDeLEquipe('mcp', 'u1', 'text')).toBe(true);
    expect(vautReponseDeLEquipe('mcp', 'u1', 'reaction')).toBe(false);
    // Un 👍 posé par un humain (l'écho de l'application WhatsApp Business) non plus (lot 4, décision de Julien).
    expect(vautReponseDeLEquipe('humain', 'u1', 'reaction')).toBe(false);
    expect(vautReponseDeLEquipe('humain', null, 'reaction')).toBe(false);
    expect(vautReponseDeLEquipe('mcp', null, 'text')).toBe(false);
    for (const robot of ['ia', 'mba', 'scenario', 'campagne', 'api'] as const) expect(vautReponseDeLEquipe(robot, 'u1', 'text'), robot).toBe(false);
  });

  it('le fragment SQL dit la même chose : la même origine, la personne, et la réaction exclue', () => {
    expect(REPONSE_DE_L_EQUIPE_SQL).toContain("m.origin = 'humain'");
    expect(REPONSE_DE_L_EQUIPE_SQL).toContain("m.origin = 'mcp' and m.sender_user_id is not null");
    // La réaction exclue AVANT l'origine : pour l'humain aussi, pas seulement pour Claude.
    expect(REPONSE_DE_L_EQUIPE_SQL).toMatch(/^\(m\.type is distinct from 'reaction' and \(/);
  });

  it('🔴 les statistiques lisent CE fragment aux trois endroits : ce qui part vers la base', async () => {
    const requetes: string[] = [];
    const pool = {
      query: async (sql: string) => {
        requetes.push(sql);
        return { rows: /schema_migrations/.test(sql) ? [{ applied_at: new Date('2026-09-29T00:00:00Z') }] : [] };
      },
    } as unknown as Pool;
    await new PgPerformanceStore(pool).lire('t1', { from: '2026-10-01', to: '2026-10-23' });
    const demandes = requetes.find((sql) => /conversation_evenements/.test(sql));
    expect(demandes, 'la requête des demandes').toBeDefined();
    // Le début (le message qui dit à qui est la balle), la première et la dernière réponse.
    expect(demandes!.split(REPONSE_DE_L_EQUIPE_SQL).length - 1).toBe(3);
    // Plus aucune lecture de la seule origine `humain` hors du fragment.
    expect(demandes!.split("m.origin = 'humain'").length - 1).toBe(3);
    expect(demandes).not.toMatch(/origin in \('humain'/);
  });

  it('la frise signe de la personne la prise du fil par Claude en son nom ; derrière une clé, la machine', () => {
    expect(auteurDeLEnvoi('mcp', 'u1')).toEqual({ collaborateur: 'u1' });
    expect(auteurDeLEnvoi('mcp', null)).toEqual({ cause: 'automatique : envoi par un agent tiers (MCP)' });
  });
});
