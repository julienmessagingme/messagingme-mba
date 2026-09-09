import { describe, it, expect } from 'vitest';
import { transcrire, TranscriptionError } from '../src/agent/llm/transcription';
import { transcrireMessage, RienATranscrire, type DepsTranscrire, type MessageATranscrire } from '../src/inbox/transcrire';
import type { HttpResponse, HttpTransport } from '../src/meta/http';

/**
 * LA TRANSCRIPTION DES VOCAUX (2026-09-09, demande de Julien).
 *
 * 🔴 LE CONTRAT DE L'ENDPOINT A ÉTÉ MESURÉ, PAS LU, et c'est ce que ces tests figent. La documentation de
 * Vercel ne décrit la transcription QUE par le SDK `ai`. Sondé sur le vrai compte : la forme OpenAI
 * (`/v1/audio/transcriptions`) rend 404, et `/v4/ai/transcription-model` exige DEUX en-têtes que rien
 * n'annonce, dont une version de protocole sans laquelle la réponse est « Unsupported gateway protocol
 * version », qui ne dit pas laquelle poser. Trois façons de se tromper, aucune visible du compilateur.
 */

class FauxTransport implements HttpTransport {
  readonly appels: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
  constructor(private readonly reponses: HttpResponse[]) {}
  post(url: string, body: unknown, headers: Record<string, string>): Promise<HttpResponse> {
    this.appels.push({ url, body, headers });
    const r = this.reponses.shift();
    if (!r) throw new Error('appel non prevu');
    return Promise.resolve(r);
  }
}

/** La forme RÉELLE mesurée le 2026-09-09 sur le vrai Gateway. */
const OK: HttpResponse = {
  status: 200,
  json: {
    text: 'Bonjour, ma commande est-elle partie ?',
    language: 'fr',
    durationInSeconds: 2.35,
    providerMetadata: { gateway: { cost: 0.000235, generationId: 'gen_1' } },
  },
};

describe('Le client de transcription', () => {
  it('🔴 frappe /v4/ai/transcription-model avec SES DEUX en-têtes', async () => {
    const t = new FauxTransport([OK]);
    await transcrire(t, { cle: 'vck', modele: 'openai/whisper-1', bytes: Buffer.from('abc'), mime: 'audio/ogg' });

    const a = t.appels[0]!;
    expect(a.url).toBe('https://ai-gateway.vercel.sh/v4/ai/transcription-model');
    expect(a.headers.authorization).toBe('Bearer vck');
    expect(a.headers['ai-model-id']).toBe('openai/whisper-1');
    // Sans elle : 400 « Unsupported gateway protocol version », mesuré.
    expect(a.headers['ai-gateway-protocol-version']).toBe('0.0.1');
  });

  it('🔴 l’audio part en BASE64, avec son mediaType', async () => {
    const t = new FauxTransport([OK]);
    await transcrire(t, { cle: 'k', modele: 'm', bytes: Buffer.from('salut'), mime: 'audio/ogg' });
    expect(t.appels[0]!.body).toEqual({ audio: Buffer.from('salut').toString('base64'), mediaType: 'audio/ogg' });
  });

  it('🔴 le COÛT est lu, au même endroit que pour les complétions', async () => {
    // Mesuré : 0,000235 $ pour 2,35 s, soit exactement le tarif de whisper-1. Sans cette lecture, la
    // consommation serait sous-comptée en silence, ce qui ne se voit sur aucun écran.
    const r = await transcrire(new FauxTransport([OK]), { cle: 'k', modele: 'm', bytes: Buffer.from('x'), mime: 'audio/ogg' });
    expect(r).toEqual({ texte: 'Bonjour, ma commande est-elle partie ?', langue: 'fr', secondes: 2.35, coutDollars: 0.000235 });
  });

  it('une réponse SANS coût ni langue reste valide', async () => {
    // Seul `text` est exigé : un fournisseur qui cesserait de rendre le confort ne doit pas faire échouer une
    // transcription par ailleurs correcte. C'est l'inverse du choix fait pour la création d'une clé, où
    // l'identifiant manquant rendait la clé impilotable.
    const r = await transcrire(new FauxTransport([{ status: 200, json: { text: 'ok' } }]), { cle: 'k', modele: 'm', bytes: Buffer.from('x'), mime: 'audio/ogg' });
    expect(r).toEqual({ texte: 'ok', langue: null, secondes: null, coutDollars: null });
  });

  it('un corps illisible échoue plutôt que de rendre du vide', async () => {
    await expect(transcrire(new FauxTransport([{ status: 200, json: { transcript: 'x' } }]), { cle: 'k', modele: 'm', bytes: Buffer.from('x'), mime: 'audio/ogg' }))
      .rejects.toBeInstanceOf(TranscriptionError);
  });
});

