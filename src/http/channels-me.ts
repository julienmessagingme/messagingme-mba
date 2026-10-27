import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { forbidNonAdmin } from '../auth/middleware';
import type { Guard } from '../auth/middleware';
import { RateLimiter } from '../auth/rate-limit';
import { urlRecuperable } from '../lib/page-distante';
import { lienWaMe } from '../lib/wa-me';
import { textePreRempli } from '../channels-me/jeton';
import type { Connexion, ConnexionPublique, Organisation, MessageChannel, Message } from '../channels-me/types';
import type { LienRow } from '../channels-me/link-store.pg';
import type { ConversationsDunLien } from '../channels-me/conversions';
import type { PostRow } from '../channels-me/post-store.pg';
import type { PublicationChannelsMe } from '../channels-me/publication';
import { journaliserDistantChannelsMe } from '../channels-me/journal';
import { espaceVerifie, estUuid } from './scope';

/** Ce que les routes lisent et écrivent de la connexion à la chaîne. */
export interface ConnexionsChannelsMe {
  /** Projection publique de la connexion : jamais les colonnes chiffrées. null = rien de provisionné. */
  get(tenantId: string): Promise<ConnexionPublique | null>;
  /** Les identifiants en clair, déchiffrés par le store. Ils ne servent qu'au client, ils ne sortent jamais d'ici. */
  getSecrets(tenantId: string): Promise<Connexion | null>;
  upsert(tenantId: string, c: Connexion): Promise<void>;
  markVerified(tenantId: string): Promise<void>;
  /**
   * Débranche la chaîne : oublie les identifiants, rien d'autre (`PgChannelsMeConnectionStore.supprimer`).
   * `true` = une connexion existait.
   */
  supprimer(tenantId: string): Promise<boolean>;
}

/** Les appels à l'API Channels Me. */
export interface ClientChannelsMe {
  getOrganisation(cx: Connexion): Promise<Organisation>;
  listChannels(cx: Connexion): Promise<MessageChannel[]>;
  getMessages(cx: Connexion): Promise<Message[]>;
}

/** Ce que les routes lisent et écrivent des liens de chaîne. */
export interface LiensChannelsMe {
  list(tenantId: string): Promise<LienRow[]>;
  byId(tenantId: string, id: string): Promise<LienRow | null>;
  /** Les conversations démarrées par chaque bouton de chaîne. */
  conversationsParLien(tenantId: string): Promise<{ parLien: ConversationsDunLien[]; partiel: boolean }>;
  /**
   * Allume l'automation compagnon d'un lien : après une publication réussie, ou par réparation manuelle
   * (POST /links/:id/enable). Prend un `linkId`, jamais un `automationId` : l'automation est possédée par le lien,
   * hors de portée de `PgAutomationStore`, et `PgChannelsMeLinkStore.allumerAutomation` porte sa garde miroir. Un
   * lien sans automation ou d'un autre espace ne touche aucune ligne, sans échec.
   */
  allumerAutomation(tenantId: string, linkId: string): Promise<void>;
  /** Eteint l'automation compagnon d'un lien (chemin : POST /links/:id/disable). Meme garde, meme store. */
  eteindreAutomation(tenantId: string, linkId: string): Promise<void>;
}

/** Les posts publiés sur la chaîne. */
export interface PostsChannelsMe {
  list(tenantId: string): Promise<PostRow[]>;
}

/**
 * Chaîne WhatsApp (Channels Me) : publier un post dont le bouton (lien wa.me pré-rempli) démarre un scénario.
 * Lecture ouverte à tout compte authentifié, écritures admin : publier sur une chaîne, c'est parler à toute une
 * audience sans relecture humaine.
 */
export interface ChannelsMeRouteDeps {
  connexions: ConnexionsChannelsMe;
  client: ClientChannelsMe;
  liens: LiensChannelsMe;
  posts: PostsChannelsMe;
  /** Le cycle création/publication : gardes, ordre fournisseur-écritures et compensations. */
  publication: PublicationChannelsMe;
  /** Numero WhatsApp affiche du tenant. null = aucun numero connecte, donc aucun lien wa.me possible. */
  getDisplayPhoneNumber(tenantId: string): Promise<string | null>;

  /** Demande d'activation (notification Telegram). */
  demanderActivation(input: { tenantId: string; userId: string | null; message: string }): Promise<void>;
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

export function registerChannelsMeRoutes(app: FastifyInstance, deps: ChannelsMeRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };
  const base = '/tenants/:tenantId/channels-me';
  // Limiteur propre à cet endpoint. Clé = userId, pas req.ip : sans `trustProxy`, derrière le proxy, `req.ip`
  // est le même pour tout le monde.
  const limiteurDemande = new RateLimiter(3, 60_000);

