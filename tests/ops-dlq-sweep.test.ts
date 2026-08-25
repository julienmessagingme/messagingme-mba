import { describe, it, expect } from 'vitest';
import { creerDlqSweep } from '../src/ops/dlq-sweep';
import type { QueueLoadRow } from '../src/ops/store.pg';

const ligne = (queue: string, backlog: number, active = 0, failed = 0): QueueLoadRow => ({ queue, backlog, active, failed });

/**
 * Surveillance des dead letter queues. Le défaut réel qu'elle couvre : un message client entrant a dormi en
 * `webhook-dlq` du 2026-08-17 au 2026-08-25 sans qu'aucune alerte ne parte.
 */
describe('dlq-sweep', () => {
  it('alerte quand une DLQ se remplit, en nommant la file et le nombre', async () => {
    const alertes: Array<{ queue: string; msg: string }> = [];
    const sweep = creerDlqSweep({
      queueLoad: async () => [ligne('webhook', 12), ligne('webhook-dlq', 1)],
      alert: (queue, msg) => alertes.push({ queue, msg }),
    });
    expect(await sweep()).toBe(1);
    expect(alertes).toHaveLength(1);
    expect(alertes[0]?.msg).toContain('webhook-dlq');
    expect(alertes[0]?.msg).toContain('1 job');
    // La file est passée À PART : c'est la clé de throttle côté worker. Deux DLQ qui se remplissent
    // ensemble doivent donner deux clés distinctes, sinon le throttle de 5 min en masquerait une.
    expect(alertes[0]?.queue).toBe('webhook-dlq');
  });

  it('silence quand toutes les DLQ sont vides', async () => {
    const alertes: string[] = [];
    const sweep = creerDlqSweep({
      queueLoad: async () => [ligne('webhook-dlq', 0), ligne('campaign-run-dlq', 0)],
      alert: (_q, m) => alertes.push(m),
    });
    expect(await sweep()).toBe(0);
    expect(alertes).toEqual([]);
  });

  it("n'alerte PAS sur une file normale chargée : seules les DLQ comptent", async () => {
    // Sans le filtre `dlqName`, un backlog sain de la file webhook (une campagne en cours, par exemple)
    // déclencherait une alerte d'échec définitif. C'est la garde que ce test protège.
    const alertes: string[] = [];
    const sweep = creerDlqSweep({
      queueLoad: async () => [ligne('webhook', 500), ligne('campaign-run', 30, 1), ligne('webhook-dlq', 0)],
      alert: (_q, m) => alertes.push(m),
    });
    expect(await sweep()).toBe(0);
    expect(alertes).toEqual([]);
  });

  it('ne RÉALERTE pas à profondeur identique : sinon un job coincé harcèle toutes les 5 min à vie', async () => {
    // La condition est PERMANENTE (rien ne consomme les DLQ) : alerter sur l'état, et non sur la hausse,
    // enverrait un Telegram à chaque tour de balayage, indéfiniment.
    const alertes: string[] = [];
    const sweep = creerDlqSweep({
      queueLoad: async () => [ligne('webhook-dlq', 1)],
      alert: (_q, m) => alertes.push(m),
    });
    expect(await sweep()).toBe(1);
    expect(await sweep()).toBe(0);
    expect(await sweep()).toBe(0);
    expect(alertes).toHaveLength(1);
  });

  it('réalerte quand la profondeur AUGMENTE encore', async () => {
    const alertes: string[] = [];
    let profondeur = 1;
    const sweep = creerDlqSweep({
      queueLoad: async () => [ligne('webhook-dlq', profondeur)],
      alert: (_q, m) => alertes.push(m),
    });
    await sweep();
    profondeur = 3;
    expect(await sweep()).toBe(1);
    expect(alertes).toHaveLength(2);
    expect(alertes[1]).toContain('3 job');
  });

  it('une DLQ vidée puis re-remplie au même niveau réalerte (le compteur se réarme à la baisse)', async () => {
    const alertes: string[] = [];
    let profondeur = 2;
    const sweep = creerDlqSweep({
      queueLoad: async () => [ligne('webhook-dlq', profondeur)],
      alert: (_q, m) => alertes.push(m),
    });
    await sweep();
    profondeur = 0;
    await sweep(); // redescente : réarme, sans alerter
    profondeur = 2;
    expect(await sweep()).toBe(1);
    expect(alertes).toHaveLength(2);
  });

  it('compte les jobs actifs et échoués, pas seulement le backlog', async () => {
    const alertes: string[] = [];
    const sweep = creerDlqSweep({
      queueLoad: async () => [ligne('campaign-run-dlq', 0, 1, 2)],
      alert: (_q, m) => alertes.push(m),
    });
    expect(await sweep()).toBe(1);
    expect(alertes[0]).toContain('3 job');
  });
});
