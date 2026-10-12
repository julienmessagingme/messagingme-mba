import { afterEach, describe, expect, it, vi } from 'vitest';
import { traiterMessageEntrantRcs, type DepsMessageEntrantRcs } from '../src/rcs/message-entrant';
import type { RcsMo } from '../src/rcs/callback';
import type { InboundMessage } from '../src/webhooks/inbound';
import type { AutomationEventJob } from '../src/automation/event-job';
import type { Signal } from '../src/signaux/types';

const message = (over: Partial<RcsMo> = {}): RcsMo => ({
  messageId: 'mo-1', channelId: 'agent-1', from: '33612345678', originMessageId: null,
  kind: 'text', text: 'DEVIS', postbackData: null, latitude: null, longitude: null,
  fileUrl: null, filename: null, ...over,
});

function monde() {
  const ordre: string[] = [];
  const inbox: Array<{ tenantId: string; message: InboundMessage; channel: 'rcs' }> = [];
  const jobs: Array<{ name: string; job: AutomationEventJob; groupId: string | undefined }> = [];
  const signaux: Array<{ tenantId: string; signal: Signal }> = [];
  const avances: Array<{ tenantId: string; from: string; messageId: string; postbackData: string | null; channel: 'rcs' }> = [];
  const deps: DepsMessageEntrantRcs = {
    optout: { markOptedOut: async () => { ordre.push('optout'); return true; } },
    inbox: { recordInbound: async (tenantId, m, channel) => { ordre.push('inbox'); inbox.push({ tenantId, message: m, channel }); } },
    contacts: { upsertFromInbound: async () => { ordre.push('contact'); return 'created'; } },
    automations: { enqueue: async (name, data, opts) => {
      ordre.push('automation');
      jobs.push({ name, job: data as AutomationEventJob, groupId: opts?.groupId });
    } },
    signaux: { emettreSignal: async (tenantId, signal) => { ordre.push(`signal:${signal.nom}`); signaux.push({ tenantId, signal }); } },
    parcours: { advance: async (tenantId, from, messageId, postbackData, channel) => {
      ordre.push('parcours');
      avances.push({ tenantId, from, messageId, postbackData, channel });
    } },
  };
  return { deps, ordre, inbox, jobs, signaux, avances };
}

afterEach(() => vi.restoreAllMocks());

describe('traiterMessageEntrantRcs', () => {
  it('inscrit STOP avant toute autre étape, puis annonce la réponse après la fiche et son automation', async () => {
    const m = monde();
    await traiterMessageEntrantRcs(m.deps, 'tenant-1', message({ text: 'STOP' }));

    expect(m.ordre).toEqual(['optout', 'signal:em_opted_out', 'inbox', 'contact', 'automation', 'signal:em_replied', 'parcours']);
    expect(m.signaux.map(({ tenantId, signal }) => ({ tenantId, nom: signal.nom, id: signal.id }))).toEqual([
      { tenantId: 'tenant-1', nom: 'em_opted_out', id: expect.any(String) },
      { tenantId: 'tenant-1', nom: 'em_replied', id: expect.any(String) },
    ]);
    expect(m.inbox).toEqual([{ tenantId: 'tenant-1', channel: 'rcs', message: {
      phoneNumberId: '', waId: '33612345678', messageId: 'mo-1', type: 'text', body: 'STOP',
      buttonPayload: null, profileName: null, field: 'messages',
    } }]);
    expect(m.jobs).toEqual([{ name: 'automation-event', groupId: 'tenant-1', job: {
      tenantId: 'tenant-1', event: { kind: 'message', waId: '33612345678', body: 'STOP', isNewContact: true, channel: 'rcs' },
    } }]);
    expect(m.avances).toEqual([{ tenantId: 'tenant-1', from: '33612345678', messageId: 'mo-1', postbackData: null, channel: 'rcs' }]);
  });

  it('n’annonce pas un second désabonnement si le STOP avait déjà été enregistré', async () => {
    const m = monde();
    m.deps.optout.markOptedOut = async () => false;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await traiterMessageEntrantRcs(m.deps, 'tenant-1', message({ text: 'STOP' }));
    expect(m.signaux.map(({ signal }) => signal.nom)).toEqual(['em_replied']);
    expect(m.ordre).toEqual(['inbox', 'contact', 'automation', 'signal:em_replied', 'parcours']);
  });

  it('transmet le libellé et la charge utile du bouton au bon canal', async () => {
    const m = monde();
    await traiterMessageEntrantRcs(m.deps, 'tenant-1', message({ kind: 'suggestion', text: 'Choisir', postbackData: 'btn:2' }));
    expect(m.inbox[0]?.message).toMatchObject({ type: 'button', body: 'Choisir', buttonPayload: 'btn:2' });
    expect(m.jobs[0]?.job.event).toMatchObject({ body: null, channel: 'rcs' });
    expect(m.signaux[0]?.signal).toMatchObject({ nom: 'em_replied', bouton: 'Choisir', canal: 'rcs' });
    expect(m.avances[0]).toMatchObject({ postbackData: 'btn:2', channel: 'rcs' });
  });

  it('conserve un aperçu lisible pour une position et un fichier', async () => {
    const m = monde();
    await traiterMessageEntrantRcs(m.deps, 'tenant-1', message({ kind: 'location', text: null, latitude: 48.85, longitude: 2.35 }));
    await traiterMessageEntrantRcs(m.deps, 'tenant-1', message({ messageId: 'mo-2', kind: 'file', text: null, fileUrl: 'https://example.com/photo.jpg', filename: 'photo.jpg' }));
    expect(m.inbox.map(({ message: entrant }) => entrant.body)).toEqual([
      expect.stringContaining('48.85'), expect.stringContaining('photo.jpg'),
    ]);
  });

  it('continue jusqu’au signal si la fiche ou le parcours échoue', async () => {
    const m = monde();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    m.deps.contacts.upsertFromInbound = async () => { throw new Error('contacts indisponibles'); };
    m.deps.parcours.advance = async () => { throw new Error('scénario indisponible'); };
    await expect(traiterMessageEntrantRcs(m.deps, 'tenant-1', message())).resolves.toBeUndefined();
    expect(m.ordre).toEqual(['inbox', 'signal:em_replied']);
    expect(m.jobs).toEqual([]);
    expect(m.signaux).toHaveLength(1);
    expect(console.error).toHaveBeenCalledWith('automations RCS ignorées:', 'contacts indisponibles');
    expect(console.error).toHaveBeenCalledWith('avance de scénario sur réponse RCS ignorée:', 'scénario indisponible');
  });

  it('ne poursuit pas après une erreur du STOP ou de l’Inbox, qui doit être rejouée par smsmode', async () => {
    const m = monde();
    m.deps.optout.markOptedOut = async () => { throw new Error('optout indisponible'); };
    await expect(traiterMessageEntrantRcs(m.deps, 'tenant-1', message({ text: 'STOP' }))).rejects.toThrow('optout indisponible');
    expect(m.inbox).toEqual([]);

    m.deps.inbox.recordInbound = async () => { throw new Error('inbox indisponible'); };
    await expect(traiterMessageEntrantRcs(m.deps, 'tenant-1', message())).rejects.toThrow('inbox indisponible');
    expect(m.jobs).toEqual([]);
    expect(m.signaux).toEqual([]);
  });
});
