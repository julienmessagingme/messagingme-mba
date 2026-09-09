import { z } from 'zod';
import type { HttpTransport } from '../../meta/http';

/**
 * TRANSCRIRE un vocal par le Vercel AI Gateway (2026-09-09, demande de Julien).
 *
 * 🔴 CE CONTRAT A ETE MESURE, PAS LU. La documentation de Vercel ne decrit la transcription QUE par le SDK
 * `ai` (`experimental_transcribe`), que ce depot n utilise pas : il parle au Gateway en HTTP brut. Sonde le
 * 2026-09-09 :
 *   - `/v1/audio/transcriptions` (la forme OpenAI, celle qu on ecrirait d instinct) rend **404** ;
 *   - `/v4/ai/transcription-model` existe, et exige DEUX en-tetes que rien n annonce : `ai-model-id` et
 *     `ai-gateway-protocol-version`. Sans le second, la reponse est
 *     « Unsupported gateway protocol version », qui ne dit pas quelle version poser.
 * Aller-retour reel reussi (synthese puis transcription du meme fichier), langue detectee toute seule.
 * Ajouter le SDK aurait apporte une dependance entiere pour un appel.
 *
 * 🔴 LA REPONSE PORTE LE COUT, au MEME endroit que les completions
 * (`providerMetadata.gateway.cost`) : mesure a 0,000235 $ pour 2,35 s, soit exactement le tarif de
 * `whisper-1` (0,0001 $/s). La comptabilite existante se reutilise donc telle quelle. Sans ce champ il
 * aurait fallu recalculer depuis la duree, et une consommation sous-comptee ne se voit pas.
 */

const URL_TRANSCRIPTION = 'https://ai-gateway.vercel.sh/v4/ai/transcription-model';

/** La version de protocole exigee par l endpoint. Mesuree : sans elle, 400 « Unsupported gateway protocol version ». */
const VERSION_PROTOCOLE = '0.0.1';

/**
 * Reponse de transcription. `safeParse`, jamais `parse` ni `as` : reponse externe.
 *
 * ⚠️ Seul `text` est EXIGE. La duree, la langue et le cout sont optionnels a dessein : un fournisseur qui
 * cesserait de les rendre ne doit pas faire echouer une transcription par ailleurs correcte. C est l inverse
 * du choix fait pour la CREATION d une cle, ou l identifiant manquant rendait la cle impilotable : ici, ce
 * qui manque est du confort, pas la substance.
 */
const reponseSchema = z.object({
  text: z.string(),
  language: z.string().optional(),
  durationInSeconds: z.number().optional(),
  providerMetadata: z.object({
    gateway: z.object({ cost: z.number().optional(), generationId: z.string().optional() }).optional(),
  }).optional(),
});

export class TranscriptionError extends Error {
  constructor(readonly status: number | null, detail: string) {
    super(`transcription impossible (${status ?? 'reseau'}) : ${detail}`);
    this.name = 'TranscriptionError';
  }
}

/**
 * ⚠️ NE PAS CONFONDRE AVEC `Transcription` de `src/zadarma/api.ts`, qui porte le meme mot pour une autre
 * chose : celle-la transcrit l enregistrement d un APPEL TELEPHONIQUE, par identifiant d appel, via l API de
 * Zadarma, pour capter l OTP d embarquement d un numero. Ici il s agit d un FICHIER audio recu sur WhatsApp,
 * transcrit par un modele. Rien a partager entre les deux : ni le fournisseur, ni l entree, ni l usage. Le
 * suffixe `Audio` existe pour qu un import ne se trompe pas de porte.
 */
export interface TranscriptionAudio {
  texte: string;
  /** Langue detectee par le modele, quand il la rend. Sert a l affichage, jamais a une decision. */
  langue: string | null;
  secondes: number | null;
  /** Cout de CET appel, en DOLLARS, comme pour les completions. `null` si le fournisseur ne l a pas rendu. */
  coutDollars: number | null;
}

/**
 * Transcrit un fichier audio deja en memoire.
 *
 * ⚠️ L audio part en BASE64 dans un corps JSON, donc il pese un tiers de plus que le fichier. C est
 * l appelant qui borne la taille, avant meme de telecharger : ici, il est deja trop tard pour refuser sans
 * avoir paye la memoire.
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
    // Le message du fournisseur est repris : contrairement a la creation d une cle, ce corps ne porte aucun
    // secret, et il dit des choses utiles (format non supporte, fichier illisible).
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
    coutDollars: g?.cost ?? null,
  };
}
