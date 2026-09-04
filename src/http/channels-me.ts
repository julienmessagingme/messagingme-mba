import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { forbidNonAdmin } from '../auth/middleware';
import type { Guard } from '../auth/middleware';
import { RateLimiter } from '../auth/rate-limit';
import { urlRecuperable } from '../lib/page-distante';
import { lienWaMe } from '../lib/wa-me';
import { nouveauJeton, textePreRempli } from '../channels-me/jeton';
import type { Connexion, ConnexionPublique, Organisation, MessageChannel, Message } from '../channels-me/types';
import type { LienRow } from '../channels-me/link-store.pg';
import type { PostRow } from '../channels-me/post-store.pg';
import { scopeTenant, estUuid } from './scope';

/**
 * Chaine WhatsApp (Channels Me) : publier un post dont le bouton (un lien wa.me pre-rempli) demarre un
 * scenario. Lecture ouverte a tout compte authentifie (les ecrans en ont besoin), ECRITURES admin-only :
 * publier sur une chaine, c'est parler a toute une audience sans qu'un humain relise.
 */
export interface ChannelsMeRouteDeps {
  /** Projection PUBLIQUE de la connexion : jamais les colonnes chiffrees. null = rien de provisionne. */
  getConnection(tenantId: string): Promise<ConnexionPublique | null>;
  /** Les identifiants EN CLAIR, dechiffres par le store. Ils ne servent qu'au client, ils ne sortent jamais d'ici. */
  getSecrets(tenantId: string): Promise<Connexion | null>;
  upsertConnection(tenantId: string, c: Connexion): Promise<void>;
  markVerified(tenantId: string): Promise<void>;

  getOrganisation(cx: Connexion): Promise<Organisation>;
  listChannels(cx: Connexion): Promise<MessageChannel[]>;
  getMessages(cx: Connexion): Promise<Message[]>;
  createMessage(cx: Connexion, m: { text: string; mediaUrl?: string }): Promise<Message>;

  listLinks(tenantId: string): Promise<LienRow[]>;
  createLink(tenantId: string, l: {
    workflowId: string; startNodeId: string | null; token: string; phrase: string;
    automationId: string | null; maxParHeure: number | null;
  }): Promise<LienRow>;
  linkById(tenantId: string, id: string): Promise<LienRow | null>;

  listPosts(tenantId: string): Promise<PostRow[]>;
  createPost(tenantId: string, p: { cmMessageId: string; linkId: string | null }): Promise<void>;

  /**
   * Cree l'automation compagnon du lien. Elle nait ETEINTE et POSSEDEE par le lien : c'est le cablage qui
   * pose `enabled: false` et la marque de possession, la route ne connait pas la forme d'une automation.
   */
  creerAutomationCompagnon(tenantId: string, input: {
    nom: string; jeton: string; workflowId: string; startNodeId: string | null;
    cooldownSeconds: number; maxParHeure: number | null;
  }): Promise<{ id: string }>;
  /**
   * Allume l'automation compagnon d'UN LIEN (chemin : une publication vient de reussir).
   *
   * 🔴 PREND UN `linkId`, JAMAIS un `automationId`, et c'est deliberement etroit. L'automation compagnon est
   * POSSEDEE (`possede_par = 'channelsme_link'`), donc hors de portee de `PgAutomationStore` : c'est
   * `PgChannelsMeLinkStore.allumerAutomation` qui ecrit la requete, avec sa propre garde miroir. Un appel sur
   * un lien sans automation (ou sur un lien d'un autre tenant) ne touche silencieusement aucune ligne : ce
   * n'est jamais une raison d'echouer la publication qui l'a declenche.
   */
  allumerAutomationLien(tenantId: string, linkId: string): Promise<void>;
  /** Eteint l'automation compagnon d'un lien (chemin : POST /links/:id/disable). Meme garde, meme store. */
  eteindreAutomationLien(tenantId: string, linkId: string): Promise<void>;

  /** 'inconnu' = pas au tenant. 'vide' = aucune version publiee. 'ok' = demarrable. */
  scenarioEtat(tenantId: string, workflowId: string): Promise<'inconnu' | 'vide' | 'ok'>;
  /** Numero WhatsApp affiche du tenant. null = aucun numero connecte, donc aucun lien wa.me possible. */
  getDisplayPhoneNumber(tenantId: string): Promise<string | null>;

  /** Demande d'activation (notification Telegram). Absente du cablage -> 503, comme partout ailleurs. */
  demanderActivation?(input: { tenantId: string; userId: string | null; message: string }): Promise<void>;
}

const ID_EXTERNE = z.string().trim().min(1).max(200);
const SECRET_TIERS = z.string().trim().min(1).max(500);

