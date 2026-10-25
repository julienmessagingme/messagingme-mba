import { describe, expect, it } from 'vitest';
import {
  creerOuvertureConversationInbox,
  type ContexteConversationInbox,
  type DepsOuvertureConversationInbox,
} from '../src/inbox/ouverture';
import type { ConversationMessage, ControlOwner } from '../src/inbox/store.pg';

const MESSAGE: ConversationMessage = {
  id: 'm1',
  direction: 'in',
  type: 'text',
  body: 'Hola',
  buttonPayload: null,
  createdAt: '2026-10-25T10:00:00.000Z',
};

type ConversationsOuverture = DepsOuvertureConversationInbox['conversations'];

/**
 * Même forme que le store PostgreSQL : chaque méthode lit `this`. Une méthode détachée ferait donc échouer ces tests,
 * comme la connexion Google lors de l'incident du 21 octobre.
 */
class ConversationsClasse implements ConversationsOuverture {
  readonly appels: string[] = [];
  contexte: ContexteConversationInbox | null = {
    waId: '33611',
    lastInboundAt: '2026-10-25T09:00:00.000Z',
    windowOpen: true,
    langueContact: 'es',
  };
  owner: ControlOwner = 'mba';

  async getConversationContext(conversationId: string, tenantId: string) {
    this.appels.push(`contexte:${tenantId}:${conversationId}`);
    return this.contexte;
  }

  async getMessages(conversationId: string, apres?: { at: string; id: string }) {
    this.appels.push(`messages:${conversationId}:${apres?.at ?? '-'}:${apres?.id ?? '-'}`);
    return [MESSAGE];
  }

  async getControlOwner(tenantId: string, waId: string) {
    this.appels.push(`main:${tenantId}:${waId}`);
    return this.owner;
  }

  async markConversationRead(tenantId: string, conversationId: string) {
    this.appels.push(`lu:${tenantId}:${conversationId}`);
  }
}

function monter(o: {
  conversations?: ConversationsClasse;
  traduireFil?: DepsOuvertureConversationInbox['traduireFil'];
  avecTranscription?: boolean;
} = {}) {
  const conversations = o.conversations ?? new ConversationsClasse();
  const medias: string[] = [];
  const transcriptions: string[] = [];
  const ouvrir = creerOuvertureConversationInbox({
    conversations,
    lireMediaMessage: async (tenant, message, conversation) => {
      medias.push(`${tenant}:${conversation}:${message}`);
      return { bytes: Buffer.from('image'), mime: 'image/jpeg', nom: 'photo.jpg' };
    },
    ...(o.avecTranscription ? {
      transcrireMessage: async (tenant, message, conversation, cible) => {
        transcriptions.push(`${tenant}:${conversation}:${message}:${cible ?? '-'}`);
        return { texte: 'bonjour', deja: false, langue: 'fr', traduction: null };
      },
    } : {}),
    ...(o.traduireFil ? { traduireFil: o.traduireFil } : {}),
  });
  return { ouvrir, conversations, medias, transcriptions };
}

describe('ouverture d’une conversation Inbox', () => {
  it('une conversation inconnue de cet espace ne rend aucune capacité', async () => {
    const conversations = new ConversationsClasse();
    conversations.contexte = null;
    const { ouvrir } = monter({ conversations });

    expect(await ouvrir('t-autre', 'c1')).toBeNull();
    expect(conversations.appels).toEqual(['contexte:t-autre:c1']);
  });

  it('lit le contexte, le curseur exact, le propriétaire et la traduction derrière une seule capacité', async () => {
    const traductions: string[] = [];
    const { ouvrir, conversations } = monter({
      traduireFil: async (tenant, conversation, messages, cible) => {
        traductions.push(`${tenant}:${conversation}:${cible}:${messages[0]?.id}`);
        return {
          indisponible: null,
          messages: messages.map((m) => ({ ...m, affiche: 'Bonjour', traduit: true, traductionEchouee: false })),
        };
      },
    });
    const conversation = await ouvrir('t1', 'c1');
    const apres = { at: '2026-10-25T10:00:00.123456Z', id: 'm0' };

    expect(await conversation?.lire(apres, 'fr')).toEqual({
      waId: '33611',
      lastInboundAt: '2026-10-25T09:00:00.000Z',
      windowOpen: true,
      langueContact: 'es',
      controlOwner: 'mba',
      messages: [{ ...MESSAGE, affiche: 'Bonjour', traduit: true, traductionEchouee: false }],
      traductionIndisponible: false,
    });
    expect(conversations.appels).toEqual([
      'contexte:t1:c1',
      `messages:c1:${apres.at}:${apres.id}`,
      'main:t1:33611',
    ]);
    expect(traductions).toEqual(['t1:c1:fr:m1']);
  });

  it('sans traducteur, rend le fil original avec la dégradation explicite', async () => {
    const { ouvrir } = monter();
    const conversation = await ouvrir('t1', 'c1');

    expect(await conversation?.lire(undefined, 'en')).toMatchObject({
      messages: [MESSAGE],
      traductionIndisponible: true,
      traductionCause: 'instance',
    });
    expect(await conversation?.lire()).not.toHaveProperty('traductionIndisponible');
  });

  it('enferme espace et conversation pour le marquage, le média et la transcription', async () => {
    const { ouvrir, conversations, medias, transcriptions } = monter({ avecTranscription: true });
    const conversation = await ouvrir('t1', 'c1');

    await conversation?.marquerLue();
    expect((await conversation?.lireMedia('m-media'))?.nom).toBe('photo.jpg');
    expect(await conversation?.transcrire?.('m-vocal', 'fr')).toMatchObject({ texte: 'bonjour' });
    expect(conversations.appels).toContain('lu:t1:c1');
    expect(medias).toEqual(['t1:c1:m-media']);
    expect(transcriptions).toEqual(['t1:c1:m-vocal:fr']);
  });

  it('n’expose aucune transcription quand elle n’est pas configurée', async () => {
    const conversation = await monter().ouvrir('t1', 'c1');
    expect(conversation?.transcrire).toBeUndefined();
  });
});
