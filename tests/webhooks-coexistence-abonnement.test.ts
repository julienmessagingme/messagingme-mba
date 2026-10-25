import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleWebhookJob, type WebhookJobDeps } from '../src/webhooks/handler';
import { cleDeContact, nAQueDesAccuses } from '../src/webhooks/parse';
import type { InboundMessage } from '../src/webhooks/inbound';
import type { StoredEvent } from '../src/webhooks/store';
import {
  aucunEspacePlein, agentEteintALArrivee, aucunEchecLibre, aucuneArriveePub, aucunRoutagePub, aucunSignalAccuse, aucunSignalReponse, aucunTarif,
} from './webhook-fixtures';
import { aucunStop } from './consentement';

/**
 * LES DEUX CHAMPS DE LA COEXISTENCE, ABONNÉS AVANT D'ÊTRE LUS (plan `docs/superpowers/plans/2026-10-24-coexistence.md`,
 * tâche 2). Julien abonne l'app de Meta à `smb_message_echoes` (ce que le marchand tape dans son application WhatsApp
 * Business) et à `account_update` (dont les coupures) dès le lot 1 en production ; leurs lecteurs n'arrivent qu'au lot 2.
 * D'ici là, ces payloads traversent la réception SANS rien produire : ni entrant (un écho n'est pas un message du
 * client), ni message de l'agent de Meta, ni bascule du fil, ni erreur qui emporterait le job.
 *
 * Les payloads sont ceux de la documentation de Meta, relevés le 2026-10-25 :
 *  - https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/reference/smb_message_echoes (texte, retrait,
 *    modification ; l'adresse de l'image modifiée est abrégée) ;
 *  - https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/reference/account_update (`PARTNER_REMOVED` d'une
 *    coexistence coupée pour inactivité, `ACCOUNT_OFFBOARDED`).
 */
const NUMERO_BUSINESS = '106540352242922';
const echo = (contenu: { id: string } & Record<string, unknown>) => ({
  object: 'whatsapp_business_account',
  entry: [{
    id: '102290129340398',
    changes: [{
      value: {
        messaging_product: 'whatsapp',
        metadata: { display_phone_number: '15550783881', phone_number_id: NUMERO_BUSINESS },
        message_echoes: [{ from: '15550783881', to: '16505551234', ...contenu }],
      },
      field: 'smb_message_echoes',
    }],
  }],
});

const ECHO_TEXTE = echo({
  id: 'wamid.HBgLMTY0NjcwNDM1OTUVAgARGBIyNDlBOEI5QUQ4NDc0N0FCNjMA',
  timestamp: '1739321024',
  type: 'text',
  text: { body: 'Here\'s the info you requested! https://www.meta.com/quest/quest-3/' },
});
const ECHO_RETIRE = echo({
  id: 'wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMAA=',
  timestamp: '1749854575',
  type: 'revoke',
  revoke: { original_message_id: 'wamid.HBgLMTQxMjU1NTA4MjkVAgASGBQzQUNCNjk5RDUwNUZGMUZEM0VBRAA=' },
});
const ECHO_MODIFIE = echo({
  id: 'wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQkJERjg0NDEzNDdFODU3MUMxMAA=',
  timestamp: '1749854620',
  type: 'edit',
  edit: {
    original_message_id: 'wamid.HBgLMTQxMjU1NTA4MjkVAgASGBQzQUNCNjk5RDUwNUZGMUZEM0VBRAA=',
    message: {
      context: { id: 'M0' },
      type: 'image',
      image: {
        caption: 'Updated image caption', mime_type: 'image/jpeg',
        sha256: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2', id: '1234567890',
        url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=133',
      },
    },
  },
});
const COUPURE = {
  object: 'whatsapp_business_account',
  entry: [{
    id: '2949482758682047',
    time: 1748477359,
    changes: [{
      value: {
        event: 'PARTNER_REMOVED',
        waba_info: { waba_id: '980198427658004', owner_business_id: '2329417887457253' },
        disconnection_info: { reason: 'PRIMARY_INACTIVITY', initiated_by: 'SYSTEM' },
      },
      field: 'account_update',
    }],
  }],
};
const DESINSCRIT = {
  object: 'whatsapp_business_account',
  entry: [{ id: '102290129340398', time: 1743451903, changes: [{ value: { event: 'ACCOUNT_OFFBOARDED' }, field: 'account_update' }] }],
};