/** Faux dépôt de messages, qui note ce qu'on lui écrit. */
function deps(msg: MessageATranscrire | null, reponses: HttpResponse[] = [OK]) {
  const ecrites: Array<{ texte: string; modele: string }> = [];
  const telechargements: string[] = [];
  const ordre: string[] = [];
  const lus: Array<{ messageId: string; conversationId?: string }> = [];
  const couts: Array<{ coutDollars: number | null; secondes: number | null }> = [];
  // ⚠️ La référence est GARDÉE : envelopper le transport sans la garder rendait `d.transport` inspectable
  // uniquement à travers l'enveloppe, et une assertion écrite dessus passait trivialement. Vu ici même.
  const faux = new FauxTransport(reponses);
  const d: DepsTranscrire = {
    lireMessage: async (_t, m2, c2) => { lus.push({ messageId: m2, ...(c2 ? { conversationId: c2 } : {}) }); return msg; },
    ecrireTranscription: async (_t, _m, texte, modele) => { ordre.push('ecrit'); ecrites.push({ texte, modele }); },
    telecharger: async (mediaId) => { telechargements.push(mediaId); return { bytes: Buffer.from('audio'), mime: 'audio/ogg' }; },
    transport: { post: (u, b, h) => { ordre.push('modele'); return faux.post(u, b, h); } },
    cle: 'vck-maison',
    modele: 'openai/whisper-1',
    tailleMaxOctets: 2 * 1024 * 1024,
    noterCout: (_t, _m, coutDollars, secondes) => { couts.push({ coutDollars, secondes }); },
  };
  return { d, faux, ecrites, telechargements, ordre, lus, couts };
}

