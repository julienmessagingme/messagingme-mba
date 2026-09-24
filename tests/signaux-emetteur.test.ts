import { describe, it, expect } from 'vitest';
import {
  creerEmetteur, creerPuitsSignauxMeta, annoncerAussiAuxSignaux, boutonTape, PRIORITE_SIGNAL,
  signalDeLAccuse, signalDeLaReponse, signalDuClic, signalDesabonnement, signalAnalyse,
} from '../src/signaux/emetteur';
import { NOMS_EVENEMENTS, SIGNAUX_PAR_JOB, schemaSignal, type JobSignaux, type Signal } from '../src/signaux/types';
import type { InboundMessage } from '../src/webhooks/inbound';

const T = '0b8f5c1e-3d2a-4c6b-9e7f-1a2b3c4d5e6f';
const C = '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b';

function emetteurDeTest(actifs: string[] = [T]) {
  const jobs: Array<{ file: string; job: JobSignaux; opts: { groupId: string; priority: number } }> = [];
  const logs: string[] = [];
  let lectures = 0;
  const emetteur = creerEmetteur({
    destinations: [{ file: 'signaux-test', espacesActifs: async () => { lectures += 1; return new Set(actifs); } }],
    enfiler: async (file, job, opts) => { jobs.push({ file, job, opts }); },
    log: (m) => { logs.push(m); },
  });
  return { emetteur, jobs, logs, lectures: () => lectures };
}
const message = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  phoneNumberId: 'PN1', waId: '33612345678', messageId: 'wamid.in1', type: 'text', body: 'bonjour',
  buttonPayload: null, profileName: null, field: 'messages', ...over,
});

describe('creerEmetteur', () => {
  it('un espace qui n’a rien branché : rien n’est enfilé', async () => {
    const { emetteur, jobs } = emetteurDeTest([]);
    await emetteur.emettreSignal(T, signalDesabonnement('33612345678', 'whatsapp'));
    expect(jobs).toEqual([]);
  });

  it('un espace branché : un job, dans la file de l’adaptateur, groupé par espace, avec sa priorité', async () => {
    const { emetteur, jobs } = emetteurDeTest();
    const s = signalDesabonnement('33612345678', 'whatsapp');
    await emetteur.emettreSignal(T, s);
    expect(jobs).toEqual([{ file: 'signaux-test', job: { tenantId: T, signaux: [s] }, opts: { groupId: T, priority: 1 } }]);
  });

  it('🔴 les accusés restent DERRIÈRE : réponses, clics, désabonnements et analyses passent devant', () => {
    expect(Object.keys(PRIORITE_SIGNAL).sort()).toEqual([...NOMS_EVENEMENTS].sort());
    for (const n of ['em_message_delivered', 'em_message_read', 'em_message_failed'] as const) {
      for (const devant of ['em_replied', 'em_link_clicked', 'em_opted_out', 'em_conversation_analyzed'] as const) {
        expect(PRIORITE_SIGNAL[devant], `${devant} devant ${n}`).toBeGreaterThan(PRIORITE_SIGNAL[n]);
      }
    }
  });

  it('🔴 une émission groupée se range par priorité, en jobs de SIGNAUX_PAR_JOB au plus', async () => {
    const { emetteur, jobs } = emetteurDeTest();
    const livre = signalDeLAccuse({ messageId: 'wamid.1', status: 'delivered', waId: '336', motif: null, codeMeta: null, le: null }, 'whatsapp')!;
    const desabos = Array.from({ length: SIGNAUX_PAR_JOB + 50 }, (_, i) => signalDesabonnement(`336${i}`, 'whatsapp'));
    await emetteur.emettreSignaux(T, [livre, ...desabos]);
    expect(jobs.map((j) => [j.opts.priority, j.job.signaux.length])).toEqual([[0, 1], [1, SIGNAUX_PAR_JOB], [1, 50]]);
  });

  it('🔴 un signal hors contrat est écarté SEUL : les autres partent', async () => {
    const { emetteur, jobs, logs } = emetteurDeTest();
    const bon = signalDesabonnement('336', 'whatsapp');
    const horsContrat = { ...signalDesabonnement('337', 'whatsapp'), texte: 'x' } as unknown as Signal;
    await emetteur.emettreSignaux(T, [bon, horsContrat]);
    expect(jobs.map((j) => j.job.signaux)).toEqual([[bon]]);
    expect(logs.some((l) => l.includes('hors contrat'))).toBe(true);
  });

  it('🔴 il ne lève JAMAIS : une lecture ou un enfilement en panne se journalise', async () => {
    const logs: string[] = [];
    const lectureCassee = creerEmetteur({
      destinations: [{ file: 'f', espacesActifs: async () => { throw new Error('base indisponible'); } }],
      enfiler: async () => {},
      log: (m) => { logs.push(m); },
    });
    await expect(lectureCassee.emettreSignal(T, signalAnalyse(C))).resolves.toBeUndefined();
    const fileCassee = creerEmetteur({
      destinations: [{ file: 'f', espacesActifs: async () => new Set([T]) }],
      enfiler: async () => { throw new Error('file pleine'); },
      log: (m) => { logs.push(m); },
    });
    await expect(fileCassee.emettreSignal(T, signalAnalyse(C))).resolves.toBeUndefined();
    expect(logs).toHaveLength(2);
  });

  it('🔴 un signal hors contrat n’entre pas dans la file (le lecteur le refuserait jusqu’à la DLQ)', async () => {
    const { emetteur, jobs, logs } = emetteurDeTest();
    const horsContrat = { ...signalDesabonnement('33612345678', 'whatsapp'), texte: 'x' } as unknown as Signal;
    await emetteur.emettreSignal(T, horsContrat);
    expect(jobs).toEqual([]);
    expect(logs[0]).toContain('hors contrat');
  });

  it('quelquUnEcoute : vrai dès qu’un espace a branché un outil', async () => {
    expect(await emetteurDeTest([]).emetteur.quelquUnEcoute()).toBe(false);
    expect(await emetteurDeTest([T]).emetteur.quelquUnEcoute()).toBe(true);
  });
});

