import { describe, it, expect } from 'vitest';
import { creerSignalerEchecTardif, type DepsSignalerEchec } from '../src/mba/signaler-echec-tardif';
import { TYPE_ENVOI_ECHOUE, evenementEnvoiEchoue, type EvenementAgent } from '../src/mba/evenement';

/**
 * Un envoi qui échoue APRÈS la réponse « C'est parti » du relais, dit à l'agent de Meta (revue du 2026-09-22).
 *
 * 🔴 CE QUE CE FICHIER PROTÈGE : l'événement part vers le bon client, avec la raison, et SEULEMENT si le fil est à
 * l'agent de Meta : sinon il le ferait parler par-dessus un opérateur, ou pendant l'attente d'un accusé (0149).
 */
function faux(o: { detenteur?: string; numero?: string | null } = {}) {
  const envois: Array<{ pn: string; to: string; event: EvenementAgent }> = [];
  const journal: string[] = [];
  const deps: DepsSignalerEchec = {
    detenteur: async () => o.detenteur ?? 'mba',
    numero: async () => (o.numero === undefined ? 'PN1' : o.numero),
    envoyer: async (_t, pn, to, event) => { envois.push({ pn, to, event }); },
    journal: (l) => { journal.push(l); },
  };
  return { signaler: creerSignalerEchecTardif(deps), envois, journal };
}

describe('dire à l’agent de Meta qu’un envoi a échoué après sa réponse', () => {
  it('🔴 envoie l’événement au client, au format mesuré, avec la raison', async () => {
    const f = faux();
    await f.signaler('t1', '33612345678', 'le contact s’est désabonné');
    expect(f.envois).toHaveLength(1);
    expect(f.envois[0]!.pn).toBe('PN1');
    expect(f.envois[0]!.to).toBe('+33612345678');
    expect(f.envois[0]!.event.type).toBe(TYPE_ENVOI_ECHOUE);
    expect(JSON.parse(f.envois[0]!.event.payload)).toEqual({ raison: 'le contact s’est désabonné' });
  });

  it('🔴 rien si le fil n’est pas à l’agent de Meta (opérateur, accusé attendu), et le journal le dit', async () => {
    for (const detenteur of ['app_human', 'app_workflow']) {
      const f = faux({ detenteur });
      await f.signaler('t1', '33612345678', 'raison');
      expect(f.envois).toEqual([]);
      expect(f.journal).toHaveLength(1);
    }
  });

  it('rien sans numéro connecté', async () => {
    const f = faux({ numero: null });
    await f.signaler('t1', '33612345678', 'raison');
    expect(f.envois).toEqual([]);
  });
});

describe('l’événement « envoi échoué »', () => {
  it('🔴 son payload tient sous 4 096 caractères APRÈS échappement, et reste du JSON', () => {
    const e = evenementEnvoiEchoue('"'.repeat(5000));
    expect(e.payload.length).toBeLessThanOrEqual(4096);
    expect(typeof JSON.parse(e.payload).raison).toBe('string');
  });

  it('dit à l’agent de parler au client, sans détail technique', () => {
    const e = evenementEnvoiEchoue('x');
    expect(e.description).toContain('Dis-le-lui');
    expect(e.description).toContain('sans détail technique');
  });
});