describe('Transcrire le message d’une conversation', () => {
  it('🔴 un message DÉJÀ transcrit ne rappelle pas le modèle', async () => {
    // Deux clics, ou deux opérateurs sur la même conversation, paieraient sinon deux fois la même seconde
    // d'audio. Et la seconde transcription écraserait la première par une variante différente, ce qui ferait
    // douter de celle qu'on venait de lire.
    const { d, ecrites, telechargements } = deps({ id: 'm1', mediaId: 'media-1', mediaMime: 'audio/ogg', transcription: 'deja dit' });
    expect(await transcrireMessage(d, 't1', 'm1')).toEqual({ texte: 'deja dit', deja: true });
    expect(telechargements).toHaveLength(0);
    expect(ecrites).toHaveLength(0);
  });

  it('🔴 le résultat est ÉCRIT avant d’être rendu', async () => {
    // Un appel payé dont le résultat n'est pas enregistré serait repayé au clic suivant, indéfiniment.
    const { d, ordre, ecrites } = deps({ id: 'm1', mediaId: 'media-1', mediaMime: 'audio/ogg', transcription: null });
    const r = await transcrireMessage(d, 't1', 'm1');
    expect(r.deja).toBe(false);
    expect(ordre).toEqual(['modele', 'ecrit']);
    expect(ecrites).toEqual([{ texte: 'Bonjour, ma commande est-elle partie ?', modele: 'openai/whisper-1' }]);
  });

  it('🔴 le mime de WhatsApp perd ses paramètres avant de partir', async () => {
    // WhatsApp annonce `audio/ogg; codecs=opus`. Le paramètre après le point-virgule n'est pas un type, et
    // le passer tel quel a été refusé par des fournisseurs : l'appel échoue APRÈS avoir été payé.
    const { d, faux } = deps({ id: 'm1', mediaId: 'media-1', mediaMime: 'audio/ogg; codecs=opus', transcription: null });
    await transcrireMessage(d, 't1', 'm1');
    expect(faux.appels[0]!.body).toMatchObject({ mediaType: 'audio/ogg' });
  });

  it('🔴 c’est la clé MAISON qui paie, pas celle du client', async () => {
    // Décision de Julien du 2026-09-09 : « on va le payer nous-mêmes sur la clé API générale, et on verra
    // après si je la refacture au client ». Le jour où ça change, ce test dira exactement quoi changer.
    const { d, faux } = deps({ id: 'm1', mediaId: 'media-1', mediaMime: 'audio/ogg', transcription: null });
    await transcrireMessage(d, 't1', 'm1');
    expect(faux.appels[0]!.headers.authorization).toBe('Bearer vck-maison');
  });

  it('🔴 la CONVERSATION nommée dans l’URL est transmise au dépôt', async () => {
    // Sans elle, transcrire le message d'une AUTRE conversation du même espace réussirait : ce n'est pas une
    // faille (le filtre d'espace tient au-dessus) mais une route qui ne fait pas ce qu'elle dit, et ça se
    // paie plus tard, quand quelqu'un s'appuie sur le chemin pour raisonner.
    const { d, lus } = deps({ id: 'm1', mediaId: 'media-1', mediaMime: 'audio/ogg', transcription: null });
    await transcrireMessage(d, 't1', 'm1', 'conv-7');
    expect(lus).toEqual([{ messageId: 'm1', conversationId: 'conv-7' }]);
  });

  it('🔴 le COÛT est noté, il n’est pas lu puis jeté', async () => {
    // Julien a décidé que la clé maison paie, donc rien n'est débité au client. Sans trace, « combien nous
    // coûte la transcription » serait une question sans réponse, et c'est exactement le chiffre qui décidera
    // de la refacturer ou non.
    const { d, couts } = deps({ id: 'm1', mediaId: 'media-1', mediaMime: 'audio/ogg', transcription: null });
    await transcrireMessage(d, 't1', 'm1');
    expect(couts).toEqual([{ coutDollars: 0.000235, secondes: 2.35 }]);
  });

  it('un message déjà transcrit ne note AUCUN coût', async () => {
    // La contrepartie de l'idempotence : rien n'a été payé, rien ne doit être compté.
    const { d, couts } = deps({ id: 'm1', mediaId: 'media-1', mediaMime: 'audio/ogg', transcription: 'deja' });
    await transcrireMessage(d, 't1', 'm1');
    expect(couts).toHaveLength(0);
  });

  it('un message SANS média n’est pas transcriptible', async () => {
    const { d } = deps({ id: 'm1', mediaId: null, mediaMime: null, transcription: null });
    await expect(transcrireMessage(d, 't1', 'm1')).rejects.toBeInstanceOf(RienATranscrire);
  });

  it('🔴 un message d’un AUTRE espace est traité comme inexistant', async () => {
    // `lireMessage` filtre par espace : elle rend `null`, et on ne doit surtout pas distinguer « pas à vous »
    // de « n'existe pas », sinon la route confirmerait l'existence du message d'un autre client.
    const { d } = deps(null);
    await expect(transcrireMessage(d, 't-autre', 'm1')).rejects.toBeInstanceOf(RienATranscrire);
  });
});
