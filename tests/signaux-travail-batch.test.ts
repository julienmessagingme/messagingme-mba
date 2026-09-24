import { describe, it, expect } from 'vitest';
import { creerTravailSignauxBatch, type DepsTravailBatch } from '../src/signaux/travail-batch';
import { BatchApiError, BATCH_URL_PROFILS, type ProfilBatch } from '../src/signaux/batch';
import { signalDeLaReponse, signalAnalyse } from '../src/signaux/emetteur';
import { HttpTimeoutError } from '../src/meta/http';
import type { JournalAppels } from '../src/agent/catalog';
import { NOM_APPEL_SIGNAUX, type Signal, type SignalComplet } from '../src/signaux/types';

const T = '0b8f5c1e-3d2a-4c6b-9e7f-1a2b3c4d5e6f';
const C = '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const CLES = { cleRest: 'cle-rest-test', cleProjet: 'projet-test' };
const REPONSE = signalDeLaReponse({ messageId: 'wamid.in1', waId: '33612345678', bouton: 'Oui' }, 'whatsapp');
const JOB = { tenantId: T, signaux: [REPONSE] };

function complet(s: Signal, externalId: string | null = 'crm-7781'): SignalComplet {
  const contact = { contactId: C, externalId, optOutWhatsapp: false, optOutRcs: false };
  if (s.nom === 'em_conversation_analyzed') {
    return { id: s.id, le: s.le, contact, contenu: { nom: s.nom, analyse: {
      intent: 'sav', sentiment: 'neutre', satisfaction: 5, urgence: 1, resolved: true, topic: 't',
      actionSuggestion: 'aucune', handledBy: 'humain', exchangesCount: 2, summary: 'Propos du client.',
    } } };
  }
  return { id: s.id, le: s.le, contact, contenu: { nom: 'em_replied', canal: 'whatsapp', bouton: 'Oui' } };
}

function monter(over: Partial<DepsTravailBatch> = {}) {
  const trace = {
    pousses: [] as ProfilBatch[][],
    journal: [] as Array<Record<string, unknown>>,
    sansId: [] as number[],
    suspendus: [] as string[],
    logs: [] as string[],
    completes: 0,
  };
  const journal: JournalAppels = {
    ouvrir: async (i) => { trace.journal.push({ ouvert: i }); return 'ligne-1'; },
    clore: async (i) => { trace.journal.push({ clos: i }); },
  };
  const deps: DepsTravailBatch = {
    reglage: async () => ({ cles: CLES, envoyerResume: false, suspendu: false }),
    completer: async (_t, s) => { trace.completes += 1; return complet(s); },
    pousser: async (r) => { trace.pousses.push(r); return { partiel: null }; },
    noterSansIdentifiant: async (_t, n) => { trace.sansId.push(n); },
    suspendre: async (t) => { trace.suspendus.push(t); },
    journal,
    maintenant: () => 1000,
    log: (m) => { trace.logs.push(m); },
    ...over,
  };
  return { travail: creerTravailSignauxBatch(deps), trace };
}

