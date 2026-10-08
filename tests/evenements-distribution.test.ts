import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { creerTravailDistribution, type DepsDistribution, type LigneEnvoi } from '../src/evenements/distribution';
import { idSignal, type Signal, type SignalComplet } from '../src/signaux/types';
import type { JobEnvoi } from '../src/evenements/envoi';

/**
 * LA DISTRIBUTION (lot 12, livraison A) : les signaux d'un espace arrivent par le bus existant ; chacun devient un
 * événement public, figé une fois, et une ligne d'envoi par adresse qui en veut.
 */
const T = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const C = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';
const A1 = 'c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f';
const A2 = 'd4e5f6a7-b8c9-4d0e-9f1a-2b3c4d5e6f70';
const LE = '2026-10-08T10:00:00.000Z';

const reponse: Signal = { nom: 'em_replied', id: idSignal('em_replied', 'wamid.1'), le: LE, waId: '33611111111', canal: 'whatsapp', bouton: null, messageId: 'wamid.1' };
const lu: Signal = { nom: 'em_message_read', id: idSignal('em_message_read', 'wamid.2'), le: LE, waId: '33611111111', canal: 'whatsapp', messageId: 'wamid.2' };

const contact = { contactId: C, telephone: '+33611111111', nom: 'Claire', externalId: null, optOutWhatsapp: false, optOutRcs: false, derniereAnalyse: null };
function complet(s: Signal): SignalComplet {
  if (s.nom === 'em_message_read') return { id: s.id, le: s.le, contact, contenu: { nom: s.nom, canal: 'whatsapp', origine: 'campagne', sendId: null } };
  return { id: s.id, le: s.le, contact, contenu: { nom: 'em_replied', canal: 'whatsapp', bouton: null } };
}

function banc(o: { adresses?: Array<{ id: string; types: string[] }>; limite?: number | null; verrouille?: boolean; dejaLa?: Set<string> } = {}) {
  const lignes: LigneEnvoi[] = [];
  const jobs: Array<{ job: JobEnvoi; priorite: number }> = [];
  let lectures = 0;
  const deps: DepsDistribution = {
    adresses: async () => o.adresses ?? [{ id: A1, types: ['message.received'] }],
    limiteAdresses: async () => (o.limite === undefined ? null : o.limite),
    espaceVerrouille: async () => o.verrouille ?? false,
    completer: async (_t, s) => { lectures += 1; return complet(s); },
    messageRecu: async () => ({ type: 'text', text: 'Bonjour, mon colis ?', transcription: null }),
    creerEnvois: async (ls) => {
      const neufs = ls.filter((l) => !o.dejaLa?.has(`${l.adresseId}:${l.evenementId}`));
      lignes.push(...neufs);
      return neufs.map((l) => ({ id: randomUUID(), type: l.type }));
    },
    enfiler: async (job, priorite) => { jobs.push({ job, priorite }); },
  };
  return { travail: creerTravailDistribution(deps), lignes, jobs, lectures: () => lectures };
}

describe('la distribution des signaux en événements', () => {
  it('🔴 un message reçu part avec son texte, la fiche et un identifiant stable, figé dans la ligne', async () => {
    const b = banc();
    await b.travail({ tenantId: T, signaux: [reponse] });
    expect(b.lignes).toHaveLength(1);
    const corps = JSON.parse(b.lignes[0]!.corps);
    expect(corps).toMatchObject({
      id: `evt_${reponse.id}`, type: 'message.received', created_at: LE, workspace_id: T,
      data: {
        contact: { id: C, phone: '+33611111111', name: 'Claire', external_id: null },
        channel: 'whatsapp', message_id: 'wamid.1', message_type: 'text', text: 'Bonjour, mon colis ?',
      },
    });
    // L'ordre des clés est celui de l'enveloppe documentée : le corps est gardé en texte, jamais réordonné.
    expect(Object.keys(corps)).toEqual(['id', 'type', 'created_at', 'workspace_id', 'data']);
    expect(b.lignes[0]).toMatchObject({ tenantId: T, adresseId: A1, contactId: C, type: 'message.received', evenementId: `evt_${reponse.id}` });
    expect(b.jobs).toEqual([{ job: { tenantId: T, envoiId: expect.any(String), tentative: 0 }, priorite: 1 }]);
  });

  it('🔴 seules les adresses abonnées au type reçoivent, et un type que personne ne veut n’est même pas relu', async () => {
    const b = banc({ adresses: [{ id: A1, types: ['message.received'] }, { id: A2, types: ['message.read', 'message.received'] }] });
    await b.travail({ tenantId: T, signaux: [lu] });
    expect(b.lignes.map((l) => l.adresseId)).toEqual([A2]);
    expect(b.jobs[0]!.priorite).toBe(0);

    const personne = banc({ adresses: [{ id: A1, types: ['contact.opted_out'] }] });
    await personne.travail({ tenantId: T, signaux: [lu, reponse] });
    expect(personne.lignes).toEqual([]);
    expect(personne.lectures()).toBe(0);
  });

  it('🔴 au-delà de l’offre, les adresses les plus récentes sont gelées : les plus anciennes reçoivent', async () => {
    const b = banc({ adresses: [{ id: A1, types: ['message.received'] }, { id: A2, types: ['message.received'] }], limite: 1 });
    await b.travail({ tenantId: T, signaux: [reponse] });
    expect(b.lignes.map((l) => l.adresseId)).toEqual([A1]);
  });

  it('🔴 un événement déjà distribué (Meta redélivre, job rejoué) n’est pas renvoyé', async () => {
    const b = banc({ dejaLa: new Set([`${A1}:evt_${reponse.id}`]) });
    await b.travail({ tenantId: T, signaux: [reponse] });
    expect(b.jobs).toEqual([]);
  });

  it('un espace verrouillé ne distribue rien', async () => {
    const b = banc({ verrouille: true });
    await b.travail({ tenantId: T, signaux: [reponse] });
    expect(b.lignes).toEqual([]);
  });

  it('un job hors contrat lève', async () => {
    await expect(banc().travail({ tenantId: T, signaux: [] })).rejects.toThrow(/payload invalide/);
  });
});
