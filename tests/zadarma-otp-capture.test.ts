import { describe, it, expect } from 'vitest';
import { capturerOtp, memeNumero } from '../src/zadarma/otp-capture';
import type { CaptureDeps } from '../src/zadarma/otp-capture';
import type { AppelEntrant, Transcription } from '../src/zadarma/api';

const NOTRE_NUMERO = '+33189480136';
const appel = (over: Partial<AppelEntrant> = {}): AppelEntrant => ({
  callId: 'c-neuf', appelant: '12025551234', destination: '33189480136', etat: 'answered', enregistre: true, debut: '2026-08-16 18:00:00', ...over,
});
const PRET = (texte: string): Transcription => ({ pret: true, texte, etat: 'recognized' });

/**
 * Horloge et attente simulées : le scénario complet se déroule en quelques millisecondes, sans jamais
 * dormir réellement. `attendre` fait avancer l'horloge, ce qui rend le délai d'abandon vérifiable.
 */
function deps(over: Partial<CaptureDeps> & { appels?: () => AppelEntrant[] } = {}): CaptureDeps & { journal: string[] } {
  let t = 1_000_000;
  const journal: string[] = [];
  const base: CaptureDeps & { journal: string[] } = {
    journal,
    appelsRecents: async () => (over.appels ? over.appels() : []),
    demanderAppel: async () => { journal.push('demanderAppel'); },
    demanderTranscription: async (id) => { journal.push(`demanderTranscription:${id}`); },
    lireTranscription: async () => ({ pret: false, texte: '', etat: 'in progress' }),
    attendre: async (ms) => { t += ms; },
    maintenant: () => t,
  };
  return Object.assign(base, over);
}

describe('memeNumero', () => {
  it('rapproche les formats qui se mélangent en pratique', () => {
    expect(memeNumero('+33189480136', '33189480136')).toBe(true);
    expect(memeNumero('0189480136', '+33 1 89 48 01 36')).toBe(true);
    expect(memeNumero('+33189480136', '+33189480142')).toBe(false);
    expect(memeNumero('', '33189480136')).toBe(false);
  });
});