describe('les signaux que les chemins chauds fabriquent', () => {
  it('un accusé `sent`, ou sans destinataire, ne fait aucun signal', () => {
    expect(signalDeLAccuse({ messageId: 'w', status: 'sent', waId: '336', motif: null, codeMeta: null, le: null }, 'whatsapp')).toBeNull();
    expect(signalDeLAccuse({ messageId: 'w', status: 'delivered', waId: null, motif: null, codeMeta: null, le: null }, 'whatsapp')).toBeNull();
  });

  it('délivré, lu, en échec : trois noms, un identifiant STABLE par message, le motif borné', () => {
    const accuse = (status: 'delivered' | 'read' | 'failed') =>
      signalDeLAccuse({ messageId: 'wamid.1', status, waId: '336', motif: status === 'failed' ? 'x'.repeat(900) : null, codeMeta: status === 'failed' ? 131026 : null, le: '2026-09-24T10:00:00.000Z' }, 'rcs');
    expect(accuse('delivered')?.nom).toBe('em_message_delivered');
    expect(accuse('read')?.nom).toBe('em_message_read');
    const echec = accuse('failed');
    expect(echec).toMatchObject({ nom: 'em_message_failed', canal: 'rcs', codeMeta: 131026, le: '2026-09-24T10:00:00.000Z' });
    expect(echec?.nom === 'em_message_failed' ? echec.motif?.length : -1).toBe(500);
    expect(accuse('delivered')?.id).toBe(accuse('delivered')?.id);
    for (const s of [accuse('delivered'), accuse('read'), echec]) expect(schemaSignal.safeParse(s).success).toBe(true);
  });

  it('boutonTape : le libellé d’un bouton, jamais un texte saisi', () => {
    expect(boutonTape(message())).toBeNull();
    expect(boutonTape(message({ type: 'button', body: 'Oui', buttonPayload: 'Oui' }))).toBe('Oui');
    expect(boutonTape(message({ type: 'interactive', body: 'Rappelez-moi', buttonPayload: 'btn:1' }))).toBe('Rappelez-moi');
    expect(boutonTape(message({ type: 'interactive', body: '[formulaire]', buttonPayload: '{"adresse":"12 rue des Lilas"}' }))).toBeNull();
    expect(boutonTape(message({ type: 'interactive', body: 'Envoyer', buttonPayload: ' {"x":1}' }))).toBeNull();
  });

  it('🔴 une réponse ne transporte JAMAIS le texte du message', () => {
    const s = signalDeLaReponse({ messageId: 'wamid.in1', waId: '336', bouton: boutonTape(message({ body: 'mon adresse est 12 rue des Lilas' })) }, 'whatsapp');
    expect(JSON.stringify(s)).not.toContain('Lilas');
    expect(schemaSignal.safeParse(s).success).toBe(true);
  });

  it('clic, désabonnement, analyse : conformes au contrat', () => {
    for (const s of [signalDuClic(C, 'ab12cd34ef56'), signalDesabonnement('336', 'rcs'), signalAnalyse(C)]) {
      expect(schemaSignal.safeParse(s).success, s.nom).toBe(true);
    }
  });
});

