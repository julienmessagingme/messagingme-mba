import { describe, it, expect } from 'vitest';
import { handleWebhookJob } from '../src/webhooks/handler';
import { processTriggers } from '../src/webhooks/triggers';
import type { AutomationEvent } from '../src/automation/match';

/**
 * Câblage webhook -> automations. Ce que ces tests protègent, et qui n'est visible nulle part ailleurs :
 *
 *  1. INVARIANT 5 : une automation qui plante ne doit JAMAIS faire échouer le job webhook, partagé avec les
 *     statuts de livraison et l'inbox. Un throw ici rejouerait/DLQ tout le webhook.
 *  2. Le signal « 1er message d'un contact inconnu » vient de l'upsert d'inbound (`created`) et de nulle part
 *     ailleurs : c'est la SEULE source du déclencheur `new_contact`.
 *  3. Un `standby` (l'agent Meta tient le fil) ne déclenche rien : répondre lui reprendrait le contrôle.
 */

const inboundPayload = (waId: string, body: string, field = 'messages') => ({
  entry: [{ changes: [{ field, value: { metadata: { phone_number_id: 'pn1' }, messages: [{ id: `wamid.${waId}.${body}`, from: waId, type: 'text', text: { body } }] } }] }],
});

// `insertEvent` renvoie un booléen (true = événement neuf, false = doublon déjà vu).
const eventStore = { insertEvent: async () => true };

describe('processTriggers', () => {
  it('message normal -> événement transmis avec le corps et le signal nouveau contact', async () => {
    const seen: AutomationEvent[] = [];
    await processTriggers(inboundPayload('33611', 'je veux un rdv'), {
      phoneNumberTenant: async () => 't1',
      isNewContact: async () => true,
      run: async (_t, ev) => { seen.push(ev); return 1; },
    });
    expect(seen).toEqual([{ kind: 'message', waId: '33611', body: 'je veux un rdv', isNewContact: true }]);
  });

  it('numéro inconnu (aucun tenant) -> aucun déclenchement', async () => {
    let ran = 0;
    await processTriggers(inboundPayload('33611', 'rdv'), {
      phoneNumberTenant: async () => null,
      isNewContact: async () => false,
      run: async () => { ran += 1; return 0; },
    });
    expect(ran).toBe(0);
  });

  it('message STANDBY (le MBA tient le fil) -> aucun déclenchement', async () => {
    let ran = 0;
    await processTriggers(inboundPayload('33611', 'rdv', 'standby'), {
      phoneNumberTenant: async () => 't1',
      isNewContact: async () => false,
      run: async () => { ran += 1; return 0; },
    });
    expect(ran).toBe(0);
  });

  it('une erreur sur un contact n’empêche pas les autres du même webhook', async () => {
    const payload = {
      entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'pn1' }, messages: [
        { id: 'wamid.1', from: 'KO', type: 'text', text: { body: 'rdv' } },
        { id: 'wamid.2', from: 'OK', type: 'text', text: { body: 'rdv' } },
      ] } }] }],
    };
    const ok: string[] = [];
    await processTriggers(payload, {
      phoneNumberTenant: async () => 't1',
      isNewContact: async () => false,
      run: async (_t, ev) => { if (ev.waId === 'KO') throw new Error('base indisponible'); ok.push(ev.waId); return 1; },
    });
    expect(ok).toEqual(['OK']);
  });
});

describe('handleWebhookJob : intégration des automations', () => {
  const inbox = {
    phoneNumberTenant: async () => 't1',
    recordInbound: async () => {},
  };

  it('le signal « nouveau contact » vient de l’upsert (created) et est transmis au déclencheur', async () => {
    const seen: AutomationEvent[] = [];
    await handleWebhookJob(
      inboundPayload('33611', 'bonjour'), eventStore, undefined, inbox, undefined, undefined,
      async () => 'created', // l'upsert signale une fiche NEUVE
      undefined,
      { phoneNumberTenant: async () => 't1', run: async (_t, ev) => { seen.push(ev); return 1; } },
    );
    expect(seen[0]).toMatchObject({ waId: '33611', isNewContact: true });
  });

  it('contact déjà connu (updated) -> isNewContact faux', async () => {
    const seen: AutomationEvent[] = [];
    await handleWebhookJob(
      inboundPayload('33611', 'bonjour'), eventStore, undefined, inbox, undefined, undefined,
      async () => 'updated',
      undefined,
      { phoneNumberTenant: async () => 't1', run: async (_t, ev) => { seen.push(ev); return 1; } },
    );
    expect(seen[0]).toMatchObject({ isNewContact: false });
  });

  it('DEUX messages du même nouveau contact dans un seul webhook -> un seul est « nouveau »', async () => {
    // Le signal se consomme : sinon le scénario d'accueil partirait deux fois pour un même contact.
    const payload = {
      entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'pn1' }, messages: [
        { id: 'wamid.1', from: '33611', type: 'text', text: { body: 'bonjour' } },
        { id: 'wamid.2', from: '33611', type: 'text', text: { body: 'il y a quelqu’un ?' } },
      ] } }] }],
    };
    const flags: boolean[] = [];
    await handleWebhookJob(
      payload, eventStore, undefined, inbox, undefined, undefined,
      async () => 'created',
      undefined,
      { phoneNumberTenant: async () => 't1', run: async (_t, ev) => { flags.push(ev.kind === 'message' && ev.isNewContact); return 1; } },
    );
    expect(flags).toEqual([true, false]);
  });

  it('une automation qui PLANTE ne fait pas échouer le job webhook (invariant 5)', async () => {
    let inboundRecorded = 0;
    await expect(handleWebhookJob(
      inboundPayload('33611', 'rdv'), eventStore, undefined,
      { phoneNumberTenant: async () => 't1', recordInbound: async () => { inboundRecorded += 1; } },
      undefined, undefined, async () => 'updated', undefined,
      { phoneNumberTenant: async () => { throw new Error('base indisponible'); }, run: async () => 0 },
    )).resolves.toBeUndefined();
    expect(inboundRecorded).toBe(1); // l'inbox a bien été enregistrée malgré l'automation en échec
  });

  it('aucune dep automation -> comportement inchangé (rétro-compatibilité)', async () => {
    await expect(handleWebhookJob(
      inboundPayload('33611', 'rdv'), eventStore, undefined, inbox, undefined, undefined, async () => 'updated',
    )).resolves.toBeUndefined();
  });
});