const connexionSchema = z.object({
  orgId: ID_EXTERNE, channelId: ID_EXTERNE, apiKey: SECRET_TIERS, secret: SECRET_TIERS,
});
const lienSchema = z.object({
  workflowId: z.string().uuid(),
  startNodeId: z.string().trim().min(1).max(200).nullish(),
  phrase: z.string().trim().min(1).max(300),
  maxParHeure: z.number().int().min(1).max(100_000).nullish(),
});
const postSchema = z.object({
  text: z.string().trim().min(1).max(4096),
  mediaUrl: z.string().trim().url().max(2000).optional(),
  linkId: z.string().uuid().optional(),
});
const demandeSchema = z.object({ message: z.string().trim().max(2000).optional() });

/** Anti-rebond du lien de chaine : 5 minutes, au lieu des 3600 s par defaut. Filtre le double appui
 *  accidentel, laisse repartir un abonne qui revient plus tard. Decide par Julien le 2026-09-04. */
const COOLDOWN_LIEN_SECONDES = 300;

/**
 * 🔴 CE QUI SORT D'UN ECHEC DISTANT : le tenant, l'etape, et le message de l'erreur levee par NOTRE client.
 * Jamais le corps de la reponse du tiers (sans `Accept: application/json` leur API rend une page HTML
 * entiere, et un corps distant peut porter les donnees d'un autre espace), jamais les identifiants.
 * `console.error` et non `req.log` : Fastify est construit en `logger: false`.
 */
function journaliserDistant(tenant: string, etape: string, err: unknown): void {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({
    lvl: 'error', msg: 'channelsme_distant_ko', tenant, etape,
    err: err instanceof Error ? err.message : String(err),
  }));
}