/** La réception de la file des entrants, telle que le worker la compose : chaque geste qui écrirait est noté. */
function reception() {
  const vu = {
    bruts: [] as string[], accuses: [] as string[], entrants: [] as string[], agent: [] as string[], escalades: [] as string[],
    standby: [] as string[], delies: [] as string[][],
  };
  const deps: WebhookJobDeps = {
    store: { insertEvent: async (e: StoredEvent) => { vu.bruts.push(e.dedupKey); return true; } },
    delivery: { updateDeliveryByMessageId: async (id) => { vu.accuses.push(id); return 0; } },
    tarifsMeta: aucunTarif, echecsLibres: aucunEchecLibre, signauxAccuse: aucunSignalAccuse,
    inbox: {
      phoneNumberTenant: async (pn) => (pn === NUMERO_BUSINESS ? 't1' : null),
      recordInbound: async (_t: string, m: InboundMessage) => { vu.entrants.push(m.messageId); return { rouverte: false }; },
    },
    arriveesPub: aucuneArriveePub, routagePub: aucunRoutagePub, signalReponse: aucunSignalReponse, inboundOptOut: aucunStop,
    numerosDelies: async (ids) => { vu.delies.push([...ids]); return new Set(); },
    espacesPleins: aucunEspacePlein,
    detenteur: { entrantEnStandby: async (_t, waId) => { vu.standby.push(waId); } },
    listeALArrivee: agentEteintALArrivee,
    handover: {
      marquerEscalade: async (_t, waId) => { vu.escalades.push(waId); },
      recordAgentMessage: async (_t, waId, body) => { vu.agent.push(`${waId}:${body}`); },
    },
  };
  return { deps, vu };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('smb_message_echoes et account_update, abonnés au lot 1, lus au lot 2', () => {
  it('🔴 un écho de l’application (texte, retrait, modification) : ni entrant, ni message de l’agent de Meta, ni bascule, ni erreur', async () => {
    const erreurs = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const payload of [ECHO_TEXTE, ECHO_RETIRE, ECHO_MODIFIE]) {
      const { deps, vu } = reception();
      await expect(handleWebhookJob(payload, deps)).resolves.toBeUndefined();
      expect([vu.entrants, vu.agent, vu.escalades, vu.standby, vu.accuses]).toEqual([[], [], [], [], []]);
      // Le journal brut le garde (il deviendra le gabarit des lecteurs du lot 2), et l'écart d'un numéro délié le voit.
      expect(vu.bruts).toEqual([`standby:${payload.entry[0]!.changes[0]!.value.message_echoes[0]!.id}`]);
      expect(vu.delies).toEqual([[NUMERO_BUSINESS]]);
    }
    expect(erreurs).not.toHaveBeenCalled();
  });

  it('🔴 un account_update (la coupure d’une coexistence, une désinscription) : rien n’est écrit, rien ne lève', async () => {
    const erreurs = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const payload of [COUPURE, DESINSCRIT]) {
      const { deps, vu } = reception();
      await expect(handleWebhookJob(payload, deps)).resolves.toBeUndefined();
      expect(vu).toEqual({ bruts: [], accuses: [], entrants: [], agent: [], escalades: [], standby: [], delies: [] });
    }
    expect(erreurs).not.toHaveBeenCalled();
  });

  it('le receveur les range dans la file des entrants (pas celle des accusés), sans planter sur leur forme', () => {
    for (const payload of [ECHO_TEXTE, ECHO_RETIRE, ECHO_MODIFIE, COUPURE, DESINSCRIT]) expect(nAQueDesAccuses(payload)).toBe(false);
    // Un écho nomme son contact (le destinataire) : il garde l'ordre des messages de ce contact.
    expect(cleDeContact(ECHO_TEXTE)).toBe(`${NUMERO_BUSINESS}:16505551234`);
    expect(cleDeContact(COUPURE)).toBeUndefined();
  });
});
