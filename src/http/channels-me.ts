import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { forbidNonAdmin } from '../auth/middleware';
import type { Guard } from '../auth/middleware';
import { RateLimiter } from '../auth/rate-limit';
import { urlRecuperable } from '../lib/page-distante';
import { lienWaMe } from '../lib/wa-me';
import { normalizeText } from '../automation/match';
import { motCleDepuisPhrase, nouveauJeton, textePreRempli } from '../channels-me/jeton';
import { ChannelsMeApiError } from '../channels-me/client';
import type { Connexion, ConnexionPublique, Organisation, MessageChannel, Message } from '../channels-me/types';
import type { LienRow } from '../channels-me/link-store.pg';
import type { ConversationsDunLien } from '../channels-me/conversions';
import type { PostRow } from '../channels-me/post-store.pg';
import { espaceVerifie, estUuid } from './scope';
import { texteDe } from '../lib/erreur';

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
  createMessage(cx: Connexion, m: { text: string; mediaUrl?: string }): Promise<Message>;
}

/** Ce que les routes lisent et écrivent des liens de chaîne. */
export interface LiensChannelsMe {
  list(tenantId: string): Promise<LienRow[]>;
  create(tenantId: string, l: {
    workflowId: string; startNodeId: string | null; token: string; phrase: string;
    automationId: string | null; maxParHeure: number | null;
  }): Promise<LienRow>;
  byId(tenantId: string, id: string): Promise<LienRow | null>;
  /**
   * Rattrapage : défait l'automation compagnon qu'on vient de créer quand `create` échoue juste après
   * (POST /links). Bornée par `tenantId` et par `possede_par = 'channelsme_link'` (garde miroir), sans effet
   * si l'id ne correspond à rien : ce n'est jamais une raison d'échouer davantage.
   */
  supprimerAutomationCompagnon(tenantId: string, automationId: string): Promise<void>;
  /** Les conversations démarrées par chaque bouton de chaîne. */
  conversationsParLien(tenantId: string): Promise<{ parLien: ConversationsDunLien[]; partiel: boolean }>;
  /**
   * Combien de messages entrants de l'espace contiennent déjà cette phrase, sans jeton de lien : le danger d'une
   * phrase n'est pas d'être courte mais d'apparaître dans la conversation ordinaire, donc on le compte.
   */
  messagesContenantLaPhrase(tenantId: string, phrase: string): Promise<number>;
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
  create(tenantId: string, p: { cmMessageId: string; linkId: string | null }): Promise<void>;
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

  /**
   * Cette phrase entre-t-elle en conflit avec celle d'un lien existant de l'espace ? Conflit veut dire inclusion,
   * pas égalité (comparaison en `contains`) : « Je veux le guide » et « Je veux le guide 2026 » déclencheraient les
   * deux scénarios sur le second bouton. Porte sur tous les liens, éteints compris : un lien éteint peut être
   * rallumé, et son post circule encore.
   */
  phraseEnConflit(tenantId: string, phrase: string): Promise<boolean>;
  creerAutomationCompagnon(tenantId: string, input: {
    nom: string;
    /** Le mot-clé qui déclenche le scénario, en mode `contains` : la phrase du lien. */
    motCle: string;
    workflowId: string; startNodeId: string | null;
    cooldownSeconds: number; maxParHeure: number | null;
  }): Promise<{ id: string }>;

