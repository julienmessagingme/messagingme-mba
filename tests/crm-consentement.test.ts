import { describe, it, expect } from 'vitest';
import { estDemandeArret, SOURCE_STOP_WHATSAPP } from '../src/crm/consentement';
import { processInbound, type InboxStore, type InboundMessage } from '../src/webhooks/inbound';

/**
 * L'OPT-OUT PAR MOT-CLÉ, SUR LES DEUX CANAUX.
 *
 * 🔴 CE QUE ÇA RÉPARE, ET C'EST DE LA CONFORMITÉ. Jusqu'au 2026-08-29, le prédicat vivait dans le callback
 * RCS et n'y servait qu'au RCS. Un contact qui écrivait STOP en RCS était désabonné ; le même contact
 * écrivant STOP en WhatsApp, le canal principal du produit, restait `opted_in` et recevait la campagne
 * suivante. L'asymétrie ne venait d'aucune décision : elle venait de l'endroit où la fonction était écrite.
 *
 * Un contournement existait (câbler soi-même une automation à mot-clé vers le bloc « Action »), mais le
 * respect d'un refus ne peut pas dépendre de ce que chaque client aura pensé à configurer.
 */

const PNID = 'PN1';

function payload(messages: Array<Record<string, unknown>>): unknown {
  return {
    entry: [{
      changes: [{
        field: 'messages',
        value: {
          metadata: { phone_number_id: PNID },
          contacts: [{ wa_id: '33600000001', profile: { name: 'Julien' } }],
          messages,
        },
      }],
    }],
  };
}

const texte = (body: string, from = '33600000001'): Record<string, unknown> =>
  ({ id: `wamid.${body}.${from}`, from, type: 'text', text: { body } });

/** Harnais : capture l'ordre des gestes, qui est le vrai sujet de ce lot. */
function harnais(over: { contactExiste?: boolean } = {}) {
  const gestes: string[] = [];
  const optOuts: Array<{ tenant: string; waId: string }> = [];
  const messagesDuStop: string[] = [];
  const store: InboxStore = {
    phoneNumberTenant: async () => 't1',
    recordInbound: async () => { gestes.push('inbox'); },
  };
  const upsert = async (): Promise<'created'> => { gestes.push('upsert'); return 'created'; };
  const optOut = async (tenant: string, waId: string, messageId: string): Promise<string | null> => {
    gestes.push('optout');
    optOuts.push({ tenant, waId });
    messagesDuStop.push(messageId);
    return over.contactExiste === false ? null : 'c1';
  };
  return { gestes, optOuts, messagesDuStop, store, upsert, optOut };
}

describe('le prédicat de demande d’arrêt', () => {
  it('reconnaît un STOP en tête de message, et PAS un stop au milieu d’une phrase', () => {
    for (const t of ['STOP', 'stop', ' Stop ', 'stop svp', 'désabonner', 'desabonner', 'unsubscribe', 'arrêt']) {
      expect(estDemandeArret(t), t).toBe(true);
    }
    for (const t of ['je ne peux pas stopper la', 'non stop merci ?', 'un arrêt de bus', null, '']) {
      expect(estDemandeArret(t), String(t)).toBe(false);
    }
  });

  it('🔴 ancré en DÉBUT de message : un faux positif désabonne quelqu’un qui ne l’a pas demandé', () => {
    // Et personne ne s'en aperçoit : la personne cesse simplement de recevoir. C'est pour ça que la forme
    // large (« stop » n'importe où) est refusée, malgré le cas « je voudrais me désabonner » qu'elle raterait.
    expect(estDemandeArret('merci, je vous rappelle si je veux stopper')).toBe(false);
    expect(estDemandeArret('Stop, plus de messages')).toBe(true);
  });
});

