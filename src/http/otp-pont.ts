import type { FastifyInstance, FastifyRequest } from 'fastify';
import { verifyRequest } from '../lib/signature';
import { journaliser } from '../lib/journal';
import { extraireCodeOtp } from '../otp/extraire-code';
import type { PgNumerosFournisStore } from '../otp/store.pg';

/**
 * LE PONT DU CODE DE VÉRIFICATION (lot 3a, spec `docs/superpowers/specs/2026-10-05-pont-du-code-design.md`, § 4).
 *
 * Meta vérifie un numéro que nous fournissons en l'appelant et en dictant un code. L'Asterisk du VPS décroche,
 * enregistre, puis son script (`ops/otp-asterisk/envoyer-otp.sh`) poste l'enregistrement ici. La route transcrit, lit
 * le code et l'écrit ; la page « Connecter WhatsApp » (lot 3b) le lit et l'affiche au client, qui le recopie dans la
 * fenêtre de Meta.
 *
 * 🔴 L'ADRESSE EST PUBLIQUE, ET C'EST LA SIGNATURE QUI LA FERME. L'API n'est pas joignable en local depuis l'Asterisk
 * (elle n'est que sur le réseau Docker) : le script passe par `api.messagingme.app`. La signature est celle de nos
 * services (`x-mm-service-signature`, `src/lib/signature.ts`), sur le corps brut, la méthode et le CHEMIN : le numéro
 * appelé et l'identifiant d'appel sont DANS le chemin pour être signés eux aussi. Elle est vérifiée AVANT de lire quoi
 * que ce soit d'autre, et une requête dans la fenêtre de cinq minutes ne peut être rejouée qu'à l'identique, ce que
 * l'unicité de `appel_id` rend sans effet.
 *
 * ⚠️ UNE RÉPONSE 200 QUAND AUCUN CODE N'EST CERTAIN : la ligne dit pourquoi, et le script efface le fichier sur tout
 * 2xx ; le rejouer donnerait le même résultat. Mais une TRANSCRIPTION EN PANNE rend 503 : la ligne s'écrit (/ops le
 * montre), le script GARDE l'enregistrement, et son rejeu remplace la ligne (relecture du lot 3a : une panne passagère
 * du service perdait le code). Refusent aussi : la signature (401, avant même le corps si l'en-tête n'a pas la forme),
 * le chemin (400), un corps qui n'est pas du son (415), un numéro hors de la réserve (404), le plafond (429).
 */

/** La forme d'une signature de nos services (`src/lib/signature.ts`). Sans elle, la requête tombe avant son corps. */
const FORME_SIGNATURE = /^v1=\d{1,15}\.[0-9a-f]{16}\.[0-9a-f]{64}$/i;

/**
 * Le plafond de la transcription, qui part sur NOTRE clé : au-delà, on ne transcrit plus ce numéro avant l'heure
 * suivante. Meta n'autorise que dix demandes de code par numéro sur 72 heures : dix appels en une heure ne viennent pas
 * de lui. Le script garde l'enregistrement (429), et le rejeu reste possible.
 */
export const PLAFOND_APPELS_PAR_HEURE = 10;

/** Corps brut capturé par l'analyseur JSON de l'application : la sonde d'auto-attaque envoie du JSON. */
type AvecCorpsBrut = FastifyRequest & { rawBody?: Buffer };

/** Quatre-vingt-dix secondes de son téléphonique en font moins de 1,5 Mo : 4 Mo laissent de la marge. */
export const TAILLE_MAX_ENREGISTREMENT = 4 * 1024 * 1024;

/** Le chemin, signé en entier. */
export const CHEMIN_PONT = '/internes/otp/appels/:numero/:appel';

const NUMERO = /^[1-9][0-9]{6,14}$/;
/** L'identifiant d'appel d'Asterisk (`UNIQUEID`, « 1728137328.12 »), ou tout identifiant borné du même alphabet. */
const APPEL = /^[A-Za-z0-9._-]{1,64}$/;

export interface OtpPontRouteDeps {
  /** Partagé avec le script de l'Asterisk (`OTP_PONT_SECRET`). Vide : la route n'est pas montée (`buildServer`). */
  secret: string;
  numeros: Pick<PgNumerosFournisStore, 'parNumero' | 'ecrireCode' | 'appelDejaLu' | 'appelsRecents'>;
  /** Transcrit l'enregistrement sur notre clé. Lève quand le service ne rend rien d'exploitable. */
  transcrire(audio: Buffer): Promise<string>;
  now?: () => number;
  windowMs?: number;
}

