import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parse as secureJsonParse } from 'secure-json-parse';
import { forbidNonAdmin, type Guard } from '../auth/middleware';
import { scopeTenant } from './scope';
import {
  bornerPourModeleMba, ENTRETIEN_MBA_VIERGE,
  type EntretienMba, type EntretienMbaStore, type TourMba,
} from '../mba/assistant/entretien-store';
import { construireMessagesMba, pointDuTourMba, type InventaireMba } from '../mba/assistant/conversation';
import { propositionMbaSchema, type Operation } from '../mba/assistant/proposition';
import { appliquer, libelleDe, type ApplicationDeps } from '../mba/assistant/application';
import { accueilMba } from '../mba/assistant/couverture';
import { MAX_FICHIER, typeMetaDuContenu, type MagasinPiecesJointes } from '../mba/assistant/pieces-jointes';
import { octetsDepuisDataUrl } from '../rcs/image';
import { moisDe, resteDuBudget, MESSAGE_PLAFOND, type DepenseStore } from '../assistant/budget';
import { microEurosDepuisDollars } from '../agent/devise';
import type { ChatMessage, GatewayChatClient, OutilExpose, ReponseChat } from '../agent/llm/chat-client';
import { direPanneModele } from '../llm/errors';
import { journaliser } from '../lib/journal';

/**
 * L'ASSISTANT DU META BUSINESS AGENT : la conversation qui règle l'agent, et qui le MET À JOUR.
 *
 * 🔴 CETTE ROUTE N'ÉCRIT RIEN CHEZ META PAR ELLE-MÊME. Elle rend une proposition et le diff qu'elle
 * produirait ; l'écriture passe par `appliquer`, sur un geste explicite du client. C'est la même règle que
 * `src/http/agent-setup.ts`, et elle a la même raison : le jour où l'onglet « Create » a disparu de
 * l'interface d'OpenAI, des GPT sont devenus non modifiables du jour au lendemain. Ici, la conversation
 * n'est JAMAIS le seul chemin d'édition, et elle n'a aucun pouvoir que les onglets n'aient déjà.
 *
 * 🔴 ADMINS SEULEMENT (décision de Julien du 2026-09-14). Dans Engage Me, les écritures sont déjà réservées
 * aux admins : un collaborateur qui ne peut pas modifier le MBA au formulaire ne doit pas pouvoir le faire
 * en le demandant à un robot, sinon la conversation devient un contournement du contrôle d'accès.
 *
 * 🔴 C'EST NOUS QUI PAYONS, DONC UN PLAFOND BORNE. Voir `src/assistant/budget.ts` : au plafond, l'assistant
 * le DIT et les onglets restent utilisables. Un message d'indisponibilité générique ferait passer une limite
 * volontaire pour une panne.
 */

export interface MbaAssistantDeps {
  /** L'inventaire de l'agent, LU CHEZ META. Voir `lireInventaireMba` dans le câblage. */
  inventaire(tenantId: string): Promise<InventaireMba | null>;
  entretiens: EntretienMbaStore;
  depenses: DepenseStore;
  plafondEuros: number;
  /**
   * Le client de modèle. Absent -> l'assistant est indisponible, et il le dit en 503.
   *
   * ⚠️ LE TYPE VIENT DU CLIENT DE CHAT, il n'est pas réécrit ici. Une signature plus lâche (`role: string`)
   * compilait de son côté et refusait le vrai câblage : un contrat recopié approximativement ne protège de
   * rien et fait diverger les deux moitiés.
   */
  completer?(entree: Parameters<GatewayChatClient['completer']>[0]): Promise<ReponseChat>;
  modele: string;
  /** Tout ce qu'il faut pour écrire chez Meta. */
  application(tenantId: string, acteur: { id: string | null; email: string | null }): ApplicationDeps;
  /** L'identifiant de l'agent Meta de cet espace (`agentId` des routes MBA). */
  agentIdDuTenant(tenantId: string): Promise<string | null>;
  tauxEurParDollar: number;
  /**
   * Le magasin des pièces jointes déposées dans le fil. Absent -> le dépôt répond 503 et le reste de la
   * conversation continue : un assistant sans dépôt de document reste un assistant.
   */
  pieces?: MagasinPiecesJointes;
}

