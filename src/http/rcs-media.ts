import type { FastifyInstance } from 'fastify';
import { forbidNonAdmin } from '../auth/middleware';
import type { Guard } from '../auth/middleware';
import { scopeTenant, estUuid } from './scope';
import { typeImage, octetsDepuisDataUrl, mimeDeExtension, TAILLE_IMAGE_MAX } from '../rcs/image';
import type { MimeImage } from '../rcs/image';
import type { RcsMediaResume, RcsMediaFichier } from '../rcs/media-store.pg';

/** Une image de 2 Mo pèse ~2,7 Mo en base64. On laisse 4 Mo de marge, et pas plus : ce corps est en mémoire. */
const TAILLE_MAX_CORPS = 4 * 1024 * 1024;

/** Code d'URL : 26 caractères base32 Crockford minuscules (`newMediaCode`). */
const CODE_RE = /^[0-9a-hjkmnp-tv-z]{26}$/;

export interface RcsMediaRouteDeps {
  list(tenantId: string): Promise<RcsMediaResume[]>;
  /** Enregistre un visuel DÉJÀ validé et rend son résumé + son URL publique. */
  create(tenantId: string, input: { mime: MimeImage; bytes: Buffer; nom: string | null }): Promise<{ media: RcsMediaResume; url: string }>;
  remove(tenantId: string, id: string): Promise<boolean>;
  /** Le fichier derrière un code. Pas de tenant : la route de lecture est publique. */
  getByCode(code: string): Promise<RcsMediaFichier | null>;
}

/**
 * Visuels des messages RCS : téléversement (privé, admin) et service du fichier (PUBLIC).
 *
 * 🔴 POURQUOI UNE ROUTE PUBLIQUE. Un message RCS à visuel ne transporte pas l'image : il transporte son
 * ADRESSE, que l'opérateur télécom va chercher lui-même, sans session ni en-tête d'authentification. Sans
 * hébergement, un client devrait poser son image ailleurs et coller un lien, ce qui suffit à rendre la
 * fonctionnalité inutilisable pour celui à qui elle sert.
 *
 * 🔴 CE QUI EST SERVI, ET COMMENT. Le type rendu est celui DÉDUIT DE LA SIGNATURE du fichier à l'écriture,
 * jamais celui déclaré par le navigateur : servir un fichier pour ce qu'il prétend être est la façon
 * classique de transformer un hébergeur d'images en hébergeur de pages. Trois formats seulement, `nosniff`
 * posé, et `Content-Disposition: inline` avec un nom neutre (le nom d'origine en dirait trop sur le client).
 */
export function registerRcsMedia(app: FastifyInstance, deps: RcsMediaRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };

  app.get('/tenants/:tenantId/rcs/media', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    return reply.code(200).send({ media: await deps.list(tenant) });
  });

  app.post('/tenants/:tenantId/rcs/media', { ...opts, bodyLimit: TAILLE_MAX_CORPS }, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;

    const body = (req.body ?? {}) as { dataUrl?: unknown; nom?: unknown };
    if (typeof body.dataUrl !== 'string') return reply.code(400).send({ error: 'dataUrl requis' });
    const bytes = octetsDepuisDataUrl(body.dataUrl);
    if (!bytes) return reply.code(400).send({ error: 'image illisible (data URL base64 attendue)' });
    // Poids vérifié sur les OCTETS décodés, pas sur la longueur du texte reçu : c'est le fichier qui compte.
    if (bytes.length > TAILLE_IMAGE_MAX) {
      return reply.code(413).send({ error: `image trop lourde (${Math.round(TAILLE_IMAGE_MAX / 1024 / 1024)} Mo maximum)` });
    }
    // La SIGNATURE tranche, jamais le type annoncé. Un PDF renommé en .png est refusé ici.
    const mime = typeImage(bytes);
    // ⚠️ Le message ne nomme PLUS l'opérateur télécom. Cet hébergeur sert désormais deux chemins (les
    // visuels RCS et les photos de la chaîne WhatsApp), et un client de la chaîne à qui on parlait d'un
    // opérateur cherchait une cause qui n'existait pas sur son écran. La contrainte, elle, est bien la
    // nôtre : c'est ce que cet hébergeur sait relire et servir.
    if (!mime) return reply.code(415).send({ error: 'format non accepté : seuls JPEG, PNG et GIF sont hébergeables' });

    const nom = typeof body.nom === 'string' && body.nom.trim() !== '' ? body.nom.trim().slice(0, 120) : null;
    const { media, url } = await deps.create(tenant, { mime, bytes, nom });
    return reply.code(201).send({ media, url });
  });

  app.delete('/tenants/:tenantId/rcs/media/:id', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    // Un identifiant mal formé partait tel quel dans un `where id = $2` sur une colonne `uuid` : Postgres
    // levait, et la route rendait 500 là où tout le dépôt rend 404. ⚠️ Un 5xx est en plus le pire choix
    // ici, Cloudflare remplaçant le corps de toute réponse 5xx par sa propre page d'erreur.
    if (!estUuid(id)) return reply.code(404).send({ error: 'visuel inconnu' });
    const fait = await deps.remove(tenant, id);
    if (!fait) return reply.code(404).send({ error: 'visuel inconnu' });
    return reply.code(200).send({ ok: true });
  });

  /**
   * Lecture PUBLIQUE. Montée hors des gardes d'auth : l'appelant est l'opérateur télécom (ou le téléphone du
   * destinataire), qui n'a aucune session.
   *
   * L'extension du chemin n'est pas décorative : le fournisseur exige une adresse qui finit par `.jpg`,
   * `.jpeg`, `.png` ou `.gif`. Elle doit CORRESPONDRE au fichier stocké, sinon on servirait un PNG sous une
   * adresse en `.jpg`, ce qui trompe le cache autant que l'opérateur.
   */
  app.get('/m/:fichier', async (req, reply) => {
    const { fichier } = req.params as { fichier: string };
    const m = /^([0-9a-z]+)\.([a-z]+)$/i.exec(typeof fichier === 'string' ? fichier.trim() : '');
    if (!m) return reply.code(404).send({ error: 'introuvable' });
    const code = m[1]!.toLowerCase();
    const mimeDemande = mimeDeExtension(m[2]!);
    // Forme du code vérifiée AVANT la base : cette adresse est publique et reçoit des scans.
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
       * 🔴 UN JOUR, et pas un an. Le contenu d'un code ne change jamais, donc `immutable` sur un an semblait
       * évident. MESURÉ le 2026-08-24 sur la production : Cloudflare met ces images en cache au bord
       * (`cf-cache-status: HIT`), et continuait donc de servir un visuel SUPPRIMÉ alors que l'origine
       * répondait déjà 404. Une suppression qui ne supprime pas est exactement le genre de promesse qu'on ne
       * peut pas tenir.
       *
       * Un jour couvre entièrement la rafale de lectures d'une campagne (elle part en quelques minutes, et
       * chaque destinataire déclenche un téléchargement), et borne l'exposition après suppression.
       */
      .header('cache-control', 'public, max-age=86400')
      .send(fichierStocke.bytes);
  });
}
