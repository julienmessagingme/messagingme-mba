import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Guard } from '../auth/middleware';
import type { ContexteTour, DecisionTracee, GatewayBrainDeps } from '../agent/brain.gateway';
import { AgentIntrouvable, penserTrace } from '../agent/brain.gateway';
import { TourInterrompu } from '../agent/brain';
import { scopeTenant, estUuid } from './scope';

/**
 * Le BAC À SABLE : parler à son agent depuis la console, avant de l'activer.
 *
 * 🔴 CE QU'IL PROUVE, ET CE QU'IL NE PROUVE PAS. Il fait tourner le VRAI cerveau, avec le vrai prompt, les
 * vrais outils exposés et la VRAIE recherche de connaissance : ce que l'agent répond ici est ce qu'il
 * répondra. En revanche les outils à effet sont simulés (`resolvers/simulation.ts`), parce qu'il n'y a ni
 * contact, ni conversation, ni parcours : poser un tag écrirait sur une vraie fiche du mini-CRM, envoyer un
 * bloc partirait chez un vrai numéro. L'écran le dit, appel par appel.
 *
 * 🔴 AUCUNE SESSION N'EST OUVERTE, aucun run n'est touché, rien n'est persisté. Les identifiants du tour sont
 * des valeurs de bac à sable, et le journal d'appels reçoit une session qui n'existe pas : c'est pour ça que
 * le câblage lui donne un journal MUET plutôt que le vrai, sans quoi chaque essai violerait la clé étrangère
 * de `agent_tool_calls`.
 */

export interface AgentTestRouteDeps {
  /** Les deps du cerveau, moins l'appel de modèle quand il n'est pas configuré. */
  cerveau?: GatewayBrainDeps;
  /** Le Gateway est-il configuré ? Le MODÈLE, lui, vient de la fiche de l'agent, pas d'une variable d'env. */
  disponible: boolean;
  /**
   * Le solde prépayé du workspace, en micro-euros. Optionnelles ensemble ; absentes -> l'essai ne coûte rien
   * au workspace (suites de tests à deps minimales).
   *
   * 🔴 UN ESSAI CONSOMME POUR DE VRAI. Le bac à sable simule les outils à EFFET, jamais l'appel de modèle : le
   * fournisseur facture un essai exactement comme une conversation. Le laisser hors du solde donnerait une
   * porte gratuite et illimitée sur un compte prépayé, et ferait mentir le solde affiché juste à côté.
   */
  solde?(tenantId: string): Promise<number>;
  /** Retire du solde ce que l'essai a coûté. La note dit d'où vient le mouvement : un essai n'ouvre aucune
   *  session, donc le journal n'a rien d'autre pour l'expliquer. */
  debiter?(tenantId: string, montantMicroEur: number, note: string): Promise<void>;
}

const messageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().trim().min(1).max(4000),
});
/** Un essai n'est pas une conversation de production : on le borne plus court, il n'a pas à durer. */
const corpsSchema = z.object({ messages: z.array(messageSchema).min(1).max(30) });

/** Budget de temps d'un essai. Plus large qu'un tour de production (30 s) : ici un humain attend devant son
 *  écran et préfère une réponse lente à un échec, alors qu'en production un contact attend sur WhatsApp. */
const DELAI_MS = 60_000;

/**
 * Le bac à sable n'a ni session, ni run, ni parcours. Ces identifiants sont là pour que le tronc commun ait
 * un contexte complet, et ils ne désignent RIEN en base : le journal du bac à sable est muet.
 *
 * ⚠️ Le CONTACT est inconnu (aucun `lireContact` n'est câblé), et la politique de contact inconnu vient de
 * la FICHE de l'agent, pas d'ici. Le bac à sable montre donc exactement ce que la production ferait, y
 * compris quand un agent en `lecture_seule` refuse ses propres outils d'écriture face à un inconnu : c'est
 * une chose que le client doit voir ici plutôt que de la découvrir en production.
 */