/** Ce que l'écran reçoit d'un coup. Trois plafonds distincts, cf. `entretien-store.ts`. */
export const MAX_MESSAGES_AFFICHES_MBA = 200;

/**
 * LE DÉLAI D'UN TOUR. Un appel de modèle n'est pas une requête de base : sans borne, un fournisseur qui
 * traîne tient la requête ouverte indéfiniment, et le navigateur avec.
 *
 * ⚠️ `src/http/agent-setup.ts` en a un du même ordre, et les deux n'ont AUCUNE raison de rester égaux : ce
 * n'est pas un invariant partagé, c'est deux routes qui doivent chacune être bornée. Les lier créerait une
 * dépendance entre deux modules de routes pour une valeur qui ne veut rien dire en commun.
 */
const DELAI_MS = 45_000;

const corpsTour = z.object({ message: z.string().trim().min(1).max(4000) });
const corpsAppliquer = z.object({ operations: z.array(z.unknown()).max(20) });
const corpsPiece = z.object({
  /** Le nom tel que Meta le gardera. Son EXTENSION doit correspondre à la signature du contenu. */
  nom: z.string().trim().min(1).max(200),
  dataUrl: z.string().min(1),
});

export function registerMbaAssistant(app: FastifyInstance, deps: MbaAssistantDeps, garde: Guard): void {
  const opts = { preHandler: garde };

  /** Contrôle d'accès commun : tenant du jeton, ADMIN, et un agent Meta rattaché. */
  const ouvrir = async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) { reply.code(403).send({ error: 'tenant interdit' }); return null; }
    if (forbidNonAdmin(req, reply)) return null;
    const agentId = await deps.agentIdDuTenant(tenant);
    if (!agentId) { reply.code(404).send({ error: 'aucun agent Meta sur cet espace' }); return null; }
    return { tenant, agentId, acteur: { id: req.auth?.userId ?? null, email: null } };
  };

  /**
   * LE FIL ET L'ÉTAT D'OUVERTURE.
   *
   * 🔴 QUAND LE FIL EST VIDE, LE SERVEUR RÉDIGE L'ACCUEIL, pas le modèle (décision de Julien : « il dit ce
   * qui manque et propose »). Un modèle à qui l'on demanderait de résumer un inventaire en inventerait la
   * moitié, et c'est précisément le moment où le client décide s'il peut faire confiance à l'assistant.
   */
  app.get('/tenants/:tenantId/mba/assistant', opts, async (req, reply) => {
    const ctx = await ouvrir(req, reply);
    if (!ctx) return;
    const inv = await deps.inventaire(ctx.tenant);
    const fil = (await deps.entretiens.lire(ctx.tenant)) ?? ENTRETIEN_MBA_VIERGE;
    const reste = resteDuBudget(await deps.depenses.lire(ctx.tenant, moisDe(new Date())), deps.plafondEuros);
    return reply.code(200).send({
      messages: fil.messages.slice(-MAX_MESSAGES_AFFICHES_MBA),
      auteurs: fil.auteurs.slice(-MAX_MESSAGES_AFFICHES_MBA),
      total: fil.messages.length,
      // ⚠️ L'accueil n'est rendu QUE sur un fil vide : le renvoyer à chaque ouverture ferait répéter à
      // l'écran un bilan que la conversation a déjà dépassé.
      accueil: fil.messages.length === 0 && inv ? accueilMba(inv.completion) : null,
      completion: inv?.completion ?? null,
      // Le client doit pouvoir voir venir la limite plutôt que de la découvrir en plein travail.
      budgetEpuise: reste <= 0,
    });
  });

  /** Repartir de zéro. Le fil est effacé ; RIEN de ce qui a été appliqué chez Meta ne l'est. */
  app.delete('/tenants/:tenantId/mba/assistant', opts, async (req, reply) => {
    const ctx = await ouvrir(req, reply);
    if (!ctx) return;
    await deps.entretiens.effacer(ctx.tenant);
    return reply.code(204).send();
  });

  /** UN TOUR de conversation. N'écrit rien chez Meta : il PROPOSE. */
  app.post('/tenants/:tenantId/mba/assistant', opts, async (req, reply) => {
    const ctx = await ouvrir(req, reply);
    if (!ctx) return;
    if (!deps.completer) return reply.code(503).send({ error: 'assistant indisponible' });
    const parse = corpsTour.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'message requis' });

    /**
     * 🔴 LE PLAFOND EST VÉRIFIÉ AVANT L'APPEL, ET IL REND 200. Ce n'est pas une panne : c'est une limite
     * volontaire, et l'assistant la DIT. Un 4xx ferait afficher un message d'infrastructure là où le client
     * attend une phrase, et un 5xx serait remplacé par la page d'erreur de Cloudflare.
     */
    const mois = moisDe(new Date());
    const reste = resteDuBudget(await deps.depenses.lire(ctx.tenant, mois), deps.plafondEuros);
    if (reste <= 0) {
      return reply.code(200).send({ message: MESSAGE_PLAFOND, operations: [], budgetEpuise: true, ongletsUtilisables: true });
    }

    const inv = await deps.inventaire(ctx.tenant);
    if (!inv) {
      // 422 et pas 502 : l'écran affiche ce message, et Cloudflare remplace le corps de toute 5xx par sa page.
      journaliser('error', 'mba_assistant_inventaire_illisible', { tenantId: ctx.tenant });
      return reply.code(422).send({ error: 'état de l’agent illisible chez Meta pour l’instant' });
    }

    const avant = (await deps.entretiens.lire(ctx.tenant)) ?? ENTRETIEN_MBA_VIERGE;
    /**
     * 🔴 DEUX FILS : `filComplet` est ce qu'on CONSERVE, `historique` ce qu'on ENVOIE. Les confondre
     * annulerait la conservation, et c'est exactement le défaut qu'a connu l'assistant d'agent IA : la
     * troncature s'y était déplacée sans disparaître, et la base recevait un fil amputé à chaque tour.
     */
    const filComplet: TourMba[] = [...avant.messages, { role: 'user', content: parse.data.message }];
    const auteurs: Array<string | null> = [...avant.auteurs, ctx.acteur.id];
    const point = pointDuTourMba(inv, avant.poses);
    const messages = construireMessagesMba(inv, bornerPourModeleMba(filComplet), avant.poses) as ChatMessage[];

    /**
     * 🔴 L'APPEL EST BORNÉ ET IL EST RATTRAPÉ, et les deux manquaient. Une panne du fournisseur, un délai
     * dépassé ou une clé refusée levaient ici : Fastify rendait alors 500, et **Cloudflare remplace le corps
     * de toute 5xx par sa page d'erreur**, donc le client voyait un écran qui n'explique rien. Rien de tout
     * ça n'est un incident de la console. Même traitement que `src/http/agent-setup.ts`.
     *
     * ⚠️ AVANT d'écrire quoi que ce soit : le fil n'est écrit qu'après une réponse. Un tour qui n'a pas eu
     * lieu ne doit pas laisser le message du client dans le fil, sans réponse en face.
     */
    let reponse: ReponseChat;
    try {
      reponse = await deps.completer({
        modele: deps.modele,
        messages,
        tenantId: '',
        outils: [outilProposer()] as OutilExpose[],
        signal: AbortSignal.timeout(DELAI_MS),
      });
    } catch (err) {
      // 🔴 422 ET PAS 502, pour la raison écrite juste au-dessus : en 502, le client ne lisait que « Erreur 502 ».
      // Et SEULEMENT pour une panne du fournisseur : le reste est notre panne, relancée en 500 opaque.
      const raison = direPanneModele(err);
      if (raison === null) throw err;
      journaliser('error', 'mba_assistant_tour_echec', { tenantId: ctx.tenant, err });
      return reply.code(422).send({ error: `l’assistant n’a pas répondu : ${raison}` });
    }

    // ⚠️ LA DÉPENSE EST NOTÉE APRÈS L'APPEL, avec le coût RÉEL : une estimation avant serait fausse, et le
    // dépassement du dernier tour est assumé, borné par le coût d'un tour.
    await deps.depenses.ajouter(ctx.tenant, mois,
      microEurosDepuisDollars(reponse.usage.coutDollars, deps.tauxEurParDollar));

    /**
     * ⚠️ LES ARGUMENTS ARRIVENT EN JSON BRUT (`argumentsJson`), et un modèle peut en rendre du mal formé.
     * Un `JSON.parse` nu léverait, donc casserait le tour sur une faute qui n'est pas celle du client :
     * on retombe sur un objet vide, que le schéma refusera proprement juste en dessous.
     */
    const appel = reponse.appelsOutils[0];
    let brut: unknown = {};
    // ⚠️ `secureJsonParse` et non `JSON.parse`, comme `src/http/agent-setup.ts` : ce JSON vient d'un modèle,
    // donc d'une source non fiable, et un `__proto__` dedans n'a rien à faire dans l'objet qu'on manipule
    // avant même la validation. Deux traitements du MÊME flux, c'est le motif « câblé sur un consommateur
    // sur deux », et c'est la moitié la plus exposée qui était restée en `JSON.parse`.
    try { brut = appel ? secureJsonParse(appel.argumentsJson) : {}; } catch { brut = {}; }
    const propose = propositionMbaSchema.safeParse(brut);
    if (!propose.success) {
      /**
       * ⚠️ UN MODÈLE QUI RÉPOND DE TRAVERS NE CASSE PAS LE FIL. On rend ce qu'il a dit en texte, sans
       * opérations : le client relance, et sa conversation n'est pas perdue. Refuser en 422 laisserait un
       * écran mort sur une erreur qu'il ne peut pas corriger.
       */
      const texte = reponse.texte ?? 'Je n’ai pas compris. Pouvez-vous reformuler ?';
      await deps.entretiens.ecrire(ctx.tenant, {
        ...avant, messages: [...filComplet, { role: 'assistant', content: texte }],
        auteurs: [...auteurs, null],
      });
      return reply.code(200).send({ message: texte, operations: [] });
    }

    const apres: EntretienMba = {
      messages: [...filComplet, { role: 'assistant', content: propose.data.message }],
      auteurs: [...auteurs, null],
      reponses: [...avant.reponses, ...propose.data.reponses],
      // Le point du tour est noté POSÉ : sans ça, le tour d'après le reposerait.
      poses: point && !avant.poses.includes(point.cle) ? [...avant.poses, point.cle] : avant.poses,
    };
    await deps.entretiens.ecrire(ctx.tenant, apres);

    return reply.code(200).send({
      message: propose.data.message,
      // Le diff, tel que l'écran l'affichera : une ligne par opération, déjà rédigée.
      operations: propose.data.operations.map((o) => ({ ...o, libelle: libelleDe(o) })),
    });
  });

  /**
   * DÉPOSER UNE PIÈCE JOINTE.
   *
   * 🔴 ELLE N'ENVOIE RIEN CHEZ META. Elle range le contenu et rend une opération `fichier.ajouter` qui entre
   * dans le diff, comme tout le reste : sans ce détour, le dépôt serait le seul geste de la conversation qui
   * agirait avant d'avoir été relu.
   *
   * 🔴 LE TYPE VIENT DE LA SIGNATURE, pas de ce que le navigateur déclare. Voir `typeMetaDuContenu`.
   *
   * `bodyLimit` dédié : les octets transitent en base64 (+33 %), comme l'upload de l'onglet Documents.
   */
  const optsPiece = { ...opts, bodyLimit: Math.ceil(MAX_FICHIER * 1.4) };
  app.post('/tenants/:tenantId/mba/assistant/piece-jointe', optsPiece, async (req, reply) => {
    const ctx = await ouvrir(req, reply);
    if (!ctx) return;
    if (!deps.pieces) return reply.code(503).send({ error: 'dépôt de document indisponible sur ce serveur' });
    const parse = corpsPiece.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'nom et dataUrl requis' });

    const octets = octetsDepuisDataUrl(parse.data.dataUrl);
    if (!octets) return reply.code(400).send({ error: 'fichier illisible (data URL base64 attendue)' });
    // ⚠️ La TAILLE se mesure sur les octets décodés, jamais sur la longueur du base64 : c'est ce que Meta
    // recevra, et c'est ce que le message annonce.
    if (octets.length > MAX_FICHIER) {
      return reply.code(413).send({ error: `fichier trop lourd (${Math.round(MAX_FICHIER / 1024 / 1024)} Mo maximum)` });
    }
    const type = typeMetaDuContenu(octets, parse.data.nom);
    // 415 et pas 400 : le corps est bien formé, c'est le TYPE du contenu qu'on refuse.
    if ('refus' in type) return reply.code(415).send({ error: type.refus });

    const jeton = deps.pieces.deposer(ctx.tenant, { nom: parse.data.nom, mime: type.mime, octets });
    const operation: Operation = { type: 'fichier.ajouter', jeton, nom: parse.data.nom };
    return reply.code(201).send({ operation: { ...operation, libelle: libelleDe(operation) } });
  });

  /**
   * APPLIQUER LE DIFF.
   *
   * 🔴 L'ACCEPTATION DU DIFF SUFFIT : pas de seconde confirmation (décision de Julien). Une confirmation qui
   * suit une acceptation n'ajoute pas de sécurité, elle apprend à cliquer sans lire.
   */
  app.post('/tenants/:tenantId/mba/assistant/appliquer', opts, async (req, reply) => {
    const ctx = await ouvrir(req, reply);
    if (!ctx) return;
    const parse = corpsAppliquer.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'operations requises' });

    /**
     * 🔴 LES OPÉRATIONS SONT REVALIDÉES ICI, et ce n'est pas de la redondance : ce corps vient du
     * NAVIGATEUR, pas du modèle. Sans cette passe, n'importe qui pourrait poster une opération que le
     * schéma de proposition interdit, et la frontière de sécurité ne servirait plus à rien.
     */
    const valides = propositionMbaSchema.safeParse({ message: 'application', operations: parse.data.operations });
    if (!valides.success) return reply.code(422).send({ error: 'ces opérations ne sont pas applicables' });

    /**
     * 🔴 LES JETONS SE VÉRIFIENT AVANT D'AVOIR RIEN ÉCRIT. C'est une lecture locale, gratuite, et elle évite
     * le pire enchaînement : appliquer trois opérations chez Meta puis s'arrêter sur un document expiré,
     * c'est-à-dire laisser un état à moitié posé pour une cause qui était connue d'avance.
     */
    const jetonMort = (valides.data.operations as Operation[]).find(
      (o) => o.type === 'fichier.ajouter' && !(deps.pieces?.contient(ctx.tenant, o.jeton) ?? false),
    );
    if (jetonMort) {
      return reply.code(422).send({
        error: `Le document « ${jetonMort.type === 'fichier.ajouter' ? jetonMort.nom : ''} » n’est plus disponible : redéposez-le, puis réessayez.`,
      });
    }

    const r = await appliquer(
      deps.application(ctx.tenant, ctx.acteur), ctx.tenant, ctx.agentId,
      valides.data.operations as Operation[],
    );
    return reply.code(200).send({
      passees: r.passees.map((o) => libelleDe(o)),
      echec: r.echec ? { libelle: libelleDe(r.echec.operation), message: r.echec.message } : null,
      nonTentees: r.nonTentees.map((o) => libelleDe(o)),
    });
  });
}

/** La définition de l'outil exposée au modèle. Il rend TOUJOURS sa réponse par là, jamais en texte libre. */
function outilProposer(): unknown {
  return {
    type: 'function',
    function: {
      name: 'proposer',
      description: 'Répondre au client et, s’il y a lieu, proposer des modifications de son agent Meta.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Ce que tu dis au client, en français.' },
          reponses: {
            type: 'array',
            items: {
              type: 'object',
              properties: { point: { type: 'string' }, valeur: { type: 'string' } },
              required: ['point'],
            },
          },
          operations: {
            type: 'array',
            description: 'Les modifications à appliquer chez Meta. Vide si tu poses seulement une question.',
            items: { type: 'object', properties: { type: { type: 'string' } }, required: ['type'] },
          },
        },
        required: ['message'],
      },
    },
  };
}
