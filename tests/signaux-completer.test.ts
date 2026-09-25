import { describe, it, expect } from 'vitest';
import { completerSignal, type FicheDuSignal, type LecturesSignal } from '../src/signaux/completer';
import { signalAnalyse, signalDeLAccuse, signalDeLaReponse, signalDesabonnement, signalDuClic } from '../src/signaux/emetteur';
import { SOURCE_STOP_RCS, type AnalyseDuSignal, type Signal } from '../src/signaux/types';

const T = '0b8f5c1e-3d2a-4c6b-9e7f-1a2b3c4d5e6f';
const C = '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const S = 'd4e5f6a7-b8c9-4d0e-9f1a-2b3c4d5e6f70';
const CONV = 'c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f';
const FICHE: FicheDuSignal = { contactId: C, externalId: 'crm-7781', optOutWhatsapp: true, optOutRcs: false, optInSource: 'whatsapp_stop' };
const ANALYSE: AnalyseDuSignal = {
  intent: 'sav', sentiment: 'neutre', satisfaction: null, urgence: 4, resolved: false, topic: 'livraison',
  actionSuggestion: 'rappeler', handledBy: 'humain', exchangesCount: 3, summary: 'Résumé.',
};

function lectures(over: Partial<LecturesSignal> = {}) {
  const tenants: string[] = [];
  const l: LecturesSignal = {
    ficheParWaId: async (t) => { tenants.push(t); return FICHE; },
    ficheParId: async (t) => { tenants.push(t); return FICHE; },
    waIdDeLaConversation: async (t) => { tenants.push(t); return '33612345678'; },
    contexteDuMessage: async (t) => { tenants.push(t); return { origine: 'campagne', sendId: S }; },
    lien: async (t) => { tenants.push(t); return { template: 'promo', destination: 'https://client.fr/promo' }; },
    analyse: async (t) => { tenants.push(t); return ANALYSE; },
    ...over,
  };
  return { l, tenants };
}
const accuse = (status: 'delivered' | 'failed'): Signal => signalDeLAccuse({
  messageId: 'wamid.1', status, waId: '33612345678',
  motif: status === 'failed' ? '131026 Message undeliverable' : null, codeMeta: status === 'failed' ? 131026 : null, le: null,
}, 'whatsapp')!;