const TOUR_BAC_A_SABLE: Omit<ContexteTour, 'appelsDejaFaits' | 'coutDejaMicroEur'> = {
  sessionId: 'bac-a-sable',
  runId: 'bac-a-sable',
  workflowId: 'bac-a-sable',
  waId: 'bac-a-sable',
};

/**
 * Retire du solde ce que l'essai vient de coûter.
 *
 * BEST-EFFORT, comme en production : le fournisseur a déjà répondu, faire échouer la requête priverait le
 * client de sa réponse pour une ligne de comptabilité. On perd le décompte, jamais l'essai.
 */
async function debiterEssai(tenantId: string, coutMicroEur: number, deps: AgentTestRouteDeps): Promise<void> {
  if (!deps.debiter || !(coutMicroEur > 0)) return;
  try {
    await deps.debiter(tenantId, coutMicroEur, 'essai depuis la console');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`agent: SOLDE NON DÉBITÉ pour un essai du tenant ${tenantId}`, err instanceof Error ? err.message : err);
  }
}

export function registerAgentTest(app: FastifyInstance, deps: AgentTestRouteDeps, guard?: Guard): void {
  const opts = guard ? { preHandler: guard } : {};

  app.post('/tenants/:tenantId/agents/:agentId/test', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { agentId } = req.params as { agentId: string };
    if (!estUuid(agentId)) return reply.code(404).send({ error: 'agent introuvable' });
    if (!deps.cerveau || !deps.disponible) {
      return reply.code(503).send({ error: 'test indisponible (aucun modèle configuré côté serveur)' });
    }
    const parse = corpsSchema.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'messages requis (rôle « user » ou « assistant », texte non vide)' });

    // Le SOLDE, avant l'appel au modèle et pour la même raison qu'en production : on ne paie pas un appel
    // qu'on ne pourra pas facturer. 409 et non 5xx : c'est un état du compte, pas un incident, et Cloudflare
    // remplacerait le corps d'une 5xx par sa page d'erreur, donc le client ne saurait même pas pourquoi.
    if (deps.solde && (await deps.solde(tenant)) <= 0) {
      return reply.code(409).send({ error: 'solde épuisé : rechargez le compte pour essayer votre agent' });
    }

    let decision: DecisionTracee;
    try {
      decision = await penserTrace(
        {
          agentId,
          tenantId: tenant,
          // Le transcript prend la forme que la session porte en production : le cerveau lit la MÊME chose
          // ici et là, sans quoi le bac à sable ne testerait pas le même prompt.
          transcript: parse.data.messages.map((m) => ({ role: m.role === 'assistant' ? 'agent' : 'contact', texte: m.content })),
          deadline: Date.now() + DELAI_MS,
        },
        { ...TOUR_BAC_A_SABLE, appelsDejaFaits: 0, coutDejaMicroEur: 0 },
        deps.cerveau,
      );
    } catch (err) {
      // Une ERREUR TYPÉE distingue l'agent inconnu du reste : reconnaître un message se casserait en silence
      // au premier refactor de ce texte, et relire l'agent avant l'essai coûterait une requête par essai.
      if (err instanceof AgentIntrouvable) return reply.code(404).send({ error: 'agent introuvable' });
      // Un aller-retour déjà facturé se paie même si le suivant a échoué : le cerveau porte dans l'erreur ce
      // qu'il avait déjà dépensé, et un essai qui casse en cours de route n'a aucune raison d'être offert.
      if (err instanceof TourInterrompu) await debiterEssai(tenant, err.usage.coutMicroEur, deps);
      // Panne du fournisseur, délai dépassé, clé refusée : rien de tout ça n'est un incident de la console,
      // et Cloudflare remplacerait le corps d'une 5xx par sa page d'erreur.
      return reply.code(502).send({ error: `l’essai a échoué : ${err instanceof Error ? err.message : 'erreur inconnue'}` });
    }

    await debiterEssai(tenant, decision.usage?.coutMicroEur ?? 0, deps);

    return reply.code(200).send({
      texte: decision.texte,
      sortie: decision.sortie,
      appels: decision.appels,
      usage: decision.usage ?? { tokensIn: 0, tokensOut: 0, coutMicroEur: 0 },
    });
  });
}
