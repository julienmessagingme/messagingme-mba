import { describe, it, expect } from 'vitest';
import {
  versBatch, pousserVersBatch, BatchApiError, BATCH_URL_PROFILS, BATCH_MAX_PROFILS, BATCH_MAX_EVENEMENTS,
  BATCH_MAX_TEXTE, type ProfilBatch,
} from '../src/signaux/batch';
import {
  NOM_DICTIONNAIRE_RE, CHAMPS_EVENEMENT, CHAMP_ID_EVENEMENT, MORCEAUX_RESUME, TEXTE_SIGNAL_MAX,
  type AnalyseDuSignal, type ContenuSignal, type NomEvenement, type SignalComplet,
} from '../src/signaux/types';
import type { HttpResponse, HttpTransport } from '../src/meta/http';

const LE = '2026-09-24T10:00:00.000Z';
const C = '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const S = 'd4e5f6a7-b8c9-4d0e-9f1a-2b3c4d5e6f70';
const ID = 'a'.repeat(32);

function signal(contenu: ContenuSignal, over: { externalId?: string | null; id?: string } = {}): SignalComplet {
  return {
    id: over.id ?? ID,
    le: LE,
    contact: { contactId: C, externalId: over.externalId === undefined ? 'crm-7781' : over.externalId, optOutWhatsapp: false, optOutRcs: false },
    contenu,
  };
}
const livre = (canal: 'whatsapp' | 'rcs' = 'whatsapp'): ContenuSignal => ({ nom: 'em_message_delivered', canal, origine: 'api', sendId: S });
const echecRcs: ContenuSignal = { nom: 'em_message_failed', canal: 'rcs', origine: null, sendId: null, motif: 'UNDELIVERABLE', codeMeta: null };
const analyse = (over: Partial<AnalyseDuSignal> = {}): ContenuSignal => ({
  nom: 'em_conversation_analyzed',
  analyse: {
    intent: 'sav', sentiment: 'positif', satisfaction: 8, urgence: 2, resolved: true, topic: 'livraison',
    actionSuggestion: 'aucune', handledBy: 'humain', exchangesCount: 6, summary: 'Le client demande où en est sa livraison.',
    ...over,
  },
});
function seul(r: ReturnType<typeof versBatch>): ProfilBatch {
  expect(r.requetes).toHaveLength(1);
  expect(r.requetes[0]).toHaveLength(1);
  return r.requetes[0]![0]!;
}