  app.get(`${base}/connection`, opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const connection = await deps.connexions.get(tenant);
    if (!connection) {
      return reply.code(200).send({ connection: null, organisation: null, channels: [], distant: 'non_configuree' });
    }
    const cx = await deps.connexions.getSecrets(tenant);
    if (!cx) {
      return reply.code(200).send({ connection, organisation: null, channels: [], distant: 'non_configuree' });
    }
    try {
      // Les deux objets sont ceux que le schéma Zod du client a laissés passer, pas le corps distant tel quel :
      // une page HTML d'erreur ou un champ inattendu n'arrive jamais jusqu'ici.
      const [organisation, channels] = await Promise.all([deps.client.getOrganisation(cx), deps.client.listChannels(cx)]);
      return reply.code(200).send({ connection, organisation, channels, distant: 'ok' });
    } catch (err) {
      journaliserDistantChannelsMe(tenant, 'connection_read', err);
      // 200 et pas 4xx : la connexion enregistrée doit rester visible même quand le tiers est muet, sinon l'écran
      // laisse croire qu'il n'y a rien de provisionné et le client ressaisit des identifiants bons.
      return reply.code(200).send({ connection, organisation: null, channels: [], distant: 'injoignable' });
    }
  });

  app.put(`${base}/connection`, opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    if (forbidNonAdmin(req, reply)) return;
    const parse = connexionSchema.safeParse(req.body ?? {});
    if (!parse.success) {
      return reply.code(400).send({ error: 'organisation, chaine, cle d’API et secret sont tous requis' });
    }
    const { orgId, channelId, apiKey, secret } = parse.data;
    // Remplacement complet, pas un patch : l'écran ne peut pas renvoyer les deux secrets, qui ne redescendent
    // jamais, donc « changer la clé » veut dire ressaisir les quatre champs. Le chiffrement est fait dans le store.
    await deps.connexions.upsert(tenant, { orgId, channelId, apiKey, secret });
    // On relit la projection publique : la réponse ne porte donc jamais les secrets qu'on vient d'écrire.
    return reply.code(200).send({ connection: await deps.connexions.get(tenant) });
  });

  /**
   * Débrancher la chaîne (interrupteur « Chaîne » de l'Accueil) : oublie les identifiants, rien d'autre. Les liens
   * et les posts déjà parus gardent leurs boutons, qui passent par notre numéro et l'automation compagnon, pas par
   * la chaîne. Rejouable : déjà débranchée, 200 avec `supprimee: false`.
   */
  app.delete(`${base}/connection`, opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    if (forbidNonAdmin(req, reply)) return;
    const supprimee = await deps.connexions.supprimer(tenant);
    return reply.code(200).send({ ok: true, supprimee });
  });

  app.post(`${base}/connection/test`, opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    if (forbidNonAdmin(req, reply)) return;
    const cx = await deps.connexions.getSecrets(tenant);
    if (!cx) return reply.code(409).send({ error: 'aucune connexion enregistree : renseigne les identifiants avant de tester' });
    try {
      // Deux lectures, jamais une ecriture : ce bouton ne publie rien.
      const [organisation, channels] = await Promise.all([deps.client.getOrganisation(cx), deps.client.listChannels(cx)]);
      await deps.connexions.markVerified(tenant);
      return reply.code(200).send({ ok: true, organisation, channels });
    } catch (err) {
      journaliserDistantChannelsMe(tenant, 'connection_test', err);
      // Message fixe : le corps de la réponse du tiers ne se relaie jamais au client.
      return reply.code(422).send({
        ok: false,
        error: 'Channels Me a refuse ces identifiants, ou n’a pas repondu. Verifie l’organisation, la chaine, la cle d’API et le secret.',
      });
    }
  });

  app.get(`${base}/links`, opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const liens = await deps.liens.list(tenant);
    // Un seul appel pour toute la liste. Le front ne recompose jamais une URL publique : il reçoit le lien
    // wa.me prêt à l'emploi, comme pour l'adresse d'un webhook entrant.
    const phone = await deps.getDisplayPhoneNumber(tenant);
    return reply.code(200).send({
      links: liens.map((l) => {
        const texte = textePreRempli(l.phrase);
        return { ...l, texteRempli: texte, waMeUrl: lienWaMe(phone, texte) };
      }),
      phone,
    });
  });

  app.post(`${base}/links`, opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    if (forbidNonAdmin(req, reply)) return;
    const parse = lienSchema.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'workflowId (uuid) et phrase sont requis' });
    const { workflowId, phrase } = parse.data;
    const startNodeId = parse.data.startNodeId ?? null;
    const maxParHeure = parse.data.maxParHeure ?? null;
    const resultat = await deps.publication.creerLien({
      tenantId: tenant, workflowId, startNodeId, phrase, maxParHeure,
    });
    switch (resultat.kind) {
      case 'scenario_inconnu':
        return reply.code(400).send({ error: 'workflowId inconnu pour ce tenant' });
      case 'numero_absent':
        return reply.code(409).send({ error: 'aucun numero WhatsApp connecte : connecte un numero avant de creer un lien de chaine' });
      case 'phrase_inexploitable':
        return reply.code(400).send({ error: 'cette phrase ne contient aucun caractere exploitable : choisis une phrase lisible' });
      case 'phrase_arret':
        return reply.code(400).send({ error: 'cette phrase commence par un mot d arret (stop, arret, desabonner) : chaque abonne qui appuierait serait desabonne. Commence-la autrement.' });
      case 'phrase_conflit':
        return reply.code(409).send({
          error: "cette phrase entre en conflit avec celle d'un autre lien ou d'un widget WhatsApp (l'une contient l'autre) : un seul message declencherait les deux",
        });
      case 'phrase_deja_vue':
        return reply.code(409).send({
          error: `cette phrase apparait deja dans ${resultat.occurrences} message(s) recu(s) : elle declencherait le scenario sur des conversations ordinaires. Choisis une phrase plus specifique.`,
        });
      case 'phrase_conflit_course':
        return reply.code(409).send({
          error: "cette phrase entre en conflit avec celle d'un autre lien (l'une contient l'autre) : un seul message declencherait les deux scenarios",
        });
      case 'cree': {
        const texte = textePreRempli(phrase);
        return reply.code(201).send({
          link: { ...resultat.lien, texteRempli: texte, waMeUrl: lienWaMe(resultat.numero, texte) },
        });
      }
    }
  });

  /**
   * Combien de conversations chaque bouton a démarrées : pas un nombre de clics, car un appui sur un lien `wa.me`
   * ne traverse pas nos serveurs ; on voit le message qui arrive ensuite. Route séparée de `GET /links`, qui sert
   * le composeur à chaque ouverture et n'a pas à relire des messages.
   */
  app.get(`${base}/links/conversations`, opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const r = await deps.liens.conversationsParLien(tenant);
    return reply.code(200).send(r);
  });

  app.post(`${base}/links/:id/disable`, opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    if (forbidNonAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    if (!estUuid(id)) return reply.code(404).send({ error: 'lien inconnu' });
    const lien = await deps.liens.byId(tenant, id);
    if (!lien) return reply.code(404).send({ error: 'lien inconnu' });
    // L'état d'un lien est le `enabled` de son automation, sans second drapeau (deux copies divergeraient). On
    // éteint plutôt qu'on ne supprime : un post publié circule pour toujours, l'extinction est réversible.
    if (lien.automationId === null) {
      return reply.code(409).send({ error: 'ce lien n’a plus d’automation compagnon : il ne declenche deja plus rien' });
    }
    // L'id transmis est celui du lien, jamais celui de l'automation : c'est `PgChannelsMeLinkStore` qui
    // résout l'automation compagnon (et sa garde `possede_par`), pas cette route.
    await deps.liens.eteindreAutomation(tenant, lien.id);
    return reply.code(200).send({ ok: true });
  });

  // Contrepartie de `disable`, calquee dessus terme a terme (memes gardes, memes codes d'erreur). Elle
  // existe pour fermer un chemin de reparation : un allumage automatique qui a echoue apres une publication
  // (POST /posts) laisse un bouton mort, et sans cette route rien ne permettait de le rallumer.
  app.post(`${base}/links/:id/enable`, opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    if (forbidNonAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    if (!estUuid(id)) return reply.code(404).send({ error: 'lien inconnu' });
    const lien = await deps.liens.byId(tenant, id);
    if (!lien) return reply.code(404).send({ error: 'lien inconnu' });
    if (lien.automationId === null) {
      return reply.code(409).send({ error: 'ce lien n’a plus d’automation compagnon : il ne peut pas etre active' });
    }
    // Même id (celui du lien) que `disable`, pour la même raison : c'est `PgChannelsMeLinkStore` qui résout
    // et garde l'automation compagnon, cette route ne connaît que le lien.
    await deps.liens.allumerAutomation(tenant, lien.id);
    return reply.code(200).send({ ok: true });
  });

  app.get(`${base}/posts`, opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const posts = await deps.posts.list(tenant);
    const cx = await deps.connexions.getSecrets(tenant);
    const sansStatut = (distant: string) =>
      reply.code(200).send({ posts: posts.map((p) => ({ ...p, message: null })), distant });
    if (!cx) return sansStatut('non_configuree');
    if (posts.length === 0) return reply.code(200).send({ posts: [], distant: 'ok' });
    try {
      // Le statut se lit en direct : rien n'est miroité en base, donc rien à resynchroniser. Une seule lecture sert
      // toute la liste (le tiers ne pagine pas).
      const messages = await deps.client.getMessages(cx);
      const parId = new Map(messages.map((m) => [String(m.id), m]));
      return reply.code(200).send({
        posts: posts.map((p) => ({ ...p, message: parId.get(p.cmMessageId) ?? null })),
        distant: 'ok',
      });
    } catch (err) {
      journaliserDistantChannelsMe(tenant, 'posts_read', err);
      return sansStatut('injoignable');
    }
  });

  app.post(`${base}/posts`, opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    if (forbidNonAdmin(req, reply)) return;
    const parse = postSchema.safeParse(req.body ?? {});
    if (!parse.success) {
      return reply.code(400).send({ error: 'text requis (1 a 4096 caracteres) ; mediaUrl doit etre une adresse' });
    }
    const { text, mediaUrl } = parse.data;
    // 🔴 Nous ne récupérons jamais ce média (Channels Me le fait) : pas de résolution DNS ici, la vérification
    // textuelle suffit à refuser un hôte interne, et on exige https en plus.
    if (mediaUrl !== undefined && (!urlRecuperable(mediaUrl) || new URL(mediaUrl).protocol !== 'https:')) {
      return reply.code(400).send({ error: 'mediaUrl doit etre une adresse https publique' });
    }
    const resultat = await deps.publication.publier({
      tenantId: tenant,
      text,
      mediaUrl,
      linkId: parse.data.linkId,
    });
    switch (resultat.kind) {
      case 'connexion_absente':
        return reply.code(409).send({ error: 'aucune connexion enregistree : renseigne les identifiants avant de publier' });
      case 'lien_inconnu':
        return reply.code(400).send({ error: 'linkId inconnu pour ce tenant' });
      case 'scenario_inconnu':
        return reply.code(409).send({ error: 'le scenario de ce lien n’existe plus' });
      case 'scenario_vide':
        return reply.code(409).send({ error: 'ce scenario n’a aucune version publiee : publie-le avant de publier le post' });
      case 'numero_absent':
        return reply.code(409).send({ error: 'aucun numero WhatsApp connecte : impossible de fabriquer le lien du post' });
      case 'delivrance_ambigue':
        return reply.code(409).send({
          error: 'Channels Me n’a pas repondu a temps : impossible de savoir si le message est deja parti. Verifie la chaine (l’onglet Publications) avant toute nouvelle tentative.',
        });
      case 'identifiants_refuses':
        return reply.code(424).send({
          error: 'Channels Me a refuse NOS identifiants (erreur de notre cote, pas de ton message). Rien n’a ete publie. Si ca persiste, previens-nous : ni le texte ni l’image n’y changeront quoi que ce soit.',
        });
      case 'publication_refusee':
        return reply.code(422).send({ error: 'Channels Me a refuse la publication. Verifie le texte et l’image, puis reessaie.' });
      case 'publie':
        return reply.code(201).send({
          post: resultat.post,
          ...(resultat.avertissements.length > 0 ? { avertissements: resultat.avertissements } : {}),
        });
    }
  });

  app.post(`${base}/activation-request`, opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    if (forbidNonAdmin(req, reply)) return;
    const userId = req.auth?.userId ?? null;
    // Le 403 tenant reste prioritaire (il ne coute rien et ne doit pas consommer de quota).
    if (!limiteurDemande.take(userId ?? req.ip)) {
      return reply.code(429).send({ error: 'trop de demandes, reessaie plus tard' });
    }
    const parse = demandeSchema.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'message trop long (2000 caracteres maximum)' });
    await deps.demanderActivation({ tenantId: tenant, userId, message: parse.data.message ?? '' });
    return reply.code(200).send({ ok: true });
  });
}
