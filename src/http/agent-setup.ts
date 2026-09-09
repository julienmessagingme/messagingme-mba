import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { parse as secureJsonParse } from 'secure-json-parse';
import type { Guard } from '../auth/middleware';
import type { ChatMessage, ChatMessageImage, ReponseChat, OutilExpose } from '../agent/llm/chat-client';
import { octetsDepuisDataUrl } from '../rcs/image';
import {
  extraireTexte, reconnaitre, texteEnFiches, TAILLE_DOCUMENT_MAX, TAILLE_IMAGE_MAX,
} from '../agent/setup/piece-jointe';
import { construireMessages, inventaireDe, MAX_CARACTERES_MESSAGE, type ContexteConstruction } from '../agent/setup/conversation';
import { differences, propositionSchema, OUTIL_PROPOSER, SCHEMA_PROPOSITION } from '../agent/setup/proposition';
import { agendaEffectif, fusionner, fusionnerBascules, manquesDeCouverture, poseUneQuestion, prochainPoint } from '../agent/setup/couverture';
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
  /**
   * Écrit une fiche de connaissance. Sert aux PIÈCES JOINTES : un document joint devient des fiches, c'est
   * tout l'intérêt de pouvoir en joindre un. Absente, la route de pièce jointe n'est pas montée.
   */
  /**
   * Ecrit les fiches d'une piece jointe, EN REMPLACANT celles que le meme fichier avait deja produites.
   *
   * 🔴 REMPLACE, ET PORTE LA PROVENANCE, alors que cette route creait des fiches ANONYMES une par une.
   * Deux consequences vecues : redeposer le meme PDF doublait la base (et la recherche remontait deux fois
   * la meme reponse), et une fiche issue d'un document etait INDISCERNABLE d'une fiche tapee a la main,
   * donc l'ecran ne pouvait pas dire d'ou elle venait. C'est la coherence que Julien demandait le
   * 2026-09-08 : le fichier joint en parlant au robot, et la fiche qui en decoule, doivent se retrouver.
   */
  ecrireFichesDocument?(
    tenantId: string, agentId: string, nom: string, fiches: Array<{ titre: string; corps: string }>,
  ): Promise<{ retirees: number; ecrites: number } | null>;
  /** L'entretien persisté. ABSENT : la route répond 503 plutôt que de retomber sur un entretien sans mémoire,
   *  qui redeviendrait non déterministe sans que personne ne le voie. */
  entretiens?: EntretienStore;
  /** Appel du modèle. Injecté pour rester testable sans réseau ; absent, la route répond 503. */
  /** ⚠️ `tenantId` decide QUELLE CLE paie l'appel (2026-09-09) : le bac a sable est du temps de modele, et
   *  il se paie sur le credit du client comme le reste. */
  completer?(input: { tenantId: string; modele: string; messages: Array<ChatMessage | ChatMessageImage>; outils: OutilExpose[]; toolChoice: string; signal: AbortSignal }): Promise<ReponseChat>;
  /** Modèle de l'IA de CONSTRUCTION. À ne pas confondre avec celui de l'agent : celui-ci tourne rarement et
   *  joue le rôle le plus dur, celui-là répond à chaque message d'un contact. */
  modele: string;
  /**
   * Modèle qui LIT LES IMAGES jointes. Vide = les images sont refusées, les documents passent quand même.
   *
   * 🔴 Séparé du modèle d'entretien, et ce n'est pas de la précaution : mesuré le 2026-08-31, `zai/glm-4.7`
   * (celui de la production) REFUSE une part `image_url` avec un 400 au corps vide. Réutiliser le modèle
   * d'entretien aurait livré une pièce jointe image morte, avec une erreur illisible.
   */
  modeleVision?: string;
}

const corpsSchema = z.object({
  message: z.string().trim().min(1).max(MAX_CARACTERES_MESSAGE),
});

const pieceSchema = z.object({
  /** Le nom du fichier, qui sert de TITRE par défaut aux fiches. Il n'est jamais interprété comme un chemin
   *  ni comme un type : la nature du fichier vient de sa signature. */
  nom: z.string().trim().min(1).max(200),
  dataUrl: z.string().min(1),
});

/** Ce qu'on demande au modèle vision. Le cadre compte : sans lui, il RACONTE l'image au lieu de la relever, et
 *  une base de connaissance faite de descriptions ne répond à aucune question de contact. */
const CONSIGNE_IMAGE = 'Relève TOUT le texte lisible de cette image, tel quel, en gardant sa structure (titres, '
  + 'listes, tableaux ligne par ligne). Ne commente pas, n’interprète pas, n’invente aucune valeur illisible : '
  + 'si un passage est flou, écris [illisible]. Si l’image ne contient aucun texte, décris en une phrase ce '
  + 'qu’elle montre, sans plus.';