describe('versBatch : la traduction du dictionnaire (fonction PURE)', () => {
  it('un accusé de livraison devient un événement, et l’état courant de la fiche l’accompagne', () => {
    const p = seul(versBatch([signal(livre())], { resume: false }));
    expect(p.identifiers).toEqual({ custom_id: 'crm-7781' });
    expect(p.attributes).toEqual({ em_contact_id: C, em_whatsapp_optout: false, em_rcs_optout: false });
    expect(p.events).toEqual([
      { name: 'em_message_delivered', time: LE, attributes: { em_event_id: ID, canal: 'whatsapp', origine: 'api', send_id: S } },
    ]);
  });

  it('la joignabilité RCS suit la livraison dans les deux sens, et reste muette pour WhatsApp', () => {
    expect(seul(versBatch([signal(livre('rcs'))], { resume: false })).attributes?.em_rcs_reachable).toBe(true);
    expect(seul(versBatch([signal(echecRcs)], { resume: false })).attributes?.em_rcs_reachable).toBe(false);
    expect(seul(versBatch([signal(livre('whatsapp'))], { resume: false })).attributes).not.toHaveProperty('em_rcs_reachable');
  });

  it('une réponse date le dernier contact, et ne porte que le bouton', () => {
    const p = seul(versBatch([signal({ nom: 'em_replied', canal: 'whatsapp', bouton: 'Oui' })], { resume: false }));
    expect(p.attributes?.['date(em_last_reply_at)']).toBe(LE);
    expect(p.events?.[0]?.attributes).toEqual({ em_event_id: ID, canal: 'whatsapp', bouton: 'Oui' });
  });

  it('une valeur absente n’est pas envoyée : null ne s’écrit pas chez l’outil', () => {
    const p = seul(versBatch([signal({ nom: 'em_message_delivered', canal: 'whatsapp', origine: null, sendId: null })], { resume: false }));
    expect(p.events?.[0]?.attributes).toEqual({ em_event_id: ID, canal: 'whatsapp' });
  });

  it('🔴 un texte VIDE n’est pas envoyé non plus : l’outil le refuserait, seul et en silence (202 partiel)', () => {
    const clic = seul(versBatch([signal({ nom: 'em_link_clicked', lien: 'ab12cd34ef56', template: '', destination: '   ' })], { resume: false }));
    expect(clic.events?.[0]?.attributes).toEqual({ em_event_id: ID, lien: 'ab12cd34ef56' });
    const desabo = seul(versBatch([signal({ nom: 'em_opted_out', canal: null, source: '' })], { resume: false }));
    expect(desabo.events?.[0]?.attributes).toEqual({ em_event_id: ID });
  });

  it('🔴 un désabonnement posé par la console n’a pas de canal : seule sa source part', () => {
    const p = seul(versBatch([signal({ nom: 'em_opted_out', canal: null, source: 'crm' })], { resume: false }));
    expect(p.events?.[0]?.attributes).toEqual({ em_event_id: ID, source: 'crm' });
  });

  it('une conversation analysée met à jour les attributs de la fiche et porte l’analyse dans l’événement', () => {
    const p = seul(versBatch([signal(analyse())], { resume: false }));
    expect(p.attributes).toMatchObject({ em_last_intent: 'sav', em_last_sentiment: 'positif', em_last_resolved: true, em_satisfaction: 8, em_urgency: 2 });
    expect(p.events?.[0]?.attributes).toMatchObject({
      intent: 'sav', sentiment: 'positif', satisfaction: 8, urgence: 2, resolved: true, topic: 'livraison',
      action_suggestion: 'aucune', handled_by: 'humain', exchanges_count: 6,
    });
  });

  it('🔴 une note ABSENTE n’écrase pas la précédente, une note à 0 est une vraie mesure', () => {
    const sans = seul(versBatch([signal(analyse({ satisfaction: null, urgence: null }))], { resume: false }));
    expect(sans.attributes).not.toHaveProperty('em_satisfaction');
    expect(sans.attributes).not.toHaveProperty('em_urgency');
    const zero = seul(versBatch([signal(analyse({ satisfaction: 0, urgence: 0 }))], { resume: false }));
    expect(zero.attributes).toMatchObject({ em_satisfaction: 0, em_urgency: 0 });
  });

  it('🔴 le résumé ne part QUE si l’option est cochée : il contient des propos du client', () => {
    const sans = seul(versBatch([signal(analyse())], { resume: false })).events?.[0]?.attributes ?? {};
    for (const m of MORCEAUX_RESUME) expect(sans, m).not.toHaveProperty(m);
    const avec = seul(versBatch([signal(analyse())], { resume: true })).events?.[0]?.attributes ?? {};
    expect(avec.summary_1).toBe('Le client demande où en est sa livraison.');
    expect(avec).not.toHaveProperty('summary_2');
  });

  it('🔴 un résumé LONG part ENTIER, en morceaux de 300 au plus, à recoller dans l’ordre', () => {
    const long = 'Le client relance pour sa commande 4521, livrée incomplète. '.repeat(20).slice(0, 800);
    const a = seul(versBatch([signal(analyse({ summary: long }))], { resume: true })).events?.[0]?.attributes ?? {};
    const morceaux = MORCEAUX_RESUME.map((m) => a[m]).filter((v): v is string => typeof v === 'string');
    expect(morceaux.join('')).toBe(long);
    for (const m of morceaux) expect(m.length).toBeLessThanOrEqual(BATCH_MAX_TEXTE);
  });

  it('🔴 chaque événement porte EXACTEMENT les champs du dictionnaire, plus em_event_id', () => {
    const pleins: ContenuSignal[] = [
      { nom: 'em_message_delivered', canal: 'rcs', origine: 'campagne', sendId: S },
      { nom: 'em_message_read', canal: 'whatsapp', origine: 'api', sendId: S },
      { nom: 'em_message_failed', canal: 'whatsapp', origine: 'api', sendId: S, motif: '131026 Message undeliverable', codeMeta: 131026 },
      { nom: 'em_replied', canal: 'whatsapp', bouton: 'Oui' },
      { nom: 'em_link_clicked', lien: 'ab12cd34ef56', template: 'promo', destination: 'https://client.fr/promo' },
      { nom: 'em_opted_out', canal: 'whatsapp', source: 'whatsapp_stop' },
      analyse({ summary: 'x'.repeat(700) }),
    ];
    expect(pleins.map((c) => c.nom).sort()).toEqual(Object.keys(CHAMPS_EVENEMENT).sort());
    for (const c of pleins) {
      const e = seul(versBatch([signal(c)], { resume: true })).events?.[0];
      const attendus = [CHAMP_ID_EVENEMENT, ...CHAMPS_EVENEMENT[c.nom as NomEvenement]].sort();
      expect(Object.keys(e?.attributes ?? {}).sort(), c.nom).toEqual(attendus);
    }
  });

  it('la borne du dictionnaire tient dans celle de l’outil', () => {
    expect(TEXTE_SIGNAL_MAX).toBeLessThanOrEqual(BATCH_MAX_TEXTE);
  });

  it('🔴 une fiche SANS externalId n’est pas poussée, et elle est COMPTÉE', () => {
    const r = versBatch([signal(livre(), { externalId: null }), signal(livre(), { externalId: '  ' }), signal(livre())], { resume: false });
    expect(r.sansIdentifiant).toBe(2);
    expect(r.requetes.flat().map((p) => p.identifiers.custom_id)).toEqual(['crm-7781']);
  });

  it('deux signaux d’une même fiche : un profil, les événements dans l’ordre, le dernier état gagne', () => {
    const p = seul(versBatch([signal(livre('rcs'), { id: '1'.repeat(32) }), signal(echecRcs, { id: '2'.repeat(32) })], { resume: false }));
    expect(p.events?.map((e) => e.name)).toEqual(['em_message_delivered', 'em_message_failed']);
    expect(p.attributes?.em_rcs_reachable).toBe(false);
  });

  it(`🔴 jamais plus de ${BATCH_MAX_PROFILS} profils par appel`, () => {
    const signaux = Array.from({ length: 450 }, (_, i) => signal(livre(), { externalId: `crm-${i}` }));
    expect(versBatch(signaux, { resume: false }).requetes.map((r) => r.length)).toEqual([200, 200, 50]);
  });

  it(`🔴 jamais plus de ${BATCH_MAX_EVENEMENTS} événements par profil et par appel, jamais deux fois le même profil dans un appel`, () => {
    const signaux = Array.from({ length: 40 }, (_, i) => signal(livre(), { id: i.toString(16).padStart(32, '0') }));
    const { requetes } = versBatch(signaux, { resume: false });
    expect(requetes.map((r) => r.map((p) => p.events?.length ?? 0))).toEqual([[15], [15], [10]]);
    for (const r of requetes) {
      const ids = r.map((p) => p.identifiers.custom_id);
      expect(new Set(ids).size).toBe(ids.length);
    }
    // L'état de la fiche part avec la DERNIÈRE tranche, celle que l'outil reçoit en dernier.
    expect(requetes.map((r) => r[0]!.attributes === undefined)).toEqual([true, true, false]);
  });

  it('🔴 aucun texte au-delà de 300 caractères ni vide, de fiche COMME d’événement, et toute clé tient la règle des noms', () => {
    // La borne vaut pour les attributs d'ÉVÉNEMENT aussi (page de l'API Profils, « Event attributes »). Un texte
    // trop long y serait rejeté seul, en 202 partiel : aucun test HTTP ne le verrait, la donnée disparaîtrait.
    const long = 'x'.repeat(2000);
    const signaux = [
      signal({ nom: 'em_message_failed', canal: 'whatsapp', origine: long, sendId: S, motif: long, codeMeta: 131026 }, { externalId: 'a' }),
      signal({ nom: 'em_link_clicked', lien: 'ab12cd34ef56', template: long, destination: long }, { externalId: 'b' }),
      signal(analyse({ topic: long, summary: long }), { externalId: 'c' }),
    ];
    const cle = /^([a-z0-9_]{1,30}|date\([a-z0-9_]{1,30}\))$/;
    for (const p of versBatch(signaux, { resume: true }).requetes.flat()) {
      for (const [k, v] of Object.entries(p.attributes ?? {})) {
        expect(k).toMatch(cle);
        if (typeof v === 'string') {
          expect(v.length, k).toBeLessThanOrEqual(BATCH_MAX_TEXTE);
          expect(v.trim(), k).not.toBe('');
        }
      }
      for (const e of p.events ?? []) {
        expect(e.name).toMatch(NOM_DICTIONNAIRE_RE);
        for (const [k, v] of Object.entries(e.attributes)) {
          expect(k).toMatch(cle);
          if (typeof v === 'string') {
            expect(v.length, k).toBeLessThanOrEqual(BATCH_MAX_TEXTE);
            expect(v.trim(), k).not.toBe('');
          }
        }
      }
    }
  });

  it('🔴 `evenementsDepuis` : un événement plus ancien ne part pas, il est COMPTÉ, et l’état de sa fiche part quand même', () => {
    // L'outil refuse un événement de plus de 24 h (page de l'API Profils, relue le 2026-09-25). La coupure est
    // une OPTION (la fonction reste pure, sans date) : c'est le travail de la file qui la calcule.
    const vieux = { ...signal(livre('rcs'), { id: '1'.repeat(32) }), le: '2026-09-23T09:00:00.000Z' };
    const recent = signal(echecRcs, { id: '2'.repeat(32) });
    const r = versBatch([vieux, recent], { resume: false, evenementsDepuis: '2026-09-23T10:00:00.000Z' });
    expect(r.tropVieux).toBe(1);
    const p = seul(r);
    expect(p.events?.map((e) => e.attributes[CHAMP_ID_EVENEMENT])).toEqual(['2'.repeat(32)]);
    expect(p.attributes?.em_rcs_reachable).toBe(false);

    // Tous trop vieux : un profil SANS `events`, qui porte l'état de la fiche (celui du vieux signal compris).
    const seulVieux = versBatch([vieux], { resume: false, evenementsDepuis: '2026-09-23T10:00:00.000Z' });
    expect(seulVieux.tropVieux).toBe(1);
    expect(seul(seulVieux)).toEqual({ identifiers: { custom_id: 'crm-7781' }, attributes: { em_contact_id: C, em_whatsapp_optout: false, em_rcs_optout: false, em_rcs_reachable: true } });

    // Sans l'option, rien n'est écarté : le comportement d'avant.
    expect(versBatch([vieux], { resume: false }).tropVieux).toBe(0);
  });
});

