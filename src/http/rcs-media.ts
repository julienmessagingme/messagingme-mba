import type { FastifyInstance } from 'fastify';
import { forbidNonAdmin } from '../auth/middleware';
import type { Guard } from '../auth/middleware';
import { espaceVerifie, estUuid } from './scope';
import { typeImage, octetsDepuisDataUrl, mimeDeExtension, TAILLE_IMAGE_MAX } from '../rcs/image';
import type { MimeImage } from '../rcs/image';
import type { RcsMediaResume, RcsMediaFichier } from '../rcs/media-store.pg';

/** Une image de 2 Mo pèse ~2,7 Mo en base64. On laisse 4 Mo de marge, et pas plus : ce corps est en mémoire. */
const TAILLE_MAX_CORPS = 4 * 1024 * 1024;

/** Code d'URL : 26 caractères base32 Crockford minuscules (`newMediaCode`). */
const CODE_RE = /^[0-9a-hjkmnp-tv-z]{26}$/;

export interface RcsMediaRouteDeps {
  list(tenantId: string): Promise<RcsMediaResume[]>;
  /** Enregistre un visuel déjà validé et rend son résumé + son URL publique. */
  create(tenantId: string, input: { mime: MimeImage; bytes: Buffer; nom: string | null }): Promise<{ media: RcsMediaResume; url: string }>;
  remove(tenantId: string, id: string): Promise<boolean>;
  /** Le fichier derrière un code. Pas de tenant : la route de lecture est publique. */
  getByCode(code: string): Promise<RcsMediaFichier | null>;
}

/**
 * Visuels des messages RCS : téléversement (admin) et service du fichier (public : l'opérateur télécom va
 * chercher l'image à son adresse, sans session).
 * 🔴 Le type servi est celui déduit de la signature du fichier, jamais celui déclaré par le navigateur (sinon
 * l'hébergeur d'images devient hébergeur de pages) : trois formats, `nosniff`, `inline` avec un nom neutre.
 */
export function registerRcsMedia(app: FastifyInstance, deps: RcsMediaRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };

  app.get('/tenants/:tenantId/rcs/media', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    return reply.code(200).send({ media: await deps.list(tenant) });
  });

  app.post('/tenants/:tenantId/rcs/media', { ...opts, bodyLimit: TAILLE_MAX_CORPS }, async (req, reply) => {
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
    const { media, url } = await deps.create(tenant, { mime, bytes, nom });
    return reply.code(201).send({ media, url });
  });

  app.delete('/tenants/:tenantId/rcs/media/:id', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    if (forbidNonAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    // Identifiant mal formé : 404 avant la requête (sur une colonne uuid, Postgres lèverait, donc 500).
    if (!estUuid(id)) return reply.code(404).send({ error: 'visuel inconnu' });
    const fait = await deps.remove(tenant, id);
    if (!fait) return reply.code(404).send({ error: 'visuel inconnu' });
    return reply.code(200).send({ ok: true });
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

    const fichierStocke = await deps.getByCode(code);
    if (!fichierStocke || fichierStocke.mime !== mimeDemande) return reply.code(404).send({ error: 'introuvable' });

    return reply
      .code(200)
      .header('content-type', fichierStocke.mime)
      // `nosniff` : même avec un type juste, on interdit au navigateur de deviner autre chose.
      .header('x-content-type-options', 'nosniff')
      .header('content-disposition', `inline; filename="${code}"`)
      /**
       * Un jour, pas un an en `immutable` : Cloudflare met ces images en cache au bord et servirait un visuel supprimé
       * alors que l'origine rend 404. Un jour couvre la rafale de lectures d'une campagne et borne l'exposition.
       */
      .header('cache-control', 'public, max-age=86400')
      .send(fichierStocke.bytes);
  });
}
