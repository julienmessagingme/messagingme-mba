import { describe, it, expect } from 'vitest';
import {
  appelerAdresse, creerTravailEnvoi, prochainEssai, type DepsTravailEnvoi, type EnvoiAFaire, type IssueAppel, type JobEnvoi,
} from '../src/evenements/envoi';

/**
 * L'ENVOI D'UN WEBHOOK SORTANT (lot 12, livraison A) : un `POST` signé vers l'adresse du client, puis l'essai suivant
 * tant qu'elle ne répond pas 2xx, pendant 24 h (décision de Julien du 2026-10-08 : toute erreur se réessaie, l'adresse
 * n'est jamais suspendue ; un 410 arrête cet envoi).
 */
const T = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const E = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';
const A = 'c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f';
const DEBUT = new Date('2026-10-08T10:00:00Z');
const plus = (ms: number) => new Date(DEBUT.getTime() + ms);
const MIN = 60_000;
const HEURE = 60 * MIN;

describe('le calendrier des réessais', () => {
  it('30 s, 2 min, 10 min, 30 min, puis toutes les heures', () => {
    expect(prochainEssai(1, DEBUT, DEBUT)).toEqual(plus(30_000));
    expect(prochainEssai(2, DEBUT, plus(30_000))).toEqual(plus(30_000 + 2 * MIN));
    expect(prochainEssai(3, DEBUT, DEBUT)).toEqual(plus(10 * MIN));
    expect(prochainEssai(4, DEBUT, DEBUT)).toEqual(plus(30 * MIN));
    expect(prochainEssai(5, DEBUT, DEBUT)).toEqual(plus(HEURE));
    expect(prochainEssai(17, DEBUT, plus(5 * HEURE))).toEqual(plus(6 * HEURE));
  });

  it('🔴 rien au-delà de 24 h après la première tentative', () => {
    expect(prochainEssai(20, DEBUT, plus(23 * HEURE))).toEqual(plus(24 * HEURE));
    expect(prochainEssai(21, DEBUT, plus(23 * HEURE + 1))).toBeNull();
  });
});

function reponse(status: number, corps = ''): Response {
  return new Response(corps === '' ? null : corps, { status });
}

describe('un appel vers l’adresse du client', () => {
  const verifieOk = async () => ({ ok: true });
  const appel = (f: typeof fetch, verifier = verifieOk) =>
    appelerAdresse({ fetch: f, verifier }, { url: 'https://app.client.fr/hook', corps: '{}', enTetes: { 'webhook-id': 'evt_1' } });

  it('2xx livre', async () => {
    expect(await appel(async () => reponse(204))).toEqual({ livre: true, definitif: false, code: 204, extrait: '' });
  });

  it('🔴 500 et 404 se réessaient (une application en plein déploiement), 410 arrête', async () => {
    expect(await appel(async () => reponse(500, 'oups'))).toMatchObject({ livre: false, definitif: false, code: 500, extrait: 'oups' });
    expect(await appel(async () => reponse(404))).toMatchObject({ livre: false, definitif: false, code: 404 });
    expect(await appel(async () => reponse(410))).toMatchObject({ livre: false, definitif: true, code: 410 });
  });

  it('🟡 une réponse avec un octet NUL s’écrit quand même au journal (Postgres le refuse dans un text)', async () => {
    expect((await appel(async () => reponse(500, 'a\u0000b'))).extrait).toBe('ab');
  });

  it('une panne réseau se réessaie, sans code', async () => {
    expect(await appel(async () => { throw new Error('ECONNRESET'); })).toMatchObject({ livre: false, definitif: false, code: null });
  });

  it('🔴 une adresse qui pointe vers l’intérieur n’est jamais appelée', async () => {
    let appele = false;
    const issue = await appel(async () => { appele = true; return reponse(200); }, async () => ({ ok: false, raison: 'ce nom pointe vers une adresse interne' }));
    expect(appele).toBe(false);
    expect(issue).toMatchObject({ livre: false, code: null, extrait: 'ce nom pointe vers une adresse interne' });
  });

  it('🔴 une redirection n’est pas suivie, et l’extrait de la réponse est borné', async () => {
    let options: RequestInit | undefined;
    const issue = await appel(async (_u, o) => { options = o; return reponse(500, 'x'.repeat(5000)); });
    expect(options?.redirect).toBe('error');
    expect(options?.method).toBe('POST');
    expect(issue.extrait.length).toBeLessThanOrEqual(1000);
  });
});