class FauxTransport implements HttpTransport {
  readonly appels: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
  constructor(private readonly reponses: Array<HttpResponse | Error>) {}
  async post(url: string, body: unknown, headers: Record<string, string>): Promise<HttpResponse> {
    this.appels.push({ url, body, headers });
    const r = this.reponses.shift();
    if (r === undefined) throw new Error('faux transport : plus de réponse prévue');
    if (r instanceof Error) throw r;
    return r;
  }
}
const CLES = { cleRest: 'cle-rest-test', cleProjet: 'projet-test' };
const REQUETE: ProfilBatch[] = [{ identifiers: { custom_id: 'crm-7781' }, attributes: { em_contact_id: C } }];
const vite = { sleep: async (): Promise<void> => {} };

describe('pousserVersBatch : le client HTTP', () => {
  it('pose l’adresse, les deux en-têtes et le corps', async () => {
    const t = new FauxTransport([{ status: 202, json: { code: 'SUCCESS' } }]);
    expect(await pousserVersBatch(REQUETE, CLES, t, vite)).toEqual({ partiel: null });
    expect(t.appels).toEqual([{
      url: BATCH_URL_PROFILS, body: REQUETE,
      headers: { authorization: 'Bearer cle-rest-test', 'x-batch-project': 'projet-test' },
    }]);
  });

  it('un succès PARTIEL est rendu, pas avalé', async () => {
    const t = new FauxTransport([{ status: 202, json: {
      code: 'SUCCESS_WITH_PARTIAL_ERRORS',
      errors: [{ category: 'attribute', bulk_index: 0, attribute: 'em_last_intent', reason: 'invalid value' }],
    } }]);
    expect(await pousserVersBatch(REQUETE, CLES, t, vite)).toEqual({ partiel: 'em_last_intent : invalid value' });
  });

  it('🔴 429 et 5xx sont rejoués', async () => {
    const t = new FauxTransport([
      { status: 429, json: { error_code: 'TOO_MANY_REQUESTS' }, headers: { 'retry-after': '1' } },
      { status: 503, json: null },
      { status: 202, json: { code: 'SUCCESS' } },
    ]);
    expect(await pousserVersBatch(REQUETE, CLES, t, vite)).toEqual({ partiel: null });
    expect(t.appels).toHaveLength(3);
  });

  it('🔴 une panne réseau est rejouée', async () => {
    const t = new FauxTransport([new TypeError('fetch failed'), { status: 202, json: { code: 'SUCCESS' } }]);
    await pousserVersBatch(REQUETE, CLES, t, vite);
    expect(t.appels).toHaveLength(2);
  });

  it('🔴 un 4xx est TERMINAL : un seul appel, une erreur non rejouable qui porte le message de l’outil', async () => {
    const t = new FauxTransport([{ status: 400, json: { error_code: 'MALFORMED_PARAMETER', error_message: 'custom_id too long' } }]);
    const err = await pousserVersBatch(REQUETE, CLES, t, vite).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BatchApiError);
    expect(err).toMatchObject({ status: 400, retryable: false, detail: 'custom_id too long' });
    expect(t.appels).toHaveLength(1);
    // 🔴 Ce message part dans Sécurité > Journal des erreurs : il ne nomme pas l'outil (spec § 10).
    expect((err as Error).message).not.toMatch(/batch/i);
  });

  it('les nouveaux essais sont bornés, puis l’erreur remonte REJOUABLE (pour la file)', async () => {
    const t = new FauxTransport([{ status: 500, json: null }, { status: 500, json: null }]);
    const err = await pousserVersBatch(REQUETE, CLES, t, { ...vite, maxRetries: 1 }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 500, retryable: true });
    expect(t.appels).toHaveLength(2);
  });
});
