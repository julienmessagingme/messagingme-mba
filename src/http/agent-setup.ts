import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { parse as secureJsonParse } from 'secure-json-parse';
import type { Guard } from '../auth/middleware';
import type { ChatMessage, ReponseChat, OutilExpose } from '../agent/llm/chat-client';
import { construireMessages, MAX_CARACTERES_MESSAGE, type ContexteConstruction } from '../agent/setup/conversation';
import { differences, propositionSchema, OUTIL_PROPOSER, SCHEMA_PROPOSITION } from '../agent/setup/proposition';
import { agendaEffectif, fusionner, manquesDeCouverture, prochainPoint } from '../agent/setup/couverture';
import { ENTRETIEN_VIERGE, type EntretienComplet, type EntretienStore, type TourEntretien } from '../agent/setup/entretien-store';
import { scopeTenant, estUuid } from './scope';

/**
 * La conversation de CONSTRUCTION d'un agent : elle propose, le client corrige.
 *
 * 🔴 CETTE ROUTE N'ÉCRIT RIEN DE L'AGENT. Elle rend une proposition et le diff qu'elle produirait ; l'écriture
 * passe par le `PATCH` de la fiche et par les routes d'outils, avec leurs verrous et leurs contrôles. C'est la
 * règle du cadrage §5.9, et elle a une raison précise : le jour où l'onglet « Create » a disparu de
 * l'interface d'OpenAI, des GPTs sont devenus non modifiables du jour au lendemain. Ici la conversation n'est
 * jamais le seul chemin d'édition, et elle n'a aucun pouvoir que le formulaire n'ait déjà. La seule chose
 * qu'elle écrit est SON PROPRE ÉTAT (table `agent_setup_conversations`).
 *
 * 🔴 CE QUE LE MODÈLE PEUT PROPOSER EST ÉNUMÉRÉ dans `src/agent/setup/proposition.ts` : la fiche et les mots
 * des outils maison. Ni la mention légale d'IA, ni les plafonds, ni le modèle de l'agent, ni le risque d'un
 * outil, ni son activation. Compromettre cette conversation ne compromet donc pas l'agent.
 *
 * 🔴 C'EST LE SERVEUR QUI CONDUIT L'ENTRETIEN, depuis le 2026-08-31. L'ordre du jour, le point du tour et la
 * couverture sont calculés ici, à partir d'un état persisté ; le modèle formule et extrait, il ne décide de
 * rien. Le navigateur ne renvoie plus l'historique : il envoie UN message, et c'est tout. Avant, il portait la
 * conversation entière, ce qui la perdait au changement d'onglet et laissait la séquence des questions à la
 * discrétion du modèle, qui sautait le ton, l'identité et la base de connaissance.
 */

export interface AgentSetupRouteDeps {
  /** L'état courant de l'agent, ou `null` s'il n'existe pas ou appartient à un autre tenant. */
  etatCourant(tenantId: string, agentId: string): Promise<ContexteConstruction | null>;
  /** L'entretien persisté. ABSENT : la route répond 503 plutôt que de retomber sur un entretien sans mémoire,
   *  qui redeviendrait non déterministe sans que personne ne le voie. */
  entretiens?: EntretienStore;
  /** Appel du modèle. Injecté pour rester testable sans réseau ; absent, la route répond 503. */
  completer?(input: { modele: string; messages: ChatMessage[]; outils: OutilExpose[]; toolChoice: string; signal: AbortSignal }): Promise<ReponseChat>;
  /** Modèle de l'IA de CONSTRUCTION. À ne pas confondre avec celui de l'agent : celui-ci tourne rarement et
   *  joue le rôle le plus dur, celui-là répond à chaque message d'un contact. */
  modele: string;
}

const corpsSchema = z.object({
  message: z.string().trim().min(1).max(MAX_CARACTERES_MESSAGE),
});

/** Un tour de construction est un appel de modèle, pas une requête de base : il faut le borner ici aussi. */
const DELAI_MS = 45_000;

/** L'avancement, tel que l'écran l'affiche. Le total est celui de l'ordre du jour EFFECTIF : un client dont
 *  l'agent n'appellera jamais d'outil ne doit pas se voir annoncer un point qui n'existera jamais pour lui. */
