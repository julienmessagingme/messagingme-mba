import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Guard } from '../auth/middleware';
import type { ContexteTour, DecisionTracee, GatewayBrainDeps } from '../agent/brain.gateway';
import { AgentIntrouvable, penserTrace } from '../agent/brain.gateway';
import { TourInterrompu } from '../agent/brain';
import { direPanneModele } from '../llm/errors';
import { journaliser } from '../lib/journal';
import { scopeTenant, estUuid } from './scope';
import { ESSAIS_AFFICHES, type TestRunStore } from '../agent/test-runs';

/**
 * Le BAC À SABLE : parler à son agent depuis la console, avant de l'activer.
 *
 * 🔴 CE QU'IL PROUVE, ET CE QU'IL NE PROUVE PAS. Il fait tourner le VRAI cerveau, avec le vrai prompt, les
 * vrais outils exposés et la VRAIE recherche de connaissance : ce que l'agent répond ici est ce qu'il
 * répondra. En revanche les outils à effet sont simulés (`resolvers/simulation.ts`), parce qu'il n'y a ni
 * contact, ni conversation, ni parcours : poser un tag écrirait sur une vraie fiche du mini-CRM, envoyer un
 * bloc partirait chez un vrai numéro. L'écran le dit, appel par appel.
 *
 * 🔴 AUCUNE SESSION N'EST OUVERTE et aucun run n'est touché. Une seule chose est persistée, depuis le
 * 2026-09-08 : l'ESSAI lui-même, dans `agent_test_runs`, pour qu'on puisse le relire et le rejouer (voir plus
 * bas). Rien d'autre, et surtout rien qui touche les données d'un contact. Les identifiants du tour sont
 * des valeurs de bac à sable, et le journal d'appels reçoit une session qui n'existe pas : c'est pour ça que
 * le câblage lui donne un journal MUET plutôt que le vrai, sans quoi chaque essai violerait la clé étrangère
 * de `agent_tool_calls`.
 */

export interface AgentTestRouteDeps {
  /**
   * L'historique des essais. OPTIONNEL : sans lui, l'essai marche exactement comme avant et l'ecran
   * n'affiche simplement aucune trace. Une commodite ne doit pas devenir une condition de fonctionnement.
   */
  essais?: TestRunStore;
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

export function registerAgentTest(app: FastifyInstance, deps: AgentTestRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };

  /**
   * Les derniers essais de cet agent, du plus recent au plus ancien.
   *
   * ⚠️ 200 avec une liste VIDE quand l'historique n'est pas cable, jamais 404 ni 503 : l'ecran doit pouvoir
   * poser la question sans savoir si le serveur tient une trace, et un agent qu'on n'a jamais essaye rend la
   * meme chose qu'un serveur sans historique. C'est ce qui permet de deployer l'ecran avant la table.
   */
  app.get('/tenants/:tenantId/agents/:agentId/tests', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { agentId } = req.params as { agentId: string };
    if (!estUuid(agentId)) return reply.code(404).send({ error: 'agent introuvable' });
    if (!deps.essais) return reply.code(200).send({ essais: [] });
    return reply.code(200).send({ essais: await deps.essais.lister(tenant, agentId, ESSAIS_AFFICHES) });
  });

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
      /**
       * Panne du fournisseur, délai dépassé, clé refusée : rien de tout ça n'est un incident de la console, et
       * Cloudflare remplacerait le corps d'une 5xx par sa page d'erreur. D'où 422, journalisé en plus.
       *
       * 🔴 MAIS CE `catch` ATTRAPE TOUT LE TOUR, PAS SEULEMENT LE MODÈLE : la lecture de l'agent en base, la clé
       * de l'espace déchiffrée, les outils. Rendre `err.message` en 422 pour tout ça enverrait au navigateur le
       * texte d'une panne de NOTRE base (relevé par la relecture du 2026-09-22). Seule une panne du fournisseur
       * se dit, rédigée par `direPanneModele` ; le reste est relancé et sort en 500 opaque. La cause se lit
       * SOUS `TourInterrompu`, qui enveloppe n'importe quelle erreur survenue après un premier appel payé.
       */
      const cause = err instanceof TourInterrompu ? err.erreur : err;
      const raison = direPanneModele(cause);
      // On relance la CAUSE, pas l'enveloppe : le gestionnaire global journalise la pile, et celle de
      // `TourInterrompu` montre `penserTrace`, pas la fonction qui a levé. Une cause qui n'est pas une `Error`
      // (rien ne l'interdit) repart dans son enveloppe, qui en porte au moins le texte.
      if (raison === null) throw cause instanceof Error ? cause : err;
      // La CAUSE ici aussi : sa pile, pas celle de l'enveloppe.
      journaliser('error', 'agent_test_echec', { tenant, agentId, err: cause instanceof Error ? cause : err });
      return reply.code(422).send({ error: `l’essai a échoué : ${raison}` });
    }

    await debiterEssai(tenant, decision.usage?.coutMicroEur ?? 0, deps);

    const usage = decision.usage ?? { tokensIn: 0, tokensOut: 0, coutMicroEur: 0 };
    /**
     * 🔴 L'HISTORIQUE S'ECRIT APRES LA DECISION, ET IL NE PEUT PAS LA FAIRE ECHOUER. Julien, le 2026-09-08 :
     * « j'ai voulu reappuyer et j'ai plus la trace de ce que j'ai lu ». Regler un agent, c'est comparer :
     * on change une consigne, on repose la meme question, on regarde si la reponse a bouge.
     *
     * 🔴 LA GARDE EST ICI, ET NULLE PART AILLEURS. Le modele a deja repondu et le solde est deja debite :
     * echouer parce que la TRACE n'a pas pu s'ecrire ferait perdre au client une reponse qu'il vient de
     * payer, pour une commodite. On journalise et on rend quand meme la reponse.
     *
     * ⚠️ L'attente est deliberee : l'ecran relit l'historique juste apres, et doit y voir l'essai qu'il
     * vient de faire.
     */
    if (deps.essais) {
      try {
        await deps.essais.ecrire(tenant, agentId, {
          messages: parse.data.messages,
          reponse: decision.texte,
          sortie: decision.sortie,
          // On garde le NOM et le STATUT, jamais le CONTENU rendu par l'outil : il peut etre volumineux, il vient
          // d'une base qu'un site tiers a remplie, et ce qu'on vient lire ici est « a-t-il seulement cherche ? ».
          appels: decision.appels.map((a) => ({ nom: a.nom, status: a.status })),
          tokensEntree: usage.tokensIn,
          tokensSortie: usage.tokensOut,
          coutMicroEur: usage.coutMicroEur,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`agent: ESSAI NON ARCHIVÉ pour le tenant ${tenant}`, err instanceof Error ? err.message : err);
      }
    }
    return reply.code(200).send({
      texte: decision.texte,
      sortie: decision.sortie,
      // Le MOTIF n'existe que quand la sortie ne se suffit pas à elle-même (cf. `MotifArret`). Il ne part
      // que vers le bac à sable : la production, elle, ne lit que la sortie, qui n'a pas bougé.
      ...(decision.motif ? { motif: decision.motif } : {}),
      appels: decision.appels,
      usage,
    });
  });
}