describe('le travail de la file signaux-batch', () => {
  it('🔴 un job hors contrat lève (la file le rejoue puis le range en DLQ)', async () => {
    await expect(monter().travail({ tenantId: T, signaux: [{ nom: 'em_inconnu' }] })).rejects.toThrow(/payload invalide/);
    await expect(monter().travail({ tenantId: T, signaux: [] })).rejects.toThrow(/payload invalide/);
  });

  it('🔴 un job de plusieurs signaux : chacun complété une fois, UN appel pour tous', async () => {
    const signaux = ['a', 'b', 'c'].map((x) => signalDeLaReponse({ messageId: `wamid.${x}`, waId: '33612345678', bouton: null }, 'whatsapp'));
    const { travail, trace } = monter();
    await travail({ tenantId: T, signaux });
    expect(trace.completes).toBe(3);
    expect(trace.pousses).toHaveLength(1);
    expect(trace.pousses[0]![0]!.events).toHaveLength(3);
  });

  it('🔴 un 4xx sur une tranche n’empêche pas la suivante', async () => {
    // Seize événements d'une même fiche : deux appels (quinze, puis un).
    const signaux = Array.from({ length: 16 }, (_, i) => signalDeLaReponse({ messageId: `wamid.in${i}`, waId: '33612345678', bouton: null }, 'whatsapp'));
    let appels = 0;
    const { travail, trace } = monter({
      pousser: async (r) => { appels += 1; if (appels === 1) throw new BatchApiError(400, false, 'x'); trace.pousses.push(r); return { partiel: null }; },
    });
    await expect(travail({ tenantId: T, signaux })).resolves.toBeUndefined();
    expect(appels).toBe(2);
    expect(trace.pousses).toHaveLength(1);
  });

  it('un espace débranché depuis l’émission : rien, sans rien relire', async () => {
    const { travail, trace } = monter({ reglage: async () => null });
    await travail(JOB);
    expect(trace.completes).toBe(0);
    expect(trace.pousses).toEqual([]);
  });

  it('un espace suspendu (clés refusées) : rien', async () => {
    const { travail, trace } = monter({ reglage: async () => ({ cles: CLES, envoyerResume: false, suspendu: true }) });
    await travail(JOB);
    expect(trace.pousses).toEqual([]);
  });

  it('une fiche disparue : rien, et ce n’est pas un échec', async () => {
    const { travail, trace } = monter({ completer: async () => null });
    await expect(travail(JOB)).resolves.toBeUndefined();
    expect(trace.pousses).toEqual([]);
  });

  it('🔴 une fiche SANS externalId : comptée, jamais poussée', async () => {
    const { travail, trace } = monter({ completer: async (_t, s) => complet(s, null) });
    await travail(JOB);
    expect(trace.sansId).toEqual([1]);
    expect(trace.pousses).toEqual([]);
  });

  it('le cas nominal : un appel, avec les clés, et aucune ligne de journal', async () => {
    let clesVues: unknown = null;
    const { travail, trace } = monter({ pousser: async (r, cles) => { trace.pousses.push(r); clesVues = cles; return { partiel: null }; } });
    await travail(JOB);
    expect(trace.pousses).toHaveLength(1);
    expect(trace.pousses[0]![0]!.identifiers).toEqual({ custom_id: 'crm-7781' });
    expect(clesVues).toEqual(CLES);
    expect(trace.journal).toEqual([]);
  });

  it('🔴 le résumé ne part que si l’espace l’a demandé', async () => {
    const analyse = { tenantId: T, signaux: [signalAnalyse(C)] };
    const sans = monter();
    await sans.travail(analyse);
    expect(sans.trace.pousses[0]![0]!.events?.[0]?.attributes).not.toHaveProperty('summary_1');
    const avec = monter({ reglage: async () => ({ cles: CLES, envoyerResume: true, suspendu: false }) });
    await avec.travail(analyse);
    expect(avec.trace.pousses[0]![0]!.events?.[0]?.attributes.summary_1).toBe('Propos du client.');
  });

  it('un succès partiel s’écrit dans le journal, sans relance', async () => {
    const { travail, trace } = monter({ pousser: async () => ({ partiel: 'em_last_intent : invalid value' }) });
    await expect(travail(JOB)).resolves.toBeUndefined();
    expect(trace.journal).toContainEqual({ clos: expect.objectContaining({ status: 'erreur_outil', httpStatus: 202, erreur: 'em_last_intent : invalid value' }) });
  });

  it('🔴 un 4xx est TERMINAL : une ligne de journal, et le job NE lève PAS (la file ne le rejoue pas)', async () => {
    const { travail, trace } = monter({ pousser: async () => { throw new BatchApiError(400, false, 'custom_id too long'); } });
    await expect(travail(JOB)).resolves.toBeUndefined();
    expect(trace.journal).toContainEqual({ clos: expect.objectContaining({ status: 'refuse', httpStatus: 400 }) });
    expect(trace.suspendus).toEqual([]);
  });

  it('🔴 des clés refusées (401, 403) SUSPENDENT la remontée : une seule ligne au lieu d’une par signal', async () => {
    const { travail, trace } = monter({ pousser: async () => { throw new BatchApiError(401, false, 'invalid key'); } });
    await travail(JOB);
    expect(trace.suspendus).toEqual([T]);
  });

  it('🔴 un 5xx épuisé s’écrit ET lève : la file le rejouera', async () => {
    const { travail, trace } = monter({ pousser: async () => { throw new BatchApiError(503, true, null); } });
    await expect(travail(JOB)).rejects.toBeInstanceOf(BatchApiError);
    expect(trace.journal).toContainEqual({ clos: expect.objectContaining({ status: 'erreur_outil', httpStatus: 503 }) });
  });

  it('un délai dépassé s’écrit « timeout » et lève', async () => {
    const { travail, trace } = monter({ pousser: async () => { throw new HttpTimeoutError('https://api.batch.com/x', 30000); } });
    await expect(travail(JOB)).rejects.toBeInstanceOf(HttpTimeoutError);
    expect(trace.journal).toContainEqual({ clos: expect.objectContaining({ status: 'timeout' }) });
  });

  it('🔴 la ligne de journal ne porte aucune donnée de la personne, ni le nom de l’outil', async () => {
    const { travail, trace } = monter({ pousser: async () => { throw new BatchApiError(400, false, null); } });
    await travail(JOB);
    expect(trace.journal).toContainEqual({ ouvert: expect.objectContaining({
      toolName: NOM_APPEL_SIGNAUX, source: 'signaux', sessionId: null,
      argsRediges: { signaux: 1, noms: 'em_replied', em_event_id: REPONSE.id },
    }) });
    expect(JSON.stringify(trace.journal)).not.toContain('33612345678');
    // Le libellé ET le message d'erreur s'affichent dans Sécurité > Journal des erreurs (spec § 10).
    expect(JSON.stringify(trace.journal)).not.toMatch(/batch/i);
  });

  it('🔴 un journal en panne n’avale pas la relance d’un échec rejouable', async () => {
    const journalCasse: JournalAppels = { ouvrir: async () => { throw new Error('base indisponible'); }, clore: async () => {} };
    const { travail } = monter({ journal: journalCasse, pousser: async () => { throw new BatchApiError(500, true, null); } });
    await expect(travail(JOB)).rejects.toBeInstanceOf(BatchApiError);
  });
});