  /** 'inconnu' = pas au tenant. 'vide' = aucune version publiee. 'ok' = demarrable. */
  scenarioEtat(tenantId: string, workflowId: string): Promise<'inconnu' | 'vide' | 'ok'>;
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

/** Anti-rebond du lien de chaîne : 5 minutes au lieu de 3600 s. Filtre le double appui accidentel, laisse
*  repartir un abonné qui revient plus tard. */
const COOLDOWN_LIEN_SECONDES = 300;

/**
 * 🔴 Ce qui sort d'un échec distant : l'espace, l'étape et le message de l'erreur levée par notre client. Jamais
 * le corps de la réponse du tiers (une page HTML entière, ou des données d'un autre espace), jamais les
 * identifiants. `console.error` et non `req.log` : Fastify est construit en `logger: false`.
 */
function journaliserDistant(tenant: string, etape: string, err: unknown): void {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({
    lvl: 'error', msg: 'channelsme_distant_ko', tenant, etape,
    err: texteDe(err),
  }));
}

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
      journaliserDistant(tenant, 'connection_read', err);
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
      journaliserDistant(tenant, 'connection_test', err);
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
    // 🔴 Un espace ne peut cibler que ses propres scénarios (même garde que la campagne workflow).
    if ((await deps.scenarioEtat(tenant, workflowId)) === 'inconnu') {
      return reply.code(400).send({ error: 'workflowId inconnu pour ce tenant' });
    }
    // Sans numero connecte il n'y a aucune URL wa.me a mettre dans le post : on refuse la creation plutot
    // que de fabriquer un lien casse que rien ne rattraperait une fois le post parti.
    const phone = await deps.getDisplayPhoneNumber(tenant);
    if (phone === null) {
      return reply.code(409).send({ error: 'aucun numero WhatsApp connecte : connecte un numero avant de creer un lien de chaine' });
    }
    // Les gardes de la phrase passent avant toute écriture : elle doit être unique et distinctive (refuser après
    // avoir créé l'automation obligerait à la défaire). La phrase normalisée ne doit pas être vide : des diacritiques
    // seuls passent `trim().min(1)`, `normalizeText` les réduit à rien, et l'automation ne déclencherait jamais.
    if (normalizeText(phrase) === '') {
      return reply.code(400).send({ error: 'cette phrase ne contient aucun caractere exploitable : choisis une phrase lisible' });
    }
    if (await deps.phraseEnConflit(tenant, phrase)) {
      return reply.code(409).send({
        error: "cette phrase entre en conflit avec celle d'un autre lien (l'une contient l'autre) : un seul message declencherait les deux scenarios",
      });
    }
    const dejaVus = await deps.liens.messagesContenantLaPhrase(tenant, phrase);
    if (dejaVus > 0) {
      // Le nombre est dit : « trop banale » sans chiffre laisse le client deviner ce qu'on lui reproche.
      return reply.code(409).send({
        error: `cette phrase apparait deja dans ${dejaVus} message(s) recu(s) : elle declencherait le scenario sur des conversations ordinaires. Choisis une phrase plus specifique.`,
      });
    }
    // Le jeton est tiré par le serveur et jamais journalisé (il circule dans des messages publics). Il ne
    // déclenche plus rien (c'est la phrase qui route) : il reste l'identifiant unique du lien, présent dans les posts.
    const token = nouveauJeton();
    // L'automation naît éteinte et ne s'allume qu'à la publication réussie : un lien créé mais jamais publié ne
    // déclenche rien, donc un jeton qui fuiterait avant publication est inerte.
    const { id: automationId } = await deps.creerAutomationCompagnon(tenant, {
      nom: `Chaine : ${phrase}`.slice(0, 200),
      // La phrase, privée de sa ponctuation finale : WhatsApp exclut cette ponctuation de l'adresse qu'il ouvre, et
      // en mode `contains` un message plus court que le mot-clé ne correspond à rien (cf. `motCleDepuisPhrase`).
      motCle: motCleDepuisPhrase(phrase),
      workflowId,
      startNodeId,
      cooldownSeconds: COOLDOWN_LIEN_SECONDES,
      maxParHeure,
    });
    let lien: LienRow;
    try {
      lien = await deps.liens.create(tenant, { workflowId, startNodeId, token, phrase, automationId, maxParHeure });
    } catch (err) {
      // Sans ce rattrapage, un `liens.create` qui échoue laisserait une automation possédée qu'aucun lien ne
      // référence : invisible de l'écran Automation, orpheline pour toujours. On la défait avant de laisser l'échec
      // remonter.
      await deps.liens.supprimerAutomationCompagnon(tenant, automationId).catch((err2) => {
        journaliserDistant(tenant, 'link_rattrapage_automation', err2);
      });
      journaliserDistant(tenant, 'link_create', err);
      // Une course entre deux créations sort en 409, pas en 500 : l'index unique est le filet quand deux requêtes
      // passent la garde applicative en même temps.
      if ((err as { code?: unknown }).code === '23505') {
        return reply.code(409).send({
          error: "cette phrase entre en conflit avec celle d'un autre lien (l'une contient l'autre) : un seul message declencherait les deux scenarios",
        });
      }
      throw err;
    }
    const texte = textePreRempli(phrase);
    return reply.code(201).send({ link: { ...lien, texteRempli: texte, waMeUrl: lienWaMe(phone, texte) } });
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
      journaliserDistant(tenant, 'posts_read', err);
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
    const cx = await deps.connexions.getSecrets(tenant);
    if (!cx) return reply.code(409).send({ error: 'aucune connexion enregistree : renseigne les identifiants avant de publier' });

    let lien: LienRow | null = null;
    let texteDuPost = text;
    if (parse.data.linkId !== undefined) {
      lien = await deps.liens.byId(tenant, parse.data.linkId);
      if (!lien) return reply.code(400).send({ error: 'linkId inconnu pour ce tenant' });
      // 🔴 Un post publié circule pour toujours : un bouton vers un scénario sans version publiée ne se rattrape
      // pas, on refuse avant de publier.
      const etat = await deps.scenarioEtat(tenant, lien.workflowId);
      if (etat !== 'ok') {
        return reply.code(409).send({
          error: etat === 'inconnu'
            ? 'le scenario de ce lien n’existe plus'
            : 'ce scenario n’a aucune version publiee : publie-le avant de publier le post',
        });
      }
      const url = lienWaMe(await deps.getDisplayPhoneNumber(tenant), textePreRempli(lien.phrase));
      if (url === null) {
        return reply.code(409).send({ error: 'aucun numero WhatsApp connecte : impossible de fabriquer le lien du post' });
      }
      texteDuPost = `${text}\n\n${url}`;
    }

    // Ce qui sort du catch dépend du statut porté par `ChannelsMeApiError`. Statut 2xx (enveloppe absente, corps
    // refusé par le schéma) : le message est parti. Statut 0 (délai, panne réseau) : on ne sait rien de la
    // délivrance. Seul un 4xx/5xx reçu est un vrai refus, où rien n'est parti.
    const avertissements: Array<'automation_non_allumee' | 'trace_manquante' | 'reponse_inattendue'> = [];
    let publie: Message | null = null;
    try {
      publie = await deps.client.createMessage(cx, { text: texteDuPost, ...(mediaUrl !== undefined ? { mediaUrl } : {}) });
    } catch (err) {
      journaliserDistant(tenant, 'post_create', err);
      if (err instanceof ChannelsMeApiError && err.status === 0) {
        // Aucune réponse reçue : on ne sait pas si le message est parti. 4xx (jamais 5xx), et le message n'invite
        // jamais à réessayer : un réessai à l'aveugle republierait peut-être le même message à toute l'audience.
        return reply.code(409).send({
          error: 'Channels Me n’a pas repondu a temps : impossible de savoir si le message est deja parti. Verifie la chaine (l’onglet Publications) avant toute nouvelle tentative.',
        });
      }
      // Un 401/403 est notre signature refusée, pas une faute du client : le lui dire autrement le ferait chercher un
      // défaut dans son texte. 424 et pas 502 : Cloudflare remplacerait le corps de toute 5xx.
      if (err instanceof ChannelsMeApiError && (err.status === 401 || err.status === 403)) {
        return reply.code(424).send({
          error: 'Channels Me a refuse NOS identifiants (erreur de notre cote, pas de ton message). Rien n’a ete publie. Si ca persiste, previens-nous : ni le texte ni l’image n’y changeront quoi que ce soit.',
        });
      }
      if (!(err instanceof ChannelsMeApiError) || err.status < 200 || err.status >= 300) {
        // Vrai refus du fournisseur (4xx/5xx reçu) ou erreur non qualifiée : rien n'est parti, et la saisie peut
        // corriger (les refus d'authentification sont sortis au-dessus). Un 500 `Down::NotFound` y tombe aussi :
        // l'image n'a pas pu être récupérée à l'adresse donnée.
        return reply.code(422).send({ error: 'Channels Me a refuse la publication. Verifie le texte et l’image, puis reessaie.' });
      }
      // Statut 2xx reçu : le message est parti, seule l'enveloppe n'a pas été reconnue. Jamais un échec apparent
      // (republier enverrait le post deux fois à toute l'audience) ; `publie` reste null, rien à tracer.
      avertissements.push('reponse_inattendue');
    }

    // 🔴 À partir d'ici le post circule : la réponse est un 201 quoi qu'il arrive, car `createMessage` n'a pas de
    // clé d'idempotence et faire réessayer republierait à toute l'audience. On allume d'abord (sinon le bouton est
    // mort), on trace ensuite ; chaque appel a son propre try/catch, et son échec est journalisé, jamais relevé.
    if (lien) {
      try {
        await deps.liens.allumerAutomation(tenant, lien.id);
      } catch (err) {
        journaliserDistant(tenant, 'post_allumage', err);
        // Le bouton reste mort, mais la reponse reste un succes : POST /links/:id/enable est la reparation.
        avertissements.push('automation_non_allumee');
      }
    }
    // Sans corps exploitable (réponse 2xx à l'enveloppe inattendue), il n'y a aucun identifiant Channels Me : la
    // trace est impossible, pas seulement ratée, donc `createPost` n'est même pas tenté.
    const cmMessageId = publie === null ? null : String(publie.id);
    if (cmMessageId !== null) {
      try {
        await deps.posts.create(tenant, { cmMessageId, linkId: lien?.id ?? null });
      } catch (err) {
        journaliserDistant(tenant, 'post_trace', err);
        // La publication n'apparaitra pas dans GET /posts tant que la trace n'est pas rejouee, mais le post
        // est bel et bien parti : ce n'est jamais une raison de repondre autre chose qu'un succes.
        avertissements.push('trace_manquante');
      }
    }
    return reply.code(201).send({
      post: { cmMessageId, linkId: lien?.id ?? null },
      ...(avertissements.length > 0 ? { avertissements } : {}),
    });
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
