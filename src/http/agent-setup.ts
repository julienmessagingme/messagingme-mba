import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse as secureJsonParse } from 'secure-json-parse';
import type { Guard } from '../auth/middleware';
import type { ChatMessage, ReponseChat, OutilExpose } from '../agent/llm/chat-client';
import { construireMessages, MAX_CARACTERES_MESSAGE, MAX_TOURS_HISTORIQUE, type ContexteConstruction } from '../agent/setup/conversation';
import { differences, propositionSchema, OUTIL_PROPOSER, SCHEMA_PROPOSITION } from '../agent/setup/proposition';
import { scopeTenant, estUuid } from './scope';

/**
 * La conversation de CONSTRUCTION d'un agent : elle propose, le client corrige.
 *
 * 🔴 CETTE ROUTE N'ÉCRIT RIEN. Elle rend une proposition et le diff qu'elle produirait ; l'écriture passe
 * par le `PATCH` de la fiche et par les routes d'outils, avec leurs verrous et leurs contrôles. C'est la
 * règle du cadrage §5.9, et elle a une raison précise : le jour où l'onglet « Create » a disparu de
 * l'interface d'OpenAI, des GPTs sont devenus non modifiables du jour au lendemain. Ici la conversation
 * n'est jamais le seul chemin d'édition, et elle n'a aucun pouvoir que le formulaire n'ait déjà.
 *
 * 🔴 CE QUE LE MODÈLE PEUT PROPOSER EST ÉNUMÉRÉ dans `src/agent/setup/proposition.ts` : la fiche et les mots
 * des outils maison. Ni la mention légale d'IA, ni les plafonds, ni le modèle de l'agent, ni le risque d'un
 * outil, ni son activation. Compromettre cette conversation ne compromet donc pas l'agent.
 *
 * La conversation N'EST PAS PERSISTÉE : le client porte l'historique et le serveur relit la fiche à chaque
 * tour. Pas de table de plus, et la synchronisation avec le formulaire est gratuite. Un admin pourrait
 * forger un faux tour d'assistant dans ce qu'il renvoie ; sans conséquence, il a déjà le droit d'écrire la
 * fiche en direct.
 */

export interface AgentSetupRouteDeps {
  /** L'état courant de l'agent, ou `null` s'il n'existe pas ou appartient à un autre tenant. */
  etatCourant(tenantId: string, agentId: string): Promise<ContexteConstruction | null>;
  /** Appel du modèle. Injecté pour rester testable sans réseau ; absent, la route répond 503. */
  completer?(input: { modele: string; messages: ChatMessage[]; outils: OutilExpose[]; toolChoice: string; signal: AbortSignal }): Promise<ReponseChat>;
  /** Modèle de l'IA de CONSTRUCTION. À ne pas confondre avec celui de l'agent : celui-ci tourne rarement et
   *  joue le rôle le plus dur, celui-là répond à chaque message d'un contact. */
  modele: string;
}

/** Un tour de conversation, tel que l'écran le renvoie. Le rôle `system` est REFUSÉ : c'est nous qui posons
 *  le mandat, et l'accepter du client laisserait réécrire les règles de l'assistant depuis le navigateur. */
const messageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().trim().min(1).max(MAX_CARACTERES_MESSAGE),
});
const corpsSchema = z.object({
  messages: z.array(messageSchema).min(1).max(MAX_TOURS_HISTORIQUE * 2),
});

/** Un tour de construction est un appel de modèle, pas une requête de base : il faut le borner ici aussi. */
const DELAI_MS = 45_000;

export function registerAgentSetup(app: FastifyInstance, deps: AgentSetupRouteDeps, guard?: Guard): void {
  const opts = guard ? { preHandler: guard } : {};

  app.post('/tenants/:tenantId/agents/:agentId/setup', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { agentId } = req.params as { agentId: string };
    if (!estUuid(agentId)) return reply.code(404).send({ error: 'agent introuvable' });
    if (!deps.completer || deps.modele.trim() === '') {
      return reply.code(503).send({ error: 'assistant de construction indisponible (aucun modèle configuré)' });
    }
    const parse = corpsSchema.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'messages requis (rôle « user » ou « assistant », texte non vide)' });

    const etat = await deps.etatCourant(tenant, agentId);
    if (!etat) return reply.code(404).send({ error: 'agent introuvable' });

    let reponse: ReponseChat;
    try {
      reponse = await deps.completer({
        modele: deps.modele,
        messages: construireMessages(etat, parse.data.messages),
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

    return reply.code(200).send({
      message: propose.data.message,
      proposition: {
        fiche: propose.data.fiche ?? {},
        outils: propose.data.outils ?? [],
        // Les connecteurs proposés sont filtrés sur ceux qui EXISTENT : l'assistant n'en crée pas, et un nom
        // inventé ne doit pas atteindre l'application, qui tenterait un patch sur un outil inconnu.
        connecteurs: (propose.data.connecteurs ?? []).filter((c) => (etat.connecteurs ?? []).some((x) => x.nom === c.nom)),
      },
      changements: differences(etat, propose.data),
      usage: { tokensIn: reponse.usage.tokensIn, tokensOut: reponse.usage.tokensOut },
    });
  });
}
