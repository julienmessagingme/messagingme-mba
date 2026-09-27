import { z } from 'zod';
import type { HttpTransport } from '../../meta/http';

/**
 * Transcrire un vocal par le Vercel AI Gateway, en HTTP brut (la documentation ne décrit que le SDK `ai`).
 *
 * Contrat mesuré, pas lu : `/v1/audio/transcriptions` (la forme OpenAI) rend 404 ; l'adresse retenue exige
 * deux en-têtes que rien n'annonce, `ai-model-id` et `ai-gateway-protocol-version`.
 *
 * 🔴 La réponse porte le coût au même endroit que les complétions (`providerMetadata.gateway.cost`), en
 * chaîne décimale de dollars : la comptabilité existante se réutilise.
 */

const URL_TRANSCRIPTION = 'https://ai-gateway.vercel.sh/v4/ai/transcription-model';

/** La version de protocole exigée par l'endpoint : sans elle, 400 « Unsupported gateway protocol version ». */
const VERSION_PROTOCOLE = '0.0.1';

/** Le coût arrive en chaîne décimale de dollars (`"0.0001"`), comme dans `llm/chat-client.ts`. */
const COUT = z.union([z.number(), z.string()]).optional().catch(undefined);

/**
 * Seul `text` est exigé. Chaque champ de confort porte `.catch(undefined)` : un type qui dérive ne doit pas
 * faire échouer le `safeParse` entier, donc refuser une transcription bonne et déjà payée.
 */
/** Reponse de transcription. `safeParse`, jamais `parse` ni `as` : reponse externe. */
const reponseSchema = z.object({
  text: z.string(),
  language: z.string().optional().catch(undefined),
  durationInSeconds: z.number().optional().catch(undefined),
  providerMetadata: z.object({
    gateway: z.object({ cost: COUT, generationId: z.string().optional().catch(undefined) }).optional().catch(undefined),
  }).optional().catch(undefined),
});

/**
 * `"0.0001"` ou `0.0001` rendent `0.0001` ; tout le reste rend `null`, jamais `0` : un coût illisible n'est
 * pas un coût nul (la chaîne vide aussi, puisque `Number("")` vaut 0).
 */
function dollarsOuNull(v: number | string | undefined): number | null {
  if (v === undefined) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export class TranscriptionError extends Error {
  constructor(readonly status: number | null, detail: string) {
    super(`transcription impossible (${status ?? 'reseau'}) : ${detail}`);
    this.name = 'TranscriptionError';
  }
}

/**
 * À ne pas confondre avec `Transcription` de `src/zadarma/api.ts` (l'enregistrement d'un appel
 * téléphonique) : ici, un fichier audio reçu sur WhatsApp, transcrit par un modèle.
 */
export interface TranscriptionAudio {
  texte: string;
  /** Langue detectee par le modele, quand il la rend. Sert a l affichage, jamais a une decision. */
  langue: string | null;
  secondes: number | null;
  /** Coût de cet appel, en dollars, comme pour les complétions. `null` si le fournisseur ne l'a pas rendu. */
  coutDollars: number | null;
}

/**
 * Transcrit un fichier audio déjà en mémoire. L'audio part en base64 (un tiers de plus) : c'est l'appelant
 * qui borne la taille, avant même de télécharger.
 */
export async function transcrire(
  transport: HttpTransport,
  o: { cle: string; modele: string; bytes: Buffer; mime: string; signal?: AbortSignal },
): Promise<TranscriptionAudio> {
  let res;
  try {
    res = await transport.post(
      URL_TRANSCRIPTION,
      { audio: o.bytes.toString('base64'), mediaType: o.mime },
      {
        authorization: `Bearer ${o.cle}`,
        'ai-model-id': o.modele,
        'ai-gateway-protocol-version': VERSION_PROTOCOLE,
      },
      o.signal ? { signal: o.signal } : undefined,
    );
  } catch (err) {
    throw new TranscriptionError(null, err instanceof Error ? err.name : 'appel impossible');
  }
  if (res.status < 200 || res.status >= 300) {
    // Le message du fournisseur est repris : ce corps ne porte aucun secret, et il dit des choses utiles.
    const msg = (res.json as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${res.status}`;
    throw new TranscriptionError(res.status, msg);
  }
  const parse = reponseSchema.safeParse(res.json);
  if (!parse.success) throw new TranscriptionError(res.status, 'reponse illisible');
  const g = parse.data.providerMetadata?.gateway;
  return {
    texte: parse.data.text,
    langue: parse.data.language ?? null,
    secondes: parse.data.durationInSeconds ?? null,
    coutDollars: dollarsOuNull(g?.cost),
  };
}
