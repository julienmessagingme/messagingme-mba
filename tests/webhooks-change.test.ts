import { describe, it, expect } from 'vitest';
import { changesDuPayload, valeurEffective } from '../src/webhooks/change';
import { extractInbound } from '../src/webhooks/inbound';
import { parseWebhook, nAQueDesAccuses, cleDeContact } from '../src/webhooks/parse';
import { processHandovers } from '../src/webhooks/handover';

/**
 * La lecture d'un `change` de webhook Meta, quand le Meta Business Agent tient le fil.
 *
 * 🔴 CE FICHIER GARDE UNE PANNE MUETTE DE DEUX JOURS, mesurée le 2026-09-10 : pendant que l'agent de Meta
 * répondait à tout le monde sur notre numéro, nous n'avons enregistré AUCUN message entrant et AUCUN statut
 * de livraison. Les webhooks arrivaient, les jobs se terminaient « avec succès », et rien n'était écrit.
 *
 * ⚠️ LES PAYLOADS CI-DESSOUS NE SONT PAS INVENTÉS. Ils sont recopiés de la file de travail de production,
 * horodatés 2026-09-10T13:34Z, avec les vrais messages de Julien. Le code d'avant avait été écrit sur une
 * forme DEVINÉE, et c'est précisément ce qui a coûté les deux jours : un test bâti sur la même supposition
 * aurait confirmé le défaut au lieu de le trouver.
 */

/** Entrant réel, capté pendant que le MBA tenait le fil. */
const STANDBY_ENTRANT = {
  entry: [{
    id: '1695646181671929',
    changes: [{
      field: 'standby',
      value: {
        standby: {
          contacts: [{ wa_id: '33633921577', profile: { name: 'Julien' }, user_id: 'FR.941869978595096' }],
          messages: [{
            id: 'wamid.HBgLMzM2MzM5MjE1NzcVAgASGCBBQzk1NkQ0OTI1QTY4MDM0Q0Y1NThEMUU5MkU4NzQ5RgA=',
            from: '33633921577',
            text: { body: 'Je veux parler a un conseiller' },
            type: 'text',
            timestamp: '1789047240',
          }],
        },
        metadata: { phone_number_id: '1234840649713976', display_phone_number: '33525680250' },
        messaging_product: 'whatsapp',
      },
    }],
  }],
  object: 'whatsapp_business_account',
};

/** Statut réel d'un message que l'agent de Meta a envoyé en notre nom. */
const STANDBY_STATUT = {
  entry: [{
    id: '1695646181671929',
    changes: [{
      field: 'standby',
      value: {
        standby: {
          contacts: [{ wa_id: '33633921577', user_id: 'FR.941869978595096' }],
          statuses: [{
            id: 'wamid.HBgLMzM2MzM5MjE1NzcVAgARGBJEMEIxRkREMDZEQzc5RDRGRDAA',
            status: 'delivered',
            timestamp: '1789047259',
            recipient_id: '33633921577',
            biz_opaque_callback_data: '{"originator":"bizai","channel":"ent"}',
          }],
        },
        metadata: { phone_number_id: '1234840649713976', display_phone_number: '33525680250' },
        messaging_product: 'whatsapp',
      },
    }],
  }],
  object: 'whatsapp_business_account',
};

/** Écho réel : ce que l'agent de Meta a répondu en notre nom. Le contenu vit sous `message`. */
const STANDBY_ECHO = {
  entry: [{
    id: '1695646181671929',
    changes: [{
      field: 'standby',
      value: {
        standby: {
          message_echoes: [{
            id: 'wamid.HBgLMzM2MzM5MjE1NzcVAgARGBJEMEIxRkREMDZEQzc5RDRGRDAA',
            message: {
              to: '33633921577',
              text: { body: "Entendu. N'hésitez pas si vous avez d'autres questions en attendant qu'un conseiller prenne le relais. Comment puis-je vous aider davantage ?\n", preview_url: 'true' },
              type: 'text',
              recipient: 'FR.941869978595096',
              recipient_type: 'individual',
              biz_opaque_callback_data: '{"originator":"bizai","channel":"ent"}',
            },
            timestamp: '1789047259',
          }],
        },
        metadata: { phone_number_id: '1234840649713976', display_phone_number: '33525680250' },
        messaging_product: 'whatsapp',
      },
    }],
  }],
  object: 'whatsapp_business_account',
};