describe('creerPuitsSignauxMeta : le coût sur le chemin chaud des accusés', () => {
  function puits(actifs: string[]) {
    let numeros = 0;
    const t = emetteurDeTest(actifs);
    const p = creerPuitsSignauxMeta({ emetteur: t.emetteur, tenantDuNumero: async () => { numeros += 1; return T; } });
    return { p, t, numeros: () => numeros };
  }

  it('🔴 un statut `sent` ne lit RIEN : ni la liste des espaces, ni le numéro', async () => {
    const { p, t, numeros } = puits([T]);
    await p.accuse('PN1', { messageId: 'wamid.1', status: 'sent', waId: '336', motif: null, codeMeta: null, le: null });
    expect(t.lectures()).toBe(0);
    expect(numeros()).toBe(0);
  });

  it('🔴 personne n’a branché d’outil : le numéro n’est pas résolu', async () => {
    const { p, t, numeros } = puits([]);
    await p.accuse('PN1', { messageId: 'wamid.1', status: 'delivered', waId: '336', motif: null, codeMeta: null, le: null });
    expect(numeros()).toBe(0);
    expect(t.jobs).toEqual([]);
  });

  it('un espace branché : l’accusé devient un signal de son espace, en priorité basse', async () => {
    const { p, t } = puits([T]);
    await p.accuse('PN1', { messageId: 'wamid.1', status: 'read', waId: '336', motif: null, codeMeta: null, le: null });
    expect(t.jobs.map((j) => [j.job.tenantId, j.job.signaux[0]!.nom, j.opts.priority])).toEqual([[T, 'em_message_read', 0]]);
  });

  it('🔴 la réponse ne transporte jamais le texte du message, et garde l’instant de Meta', async () => {
    const { p, t } = puits([T]);
    const envoyeLe = new Date('2026-09-24T09:59:00.000Z');
    await p.reponse(T, message({ body: 'mon adresse est 12 rue des Lilas', envoyeLe }));
    expect(t.jobs).toHaveLength(1);
    expect(JSON.stringify(t.jobs[0])).not.toContain('Lilas');
    expect(t.jobs[0]!.job.signaux[0]).toMatchObject({ nom: 'em_replied', canal: 'whatsapp', bouton: null, le: envoyeLe.toISOString() });
  });

  it('🔴 une réaction, un type non pris en charge ou inconnu n’est PAS une réponse', async () => {
    const { p, t } = puits([T]);
    await p.reponse(T, message({ type: 'reaction', body: '👍', buttonPayload: 'wamid.x' }));
    await p.reponse(T, message({ type: 'unsupported', body: null }));
    await p.reponse(T, message({ type: 'unknown', body: null }));
    expect(t.jobs).toEqual([]);
  });

  it('🔴 un message du contact en `standby` reste une réponse : l’agent de Meta tient le fil, le contact a bien écrit', async () => {
    // L'avance de scénario et les automations refusent le standby parce que RÉPONDRE reprendrait le fil à
    // l'agent de Meta. Un signal n'envoie rien au contact : cette raison ne s'applique pas. Et l'écho de ce que
    // l'agent a dit n'arrive jamais ici (`message_echoes`, lu par `processHandovers` seul, tâche 4).
    const { p, t } = puits([T]);
    await p.reponse(T, message({ field: 'standby' }));
    expect(t.jobs.map((j) => j.job.signaux[0]!.nom)).toEqual(['em_replied']);
  });
});

describe('annoncerAussiAuxSignaux : le désabonnement', () => {
  it('annonce au connecteur PUIS un signal par personne, dans UN job', async () => {
    const ordre: string[] = [];
    const { emetteur, jobs } = emetteurDeTest();
    await annoncerAussiAuxSignaux(async (t, w) => { ordre.push(`annonce:${t}:${w.join(',')}`); }, emetteur)(T, ['336', '337']);
    expect(ordre).toEqual([`annonce:${T}:336,337`]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.job.signaux).toMatchObject([
      { nom: 'em_opted_out', waId: '336', canal: 'whatsapp' },
      { nom: 'em_opted_out', waId: '337', canal: 'whatsapp' },
    ]);
  });

  it('🔴 un désabonnement de MASSE s’enfile en quelques jobs, pas un par fiche', async () => {
    const { emetteur, jobs } = emetteurDeTest();
    const waIds = Array.from({ length: 2 * SIGNAUX_PAR_JOB + 50 }, (_, i) => `3361234${String(i).padStart(4, '0')}`);
    await annoncerAussiAuxSignaux(async () => {}, emetteur)(T, waIds);
    expect(jobs.map((j) => j.job.signaux.length)).toEqual([SIGNAUX_PAR_JOB, SIGNAUX_PAR_JOB, 50]);
  });

  it('🔴 une annonce en panne n’empêche pas le signal, et son erreur remonte à qui la journalise', async () => {
    const { emetteur, jobs } = emetteurDeTest();
    const compose = annoncerAussiAuxSignaux(async () => { throw new Error('file pleine'); }, emetteur);
    await expect(compose(T, ['336'])).rejects.toThrow('file pleine');
    expect(jobs).toHaveLength(1);
  });
});