describe('completerSignal : relire ce que le chemin chaud ne portait pas', () => {
  it('un accusé : la fiche par son wa_id, l’origine du message et son envoi', async () => {
    const r = await completerSignal(lectures().l, T, accuse('delivered'));
    expect(r?.contact).toEqual({ contactId: C, externalId: 'crm-7781', optOutWhatsapp: true, optOutRcs: false });
    expect(r?.contenu).toEqual({ nom: 'em_message_delivered', canal: 'whatsapp', origine: 'campagne', sendId: S });
  });

  it('un échec garde son motif et son code', async () => {
    const r = await completerSignal(lectures().l, T, accuse('failed'));
    expect(r?.contenu).toEqual({ nom: 'em_message_failed', canal: 'whatsapp', origine: 'campagne', sendId: S, motif: '131026 Message undeliverable', codeMeta: 131026 });
  });

  it('une réponse garde son bouton', async () => {
    const r = await completerSignal(lectures().l, T, signalDeLaReponse({ messageId: 'wamid.in', waId: '336', bouton: 'Oui' }, 'rcs'));
    expect(r?.contenu).toEqual({ nom: 'em_replied', canal: 'rcs', bouton: 'Oui' });
  });

  it('un clic : la fiche par son identifiant, le template et la destination du lien', async () => {
    const r = await completerSignal(lectures().l, T, signalDuClic(C, 'ab12cd34ef56'));
    expect(r?.contenu).toEqual({ nom: 'em_link_clicked', lien: 'ab12cd34ef56', template: 'promo', destination: 'https://client.fr/promo' });
    const inconnu = await completerSignal(lectures({ lien: async () => null }).l, T, signalDuClic(C, 'ab12cd34ef56'));
    expect(inconnu?.contenu).toEqual({ nom: 'em_link_clicked', lien: 'ab12cd34ef56', template: null, destination: null });
  });

  it('un désabonnement dit sa source : celle de la fiche, ou le STOP RCS', async () => {
    expect((await completerSignal(lectures().l, T, signalDesabonnement('336', 'whatsapp')))?.contenu)
      .toEqual({ nom: 'em_opted_out', canal: 'whatsapp', source: 'whatsapp_stop' });
    expect((await completerSignal(lectures().l, T, signalDesabonnement('336', 'rcs')))?.contenu)
      .toEqual({ nom: 'em_opted_out', canal: 'rcs', source: SOURCE_STOP_RCS });
  });

  it('🔴 un désabonnement posé par la console ou l’API n’a PAS de canal : personne n’a écrit STOP', async () => {
    for (const source of ['crm', 'api', 'webhook:formulaire-site']) {
      const l = lectures({ ficheParWaId: async () => ({ ...FICHE, optInSource: source }) }).l;
      expect((await completerSignal(l, T, signalDesabonnement('336', 'whatsapp')))?.contenu, source)
        .toEqual({ nom: 'em_opted_out', canal: null, source });
    }
  });

  it('une conversation analysée : la fiche par la conversation, et l’analyse relue', async () => {
    const r = await completerSignal(lectures().l, T, signalAnalyse(CONV));
    expect(r?.contenu).toEqual({ nom: 'em_conversation_analyzed', analyse: ANALYSE });
  });

  it('plus rien à pousser : fiche supprimée, conversation inconnue, analyse disparue', async () => {
    expect(await completerSignal(lectures({ ficheParWaId: async () => null }).l, T, accuse('delivered'))).toBeNull();
    expect(await completerSignal(lectures({ waIdDeLaConversation: async () => null }).l, T, signalAnalyse(CONV))).toBeNull();
    expect(await completerSignal(lectures({ analyse: async () => null }).l, T, signalAnalyse(CONV))).toBeNull();
  });

  it('🔴 une fiche SANS identifiant externe : rien de ce qui ne sert qu’à la poussée n’est relu, et elle reste comptable', async () => {
    // Elle ne sera jamais poussée : l'adaptateur la compte. Le contexte d'un accusé (trois sous-requêtes, des
    // milliers d'accusés par campagne) et le lien d'un clic seraient lus pour rien.
    for (const externalId of [null, '   ']) {
      const lus: string[] = [];
      const { l } = lectures({
        ficheParWaId: async () => ({ ...FICHE, externalId }),
        ficheParId: async () => ({ ...FICHE, externalId }),
        contexteDuMessage: async () => { lus.push('contexte'); return { origine: 'campagne', sendId: S }; },
        lien: async () => { lus.push('lien'); return { template: 'promo', destination: 'https://client.fr/promo' }; },
        analyse: async () => { lus.push('analyse'); return ANALYSE; },
      });
      const livre = await completerSignal(l, T, accuse('delivered'));
      const echec = await completerSignal(l, T, accuse('failed'));
      const clic = await completerSignal(l, T, signalDuClic(C, 'ab12cd34ef56'));
      const analyse = await completerSignal(l, T, signalAnalyse(CONV));
      expect(lus, String(externalId)).toEqual(['analyse']);
      // Non nuls : c'est ce qui permet à l'adaptateur de les COMPTER (`sansIdentifiant`) au lieu de les perdre.
      expect(livre?.contenu).toEqual({ nom: 'em_message_delivered', canal: 'whatsapp', origine: null, sendId: null });
      expect(echec?.contenu).toMatchObject({ nom: 'em_message_failed', origine: null, sendId: null, codeMeta: 131026 });
      expect(clic?.contenu).toEqual({ nom: 'em_link_clicked', lien: 'ab12cd34ef56', template: null, destination: null });
      // L'analyse, elle, est relue : son absence veut dire « plus rien à pousser », pas « à compter ».
      expect(analyse?.contenu).toEqual({ nom: 'em_conversation_analyzed', analyse: ANALYSE });
    }
  });

  it('🔴 chaque lecture reçoit l’espace du JOB, jamais un autre', async () => {
    const { l, tenants } = lectures();
    for (const s of [accuse('delivered'), signalDuClic(C, 'ab12cd34ef56'), signalAnalyse(CONV)]) await completerSignal(l, T, s);
    expect(tenants.length).toBeGreaterThan(0);
    expect(new Set(tenants)).toEqual(new Set([T]));
  });
});