/** Le même entrant, forme NORMALE (le MBA ne tient pas le fil). Le correctif ne doit rien y changer. */
const NORMAL_ENTRANT = {
  entry: [{
    id: '1695646181671929',
    changes: [{
      field: 'messages',
      value: {
        contacts: [{ wa_id: '33633921577', profile: { name: 'Julien' } }],
        messages: [{ id: 'wamid.NORMAL', from: '33633921577', text: { body: 'Bonjour' }, type: 'text' }],
        metadata: { phone_number_id: '1234840649713976', display_phone_number: '33525680250' },
        messaging_product: 'whatsapp',
      },
    }],
  }],
  object: 'whatsapp_business_account',
};

describe('valeurEffective', () => {
  it('🔴 remonte messages et contacts depuis value.standby', () => {
    const v = valeurEffective(STANDBY_ENTRANT.entry[0]!.changes[0]!.value);
    expect(Array.isArray(v['messages'])).toBe(true);
    expect((v['messages'] as unknown[]).length).toBe(1);
    expect(Array.isArray(v['contacts'])).toBe(true);
  });

  it('🔴 GARDE metadata, que Meta laisse au premier niveau en standby', () => {
    // Sans metadata, `phone_number_id` est absent et TOUS les extracteurs abandonnent la ligne : le message
    // serait perdu exactement comme avant, mais pour une autre raison. L'ordre du spread porte ce point.
    const v = valeurEffective(STANDBY_ENTRANT.entry[0]!.changes[0]!.value);
    expect((v['metadata'] as Record<string, unknown>)['phone_number_id']).toBe('1234840649713976');
  });

  it('ne change RIEN à un payload normal', () => {
    const brut = NORMAL_ENTRANT.entry[0]!.changes[0]!.value;
    expect(valeurEffective(brut)).toEqual(brut);
  });

  it('ne lève sur aucune saleté', () => {
    for (const saleté of [null, undefined, 42, 'texte', [], { standby: 'pas un objet' }]) {
      expect(() => valeurEffective(saleté)).not.toThrow();
    }
  });
});

describe('changesDuPayload', () => {
  it('rend le field TEL QUEL, sans le traduire', () => {
    // 🔴 Les consommateurs qui doivent se TAIRE quand le MBA tient le fil (déclencheurs d'automation, avance
    // de scénario) testent `field !== 'messages'`. Normaliser `standby` en `messages` ici les ferait répondre
    // par-dessus l'agent de Meta, donc reprendre le fil sans que personne l'ait demandé.
    expect(changesDuPayload(STANDBY_ENTRANT)[0]!.field).toBe('standby');
    expect(changesDuPayload(NORMAL_ENTRANT)[0]!.field).toBe('messages');
  });

  it('rend une liste vide sur un payload vide', () => {
    expect(changesDuPayload({})).toEqual([]);
    expect(changesDuPayload(null)).toEqual([]);
  });
});

