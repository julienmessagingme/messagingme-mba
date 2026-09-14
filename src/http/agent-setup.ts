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
import { bornerPourModele, ENTRETIEN_VIERGE, type EntretienComplet, type EntretienStore, type TourEntretien } from '../agent/setup/entretien-store';
import { scopeTenant, estUuid } from './scope';
import { moisDe, resteDuBudget, MESSAGE_PLAFOND, type DepenseStore } from '../assistant/budget';
import { microEurosDepuisDollars } from '../agent/devise';

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

/**
 * Combien de messages l'écran reçoit d'un coup.
 *
 * ⚠️ CE N'EST PAS `MAX_TOURS_HISTORIQUE` (ce qu'on envoie au MODÈLE) ni `MAX_TOURS_CONSERVES` (ce que la
 * base garde) : trois plafonds, trois raisons. Celui-ci borne le POIDS D'UNE RÉPONSE HTTP, et il est
 * généreux parce qu'un fil de travail se relit.
 */
export const MAX_MESSAGES_AFFICHES = 200;

export interface AgentSetupRouteDeps {
  /** L'état courant de l'agent, ou `null` s'il n'existe pas ou appartient à un autre tenant. */
  etatCourant(tenantId: string, agentId: string): Promise<ContexteConstruction | null>;
  /**
   * QUI a écrit chaque message : les adresses des membres de l'espace, par identifiant.
   *
   * 🔴 RÉSOLU CÔTÉ SERVEUR, jamais par le navigateur. Le fil ne porte que des identifiants (migration 0147,
   * et c'est le bon choix : recopier une adresse dans un jsonb que personne ne purge serait pire). L'écran,
   * lui, ne peut afficher qu'un nom : le faire résoudre par le navigateur ajouterait un appel à chaque
   * ouverture d'onglet, et donnerait à voir la liste des comptes de l'espace pour afficher deux adresses.
   *
   * ⚠️ OPTIONNEL : sans lui, le fil s'affiche avec « auteur inconnu », ce qui est le comportement des tours
   * d'avant la migration. Un journal sans auteur reste lisible ; un écran qui refuse de s'ouvrir, non.
   */
  emailsDesMembres?(tenantId: string): Promise<Record<string, string>>;
  /**
   * LE COMPTEUR DE NOTRE DÉPENSE, partagé avec l'assistant du Meta Business Agent.
   *
   * 🔴 IL MANQUAIT, ET LE COMMENTAIRE DU CÂBLAGE L'AVAIT ANNONCÉ : « c'est ce qui rend le plafond
   * obligatoire [...] les deux moitiés de cette décision vont ensemble, l'une sans l'autre est dangereuse ».
   * Cet assistant est passé sur NOTRE clé le 2026-09-14 ; le plafond, lui, n'a été câblé que sur l'autre.
   * Un espace pouvait donc bavarder sans limite avec l'assistant d'agent, à nos frais.
   *
   * 🔴 LE COMPTEUR EST PAR ESPACE, PAS PAR ASSISTANT (migration 0146) : un plafond par assistant
   * multiplierait notre exposition par le nombre de robots, c'est-à-dire par un chiffre que le client
   * contrôle lui-même.
   *
   * ⚠️ OPTIONNEL : sans lui, l'assistant fonctionne SANS plafond, exactement comme avant. C'est le
   * comportement qu'il faut pour un serveur de test, et c'est aussi pourquoi le câblage est gardé par un test.
   */
  depenses?: DepenseStore;
  /** Le plafond mensuel, en euros. 0 ou absent = pas de plafond. */
  plafondEuros?: number;
  tauxEurParDollar?: number;
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

/** Lit une image par le modèle et rend son texte AVEC son coût. Isolé pour que la route reste lisible.
 *  ⚠️ Le coût remonte parce que cet appel-là compte dans le plafond : le jeter rendrait la lecture d'image
 *  gratuite du point de vue du compteur, donc contournable. */
async function lireImage(
  deps: AgentSetupRouteDeps, tenantId: string, modele: string, dataUrl: string, nom: string,
): Promise<{ texte: string | null; coutDollars: number }> {
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
  // ⚠️ LE COÛT REMONTE AVEC LE TEXTE : une image part chez un fournisseur qui la facture, sur NOTRE clé.
  // Le jeter ici rendrait la lecture d'image gratuite du point de vue du plafond, donc le contournerait.
  return { texte: r.texte, coutDollars: r.usage.coutDollars };
}

/** Un tour de construction est un appel de modèle, pas une requête de base : il faut le borner ici aussi. */
const DELAI_MS = 45_000;

/**
 * LE PLAFOND, LU AVANT L'APPEL. `true` = on peut parler.
 *
 * ⚠️ Un dépôt de dépense ABSENT laisse passer : une instance sans compteur doit fonctionner, et c'est le
 * câblage, gardé par un test, qui garantit qu'il est là en production.
 */
async function budgetOuvert(deps: AgentSetupRouteDeps, tenantId: string): Promise<boolean> {
  if (!deps.depenses || !deps.plafondEuros) return true;
  return resteDuBudget(await deps.depenses.lire(tenantId, moisDe(new Date())), deps.plafondEuros) > 0;
}

/**
 * LA DÉPENSE, NOTÉE APRÈS L'APPEL, avec le coût RÉEL.
 *
 * ⚠️ Une estimation avant serait fausse, et le dépassement du dernier tour est assumé : il est borné par le
 * coût d'UN tour. Même règle que l'assistant du Meta Business Agent.
 */
async function noterDepense(deps: AgentSetupRouteDeps, tenantId: string, coutDollars: number): Promise<void> {
  if (!deps.depenses) return;
  await deps.depenses.ajouter(tenantId, moisDe(new Date()),
    microEurosDepuisDollars(coutDollars, deps.tauxEurParDollar ?? 1));
}

/** L'avancement, tel que l'écran l'affiche. Le total est celui de l'ordre du jour EFFECTIF : un client dont
 *  l'agent n'appellera jamais d'outil ne doit pas se voir annoncer un point qui n'existera jamais pour lui. */
function avancement(etat: EntretienComplet, ctx: ContexteConstruction | null): { manquants: string[]; total: number; pointOuvert: string | null } {
  // L'INVENTAIRE entre ici parce qu'il change la QUESTION du moyen, pas la liste des points : le compte et
  // l'ordre sont les mêmes, mais la question posée montre ce qui est réellement branché.
  const inv = ctx ? inventaireDe(ctx) : undefined;
  /**
   * ⚠️ UN CHAMP VIDÉ N'ENTRE PAS DANS CE COMPTE, et ce n'est pas un oubli : cette couverture-là RETIENT la
   * proposition, or un champ ne se remplit qu'en appliquant une proposition. L'y faire entrer enfermerait
   * l'entretien dans un cycle. Le champ vidé est SIGNALÉ dans la consigne d'évolution, pas recompté ici.
   */
  const manquants = manquesDeCouverture(etat, inv);
  return {
    manquants,
    total: agendaEffectif(etat, inv).length,
    pointOuvert: prochainPoint(etat, inv)?.code ?? null,
  };
}

/**
 * Les noms d'outils RETENUS : ceux qui existent dans la bibliothèque de l'espace ET dont le branchement
 * changerait vraiment d'état. `brancheAttendu` dit l'état dans lequel l'outil doit être AUJOURD'HUI pour que
 * le geste ait un sens (`false` pour brancher, `true` pour débrancher).
 */
export function brancheables(
  catalogue: ContexteConstruction['catalogue'], noms: readonly string[] | undefined, brancheAttendu: boolean,
): string[] {
  const par = new Map((catalogue ?? []).map((c) => [c.nom, c]));
  return (noms ?? []).filter((n) => par.get(n)?.branche === brancheAttendu);
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
    /**
     * 🔴 L'ÉCRAN NE REÇOIT PAS LE FIL ENTIER, ET C'EST UN DÉFAUT RELEVÉ EN REVUE (2026-09-14). Depuis que le
     * fil PERDURE, la base n'en tronque plus rien : envoyer `entretien.messages` tel quel ferait grossir
     * cette réponse sans fin, sur une route appelée à CHAQUE ouverture de l'onglet. Avant, la troncature à
     * l'écriture masquait le problème ; en la retirant, on l'a créé.
     *
     * ⚠️ LE FIL RESTE ENTIER EN BASE : c'est bien l'AFFICHAGE qui est borné, pas la conservation. Le total
     * part avec, pour que l'écran puisse dire « 340 messages, les 200 derniers » plutôt que de laisser croire
     * que le reste n'existe plus.
     */
    const recents = entretien.messages.slice(-MAX_MESSAGES_AFFICHES);
    const auteurs = entretien.auteurs.slice(-MAX_MESSAGES_AFFICHES);
    /**
     * ⚠️ ON NE RÉSOUT QUE S'IL Y A QUELQUE CHOSE À RÉSOUDRE : un fil entièrement anonyme (les tours d'avant
     * la migration 0147, et les réponses de l'assistant) ne doit pas coûter une requête à chaque ouverture.
     */
    const emails = auteurs.some((a) => a !== null) && deps.emailsDesMembres
      ? await deps.emailsDesMembres(ctx.tenant).catch(() => ({} as Record<string, string>))
      : {};
    return reply.code(200).send({
      messages: recents,
      /**
       * 🔴 DES ADRESSES, PAS DES IDENTIFIANTS, et `null` quand on ne sait pas : un compte supprimé laisse un
       * tour sans auteur, et lui en inventer un serait faux. L'écran dit alors « auteur inconnu ».
       */
      auteurs: auteurs.map((a) => (a === null ? null : emails[a] ?? null)),
      total: entretien.messages.length,
      couverture: avancement(entretien, ctx.etat),
    });
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
      if (!(await budgetOuvert(deps, ctx.tenant))) {
        // 422 et pas 200 : ici le client attend un IMPORT, pas une phrase. Lui dire que ce n'est pas parti
        // est le seul comportement honnête, et les documents texte, eux, continuent de passer.
        return reply.code(422).send({ error: `${MESSAGE_PLAFOND} Les documents texte, PDF et Word passent quand même.` });
      }
      try {
        const lu = await lireImage(deps, ctx.tenant, vision, parse.data.dataUrl, parse.data.nom);
        await noterDepense(deps, ctx.tenant, lu.coutDollars);
        texte = lu.texte;
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
    /**
     * 🔴 LA BORNE EST ICI, À LA CONSTRUCTION DU PROMPT, ET PLUS À L'ÉCRITURE (2026-09-14). Elle était posée
     * dans `PgEntretienStore.ecrire` : les tours anciens n'étaient donc pas seulement absents du contexte du
     * modèle, ils étaient DÉTRUITS. Un fil qui perdure (décision de Julien : « toute la conversation avec
     * l'assistant doit perdurer ») ne peut pas se faire amputer par sa propre sauvegarde.
     *
     * ⚠️ On borne ce qui PART, jamais ce qu'on GARDE : le fil conserve tout, le prompt reste borné. Un
     * historique sans fin dans le contexte pousserait la fiche courante hors de la fenêtre du modèle.
     */
    /**
     * 🔴 DEUX FILS, ET LES CONFONDRE ANNULE TOUT LE LOT. `filComplet` est ce qu'on CONSERVE ; `historique`
     * est ce qu'on ENVOIE au modèle. Une première version construisait l'état écrit à partir du fil BORNÉ :
     * la troncature était alors seulement DÉPLACÉE, pas supprimée, et la base recevait un fil amputé à
     * chaque tour. Relevé en revue, jamais par un test ni par le compilateur, les deux tableaux ayant
     * exactement le même type.
     *
     * ⚠️ L'AUTEUR EST POSÉ ICI, sur le message de l'utilisateur, et `null` pour la réponse de l'assistant :
     * le fil est partagé entre les admins d'un espace, donc « qui a demandé ça ? » doit avoir une réponse.
     */
    const filComplet: TourEntretien[] = [...avant.messages, { role: 'user', content: parse.data.message }];
    const auteursComplets: Array<string | null> = [...avant.auteurs, req.auth?.userId ?? null];
    const historique: TourEntretien[] = bornerPourModele(filComplet);
    // 🔴 Le point du tour est arrêté AVANT l'appel, sur l'état serveur : c'est ce qui rend la séquence des
    // questions non négociable. Il est noté « posé » plus bas, parce que la réponse du modèle le pose.
    const pointDuTour = prochainPoint(avant, inventaireDe(ctx.etat));

    /**
     * 🔴 LE PLAFOND EST VÉRIFIÉ AVANT L'APPEL, ET IL REND 200. Ce n'est pas une panne : c'est une limite
     * volontaire, et l'assistant la DIT. Un 4xx afficherait un message d'infrastructure là où le client
     * attend une phrase, et un 5xx serait remplacé par la page d'erreur de Cloudflare.
     *
     * ⚠️ LA FORME DE LA RÉPONSE NE CHANGE PAS : l'écran attend `message`, `couverture`, `proposition` et
     * `changements`. Un corps amputé ferait planter le rendu sur ce qui doit être le cas le plus doux.
     */
    if (!(await budgetOuvert(deps, ctx.tenant))) {
      return reply.code(200).send({
        message: MESSAGE_PLAFOND,
        couverture: avancement(avant, ctx.etat),
        proposition: { fiche: {}, outils: [], connecteurs: [], outilsBranches: [], outilsDebranches: [] },
        changements: [],
        budgetEpuise: true,
        ongletsUtilisables: true,
        usage: { tokensIn: 0, tokensOut: 0 },
      });
    }

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

    // ⚠️ AVANT toute sortie d'erreur : l'appel a eu lieu, donc il est payé, même si sa réponse est
    // inexploitable. Le noter seulement sur le chemin heureux rendrait le plafond contournable par un modèle
    // qui répond de travers.
    await noterDepense(deps, ctx.tenant, reponse.usage.coutDollars);

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
      // 🔴 `filComplet`, JAMAIS `historique` : voir la note plus haut. C'est la ligne qui décide si le fil
      // perdure ou se fait amputer par sa propre sauvegarde.
      messages: [...filComplet, { role: 'assistant', content: message }],
      // L'assistant n'a pas d'auteur humain : `null`, et l'écran l'affiche comme venant de l'assistant.
      auteurs: [...auteursComplets, null],
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
      proposition: enEntretien ? { fiche: {}, outils: [], connecteurs: [], outilsBranches: [], outilsDebranches: [] } : {
        fiche: propose.data.fiche ?? {},
        outils: propose.data.outils ?? [],
        // Les connecteurs proposés sont filtrés sur ceux qui EXISTENT : l'assistant n'en crée pas, et un nom
        // inventé ne doit pas atteindre l'application, qui tenterait un patch sur un outil inconnu.
        connecteurs: (propose.data.connecteurs ?? []).filter((c) => (ctx.etat.connecteurs ?? []).some((x) => x.nom === c.nom)),
        /**
         * 🔴 LE BRANCHEMENT EST FILTRÉ SUR LA BIBLIOTHÈQUE DE L'ESPACE, et c'est LE contrôle : le schéma ne
         * connaît pas le catalogue, donc il ne peut pas refuser un nom inventé. Julien, 2026-09-14 : « il
         * n'a pas la main pour créer des outils puisqu'il n'a que la liste d'outils déjà setuppés, donc au
         * pire il en débranche un ».
         *
         * ⚠️ ON FILTRE AUSSI SUR L'ÉTAT COURANT : brancher ce qui l'est déjà, ou débrancher ce qui ne l'est
         * pas, n'est pas une erreur mais ne doit produire AUCUN geste, sans quoi l'écran annoncerait une
         * modification qui n'en est pas une. Même règle que le diff, qui ne montre que ce qui change.
         */
        outilsBranches: brancheables(ctx.etat.catalogue, propose.data.outilsBranches, false),
        outilsDebranches: brancheables(ctx.etat.catalogue, propose.data.outilsDebranches, true),
      },
      changements: enEntretien ? [] : differences(ctx.etat, propose.data),
      usage: { tokensIn: reponse.usage.tokensIn, tokensOut: reponse.usage.tokensOut },
    });
  });
}