export function registerOtpPont(app: FastifyInstance, deps: OtpPontRouteDeps): void {
  const now = deps.now ?? (() => Date.now());
  const windowMs = deps.windowMs ?? 5 * 60 * 1000;

  // L'analyseur du son vit dans CETTE portée : déclaré sur l'application, il vaudrait pour toutes les routes.
  void app.register(async (portee) => {
    portee.addContentTypeParser(['audio/wav', 'audio/x-wav'], { parseAs: 'buffer', bodyLimit: TAILLE_MAX_ENREGISTREMENT }, (_req, corps, fait) => {
      fait(null, corps);
    });
    // Avant le corps : une requête sans en-tête de signature bien formé ne fait pas lire 4 Mo à l'API.
    portee.addHook('onRequest', async (req, reply) => {
      const entete = req.headers['x-mm-service-signature'];
      const valeur = Array.isArray(entete) ? entete[0] : entete;
      if (!valeur || !FORME_SIGNATURE.test(valeur.trim())) return reply.code(401).send({ error: 'signature invalide' });
    });

    portee.post(CHEMIN_PONT, { bodyLimit: TAILLE_MAX_ENREGISTREMENT }, async (req, reply) => {
      // 1. 🔴 La signature, sur le corps brut, avant tout le reste.
      const audio = Buffer.isBuffer(req.body) ? req.body : null;
      const brut = audio ?? (req as AvecCorpsBrut).rawBody;
      const entete = req.headers['x-mm-service-signature'];
      const signature = Array.isArray(entete) ? entete[0] : entete;
      const chemin = req.url.split('?')[0] ?? req.url;
      if (!brut || !verifyRequest(brut, signature, deps.secret, { method: req.method, path: chemin, now: now(), windowMs })) {
        return reply.code(401).send({ error: 'signature invalide' });
      }

      // 2. Le chemin, signé mais borné : il devient une clé de base.
      const { numero, appel } = req.params as { numero: string; appel: string };
      if (!NUMERO.test(numero) || !APPEL.test(appel)) return reply.code(400).send({ error: 'numéro ou identifiant d’appel invalide' });
      if (!audio || audio.length === 0) return reply.code(415).send({ error: 'enregistrement audio attendu (audio/wav)' });

      // 3. Le numéro doit être dans la réserve : un appel reçu ailleurs n'a pas de destinataire.
      const fourni = await deps.numeros.parNumero(numero);
      if (!fourni) {
        journaliser('warn', 'otp_numero_hors_reserve', { numero, appel });
        return reply.code(404).send({ error: 'numéro inconnu de la réserve' });
      }

      // 4. Ni un appel déjà lu, ni au-delà du plafond : la transcription part sur notre clé.
      if (await deps.numeros.appelDejaLu(appel)) return reply.code(200).send({ recu: true, deja: true });
      if (await deps.numeros.appelsRecents(fourni.id, 60) >= PLAFOND_APPELS_PAR_HEURE) {
        journaliser('warn', 'otp_plafond_appels', { numero, appel });
        return reply.code(429).send({ error: 'trop d’appels sur ce numéro cette heure-ci' });
      }

      // 5. La transcription, puis le code. Une panne s'écrit aussi (/ops dit pourquoi aucun code n'est venu), et rend
      //    503 : le script garde l'enregistrement pour un rejeu, qui remplacera la ligne.
      let transcription: string;
      try {
        transcription = await deps.transcrire(audio);
      } catch (err) {
        journaliser('error', 'otp_transcription_indisponible', { err, numero, appel });
        await deps.numeros.ecrireCode(fourni.id, { appelId: appel, code: null, transcription: '', cause: 'transcription_indisponible' });
        return reply.code(503).send({ recu: false });
      }
      const code = extraireCodeOtp(transcription);
      const ecrit = await deps.numeros.ecrireCode(fourni.id, code === null
        ? { appelId: appel, code: null, transcription, cause: 'code_introuvable' }
        : { appelId: appel, code, transcription });
      // Le code ne part ni dans le journal ni dans la réponse : il ne sert qu'au serveur, dans les dix minutes.
      journaliser('info', 'otp_appel_traite', { numero, appel, code: code !== null, deja: !ecrit });
      return reply.code(200).send({ recu: true, code: code !== null, deja: !ecrit });
    });
  });
}
