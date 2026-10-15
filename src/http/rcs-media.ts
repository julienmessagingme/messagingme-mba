import type { FastifyInstance } from 'fastify';
import { forbidNonAdmin, gardeEtendue } from '../auth/middleware';
import type { Guard, PreHandler } from '../auth/middleware';
import { espaceVerifie } from './scope';
import { typeImage, octetsDepuisDataUrl, mimeDeExtension, TAILLE_IMAGE_MAX } from '../rcs/image';
import type { MimeImage } from '../rcs/image';
import type { RcsMediaResume, RcsMediaFichier, IssueSuppression } from '../rcs/media-store.pg';

/** Une image de 2 Mo pèse ~2,7 Mo en base64. On laisse 4 Mo de marge, et pas plus : ce corps est en mémoire. */
const TAILLE_MAX_CORPS = 4 * 1024 * 1024;

/** Code d'URL : 26 caractères base32 Crockford minuscules (`newMediaCode`). */
const CODE_RE = /^[0-9a-hjkmnp-tv-z]{26}$/;

export interface RcsMediasDep {
  /** Le fichier derrière un code. Pas de tenant : la route de lecture est publique. */
  getByCode(code: string): Promise<RcsMediaFichier | null>;
}

export interface RcsMediaRouteDeps {
  medias: RcsMediasDep;
  /**
   * Dépose un visuel déjà validé sous le quota de l'offre de l'espace, et rend son résumé + son URL publique. Un fichier
   * identique déjà présent rend sa fiche (`existant`). Quota dépassé : `LimiteOffreError`, traduite en 402 par le serveur.
   */
  create(tenantId: string, input: { mime: MimeImage; bytes: Buffer; nom: string | null }): Promise<{ media: RcsMediaResume; url: string; existant: boolean }>;
  /** La médiathèque de l'espace : ses fichiers vivants avec leur adresse, ce qu'ils pèsent, et le quota (`null` = sans limite). */
  lister(tenantId: string): Promise<{ fichiers: Array<RcsMediaResume & { url: string }>; occupation: number; quota: number | null }>;
  /** Suppression douce, refusée tant que le fichier sert (spec médias, § 2.4). */
  supprimer(tenantId: string, code: string): Promise<IssueSuppression>;
}

/**
 * La médiathèque : téléversement (admin), liste (tout membre), suppression (admin), et service du fichier (public :
 * l'opérateur télécom va chercher l'image à son adresse, sans session). Le dépôt sert le bloc « message rapide » des
 * scénarios autant que le RCS : le module exige les scénarios (spec médias du 2026-10-14, § 2.3).
 * 🔴 Le type servi est celui déduit de la signature du fichier, jamais celui déclaré par le navigateur (sinon
 * l'hébergeur d'images devient hébergeur de pages) : trois formats, `nosniff`, `inline` avec un nom neutre.
 */
export function registerRcsMedia(app: FastifyInstance, deps: RcsMediaRouteDeps, garde: Guard, limiteCouteuse?: PreHandler): void {
  const opts = { preHandler: garde };

  app.post('/tenants/:tenantId/rcs/media', { ...gardeEtendue(garde, limiteCouteuse), bodyLimit: TAILLE_MAX_CORPS }, async (req, reply) => {
    const tenant = espaceVerifie(req);
    if (forbidNonAdmin(req, reply)) return;

    const body = (req.body ?? {}) as { dataUrl?: unknown; nom?: unknown };
    if (typeof body.dataUrl !== 'string') return reply.code(400).send({ error: 'dataUrl requis' });
    const bytes = octetsDepuisDataUrl(body.dataUrl);
    if (!bytes) return reply.code(400).send({ error: 'image illisible (data URL base64 attendue)' });
    // Poids vérifié sur les octets décodés, pas sur la longueur du texte reçu.
    if (bytes.length > TAILLE_IMAGE_MAX) {
      return reply.code(413).send({ error: `image trop lourde (${Math.round(TAILLE_IMAGE_MAX / 1024 / 1024)} Mo maximum)` });
    }
    // La signature tranche, jamais le type annoncé : un PDF renommé en .png est refusé.
    const mime = typeImage(bytes);
    // Message neutre : cet hébergeur sert aussi les photos de la chaîne WhatsApp, pas seulement le RCS.
    if (!mime) return reply.code(415).send({ error: 'format non accepté : seuls JPEG, PNG et GIF sont hébergeables' });

    const nom = typeof body.nom === 'string' && body.nom.trim() !== '' ? body.nom.trim().slice(0, 120) : null;
    const { media, url, existant } = await deps.create(tenant, { mime, bytes, nom });
    return reply.code(201).send({ media, url, existant });
  });

  app.get('/tenants/:tenantId/rcs/media', opts, async (req) => deps.lister(espaceVerifie(req)));

  app.delete('/tenants/:tenantId/rcs/media/:code', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    if (forbidNonAdmin(req, reply)) return;
    const { code } = req.params as { code: string };
    // Forme du code vérifiée avant la base : un code mal formé ne désigne aucun fichier.
    if (!CODE_RE.test(code)) return reply.code(404).send({ error: 'introuvable' });
    const issue = await deps.supprimer(tenant, code);
    if (issue.issue === 'introuvable') return reply.code(404).send({ error: 'introuvable' });
    if (issue.issue === 'utilise') {
      return reply.code(409).send({ error: 'ce fichier est encore utilisé', code: 'media_utilise', utilisations: issue.utilisations });
    }
    return reply.code(204).send();
  });

  /**
   * Lecture publique, montée hors des gardes : l'appelant (opérateur télécom, téléphone) n'a aucune session.
   * L'extension est exigée par le fournisseur (`.jpg`, `.jpeg`, `.png`, `.gif`) et doit correspondre au fichier.
   */
  app.get('/m/:fichier', async (req, reply) => {
    const { fichier } = req.params as { fichier: string };
    const m = /^([0-9a-z]+)\.([a-z]+)$/i.exec(typeof fichier === 'string' ? fichier.trim() : '');
    if (!m) return reply.code(404).send({ error: 'introuvable' });
    const code = m[1]!.toLowerCase();
    const mimeDemande = mimeDeExtension(m[2]!);
    // Forme du code vérifiée avant la base : cette adresse est publique et reçoit des scans.
    if (!CODE_RE.test(code) || mimeDemande === null) return reply.code(404).send({ error: 'introuvable' });

    const fichierStocke = await deps.medias.getByCode(code);
    if (!fichierStocke || fichierStocke.mime !== mimeDemande) return reply.code(404).send({ error: 'introuvable' });

    return reply
      .code(200)
      .header('content-type', fichierStocke.mime)
      // `nosniff` : même avec un type juste, on interdit au navigateur de deviner autre chose.
      .header('x-content-type-options', 'nosniff')
      .header('content-disposition', `inline; filename="${code}"`)
      /**
       * Un jour, pas un an en `immutable` : Cloudflare met ces images en cache au bord et servirait un visuel effacé
       * (suppression de l'espace) alors que l'origine rend 404. Un jour couvre la rafale de lectures d'une campagne et borne l'exposition.
       */
      .header('cache-control', 'public, max-age=86400')
      .send(fichierStocke.bytes);
  });
}