function envoi(over: Partial<EnvoiAFaire> = {}): EnvoiAFaire {
  return {
    id: E, tenantId: T, statut: 'en_cours', tentatives: 0, essaisDepuis: DEBUT, evenementId: 'evt_1', type: 'message.received',
    corps: '{"id":"evt_1"}',
    adresse: { id: A, url: 'https://app.client.fr/hook', active: true, rang: 1, secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', secretPrecedent: null, secretPrecedentJusqua: null },
    ...over,
  };
}

function banc(o: { envoi?: EnvoiAFaire | null; issue?: IssueAppel; verrouille?: boolean; limite?: number | null; maintenant?: Date } = {}) {
  const gestes: string[] = [];
  const notes: Array<{ tentative: number; statut: string; prochainEssai: Date | null; code: number | null }> = [];
  const jobs: Array<{ job: JobEnvoi; startAfter: Date }> = [];
  const priorites: Array<number | null> = [];
  const appels: Array<{ url: string; enTetes: Record<string, string> }> = [];
  const deps: DepsTravailEnvoi = {
    lire: async () => (o.envoi === undefined ? envoi() : o.envoi),
    noter: async (_t, _e, tentative, maj) => { gestes.push('noter'); notes.push({ tentative, statut: maj.statut, prochainEssai: maj.prochainEssai, code: maj.code }); },
    enfiler: async (job, startAfter, priorite) => { gestes.push('enfiler'); jobs.push({ job, startAfter }); priorites.push(priorite); },
    espaceVerrouille: async () => o.verrouille ?? false,
    limiteAdresses: async () => (o.limite === undefined ? null : o.limite),
    appeler: async (a) => { appels.push({ url: a.url, enTetes: a.enTetes }); return o.issue ?? { livre: true, definitif: false, code: 200, extrait: '' }; },
    maintenant: () => o.maintenant ?? DEBUT,
  };
  return { travail: creerTravailEnvoi(deps), gestes, notes, jobs, appels, priorites };
}

const job = (tentative = 0): JobEnvoi => ({ tenantId: T, envoiId: E, tentative });

describe('le travail de la file d’envoi', () => {
  it('2xx : l’envoi est livré, signé, et rien n’est reprogrammé', async () => {
    const b = banc();
    await b.travail(job());
    expect(b.notes).toEqual([{ tentative: 0, statut: 'livre', prochainEssai: null, code: 200 }]);
    expect(b.jobs).toEqual([]);
    expect(b.appels[0]!.enTetes['webhook-id']).toBe('evt_1');
    expect(b.appels[0]!.enTetes['webhook-signature']).toMatch(/^v1,/);
  });

  it('🔴 un échec reprogramme l’essai suivant AVANT de l’écrire : un arrêt entre les deux ne perd pas l’envoi', async () => {
    const b = banc({ issue: { livre: false, definitif: false, code: 503, extrait: '' } });
    await b.travail(job(0));
    expect(b.gestes).toEqual(['enfiler', 'noter']);
    expect(b.jobs).toEqual([{ job: job(1), startAfter: plus(30_000) }]);
    expect(b.notes).toEqual([{ tentative: 0, statut: 'en_cours', prochainEssai: plus(30_000), code: 503 }]);
  });

  it('🔴 le réessai d’une demande de réponse garde sa priorité ; celui d’un autre type prend la priorité par défaut', async () => {
    const echec = { livre: false, definitif: false, code: 503, extrait: '' };
    const demande = banc({ envoi: envoi({ type: 'conversation.needs_reply' }), issue: echec });
    await demande.travail(job(0));
    expect(demande.priorites).toEqual([2]);
    const autre = banc({ issue: echec });
    await autre.travail(job(0));
    expect(autre.priorites).toEqual([null]);
  });

  it('🔴 au-delà de 24 h, l’envoi passe en échec et n’est plus reprogrammé', async () => {
    const b = banc({ envoi: envoi({ tentatives: 27 }), issue: { livre: false, definitif: false, code: 500, extrait: '' }, maintenant: plus(23.5 * HEURE) });
    await b.travail(job(27));
    expect(b.jobs).toEqual([]);
    expect(b.notes).toEqual([{ tentative: 27, statut: 'echec', prochainEssai: null, code: 500 }]);
  });

  it('410 : échec sans réessai, et l’adresse n’est pas touchée', async () => {
    const b = banc({ issue: { livre: false, definitif: true, code: 410, extrait: '' } });
    await b.travail(job());
    expect(b.jobs).toEqual([]);
    expect(b.notes[0]).toMatchObject({ statut: 'echec' });
  });

  it('🔴 un job périmé (doublon, envoi déjà livré, rejoué, ou purgé) ne rappelle pas l’adresse', async () => {
    for (const b of [banc({ envoi: envoi({ tentatives: 3 }) }), banc({ envoi: envoi({ statut: 'livre' }) }), banc({ envoi: null })]) {
      await b.travail(job(0));
      expect(b.appels).toEqual([]);
      expect(b.notes).toEqual([]);
    }
  });

  it('🔴 un espace verrouillé (suppression en cours) n’envoie plus rien', async () => {
    const b = banc({ verrouille: true });
    await b.travail(job());
    expect(b.appels).toEqual([]);
  });

  it('une adresse en pause, ou au-delà de l’offre, n’est pas appelée : l’envoi s’arrête et le journal le dit', async () => {
    const enPause = banc({ envoi: envoi({ adresse: { ...envoi().adresse, active: false } }) });
    await enPause.travail(job());
    expect(enPause.appels).toEqual([]);
    expect(enPause.notes[0]).toMatchObject({ statut: 'echec', code: null });

    // Retour en Base (1 adresse) : la deuxième plus ancienne est gelée au point d'envoi, rien n'est effacé.
    const gelee = banc({ envoi: envoi({ adresse: { ...envoi().adresse, rang: 2 } }), limite: 1 });
    await gelee.travail(job());
    expect(gelee.appels).toEqual([]);
    expect(gelee.notes[0]).toMatchObject({ statut: 'echec' });
  });

  it('un job hors contrat lève : la file le rejoue puis le range en DLQ, visible de /ops', async () => {
    await expect(banc().travail({ tenantId: T })).rejects.toThrow(/payload invalide/);
  });
});
