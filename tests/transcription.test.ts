import { describe, it, expect } from 'vitest';
import { transcrire, TranscriptionError } from '../src/agent/llm/transcription';
import { transcrireMessage, RienATranscrire, type DepsTranscrire, type MessageATranscrire } from '../src/inbox/transcrire';
import type { HttpResponse, HttpTransport } from '../src/meta/http';
import { MediaExpire } from '../src/inbox/media-entrant';
import { MetaApiError } from '../src/meta/errors';

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

/**
 * La forme REELLE, re-mesuree le 2026-09-11 sur le vrai Gateway.
 *
 * 🔴 CE FAUX ETAIT FAUX, ET C EST CE QUI A LAISSE PASSER LE DEFAUT. Il posait `cost` en NOMBRE ; le Gateway
 * rend une CHAINE. Les tests etaient donc verts pendant que chaque clic sur Transcrire echouait en
 * production, parce qu un test unitaire monte un faux cablage et que le faux ne bouge pas avec le vrai.
 * Les champs annexes (`segments`, `warnings`, `routing`, `marketCost`) sont gardes tels quels : le schema
 * doit continuer de les ignorer sans broncher.
 */
const OK: HttpResponse = {
  status: 200,
  json: {
    text: 'Bonjour, ma commande est-elle partie ?',
    segments: [{ text: ' Bonjour, ma commande est-elle partie ?', startSecond: 0, endSecond: 2.35 }],
    language: 'fr',
    durationInSeconds: 2.35,
    warnings: [],
    providerMetadata: {
      gateway: {
        routing: { originalModelId: 'openai/whisper-1', finalProvider: 'openai' },
        cost: '0.000235',
        marketCost: '0.000235',
        surchargeCost: '0',
        generationId: 'gen_1',
      },
    },
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

  it('🔴 le COÛT arrive en CHAÎNE de caractères, et il est lu comme un nombre', async () => {
    // 0,000235 $ pour 2,35 s, soit exactement le tarif de whisper-1. Le Gateway le rend en CHAÎNE, comme
    // pour les complétions : un schéma qui en attendait un nombre refusait TOUTE la réponse, donc faisait
    // échouer une transcription déjà payée.
    const r = await transcrire(new FauxTransport([OK]), { cle: 'k', modele: 'm', bytes: Buffer.from('x'), mime: 'audio/ogg' });
    expect(r).toEqual({ texte: 'Bonjour, ma commande est-elle partie ?', langue: 'fr', secondes: 2.35, coutDollars: 0.000235 });
  });

  it('une réponse SANS coût ni langue reste valide', async () => {
    // Seul `text` est exigé : un fournisseur qui cesserait de rendre le confort ne doit pas faire échouer une
    // transcription par ailleurs correcte. C'est l'inverse du choix fait pour la création d'une clé, où
    // l'identifiant manquant rendait la clé impilotable.
    // ⚠️ Celui-ci éprouve le champ ABSENT ; le test juste en dessous éprouve le champ PRÉSENT au MAUVAIS
    // type, qui est le cas réellement survenu. Les deux se ressemblent et un seul des deux a cassé.
    const r = await transcrire(new FauxTransport([{ status: 200, json: { text: 'ok' } }]), { cle: 'k', modele: 'm', bytes: Buffer.from('x'), mime: 'audio/ogg' });
    expect(r).toEqual({ texte: 'ok', langue: null, secondes: null, coutDollars: null });
  });

  it('un corps illisible échoue plutôt que de rendre du vide', async () => {
    await expect(transcrire(new FauxTransport([{ status: 200, json: { transcript: 'x' } }]), { cle: 'k', modele: 'm', bytes: Buffer.from('x'), mime: 'audio/ogg' }))
      .rejects.toBeInstanceOf(TranscriptionError);
  });

  it('🔴 un champ de CONFORT dont le type dérive ne fait plus échouer la transcription', async () => {
    // C'est le défaut exact qui cassait le bouton, rejoué sur un AUTRE champ : ce qui a dérivé une fois
    // dérivera ailleurs. Le texte est là, il est payé, il sort ; seul le confort manquant retombe à `null`.
    const derive: HttpResponse = {
      status: 200,
      json: {
        text: 'le texte est bon',
        language: 42,
        durationInSeconds: '2.35',
        providerMetadata: { gateway: { cost: '0.0001' } },
      },
    };
    const r = await transcrire(new FauxTransport([derive]), { cle: 'k', modele: 'm', bytes: Buffer.from('x'), mime: 'audio/ogg' });
    expect(r).toEqual({ texte: 'le texte est bon', langue: null, secondes: null, coutDollars: 0.0001 });
  });

  it('🔴 un coût ILLISIBLE rend `null`, jamais `0`', async () => {
    // Un coût nul et un coût inconnu se ressemblent sur un écran et n'ont rien à voir : compter l'inconnu
    // comme zéro ferait croire à une transcription gratuite, et c'est ce chiffre qui décidera de la
    // refacturer. ⚠️ La chaîne VIDE est du même lot : `Number('')` vaut 0.
    for (const cost of ['gratuit', '', ' ']) {
      const r = await transcrire(
        new FauxTransport([{ status: 200, json: { text: 'x', providerMetadata: { gateway: { cost } } } }]),
        { cle: 'k', modele: 'm', bytes: Buffer.from('x'), mime: 'audio/ogg' },
      );
      expect(r.coutDollars, `cost=${JSON.stringify(cost)}`).toBeNull();
    }
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
    // ⚠️ `langue` et `traduction` a null : SANS langue cible (migration 0137), la traduction est
    // eteinte et aucun second appel n'est fait. Le cas exerce ici ne change pas d'un iota, seule la
    // FORME du retour s'est elargie.
    expect(await transcrireMessage(d, 't1', 'm1')).toEqual({ texte: 'deja dit', deja: true, langue: null, traduction: null });
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

  it('🔴 un vocal EXPIRÉ n’appelle pas Meta : il est trop tard, et on le dit', async () => {
    // Passé sept jours, l'appel échouerait à coup sûr. Le dire avant évite un aller-retour, et surtout
    // évite de répondre « réessayez » sur un fichier qui ne reviendra jamais.
    const { d, telechargements } = deps({ id: 'm1', mediaId: 'media-1', mediaMime: 'audio/ogg', transcription: null, mediaExpire: true });
    await expect(transcrireMessage(d, 't1', 'm1')).rejects.toBeInstanceOf(MediaExpire);
    expect(telechargements).toHaveLength(0);
  });

  it('🔴 un vocal expiré mais DÉJÀ transcrit se relit toujours', async () => {
    // La transcription faite quand le fichier existait est à nous : l'expiration ne la reprend pas.
    const { d } = deps({ id: 'm1', mediaId: 'media-1', mediaMime: 'audio/ogg', transcription: 'deja dit', mediaExpire: true });
    expect((await transcrireMessage(d, 't1', 'm1')).texte).toBe('deja dit');
  });

  it('🔴 Meta répond 100/33 : c’est un vocal EXPIRÉ, pas une panne', async () => {
    const { d } = deps({ id: 'm1', mediaId: 'media-1', mediaMime: 'audio/ogg', transcription: null });
    d.telecharger = async () => { throw new MetaApiError(400, { code: 100, error_subcode: 33 }); };
    await expect(transcrireMessage(d, 't1', 'm1')).rejects.toBeInstanceOf(MediaExpire);
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
