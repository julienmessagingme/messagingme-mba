import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parse as secureJsonParse } from 'secure-json-parse';
import { forbidNonAdmin, type Guard } from '../auth/middleware';
import { espaceVerifie } from './scope';
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
 * L'assistant du Meta Business Agent : la conversation qui règle l'agent et le met à jour.
 * Cette route n'écrit rien chez Meta : elle rend une proposition et son diff, l'écriture passe par `appliquer`
 * sur un geste explicite du client. La conversation n'est jamais le seul chemin d'édition.
 * 🔴 Admins seulement : sinon la conversation contournerait le contrôle d'accès des formulaires.
 * 🔴 C'est nous qui payons : un plafond borne la dépense (`src/assistant/budget.ts`), et l'assistant le dit.
 */

export interface MbaAssistantDeps {
  /** L'inventaire de l'agent, lu chez Meta. Voir `lireInventaireMba` dans le câblage. */
  inventaire(tenantId: string): Promise<InventaireMba | null>;
  entretiens: EntretienMbaStore;
  depenses: DepenseStore;
  plafondEuros: number;
  /**
   * Le client de modèle ; absent, l'assistant est indisponible (503). Le type vient du client de chat, pas
   * recopié : un contrat recopié approximativement ne protège de rien.
   */
  completer?(entree: Parameters<GatewayChatClient['completer']>[0]): Promise<ReponseChat>;
  modele: string;
  /** Tout ce qu'il faut pour écrire chez Meta. */
  application(tenantId: string, acteur: { id: string | null; email: string | null }): ApplicationDeps;
  /** L'identifiant de l'agent Meta de cet espace (`agentId` des routes MBA) : son numéro Meta. */
  numeros: { getTenantPhoneNumberId(tenantId: string): Promise<string | null> };
  tauxEurParDollar: number;
  /**
   * Le magasin des pièces jointes déposées dans le fil. Toujours câblé quand ce module est monté.
   */
  pieces: MagasinPiecesJointes;
}

/** Ce que l'écran reçoit d'un coup. Trois plafonds distincts, cf. `entretien-store.ts`. */
export const MAX_MESSAGES_AFFICHES_MBA = 200;

/**
 * Le délai d'un tour : sans borne, un fournisseur qui traîne tient la requête ouverte indéfiniment. Sans lien
 * avec celui de `agent-setup.ts` : deux routes bornées chacune, pas un invariant partagé.
 */
const DELAI_MS = 45_000;

const corpsTour = z.object({ message: z.string().trim().min(1).max(4000) });
const corpsAppliquer = z.object({ operations: z.array(z.unknown()).max(20) });
const corpsPiece = z.object({
  /** Le nom tel que Meta le gardera. Son extension doit correspondre à la signature du contenu. */
  nom: z.string().trim().min(1).max(200),
  dataUrl: z.string().min(1),
});