describe('les extracteurs voient enfin le standby', () => {
  it('🔴 un entrant en standby est extrait, avec son texte et son auteur', () => {
    const msgs = extractInbound(STANDBY_ENTRANT);
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.body).toBe('Je veux parler a un conseiller');
    expect(msgs[0]!.waId).toBe('33633921577');
    expect(msgs[0]!.profileName).toBe('Julien');
    expect(msgs[0]!.phoneNumberId).toBe('1234840649713976');
  });

  it('🔴 il reste MARQUÉ standby : enregistrer n’est pas répondre', () => {
    // C'est ce champ qui empêche l'avance de scénario et les déclencheurs de réagir. Le perdre en corrigeant
    // l'extraction ferait répondre nos scénarios PAR-DESSUS l'agent de Meta.
    expect(extractInbound(STANDBY_ENTRANT)[0]!.field).toBe('standby');
  });

  it('🔴 un statut de livraison en standby produit bien un événement', () => {
    // 136 statuts en base, aucun depuis que le MBA a pris les fils : la livraison des messages que Meta envoie
    // en notre nom n'était plus mesurée du tout.
    const evs = parseWebhook(STANDBY_STATUT).filter((e) => e.source === 'statuses');
    expect(evs.length).toBe(1);
    expect((evs[0]!.data as { status?: string }).status).toBe('delivered');
    expect(evs[0]!.phoneNumberId).toBe('1234840649713976');
  });

  it('🔴 un entrant en standby produit un événement « messages », pas rien', () => {
    // C'est cet événement qui alimente l'Inbox, l'analyse et la facturation. Sans lui, tout l'aval est aveugle.
    const evs = parseWebhook(STANDBY_ENTRANT).filter((e) => e.source === 'messages');
    expect(evs.length).toBe(1);
    expect(evs[0]!.phoneNumberId).toBe('1234840649713976');
  });

  it('🔴 un entrant en standby n’est PAS « que des accusés »', () => {
    // `nAQueDesAccuses` décide si le payload mérite un traitement complet. En rendant `true` sur un standby
    // porteur d'un vrai message, elle le faisait ranger avec les accusés de lecture.
    expect(nAQueDesAccuses(STANDBY_ENTRANT)).toBe(false);
    expect(nAQueDesAccuses(STANDBY_STATUT)).toBe(true);
  });

  it('🔴 un standby a une clé de contact, il n’est plus « inattribuable »', () => {
    // Elle sert à sérialiser les webhooks d'un même contact (un seul job en vol par groupe). Absente, deux
    // messages du même contact se traitent en parallèle et peuvent s'inverser dans l'Inbox.
    // ⚠️ La clé est `<phone_number_id>:<wa_id>`, pas le seul numéro : le numéro business en fait partie,
    // c'est lui qui cloisonne les espaces sans rien lire en base.
    expect(cleDeContact(STANDBY_ENTRANT)).toBe('1234840649713976:33633921577');
    expect(cleDeContact(NORMAL_ENTRANT)).toBe('1234840649713976:33633921577');
  });

  it('🔴 l’écho d’un message de l’agent Meta est lu, corps ET destinataire', async () => {
    // Deuxième défaut du même module : le contenu d'un écho vit sous `message`, pas à plat. `echo.text.body`
    // rendait `undefined`, donc la garde `if (waId && body)` ne passait jamais et l'agent de Meta restait
    // invisible dans l'Inbox, même une fois le standby remonté.
    const vus: Array<{ waId: string; body: string }> = [];
    await processHandovers(STANDBY_ECHO, {
      phoneNumberTenant: async () => 'tenant-1',
      setControlOwner: async () => true,
      recordAgentMessage: async (_t, waId, body) => { vus.push({ waId, body }); },
    });
    expect(vus.length).toBe(1);
    expect(vus[0]!.waId).toBe('33633921577');
    expect(vus[0]!.body).toMatch(/conseiller prenne le relais/);
  });

  it('🔴 le destinataire d’un écho est `to`, JAMAIS `recipient`', () => {
    // `message.recipient` porte le BSUID (`FR.9418...`), pas le numéro. Les intervertir rattacherait le
    // message de l'agent à un contact qui n'existe pas, et l'Inbox afficherait un fil fantôme.
    const echo = STANDBY_ECHO.entry[0]!.changes[0]!.value.standby.message_echoes[0]!;
    expect(echo.message.to).toBe('33633921577');
    expect(echo.message.recipient).toMatch(/^FR\./);
  });

  it('un entrant normal continue d’être extrait à l’identique', () => {
    const msgs = extractInbound(NORMAL_ENTRANT);
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.body).toBe('Bonjour');
    expect(msgs[0]!.field).toBe('messages');
  });
});