describe('capturerOtp', () => {
  it('nominal : appel reçu, enregistré, transcrit -> code', async () => {
    let tour = 0;
    const d = deps({
      // 1er passage : instantané (rien). Ensuite l'appel de Meta apparaît.
      appels: () => (tour++ === 0 ? [] : [appel()]),
      lireTranscription: async () => PRET('votre code de verification est un deux trois quatre cinq six'),
    });
    const res = await capturerOtp(d, { numero: NOTRE_NUMERO });
    expect(res).toEqual({ ok: true, code: '123456', callId: 'c-neuf', transcription: 'votre code de verification est un deux trois quatre cinq six' });
    // L'instantané est pris AVANT de déclencher l'appel : sinon on ne saurait pas distinguer l'appel de Meta.
    expect(d.journal[0]).toBe('demanderAppel');
    expect(d.journal).toContain('demanderTranscription:c-neuf');
  });

  it('un appel ANTÉRIEUR au déclenchement est ignoré (c’est l’instantané qui tranche, pas l’heure)', async () => {
    const ancien = appel({ callId: 'c-vieux' });
    const d = deps({ appels: () => [ancien], lireTranscription: async () => PRET('code 999999') });
    const res = await capturerOtp(d, { numero: NOTRE_NUMERO, delaiTotalMs: 20_000 });
    expect(res).toEqual({ ok: false, cause: 'aucun_appel' });
    expect(d.journal).not.toContain('demanderTranscription:c-vieux');
  });

  it('un appel vers un AUTRE de nos numéros est ignoré', async () => {
    let tour = 0;
    const d = deps({ appels: () => (tour++ === 0 ? [] : [appel({ destination: '33423500716' })]) });
    expect(await capturerOtp(d, { numero: NOTRE_NUMERO, delaiTotalMs: 20_000 })).toEqual({ ok: false, cause: 'aucun_appel' });
  });

  it('🔴 appel reçu mais AUCUN enregistrement -> cause explicite (rien n’a décroché)', async () => {
    // C'est LE risque du montage : la doc Meta ne garantit rien face à un répondeur. La cause doit le dire.
    let tour = 0;
    const d = deps({ appels: () => (tour++ === 0 ? [] : [appel({ enregistre: false, etat: 'no answer' })]) });
    const res = await capturerOtp(d, { numero: NOTRE_NUMERO, delaiTotalMs: 20_000 });
    expect(res).toMatchObject({ ok: false, cause: 'appel_non_enregistre', callId: 'c-neuf' });
    expect((res as { details: string }).details).toContain('rien n’a décroché');
    expect(d.journal).not.toContain('demanderTranscription:c-neuf'); // rien à transcrire
  });

  it('enregistrement présent mais reconnaissance jamais prête -> transcription_indisponible', async () => {
    let tour = 0;
    const d = deps({
      appels: () => (tour++ === 0 ? [] : [appel()]),
      lireTranscription: async () => ({ pret: false, texte: '', etat: 'in progress' }),
    });
    const res = await capturerOtp(d, { numero: NOTRE_NUMERO, delaiTotalMs: 30_000 });
    expect(res).toMatchObject({ ok: false, cause: 'transcription_indisponible' });
    expect((res as { details: string }).details).toContain('in progress');
  });

  it('transcription lisible sans code certain -> abandon IMMÉDIAT (le texte ne changera plus)', async () => {
    let tour = 0;
    let lectures = 0;
    const d = deps({
      appels: () => (tour++ === 0 ? [] : [appel()]),
      lireTranscription: async () => { lectures += 1; return PRET('bonjour, laissez un message apres le bip'); },
    });
    const res = await capturerOtp(d, { numero: NOTRE_NUMERO, delaiTotalMs: 120_000 });
    expect(res).toMatchObject({ ok: false, cause: 'code_introuvable', transcription: 'bonjour, laissez un message apres le bip' });
    expect(lectures).toBe(1); // on ne relit pas 40 fois une transcription déjà rendue
  });

  it('🔴 un hoquet réseau pendant le sondage ne tue PAS la capture (la tentative Meta est déjà consommée)', async () => {
    // Au moment du sondage, `demanderAppel` a déjà brûlé une des 10 tentatives par numéro sur 72 h. Laisser
    // remonter un 5xx passager la gaspillerait alors que l'enregistrement de Meta nous attend.
    let tour = 0;
    const d = deps({
      appels: () => {
        tour += 1;
        if (tour === 2) throw new Error('ECONNRESET');
        return tour <= 1 ? [] : [appel()];
      },
      lireTranscription: async () => PRET('code 123456'),
    });
    expect(await capturerOtp(d, { numero: NOTRE_NUMERO, delaiTotalMs: 60_000 })).toMatchObject({ ok: true, code: '123456' });
  });

  it('panne durable -> la cause reste honnête ET porte la dernière erreur', async () => {
    // Sans ça, une panne Zadarma qui dure tout le sondage se lirait « Meta n'a pas appelé » et enverrait
    // chercher le problème du mauvais côté.
    // L'instantané passe (rien n'est encore consommé), puis Zadarma tombe : c'est le cas dangereux.
    let tour = 0;
    const d = deps({ appels: () => { if (tour++ === 0) return []; throw new Error('zadarma HTTP 503'); } });
    const res = await capturerOtp(d, { numero: NOTRE_NUMERO, delaiTotalMs: 20_000 });
    expect(res).toMatchObject({ ok: false, cause: 'aucun_appel' });
    expect((res as { details: string }).details).toContain('zadarma HTTP 503');
  });

  it('l’enregistrement n’apparaît qu’à la fin de l’appel : on continue d’attendre, puis on transcrit', async () => {
    let tour = 0;
    const d = deps({
      // instantané vide, puis appel en cours (non enregistré), puis le même appel enregistré.
      appels: () => { tour += 1; return tour <= 1 ? [] : tour <= 3 ? [appel({ enregistre: false })] : [appel()]; },
      lireTranscription: async () => PRET('123456'),
    });
    const res = await capturerOtp(d, { numero: NOTRE_NUMERO, delaiTotalMs: 60_000 });
    expect(res).toMatchObject({ ok: true, code: '123456' });
  });
});