/** Lit une image par le modèle et rend son texte. Isolé pour que la route reste lisible. */
async function lireImage(deps: AgentSetupRouteDeps, tenantId: string, modele: string, dataUrl: string, nom: string): Promise<string | null> {
  const r = await deps.completer!({
    tenantId,
    modele,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: `${CONSIGNE_IMAGE}\n\nNom du fichier : ${nom}` },
        { type: 'image_url', image_url: { url: dataUrl } },
      ],
    }],
    outils: [],
    toolChoice: '',
    signal: AbortSignal.timeout(DELAI_MS),
  });
  return r.texte;
}

/** Un tour de construction est un appel de modèle, pas une requête de base : il faut le borner ici aussi. */
const DELAI_MS = 45_000;

/** L'avancement, tel que l'écran l'affiche. Le total est celui de l'ordre du jour EFFECTIF : un client dont
 *  l'agent n'appellera jamais d'outil ne doit pas se voir annoncer un point qui n'existera jamais pour lui. */
function avancement(etat: EntretienComplet, ctx: ContexteConstruction | null): { manquants: string[]; total: number; pointOuvert: string | null } {
  // L'INVENTAIRE entre ici parce qu'il change la QUESTION du moyen, pas la liste des points : le compte et
  // l'ordre sont les mêmes, mais la question posée montre ce qui est réellement branché.
  const inv = ctx ? inventaireDe(ctx) : undefined;
  const manquants = manquesDeCouverture(etat, inv);
  return {
    manquants,
    total: agendaEffectif(etat, inv).length,
    pointOuvert: prochainPoint(etat, inv)?.code ?? null,
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
    return reply.code(200).send({ messages: entretien.messages, couverture: avancement(entretien, ctx.etat) });
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
    return reply.code(200).send({ efface: true, couverture: avancement(ENTRETIEN_VIERGE, ctx.etat) });
  });

  /**
   * UNE PIÈCE JOINTE, transformée en fiches de connaissance.
   *
   * Julien, 2026-08-31 : « il faut aussi qu'on puisse rajouter des pièces jointes (images, documents, …) dans
   * la conversation (notamment pour rajouter des base de connaissance) ». Un client arrive avec ses procédures
   * déjà écrites ; les retaper fiche par fiche est exactement le travail qu'on lui promet d'éviter.
   *
   * 🔴 CE QUE LA ROUTE ÉCRIT, ET POURQUOI CE N'EST PAS UNE ENTORSE au « rien ne s'écrit sans un clic ». Ce
   * diff-là protège contre ce que le MODÈLE propose ; ici c'est le CLIENT qui téléverse son propre document,
   * délibérément, et le geste EST le consentement. Même doctrine que l'import d'une page de son site, qui
   * écrit lui aussi ses fiches directement. Tout reste relisible et modifiable dans l'onglet Connaissance.
   *
   * 🔴 UNE IMAGE EST LUE UNE SEULE FOIS, ICI. Elle part au modèle vision au moment où elle est jointe, et ce
   * qu'on en garde est du TEXTE. La garder pour les tours suivants ferait grossir l'entretien de plusieurs
   * méga et referait payer sa lecture à chaque tour.
   *
   * `bodyLimit` dédié : les octets transitent en base64 (+33 %), comme pour l'upload média.
   */
  const optsPiece = { ...opts, bodyLimit: Math.ceil(TAILLE_DOCUMENT_MAX * 1.4) };
  app.post('/tenants/:tenantId/agents/:agentId/setup/piece-jointe', optsPiece, async (req, reply) => {
    const ctx = await ouvrir(req, reply);
    if (!ctx) return;
    if (!deps.ecrireFichesDocument) return reply.code(503).send({ error: 'pièces jointes indisponibles sur ce serveur' });
    const parse = pieceSchema.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'nom et dataUrl requis' });

    const bytes = octetsDepuisDataUrl(parse.data.dataUrl);
    if (!bytes) return reply.code(400).send({ error: 'fichier illisible (data URL base64 attendu)' });
    const reconnu = reconnaitre(bytes);
    // 415 et pas 400 : le corps est bien formé, c'est le TYPE du contenu qu'on refuse. Et le refus se fonde
    // sur la signature réelle, jamais sur l'extension du nom, qui ne prouve rien.
    if (!reconnu) {
      return reply.code(415).send({ error: 'format non accepté (texte, CSV, PDF, Word, ou image JPEG/PNG/GIF/WebP)' });
    }
    const plafond = reconnu.nature === 'image' ? TAILLE_IMAGE_MAX : TAILLE_DOCUMENT_MAX;
    if (bytes.length > plafond) {
      return reply.code(413).send({ error: `fichier trop lourd (${Math.round(plafond / 1024 / 1024)} Mo maximum pour ce type)` });
    }

    let texte: string | null;
    if (reconnu.nature === 'image') {
      // Refus EXPLICITE plutôt qu'un appel voué à un 400 illisible : sans modèle de vision, on le dit, et les
      // documents continuent de passer par ailleurs (ils n'ont besoin d'aucun modèle).
      const vision = (deps.modeleVision ?? '').trim();
      if (!deps.completer || vision === '') {
        return reply.code(503).send({ error: 'lecture d’image indisponible sur ce serveur (aucun modèle de vision configuré) ; les documents texte, PDF et Word passent quand même' });
      }
      try {
        texte = await lireImage(deps, ctx.tenant, vision, parse.data.dataUrl, parse.data.nom);
      } catch (err) {
        return reply.code(502).send({ error: `l’image n’a pas pu être lue : ${err instanceof Error ? err.message : 'erreur inconnue'}` });
      }
    } else {
      texte = await extraireTexte(bytes, reconnu.nature);
    }
    if (texte === null || texte.trim() === '') {
      // 422 : le fichier est d'un type accepté mais ne porte aucun texte exploitable (PDF scanné, image sans
      // écriture, document vide). Le dire est plus utile qu'un succès à zéro fiche, que le client lirait
      // comme un import réussi.
      return reply.code(422).send({ error: 'aucun texte lisible dans ce fichier (un PDF scanné, par exemple, n’en contient pas)' });
    }

    const fiches = texteEnFiches(texte, parse.data.nom);
    if (fiches.length === 0) return reply.code(422).send({ error: 'ce fichier est trop court pour faire une fiche' });
    const bilan = await deps.ecrireFichesDocument(ctx.tenant, ctx.agentId, parse.data.nom, fiches);
    if (!bilan) return reply.code(404).send({ error: 'agent introuvable' });

    return reply.code(201).send({
      fiches: bilan.ecrites,
      remplacees: bilan.retirees,
      titres: fiches.map((f) => f.titre),
      nature: reconnu.nature,
    });
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
    const pointDuTour = prochainPoint(avant, inventaireDe(ctx.etat));

    let reponse: ReponseChat;
    try {
      reponse = await deps.completer({
        tenantId: ctx.tenant,
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
    const reponses = fusionner(avant.reponses, propose.data.reponses);
    // Les BASCULES vivent à part : elles sont une LISTE (un moment, une action, un moyen), pas une réponse à
    // un point. C'est ce qui permet de les prendre une par une au lieu de les écraser l'une sur l'autre.
    const listeBascules = fusionnerBascules(avant.bascules ?? [], propose.data.bascules ?? []);
    const poses = pointDuTour && !avant.poses.includes(pointDuTour.code)
      ? [...avant.poses, pointDuTour.code]
      : avant.poses;

    /**
     * 🔴 UN MESSAGE QUI N'INTERROGE RIEN LAISSE L'ENTRETIEN MORT. Le serveur pose alors la question lui-même.
     *
     * Vu par Julien le 2026-08-31, au point 3 sur 8 : l'assistant a accusé réception (« D'accord : les pages
     * de description des véhicules seront importées ») et s'est arrêté là. Le client n'avait plus rien à quoi
     * répondre, et rien dans le dispositif ne le rattrapait. Le mandat bornait le MAXIMUM de questions et
     * n'avait jamais posé de minimum.
     *
     * La question ajoutée est celle du point ENCORE OUVERT une fois les réponses de ce tour intégrées : c'est
     * bien la suivante, pas celle à laquelle il vient de répondre. Et on la note POSÉE, puisqu'on vient de la
     * poser : sans ça, le tour d'après la reposerait.
     */
    const ouvertApres = prochainPoint({ poses, reponses, bascules: listeBascules }, inventaireDe(ctx.etat));
    const relance = ouvertApres && !poseUneQuestion(propose.data.message) ? ouvertApres : null;
    const message = relance ? `${propose.data.message}\n\n${relance.question}` : propose.data.message;

    const apres: EntretienComplet = {
      messages: [...historique, { role: 'assistant', content: message }],
      reponses,
      bascules: listeBascules,
      poses: relance && !poses.includes(relance.code) ? [...poses, relance.code] : poses,
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
    const suivi = avancement(apres, ctx.etat);
    const enEntretien = suivi.manquants.length > 0;

    return reply.code(200).send({
      message,
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
