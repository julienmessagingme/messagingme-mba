import { describe, it, expect } from 'vitest';
import { traiterRapportRcs, type DepsRapportRcs } from '../src/rcs/rapport-livraison';
import type { RcsDlr } from '../src/rcs/callback';
import type { EchecMessageLibre, EchecSansMessage } from '../src/delivery/echecs-messages.pg';

const MAINTENANT = 1_700_000_000_000;

const rapport = (over: Partial<RcsDlr> = {}): RcsDlr => ({
  messageId: 'sms-1', channelId: 'agent-1', to: '33612345678', status: 'failed',
  echecDefinitif: true, detail: 'UNDELIVERABLE', refClient: null, ...over,
});

/**
 * `touches` : les destinataires de campagne que le rapport a touchés. `messageInscrit` : ce que `noter` trouve
 * dans le fil (faux = le rapport a DEVANCÉ l'inscription du message par la route ou par l'Inbox).
 */
function monde(touches = 0, messageInscrit = true) {
  const journal: string[] = [];
  const notes: EchecMessageLibre[] = [];
  const replis: EchecSansMessage[] = [];
  const cache: Array<{ agentId: string; e164: string; reachable: boolean; at: number }> = [];
  const deps: DepsRapportRcs = {
    majLivraison: async (id, statut) => { journal.push(`maj:${id}:${statut}`); return touches; },
    mesureBloc: async (id, statut) => { journal.push(`bloc:${id}:${statut}`); return 0; },
    echecs: {
      noter: async (e) => {
        notes.push(e);
        return messageInscrit ? { tenantId: 't1', waId: '33612345678', canal: 'rcs', origine: 'api' } : null;
      },
      noterSansMessage: async (e) => { replis.push(e); return null; },
    },
    joignabilite: { put: async (agentId, e164, reachable, at) => { cache.push({ agentId, e164, reachable, at }); } },
    rcsInjoignable: async (_t, to, id) => { journal.push(`injoignable:${to}:${id}`); return true; },
    rcsDelivre: async (_t, to, id) => { journal.push(`delivre:${to}:${id}`); return true; },
    maintenant: () => MAINTENANT,
  };
  return { deps, journal, notes, replis, cache };
}

describe('traiterRapportRcs : l’échec d’un RCS libre (défaut 4, côté smsmode)', () => {
  it('🔴 un échec définitif hors campagne est NOTÉ, avec l’espace connu par le code de l’URL', async () => {
    const m = monde(0);
    await traiterRapportRcs(m.deps, 't1', rapport());
    expect(m.notes).toEqual([{ messageId: 'sms-1', code: null, motif: 'UNDELIVERABLE', tenantId: 't1' }]);
    // Le message était inscrit : le repli n'a rien à faire.
    expect(m.replis).toEqual([]);
  });

  it('🔴 le rapport arrivé AVANT l’inscription du message est écrit quand même, depuis ce qu’il sait', async () => {
    const m = monde(0, false);
    await traiterRapportRcs(m.deps, 't1', rapport());
    // Ancre positive : `noter` a bien été interrogé d'abord.
    expect(m.notes.map((n) => n.messageId)).toEqual(['sms-1']);
    expect(m.replis).toEqual([{ messageId: 'sms-1', tenantId: 't1', waId: '33612345678', canal: 'rcs', code: null, motif: 'UNDELIVERABLE' }]);
  });

  it('🔴 le numéro devient injoignable pour CET agent, sous sa forme E.164', async () => {
    const m = monde(0);
    await traiterRapportRcs(m.deps, 't1', rapport());
    expect(m.cache).toEqual([{ agentId: 'agent-1', e164: '+33612345678', reachable: false, at: MAINTENANT }]);
  });

  it('un destinataire de campagne n’est pas noté une seconde fois, mais sa joignabilité est apprise', async () => {
    const m = monde(1);
    await traiterRapportRcs(m.deps, 't1', rapport());
    expect(m.notes).toEqual([]);
    expect(m.replis).toEqual([]);
    expect(m.cache.map((c) => c.reachable)).toEqual([false]);
  });

  it('une livraison rend le numéro joignable, et ne note rien', async () => {
    const m = monde(0);
    await traiterRapportRcs(m.deps, 't1', rapport({ status: 'delivered', echecDefinitif: false, detail: null }));
    expect(m.cache).toEqual([{ agentId: 'agent-1', e164: '+33612345678', reachable: true, at: MAINTENANT }]);
    expect(m.notes).toEqual([]);
    expect(m.journal).toContain('delivre:33612345678:sms-1');
  });

  it('un statut lu ou envoyé ne touche pas au cache', async () => {
    const m = monde(0);
    await traiterRapportRcs(m.deps, 't1', rapport({ status: 'read', echecDefinitif: false, detail: null }));
    await traiterRapportRcs(m.deps, 't1', rapport({ messageId: 'sms-2', status: 'sent', echecDefinitif: false, detail: null }));
    // Ancre positive : les deux rapports ont bien été traités.
    expect(m.journal).toEqual(['maj:sms-1:read', 'bloc:sms-1:read', 'maj:sms-2:sent']);
    expect(m.cache).toEqual([]);
  });

  it('🔴 une panne du journal ou du cache ne fait pas échouer le rapport, et la sortie du bloc s’allume quand même', async () => {
    const m = monde(0);
    m.deps.echecs = {
      noter: async () => { throw new Error('base indisponible'); },
      noterSansMessage: async () => { throw new Error('base indisponible'); },
    };
    m.deps.joignabilite = { put: async () => { throw new Error('base indisponible'); } };
    await expect(traiterRapportRcs(m.deps, 't1', rapport())).resolves.toBeUndefined();
    expect(m.journal).toContain('injoignable:33612345678:sms-1');
  });

  it('un statut inconnu n’écrit rien, et ne masque pas le rapport suivant', async () => {
    const m = monde(0);
    await traiterRapportRcs(m.deps, 't1', rapport({ status: null, echecDefinitif: false }));
    await traiterRapportRcs(m.deps, 't1', rapport({ messageId: 'sms-3' }));
    expect(m.journal).toEqual(['maj:sms-3:failed', 'bloc:sms-3:failed', 'injoignable:33612345678:sms-3']);
    expect(m.notes.map((n) => n.messageId)).toEqual(['sms-3']);
  });
});