function avancement(etat: EntretienComplet): { manquants: string[]; total: number; pointOuvert: string | null } {
  const manquants = manquesDeCouverture(etat);
  return {
    manquants,
    total: agendaEffectif(etat.reponses).length,
    pointOuvert: prochainPoint(etat)?.code ?? null,
  };
}

export function registerAgentSetup(app: FastifyInstance, deps: AgentSetupRouteDeps, guard?: Guard): void {
  const opts = guard ? { preHandler: guard } : {};

  /** Contrôle d'accès commun aux trois routes : tenant du jeton, agent existant DE CE TENANT. */
  const ouvrir = async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) { reply.code(403).send({ error: 'tenant interdit' }); return null; }
    const { agentId } = req.params as { agentId: string };
    if (!estUuid(agentId)) { reply.code(404).send({ error: 'agent introuvable' }); return null; }
    if (!deps.entretiens) { reply.code(503).send({ error: 'assistant de construction indisponible' }); return null; }
    const etat = await deps.etatCourant(tenant, agentId);
    if (!etat) { reply.code(404).send({ error: 'agent introuvable' }); return null; }
    return { tenant, agentId, etat, entretiens: deps.entretiens };
  };

  /**
   * L'entretien tel qu'il est, pour rouvrir l'onglet là où on l'avait laissé.
   *
   * Julien, 2026-08-31 : « je veux que la conversation qui a été tenue préalablement soit persistante quand on
   * revient plus tard sur l'onglet ». Sans cette route, l'écran repartirait d'une page blanche et le client
   * recommencerait un entretien qu'il avait déjà mené.
   */
  app.get('/tenants/:tenantId/agents/:agentId/setup', opts, async (req, reply) => {
    const ctx = await ouvrir(req, reply);
    if (!ctx) return;
    const entretien = (await ctx.entretiens.lire(ctx.tenant, ctx.agentId)) ?? ENTRETIEN_VIERGE;
    return reply.code(200).send({ messages: entretien.messages, couverture: avancement(entretien) });
  });

  /**
   * Recommencer. Un entretien qui a mal tourné doit pouvoir se jeter sans supprimer l'agent : sans ce geste,
   * la persistance qu'on vient d'ajouter deviendrait une prison, et le seul moyen de repartir proprement
   * serait de recréer l'agent et de perdre tout ce qui a déjà été réglé dans les autres onglets.
   */
  app.delete('/tenants/:tenantId/agents/:agentId/setup', opts, async (req, reply) => {
    const ctx = await ouvrir(req, reply);
    if (!ctx) return;
    await ctx.entretiens.effacer(ctx.tenant, ctx.agentId);
    return reply.code(200).send({ efface: true, couverture: avancement(ENTRETIEN_VIERGE) });
  });

  app.post('/tenants/:tenantId/agents/:agentId/setup', opts, async (req, reply) => {
    const ctx = await ouvrir(req, reply);
    if (!ctx) return;
    if (!deps.completer || deps.modele.trim() === '') {
      return reply.code(503).send({ error: 'assistant de construction indisponible (aucun modèle configuré)' });
    }
    const parse = corpsSchema.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'message requis (texte non vide)' });

    const avant = (await ctx.entretiens.lire(ctx.tenant, ctx.agentId)) ?? ENTRETIEN_VIERGE;
    const historique: TourEntretien[] = [...avant.messages, { role: 'user', content: parse.data.message }];
    // 🔴 Le point du tour est arrêté AVANT l'appel, sur l'état serveur : c'est ce qui rend la séquence des
    // questions non négociable. Il est noté « posé » plus bas, parce que la réponse du modèle le pose.
    const pointDuTour = prochainPoint(avant);

    let reponse: ReponseChat;
    try {
      reponse = await deps.completer({
        modele: deps.modele,
        messages: construireMessages(ctx.etat, historique, avant),
        outils: [{
          name: OUTIL_PROPOSER,
          description: 'Rends ta réponse et, si tu en as une, ta proposition de réglage.',
          parameters: SCHEMA_PROPOSITION,
        }],
        toolChoice: OUTIL_PROPOSER,
        signal: AbortSignal.timeout(DELAI_MS),
      });
    } catch (err) {
      // Panne du fournisseur, délai dépassé, clé refusée : rien de tout ça n'est un incident de la console,
      // et un 5xx verrait son corps remplacé par la page d'erreur de Cloudflare.
      return reply.code(502).send({ error: `l’assistant n’a pas répondu : ${err instanceof Error ? err.message : 'erreur inconnue'}` });
    }

    const appel = reponse.appelsOutils.find((a) => a.nom === OUTIL_PROPOSER);
    if (!appel) return reply.code(422).send({ error: 'l’assistant n’a pas rendu de proposition exploitable' });
    let brut: unknown;
    try {
      // `secureJsonParse` et non `JSON.parse` : ce JSON vient d'un modèle, donc d'une source non fiable, et
      // un `__proto__` dedans polluerait le prototype avant même la validation. Même règle que le webhook.
      brut = secureJsonParse(appel.argumentsJson);
    } catch {
      return reply.code(422).send({ error: 'l’assistant a rendu une proposition illisible' });
    }
    // `safeParse` : tout ce qui n'est pas au schéma est ÉCARTÉ, silencieusement et sans faire échouer le
    // tour. Un modèle qui tente une clé de sécurité n'obtient rien, il ne casse pas la conversation.
    const propose = propositionSchema.safeParse(brut);
    if (!propose.success) return reply.code(422).send({ error: 'l’assistant a rendu une proposition hors format' });

    /**
     * 🔴 L'ÉTAT DE L'ENTRETIEN EST RECALCULÉ ICI, ET NULLE PART AILLEURS.
     *
     * Deux écritures, et chacune porte une garantie :
     *  - les RÉPONSES extraites entrent dans l'état (`fusionner` ignore les codes inconnus et les valeurs
     *    vides : un modèle qui invente un point n'obtient rien) ;
     *  - le point du tour est noté POSÉ, parce que le message que l'assistant vient d'écrire le pose. C'est
     *    ce qui interdit de compter couvert un point que le client n'a jamais vu passer, même si le modèle
     *    prétend en connaître la réponse. La couverture cesse d'être une déclaration pour devenir un fait.
     */
    const apres: EntretienComplet = {
      messages: [...historique, { role: 'assistant', content: propose.data.message }],
      reponses: fusionner(avant.reponses, propose.data.reponses),
      poses: pointDuTour && !avant.poses.includes(pointDuTour.code)
        ? [...avant.poses, pointDuTour.code]
        : avant.poses,
    };
    await ctx.entretiens.ecrire(ctx.tenant, ctx.agentId, apres);

    /**
     * 🔴 LE DIFF EST RETENU TANT QUE L'ORDRE DU JOUR N'EST PAS ÉPUISÉ.
     *
     * Julien, 2026-08-28 : « poser des questions pour couvrir d'abord tout le périmètre en un premier round
     * avant d'afficher les règles ». Le mandat le dit au modèle ; ceci le lui IMPOSE, et depuis le 2026-08-31
     * sans le vieux garde-fou du « au moins deux messages du client », qui était un pis-aller : il compensait
     * le fait que la couverture était déclarée par le modèle. Elle ne l'est plus.
     *
     * On ne jette pas la proposition, on ne la MONTRE pas : le tour suivant la reformulera avec ce qu'il aura
     * appris entre-temps, et rien de ce que le client n'a pas encore dit n'aura été présenté comme compris.
     */
    const suivi = avancement(apres);
    const enEntretien = suivi.manquants.length > 0;

    return reply.code(200).send({
      message: propose.data.message,
      couverture: suivi,
      proposition: enEntretien ? { fiche: {}, outils: [], connecteurs: [] } : {
        fiche: propose.data.fiche ?? {},
        outils: propose.data.outils ?? [],
        // Les connecteurs proposés sont filtrés sur ceux qui EXISTENT : l'assistant n'en crée pas, et un nom
        // inventé ne doit pas atteindre l'application, qui tenterait un patch sur un outil inconnu.
        connecteurs: (propose.data.connecteurs ?? []).filter((c) => (ctx.etat.connecteurs ?? []).some((x) => x.nom === c.nom)),
      },
      changements: enEntretien ? [] : differences(ctx.etat, propose.data),
      usage: { tokensIn: reponse.usage.tokensIn, tokensOut: reponse.usage.tokensOut },
    });
  });
}
