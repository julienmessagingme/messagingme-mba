import { describe, it, expect } from 'vitest';
import { creerDemandeALApplication, PRIORITE_BESOIN_REPONSE, type DepsDemandeALApplication } from '../src/evenements/besoin-reponse';
import type { LigneEnvoi } from '../src/evenements/distribution';
import type { JobEnvoi } from '../src/evenements/envoi';

/**
 * « MON APPLICATION RÉPOND » (lot 12, livraison B) : un message entrant que personne ne tient part vers l'adresse
 * désignée, en `conversation.needs_reply`, devant tout le reste de la file.
 */
const T = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const A = 'c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f';
const CONV = 'd4e5f6a7-b8c9-4d0e-9f1a-2b3c4d5e6f70';
const C = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';

type Recu = { type: string | null; text: string | null; transcription: string | null } | null;
function banc(o: { adresse?: { active: boolean; rang: number } | null; limite?: number | null; dejaLa?: boolean; message?: Recu } = {}) {
  const lignes: LigneEnvoi[] = [];
  const jobs: Array<{ job: JobEnvoi; priorite: number }> = [];
  const deps: DepsDemandeALApplication = {
    adresse: async () => (o.adresse === undefined ? { active: true, rang: 1 } : o.adresse),
    limiteAdresses: async () => (o.limite === undefined ? null : o.limite),
    fiche: async () => ({ contactId: C, telephone: '+33611111111', nom: 'Claire', externalId: null, optOutWhatsapp: false, optOutRcs: false }),
    conversationId: async () => CONV,
    messageRecu: async () => (o.message === undefined ? { type: 'text', text: 'Bonjour, mon colis ?', transcription: null } : o.message),
    // Le contrat du vrai dépôt (`creerNeuf`) : `null` quand la ligne existait déjà.
    creerEnvoiNeuf: async (l) => { lignes.push(l); return o.dejaLa ? null : 'e1e1e1e1-0000-4000-8000-000000000000'; },
    enfiler: async (job, priorite) => { jobs.push({ job, priorite }); },
    maintenant: () => new Date('2026-10-08T10:00:00Z'),
  };
  return { demande: creerDemandeALApplication(deps), lignes, jobs };
}

describe('la demande de réponse à l’application', () => {
  it('🔴 le message part vers l’adresse désignée, avec la conversation à qui répondre, devant le reste de la file', async () => {
    const b = banc();
    expect(await b.demande.demander(T, '33611111111', { adresseId: A, messageDeclencheur: 'wamid.1', contenu: 'Bonjour, mon colis ?' })).toBe('demande');
    expect(b.lignes).toHaveLength(1);
    expect(b.lignes[0]).toMatchObject({ tenantId: T, adresseId: A, type: 'conversation.needs_reply', contactId: C });
    const corps = JSON.parse(b.lignes[0]!.corps);
    expect(corps).toMatchObject({
      type: 'conversation.needs_reply', workspace_id: T,
      data: {
        contact: { id: C, phone: '+33611111111', name: 'Claire' }, conversation_id: CONV, channel: 'whatsapp', message_id: 'wamid.1',
        message_type: 'text', text: 'Bonjour, mon colis ?', transcription: null,
        reply_with: { method: 'POST', path: '/v1/messages/whatsapp' },
      },
    });
    expect(b.jobs).toEqual([{ job: { tenantId: T, envoiId: expect.any(String), tentative: 0 }, priorite: PRIORITE_BESOIN_REPONSE }]);
    expect(PRIORITE_BESOIN_REPONSE).toBeGreaterThan(1);
  });

  it('🔴 un message redélivré par Meta garde le même identifiant d’événement : il ne part pas deux fois', async () => {
    const un = banc();
    await un.demande.demander(T, '33611111111', { adresseId: A, messageDeclencheur: 'wamid.1', contenu: 'x' });
    const deux = banc({ dejaLa: true });
    await deux.demande.demander(T, '33611111111', { adresseId: A, messageDeclencheur: 'wamid.1', contenu: 'x' });
    expect(deux.lignes[0]!.evenementId).toBe(un.lignes[0]!.evenementId);
    expect(deux.jobs).toEqual([]);
  });

  it('🔴 une adresse en pause, supprimée ou gelée par l’offre ne reçoit rien : la remise passe la main à l’équipe', async () => {
    for (const o of [{ adresse: null }, { adresse: { active: false, rang: 1 } }, { adresse: { active: true, rang: 2 }, limite: 1 }]) {
      const b = banc(o);
      expect(await b.demande.demander(T, '33611111111', { adresseId: A, messageDeclencheur: 'wamid.1', contenu: 'x' })).toBe('indisponible');
      expect(b.lignes).toEqual([]);
    }
  });

  it('un contenu vide sans message nommé part sans texte, plutôt qu’avec une chaîne vide', async () => {
    const b = banc();
    await b.demande.demander(T, '33611111111', { adresseId: A, messageDeclencheur: null, contenu: '  ' });
    expect(JSON.parse(b.lignes[0]!.corps).data).toMatchObject({ text: null, message_type: null, transcription: null });
  });

  it('🔴 la fin de parcours (contenu vide) envoie le texte du message enregistré, à quoi l’application doit répondre', async () => {
    const b = banc({ message: { type: 'text', text: 'Et pour un retour ?', transcription: null } });
    await b.demande.demander(T, '33611111111', { adresseId: A, messageDeclencheur: 'wamid.2', contenu: '' });
    expect(JSON.parse(b.lignes[0]!.corps).data).toMatchObject({ message_id: 'wamid.2', message_type: 'text', text: 'Et pour un retour ?' });
  });

  it('un vocal part avec son type et sa transcription, pas seulement « [audio] »', async () => {
    const b = banc({ message: { type: 'audio', text: '[audio]', transcription: 'je voudrais changer mon rendez-vous' } });
    await b.demande.demander(T, '33611111111', { adresseId: A, messageDeclencheur: 'wamid.3', contenu: '[audio]' });
    expect(JSON.parse(b.lignes[0]!.corps).data).toMatchObject({ message_type: 'audio', transcription: 'je voudrais changer mon rendez-vous' });
  });
});