export function registerMbaAssistant(app: FastifyInstance, deps: MbaAssistantDeps, garde: Guard): void {
  const opts = { preHandler: garde };

  /** Contrôle d'accès commun : tenant du jeton, admin, et un agent Meta rattaché. */
  const ouvrir = async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = espaceVerifie(req);
    if (forbidNonAdmin(req, reply)) return null;
    const agentId = await deps.numeros.getTenantPhoneNumberId(tenant);
    if (!agentId) { reply.code(404).send({ error: 'aucun agent Meta sur cet espace' }); return null; }
    return { tenant, agentId, acteur: { id: req.auth?.userId ?? null, email: null } };
  };

  /**
   * Le fil et l'état d'ouverture. Quand le fil est vide, le serveur rédige l'accueil, pas le modèle : à qui l'on
   * demanderait de résumer un inventaire, un modèle en inventerait la moitié.
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
      // L'accueil n'est rendu que sur un fil vide : le renvoyer à chaque ouverture répéterait un bilan dépassé.
      accueil: fil.messages.length === 0 && inv ? accueilMba(inv.completion) : null,
      completion: inv?.completion ?? null,
      // Le client doit pouvoir voir venir la limite plutôt que de la découvrir en plein travail.
      budgetEpuise: reste <= 0,
    });
  });

  /** Repartir de zéro. Le fil est effacé ; rien de ce qui a été appliqué chez Meta ne l'est. */
  app.delete('/tenants/:tenantId/mba/assistant', opts, async (req, reply) => {
    const ctx = await ouvrir(req, reply);
    if (!ctx) return;
    await deps.entretiens.effacer(ctx.tenant);
    return reply.code(204).send();
  });

  /** Un tour de conversation. N'écrit rien chez Meta : il propose. */
  app.post('/tenants/:tenantId/mba/assistant', opts, async (req, reply) => {
    const ctx = await ouvrir(req, reply);
    if (!ctx) return;
    if (!deps.completer) return reply.code(503).send({ error: 'assistant indisponible' });
    const parse = corpsTour.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'message requis' });

    /**
     * Le plafond est vérifié avant l'appel et rend 200 : c'est une limite voulue, l'assistant la dit (un 4xx
     * afficherait un message d'infrastructure, un 5xx serait remplacé par la page de Cloudflare).
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
     * Deux fils : `filComplet` est ce qu'on conserve, `historique` ce qu'on envoie au modèle. Les confondre ferait
     * écrire en base un fil amputé à chaque tour.
     */
    const filComplet: TourMba[] = [...avant.messages, { role: 'user', content: parse.data.message }];
    const auteurs: Array<string | null> = [...avant.auteurs, ctx.acteur.id];
    const point = pointDuTourMba(inv, avant.poses);
    const messages = construireMessagesMba(inv, bornerPourModeleMba(filComplet), avant.poses) as ChatMessage[];

    /**
     * L'appel est borné et rattrapé : une panne du fournisseur, un délai ou une clé refusée ne sont pas des incidents
     * de la console. Rien n'est écrit avant : le fil ne s'écrit qu'après une réponse, sinon le message du client y
     * resterait sans réponse en face.
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
      // 422 et pas 502, pour que l'écran lise le message. Seulement pour une panne du fournisseur : le reste est
      // notre panne, relancée en 500 opaque.
      const raison = direPanneModele(err);
      if (raison === null) throw err;
      journaliser('error', 'mba_assistant_tour_echec', { tenantId: ctx.tenant, err });
      return reply.code(422).send({ error: `l’assistant n’a pas répondu : ${raison}` });
    }

    // La dépense est notée après l'appel, au coût réel ; le dépassement du dernier tour est assumé, borné par le
    // coût d'un tour.
    await deps.depenses.ajouter(ctx.tenant, mois,
      microEurosDepuisDollars(reponse.usage.coutDollars, deps.tauxEurParDollar));

    /**
     * Les arguments arrivent en JSON brut, et un modèle peut en rendre du mal formé : on retombe sur un objet vide,
     * que le schéma refusera proprement.
     */
    const appel = reponse.appelsOutils[0];
    let brut: unknown = {};
    // `secureJsonParse` et non `JSON.parse` : ce JSON vient d'un modèle, et un `__proto__` n'a rien à faire dans
    // l'objet manipulé avant la validation.
    try { brut = appel ? secureJsonParse(appel.argumentsJson) : {}; } catch { brut = {}; }
    const propose = propositionMbaSchema.safeParse(brut);
    if (!propose.success) {
      /**
       * Un modèle qui répond de travers ne casse pas le fil : on rend son texte, sans opérations, et le client relance.
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
      // Le point du tour est noté posé : sans ça, le tour d'après le reposerait.
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
   * Déposer une pièce jointe. Elle n'envoie rien chez Meta : elle range le contenu et rend une opération
   * `fichier.ajouter` qui entre dans le diff, relu comme le reste. Le type vient de la signature, pas du
   * navigateur (`typeMetaDuContenu`). `bodyLimit` dédié : les octets transitent en base64 (+33 %).
   */
  const optsPiece = { ...opts, bodyLimit: Math.ceil(MAX_FICHIER * 1.4) };
  app.post('/tenants/:tenantId/mba/assistant/piece-jointe', optsPiece, async (req, reply) => {
    const ctx = await ouvrir(req, reply);
    if (!ctx) return;
    const parse = corpsPiece.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'nom et dataUrl requis' });

    const octets = octetsDepuisDataUrl(parse.data.dataUrl);
    if (!octets) return reply.code(400).send({ error: 'fichier illisible (data URL base64 attendue)' });
    // La taille se mesure sur les octets décodés, jamais sur la longueur du base64 : c'est ce que Meta recevra.
    if (octets.length > MAX_FICHIER) {
      return reply.code(413).send({ error: `fichier trop lourd (${Math.round(MAX_FICHIER / 1024 / 1024)} Mo maximum)` });
    }
    const type = typeMetaDuContenu(octets, parse.data.nom);
    // 415 et pas 400 : le corps est bien formé, c'est le type du contenu qu'on refuse.
    if ('refus' in type) return reply.code(415).send({ error: type.refus });

    const jeton = deps.pieces.deposer(ctx.tenant, { nom: parse.data.nom, mime: type.mime, octets });
    const operation: Operation = { type: 'fichier.ajouter', jeton, nom: parse.data.nom };
    return reply.code(201).send({ operation: { ...operation, libelle: libelleDe(operation) } });
  });

  /**
   * Appliquer le diff. L'acceptation du diff suffit : une seconde confirmation apprendrait à cliquer sans lire.
   */
  app.post('/tenants/:tenantId/mba/assistant/appliquer', opts, async (req, reply) => {
    const ctx = await ouvrir(req, reply);
    if (!ctx) return;
    const parse = corpsAppliquer.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'operations requises' });

    /**
     * 🔴 Les opérations sont revalidées ici : ce corps vient du navigateur, pas du modèle, et sans cette passe
     * n'importe qui posterait une opération que le schéma de proposition interdit.
     */
    const valides = propositionMbaSchema.safeParse({ message: 'application', operations: parse.data.operations });
    if (!valides.success) return reply.code(422).send({ error: 'ces opérations ne sont pas applicables' });

    /**
     * Les jetons se vérifient avant toute écriture (lecture locale, gratuite) : sinon trois opérations appliquées
     * chez Meta, puis un arrêt sur un document expiré, laisseraient un état à moitié posé.
     */
    const jetonMort = (valides.data.operations as Operation[]).find(
      (o) => o.type === 'fichier.ajouter' && !deps.pieces.contient(ctx.tenant, o.jeton),
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

/** La définition de l'outil exposée au modèle. Il rend toujours sa réponse par là, jamais en texte libre. */
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