export function registerChannelsMeRoutes(app: FastifyInstance, deps: ChannelsMeRouteDeps, guard?: Guard): void {
  const opts = guard ? { preHandler: guard } : {};
  const base = '/tenants/:tenantId/channels-me';
  // Un limiteur PROPRE a cet endpoint (jamais l'instance d'un autre : regle deja posee dans
  // src/auth/routes.ts). Cle = userId, PAS req.ip : la route est authentifiee, et Fastify n'est pas
  // construit en `trustProxy`, donc derriere le proxy `req.ip` est le meme pour tout le monde.
  const limiteurDemande = new RateLimiter(3, 60_000);

  app.get(`${base}/connection`, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const connection = await deps.getConnection(tenant);
    if (!connection) {
      return reply.code(200).send({ connection: null, organisation: null, channels: [], distant: 'non_configuree' });
    }
    const cx = await deps.getSecrets(tenant);
    if (!cx) {
      return reply.code(200).send({ connection, organisation: null, channels: [], distant: 'non_configuree' });
    }
    try {
      // Les deux objets sont ceux que le SCHEMA Zod du client a laisses passer, pas le corps distant tel
      // quel : une page HTML d'erreur ou un champ inattendu n'arrive jamais jusqu'ici.
      const [organisation, channels] = await Promise.all([deps.getOrganisation(cx), deps.listChannels(cx)]);
      return reply.code(200).send({ connection, organisation, channels, distant: 'ok' });
    } catch (err) {
      journaliserDistant(tenant, 'connection_read', err);
      // 200 et pas 4xx : la connexion ENREGISTREE doit rester visible meme quand le tiers est muet, sinon
      // l'ecran laisse croire qu'il n'y a rien de provisionne et le client ressaisit des identifiants bons.
      return reply.code(200).send({ connection, organisation: null, channels: [], distant: 'injoignable' });
    }
  });

  app.put(`${base}/connection`, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const parse = connexionSchema.safeParse(req.body ?? {});
    if (!parse.success) {
      return reply.code(400).send({ error: 'organisation, chaine, cle d’API et secret sont tous requis' });
    }
    const { orgId, channelId, apiKey, secret } = parse.data;
    // Remplacement COMPLET, et non un patch : l'ecran ne peut pas renvoyer ce qu'il n'a jamais eu (les deux
    // secrets ne redescendent jamais), donc « changer la cle » veut dire ressaisir les quatre champs.
    // Le chiffrement est fait DANS le store, jamais ici.
    await deps.upsertConnection(tenant, { orgId, channelId, apiKey, secret });
    // On relit la projection PUBLIQUE : la reponse ne porte donc jamais les secrets qu'on vient d'ecrire.
    return reply.code(200).send({ connection: await deps.getConnection(tenant) });
  });

  app.post(`${base}/connection/test`, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const cx = await deps.getSecrets(tenant);
    if (!cx) return reply.code(409).send({ error: 'aucune connexion enregistree : renseigne les identifiants avant de tester' });
    try {
      // Deux lectures, jamais une ecriture : ce bouton ne publie rien.
      const [organisation, channels] = await Promise.all([deps.getOrganisation(cx), deps.listChannels(cx)]);
      await deps.markVerified(tenant);
      return reply.code(200).send({ ok: true, organisation, channels });
    } catch (err) {
      journaliserDistant(tenant, 'connection_test', err);
      // Message FIXE : le corps de la reponse du tiers ne se relaie jamais au client.
      return reply.code(422).send({
        ok: false,
        error: 'Channels Me a refuse ces identifiants, ou n’a pas repondu. Verifie l’organisation, la chaine, la cle d’API et le secret.',
      });
    }
  });

  app.get(`${base}/links`, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const liens = await deps.listLinks(tenant);
    // UN seul appel pour toute la liste. Le front ne recompose JAMAIS une URL publique : il recoit le lien
    // wa.me pret a l'emploi, comme pour l'adresse d'un webhook entrant.
    const phone = await deps.getDisplayPhoneNumber(tenant);
    return reply.code(200).send({
      links: liens.map((l) => {
        const texte = textePreRempli(l.phrase, l.token);
        return { ...l, texteRempli: texte, waMeUrl: lienWaMe(phone, texte) };
      }),
      phone,
    });
  });

  app.post(`${base}/links`, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const parse = lienSchema.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'workflowId (uuid) et phrase sont requis' });
    const { workflowId, phrase } = parse.data;
    const startNodeId = parse.data.startNodeId ?? null;
    const maxParHeure = parse.data.maxParHeure ?? null;
    // Un tenant ne peut cibler QUE ses propres scenarios (meme garde que la campagne workflow).
    if ((await deps.scenarioEtat(tenant, workflowId)) === 'inconnu') {
      return reply.code(400).send({ error: 'workflowId inconnu pour ce tenant' });
    }
    // Sans numero connecte il n'y a aucune URL wa.me a mettre dans le post : on refuse la creation plutot
    // que de fabriquer un lien casse que rien ne rattraperait une fois le post parti.
    const phone = await deps.getDisplayPhoneNumber(tenant);
    if (phone === null) {
      return reply.code(409).send({ error: 'aucun numero WhatsApp connecte : connecte un numero avant de creer un lien de chaine' });
    }
    // Le jeton est tire par le SERVEUR. Il n'est jamais journalise : il circule dans des messages publics,
    // mais c'est lui qui declenche un scenario.
    const token = nouveauJeton();
    // L'automation nait ETEINTE et ne s'allume qu'a la publication reussie : un lien cree mais jamais
    // publie ne declenche rien, donc un jeton qui fuiterait avant publication est inerte.
    const { id: automationId } = await deps.creerAutomationCompagnon(tenant, {
      nom: `Chaine : ${phrase}`.slice(0, 200),
      jeton: token,
      workflowId,
      startNodeId,
      cooldownSeconds: COOLDOWN_LIEN_SECONDES,
      maxParHeure,
    });
    const lien = await deps.createLink(tenant, { workflowId, startNodeId, token, phrase, automationId, maxParHeure });
    const texte = textePreRempli(phrase, token);
    return reply.code(201).send({ link: { ...lien, texteRempli: texte, waMeUrl: lienWaMe(phone, texte) } });
  });

  app.post(`${base}/links/:id/disable`, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    if (!estUuid(id)) return reply.code(404).send({ error: 'lien inconnu' });
    const lien = await deps.linkById(tenant, id);
    if (!lien) return reply.code(404).send({ error: 'lien inconnu' });
    // 🔴 L'etat d'un lien EST le `enabled` de son automation : il n'y a pas de second drapeau a ecrire, et
    // en poser un creerait deux copies du meme etat, qui divergeraient au premier chemin qui n'ecrit qu'une
    // des deux. On eteint plutot qu'on ne supprime : un post publie circule pour toujours, l'extinction est
    // reversible, la suppression laisserait un bouton mort sans trace.
    if (lien.automationId === null) {
      return reply.code(409).send({ error: 'ce lien n’a plus d’automation compagnon : il ne declenche deja plus rien' });
    }
    // L'id transmis est celui du LIEN, jamais celui de l'automation : c'est `PgChannelsMeLinkStore` qui
    // resout l'automation compagnon (et sa garde `possede_par`), pas cette route.
    await deps.eteindreAutomationLien(tenant, lien.id);
    return reply.code(200).send({ ok: true });
  });

  app.get(`${base}/posts`, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const posts = await deps.listPosts(tenant);
    const cx = await deps.getSecrets(tenant);
    const sansStatut = (distant: string) =>
      reply.code(200).send({ posts: posts.map((p) => ({ ...p, message: null })), distant });
    if (!cx) return sansStatut('non_configuree');
    if (posts.length === 0) return reply.code(200).send({ posts: [], distant: 'ok' });
    try {
      // Le statut se LIT EN DIRECT : rien n'est miroite en base, donc il n'y a rien a resynchroniser et
      // aucune file de rattrapage. Une seule lecture sert toute la liste (le tiers ne pagine pas).
      const messages = await deps.getMessages(cx);
      const parId = new Map(messages.map((m) => [String(m.id), m]));
      return reply.code(200).send({
        posts: posts.map((p) => ({ ...p, message: parId.get(p.cmMessageId) ?? null })),
        distant: 'ok',
      });
    } catch (err) {
      journaliserDistant(tenant, 'posts_read', err);
      return sansStatut('injoignable');
    }
  });

  app.post(`${base}/posts`, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const parse = postSchema.safeParse(req.body ?? {});
    if (!parse.success) {
      return reply.code(400).send({ error: 'text requis (1 a 4096 caracteres) ; mediaUrl doit etre une adresse' });
    }
    const { text, mediaUrl } = parse.data;
    // 🔴 Nous ne recuperons JAMAIS ce media (c'est Channels Me qui le fait), donc pas de resolution DNS ici,
    // qui n'aurait aucun sens : la verification TEXTUELLE existante suffit a refuser un hote interne, et on
    // exige https en plus.
    if (mediaUrl !== undefined && (!urlRecuperable(mediaUrl) || new URL(mediaUrl).protocol !== 'https:')) {
      return reply.code(400).send({ error: 'mediaUrl doit etre une adresse https publique' });
    }
    const cx = await deps.getSecrets(tenant);
    if (!cx) return reply.code(409).send({ error: 'aucune connexion enregistree : renseigne les identifiants avant de publier' });

    let lien: LienRow | null = null;
    let texteDuPost = text;
    if (parse.data.linkId !== undefined) {
      lien = await deps.linkById(tenant, parse.data.linkId);
      if (!lien) return reply.code(400).send({ error: 'linkId inconnu pour ce tenant' });
      // 🔴 UN POST PUBLIE CIRCULE POUR TOUJOURS. Un bouton qui demarre un scenario sans version publiee ne
      // se rattrape pas : on refuse AVANT de publier, jamais apres.
      const etat = await deps.scenarioEtat(tenant, lien.workflowId);
      if (etat !== 'ok') {
        return reply.code(409).send({
          error: etat === 'inconnu'
            ? 'le scenario de ce lien n’existe plus'
            : 'ce scenario n’a aucune version publiee : publie-le avant de publier le post',
        });
      }
      const url = lienWaMe(await deps.getDisplayPhoneNumber(tenant), textePreRempli(lien.phrase, lien.token));
      if (url === null) {
        return reply.code(409).send({ error: 'aucun numero WhatsApp connecte : impossible de fabriquer le lien du post' });
      }
      texteDuPost = `${text}\n\n${url}`;
    }

    let publie: Message;
    try {
      publie = await deps.createMessage(cx, { text: texteDuPost, ...(mediaUrl !== undefined ? { mediaUrl } : {}) });
    } catch (err) {
      journaliserDistant(tenant, 'post_create', err);
      return reply.code(422).send({ error: 'Channels Me a refuse la publication. Verifie le texte et l’image, puis reessaie.' });
    }

    // 🔴 A PARTIR D'ICI LE POST CIRCULE, plus rien n'est annulable. On allume D'ABORD (sinon le bouton du
    // post est mort des sa diffusion), on trace ENSUITE (la trace n'a aucun effet sur l'abonne). Un echec de
    // publication AVANT ce point laisse le lien ETEINT : c'est le comportement voulu, meme si le jeton a fuite.
    if (lien) await deps.allumerAutomationLien(tenant, lien.id);
    const cmMessageId = String(publie.id);
    await deps.createPost(tenant, { cmMessageId, linkId: lien?.id ?? null });
    return reply.code(201).send({ post: { cmMessageId, linkId: lien?.id ?? null } });
  });

  app.post(`${base}/activation-request`, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const userId = req.auth?.userId ?? null;
    // Le 403 tenant reste prioritaire (il ne coute rien et ne doit pas consommer de quota).
    if (!limiteurDemande.take(userId ?? req.ip)) {
      return reply.code(429).send({ error: 'trop de demandes, reessaie plus tard' });
    }
    if (!deps.demanderActivation) return reply.code(503).send({ error: 'demande d’activation indisponible sur cette instance' });
    const parse = demandeSchema.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'message trop long (2000 caracteres maximum)' });
    await deps.demanderActivation({ tenantId: tenant, userId, message: parse.data.message ?? '' });
    return reply.code(200).send({ ok: true });
  });
}
