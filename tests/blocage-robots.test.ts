import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Pool } from 'pg';
import { PgContactStore } from '../src/crm/contact-store.pg';

/**
 * UN CONTACT BLOQUÉ, AUCUN ROBOT NE LUI ÉCRIT, MÊME EN COURS DE ROUTE (essai réel du 2026-10-23). Le blocage n'était relu
 * qu'à l'ENTRÉE d'un robot (la remise du fil, l'automation, la publicité) : un contact bloqué pendant une session d'agent
 * recevait encore les réponses de l'agent jusqu'à la fin de la session, parce que la garde que relisent les robots juste
 * avant d'écrire ne lisait que le STOP. Elle lit désormais les deux (`machineSeTaitParWaId`), sur les trois câblages.
 */

/** Un faux pool qui répond aux deux lectures d'origine : le consentement, puis le blocage. */
function store(fiche: { opt_in_status: string; bloque: boolean } | null) {
  const pool = {
    query: async (sql: string) => {
      if (fiche === null) return { rows: [] };
      if (/select opt_in_status from contacts/.test(sql)) return { rows: [{ opt_in_status: fiche.opt_in_status }] };
      if (/blocked_at is not null\) as bloque/.test(sql)) return { rows: [{ bloque: fiche.bloque }] };
      throw new Error(`requête inattendue : ${sql}`);
    },
  } as unknown as Pool;
  return new PgContactStore(pool);
}

describe('machineSeTaitParWaId : STOP ou bloqué', () => {
  it('🔴 un contact bloqué fait taire les robots, comme un STOP ; un contact ordinaire ou inconnu, non', async () => {
    expect(await store({ opt_in_status: 'unknown', bloque: true }).machineSeTaitParWaId('t1', '33612345678')).toBe(true);
    expect(await store({ opt_in_status: 'opted_out', bloque: false }).machineSeTaitParWaId('t1', '33612345678')).toBe(true);
    expect(await store({ opt_in_status: 'opted_in', bloque: false }).machineSeTaitParWaId('t1', '33612345678')).toBe(false);
    expect(await store(null).machineSeTaitParWaId('t1', '33612345678')).toBe(false);
  });
});

describe('🔴 les trois câblages des robots lisent le blocage', () => {
  /** Le bloc de texte qui suit une ancre, jusqu'à la fermeture de l'objet : de quoi lire le câblage d'un seul robot. */
  const bloc = (src: string, ancre: string, fin: string): string => {
    const debut = src.indexOf(ancre);
    expect(debut, `${ancre} introuvable : ce test a besoin d'être revisé`).toBeGreaterThan(0);
    return src.slice(debut, src.indexOf(fin, debut));
  };
  const worker = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
  const wiring = readFileSync(new URL('../src/workflow/wiring.ts', import.meta.url), 'utf8');

  it('la réponse de l’agent IA (le tour, `run-turn`) et ses gestes d’envoi', () => {
    // Les dépendances du tour : sa garde est la dernière `estDesabonne:` avant le numéro bloqué, son voisin dans l'objet.
    const ancre = worker.indexOf('numeroBloque: numeroBloqueDeLEspace');
    expect(ancre, 'les dépendances du tour sont introuvables : ce test a besoin d’être revisé').toBeGreaterThan(0);
    expect(worker.slice(worker.lastIndexOf('estDesabonne:', ancre), ancre)).toContain('contactStore.machineSeTaitParWaId(t, waId)');
    const gestes = bloc(worker, 'creerGestesEnvoiAgent({', '});');
    expect(gestes).toContain('estDesabonne: (t, waId) => contactStore.machineSeTaitParWaId(t, waId)');
  });

  it('les envois d’un parcours (scénario, automation, outils de l’agent par `apply`)', () => {
    expect(wiring).toContain('estDesabonne: (tenant, waId) => contactStore.machineSeTaitParWaId(tenant, waId)');
    expect(wiring).not.toContain('contactStore.estDesabonneParWaId');
  });

  it('le worker ne garde la lecture du seul STOP que là où le blocage est relu à part (le routage des publicités)', () => {
    const restes = [...worker.matchAll(/contactStore\.estDesabonneParWaId/g)].length;
    expect(restes).toBe(1);
    expect(worker).toContain('contactBloque: (t, waId) => contactStore.isBlockedByWaId(t, waId)');
  });
});