/**
 * 🔴 DÉCISION 2 DE LA TÂCHE 7 (relue sur la page de l'outil le 2026-09-25) : le TEXTE QUE L'OUTIL RENVOIE
 * (détail d'un 4xx, raison d'un succès partiel) et l'adresse que portent un délai dépassé ou une panne réseau
 * sont recopiés dans Sécurité > Journal des erreurs, un écran de la MARQUE. La spec (§ 10) y interdit le nom de
 * l'outil : il est neutralisé, quelle que soit sa casse, sans perdre le reste du message.
 */
describe('le texte recopié dans le journal des erreurs ne nomme pas l’outil', () => {
  const journalise = async (pousser: DepsTravailBatch['pousser']): Promise<string> => {
    const { travail, trace } = monter({ pousser });
    await travail(JOB).catch(() => undefined);
    return JSON.stringify(trace.journal);
  };

  it('🔴 le détail d’un 4xx qui nomme l’outil', async () => {
    const j = await journalise(async () => { throw new BatchApiError(400, false, 'Invalid Batch project key (BATCH_PROJECT_KEY)'); });
    expect(j).not.toMatch(/batch/i);
    expect(j).toContain('Invalid');
    expect(j).toContain('project key');
  });

  it('🔴 la raison d’un succès partiel qui nomme l’outil', async () => {
    const j = await journalise(async () => ({ partiel: 'em_last_intent : rejected by batch' }));
    expect(j).not.toMatch(/batch/i);
    expect(j).toContain('em_last_intent : rejected by');
  });

  it('🔴 l’adresse de l’outil dans un délai dépassé ou une panne réseau', async () => {
    const j1 = await journalise(async () => { throw new HttpTimeoutError(BATCH_URL_PROFILS, 30000); });
    const j2 = await journalise(async () => { throw new Error(`connect ECONNREFUSED ${BATCH_URL_PROFILS}`); });
    for (const j of [j1, j2]) {
      expect(j).not.toMatch(/batch/i);
      expect(j).not.toMatch(/https?:\/\//);
    }
    expect(j1).toContain('délai dépassé (30000 ms)');
  });

  it('un texte qui ne nomme pas l’outil passe tel quel', async () => {
    const j = await journalise(async () => ({ partiel: 'em_last_intent : invalid value' }));
    expect(j).toContain('em_last_intent : invalid value');
  });
});

/**
 * 🔴 DÉCISION 1 DE LA TÂCHE 7 (relue sur la page de l'outil le 2026-09-25) : l'outil n'accepte que les événements
 * des DERNIÈRES 24 HEURES. Un job rejoué au-delà (worker arrêté, file engorgée) verrait ses événements refusés un
 * par un, en « succès partiel ». La règle : l'ÉTAT DE LA FICHE part toujours (il est relu au moment de pousser,
 * donc à jour) ; un événement trop vieux n'est PAS envoyé, et le job le DIT dans son journal (le nombre et les
 * noms), au lieu de le laisser disparaître en silence.
 */
describe('un événement trop vieux pour l’outil', () => {
  const MAINTENANT = Date.parse('2026-09-25T12:00:00.000Z');
  const vieux = signalDeLaReponse({ messageId: 'wamid.vieux', waId: '33612345678', bouton: null, le: '2026-09-24T11:00:00.000Z' }, 'whatsapp');
  const recent = signalDeLaReponse({ messageId: 'wamid.recent', waId: '33612345678', bouton: null, le: '2026-09-25T11:00:00.000Z' }, 'whatsapp');

  it('🔴 ne part pas, l’état de la fiche part quand même, et le job le dit', async () => {
    const { travail, trace } = monter({ maintenant: () => MAINTENANT });
    await expect(travail({ tenantId: T, signaux: [vieux, recent] })).resolves.toBeUndefined();
    expect(trace.pousses).toHaveLength(1);
    const profil = trace.pousses[0]![0]!;
    expect(profil.events?.map((e) => e.attributes.em_event_id)).toEqual([recent.id]);
    expect(profil.attributes?.em_contact_id).toBe(C);
    expect(trace.logs.some((l) => l.includes('1 evenement(s)') && l.includes('em_replied') && l.includes(T))).toBe(true);
    // Ce n'est pas un refus de l'outil : rien dans le journal des erreurs de la marque.
    expect(trace.journal).toEqual([]);
  });

  it('🔴 une fiche dont TOUS les événements sont trop vieux : son état part seul, sans événement', async () => {
    const { travail, trace } = monter({ maintenant: () => MAINTENANT });
    await travail({ tenantId: T, signaux: [vieux] });
    expect(trace.pousses).toHaveLength(1);
    const profil = trace.pousses[0]![0]!;
    expect(profil).not.toHaveProperty('events');
    expect(profil.identifiers).toEqual({ custom_id: 'crm-7781' });
    expect(profil.attributes?.em_contact_id).toBe(C);
  });

  it('un événement récent ne dit rien : aucun journal', async () => {
    const { travail, trace } = monter({ maintenant: () => MAINTENANT });
    await travail({ tenantId: T, signaux: [recent] });
    expect(trace.logs).toEqual([]);
    expect(trace.pousses[0]![0]!.events).toHaveLength(1);
  });
});