describe('WhatsApp entrant : STOP désabonne, comme en RCS', () => {
  it('🔴 un message « STOP » écrit le refus, avec sa source', async () => {
    const h = harnais();
    await processInbound(payload([texte('STOP')]), h.store, { upsertContact: h.upsert, optOut: h.optOut });
    expect(h.optOuts).toEqual([{ tenant: 't1', waId: '33600000001' }]);
    // La source distingue ce refus de ceux posés à la main : c'est ce qui permet de dire D'OÙ il vient.
    expect(SOURCE_STOP_WHATSAPP).toBe('whatsapp_stop');
  });

  it('🔴 le refus reçoit le wamid du STOP : c’est la clé qui rend son signal stable si Meta le redélivre', async () => {
    // Sans lui, l'`em_event_id` du désabonnement est tiré au hasard : un STOP redélivré (ou un job de webhook
    // rejoué) produit un second événement que l'outil du client ne peut pas dédupliquer (spec § 8).
    const h = harnais();
    await processInbound(payload([texte('STOP')]), h.store, { upsertContact: h.upsert, optOut: h.optOut });
    expect(h.messagesDuStop).toEqual(['wamid.STOP.33600000001']);
  });

  it('🔴 L’ORDRE : l’opt-out passe APRÈS l’upsert, sinon le cas qui compte le plus est perdu', async () => {
    // `setOptInByWaId` est merge-only : elle n'écrit que sur une fiche EXISTANTE. Un contact inconnu dont le
    // TOUT PREMIER message est STOP n'a pas encore de fiche. Écrire l'opt-out avant l'upsert ne ferait donc
    // rien, et la fiche serait créée juste après, `opted_in`. C'est exactement le cas d'un numéro acheté qui
    // reçoit une campagne et répond STOP.
    const h = harnais();
    await processInbound(payload([texte('STOP')]), h.store, { upsertContact: h.upsert, optOut: h.optOut });
    expect(h.gestes).toEqual(['upsert', 'optout', 'inbox']);
  });

  it('🔴 mais AVANT l’inbox, donc avant tout ce qui envoie', async () => {
    // Le handler appelle `processInbound` avant l'avance de scénario et avant les automations : le refus est
    // enregistré avant qu'une seule réponse ne parte.
    const h = harnais();
    await processInbound(payload([texte('stop')]), h.store, { upsertContact: h.upsert, optOut: h.optOut });
    expect(h.gestes.indexOf('optout')).toBeLessThan(h.gestes.indexOf('inbox'));
  });

  it('un message ordinaire ne désabonne personne', async () => {
    const h = harnais();
    await processInbound(payload([texte('bonjour, je voudrais un devis')]), h.store, { upsertContact: h.upsert, optOut: h.optOut });
    expect(h.optOuts).toEqual([]);
    expect(h.gestes).toEqual(['upsert', 'inbox']);
  });

  it('🔴 un BOUTON libellé « Stopper… » ne désabonne pas : seuls les messages TEXTE comptent', async () => {
    // Un bouton porte son libellé dans `body`. Un bouton « Stopper la simulation » désabonnerait quelqu'un
    // qui voulait seulement sortir d'un parcours. Même règle qu'en RCS (`mo.kind === 'text'`).
    const h = harnais();
    await processInbound(payload([
      { id: 'wamid.b1', from: '33600000001', type: 'button', button: { text: 'Stopper la simulation', payload: 'stop_sim' } },
    ]), h.store, { upsertContact: h.upsert, optOut: h.optOut });
    expect(h.optOuts).toEqual([]);
  });

  it('un STOP d’un numéro SANS fiche est journalisé, et n’interrompt rien', async () => {
    const h = harnais({ contactExiste: false });
    await processInbound(payload([texte('STOP')]), h.store, { upsertContact: h.upsert, optOut: h.optOut });
    expect(h.gestes).toEqual(['upsert', 'optout', 'inbox']); // l'inbox enregistre quand même le message
  });

  it('🔴 un opt-out qui ÉCHOUE n’emporte pas l’enregistrement du message', async () => {
    // Même doctrine que les autres étapes du webhook : isolée, jamais fatale. Un throw ici rejouerait tout le
    // webhook, donc aussi les statuts de livraison déjà traités.
    const gestes: string[] = [];
    const store: InboxStore = {
      phoneNumberTenant: async () => 't1',
      recordInbound: async () => { gestes.push('inbox'); },
    };
    await expect(processInbound(
      payload([texte('STOP')]), store,
      { upsertContact: async () => 'created', optOut: async () => { throw new Error('pooler injoignable'); } },
    )).resolves.toBeUndefined();
    expect(gestes).toEqual(['inbox']);
  });

  it('sans dépendance d’opt-out câblée, le comportement d’avant est inchangé', async () => {
    // Les câblages de test et le bac à sable ne la fournissent pas : ils ne doivent pas changer de sens.
    const h = harnais();
    await processInbound(payload([texte('STOP')]), h.store, { upsertContact: h.upsert });
    expect(h.optOuts).toEqual([]);
    expect(h.gestes).toEqual(['upsert', 'inbox']);
  });

  it('plusieurs messages dans le même webhook : seul celui qui dit STOP désabonne', async () => {
    const h = harnais();
    await processInbound(payload([
      texte('bonjour', '33600000001'),
      texte('STOP', '33600000002'),
    ]), h.store, { upsertContact: h.upsert, optOut: h.optOut });
    expect(h.optOuts).toEqual([{ tenant: 't1', waId: '33600000002' }]);
  });
});

describe('le message entrant reste intact', () => {
  it('un STOP est bien enregistré en inbox : l’opérateur doit VOIR le refus', async () => {
    const vus: InboundMessage[] = [];
    const store: InboxStore = {
      phoneNumberTenant: async () => 't1',
      recordInbound: async (_t, m) => { vus.push(m); },
    };
    await processInbound(payload([texte('STOP')]), store, { optOut: async () => 'c1' });
    expect(vus).toHaveLength(1);
    expect(vus[0]!.body).toBe('STOP');
  });
});
