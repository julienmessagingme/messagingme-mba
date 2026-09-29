import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { parse as secureJsonParse } from 'secure-json-parse';
import type { Guard } from '../auth/middleware';
import type { ChatMessage, ChatMessageImage, ReponseChat, OutilExpose } from '../agent/llm/chat-client';
import { octetsDepuisDataUrl } from '../rcs/image';
import { MAX_FICHES_PAR_PAGE } from '../agent/scrape';
import {
  extraireTexte, reconnaitre, texteEnFiches, TAILLE_DOCUMENT_MAX, TAILLE_IMAGE_MAX,
} from '../agent/setup/piece-jointe';
import { construireMessages, inventaireDe, MAX_CARACTERES_MESSAGE, type ContexteConstruction } from '../agent/setup/conversation';
import {
  assainirProposition, differences, propositionSchema, OUTIL_PROPOSER, SCHEMA_PROPOSITION,
} from '../agent/setup/proposition';
import {
  agendaEffectif, fusionner, fusionnerBascules, manquesDeCouverture, poseUneQuestion, prochainPoint,
  urlDeConnaissance,
} from '../agent/setup/couverture';
import { bornerPourModele, ENTRETIEN_VIERGE, type EntretienComplet, type EntretienStore, type TourEntretien } from '../agent/setup/entretien-store';
import { espaceVerifie, estUuid } from './scope';
import { moisDe, resteDuBudget, MESSAGE_PLAFOND, type DepenseStore } from '../assistant/budget';
import { microEurosDepuisDollars } from '../agent/devise';
import { direPanneModele } from '../llm/errors';
import { journaliser } from '../lib/journal';

/**
 * La conversation de construction d'un agent : elle propose, le client corrige.
 * Cette route n'écrit rien de l'agent : elle rend une proposition et son diff, l'écriture passe par le `PATCH`
 * de la fiche et les routes d'outils. La conversation n'est jamais le seul chemin d'édition ; elle n'écrit que
 * son propre état (`agent_setup_conversations`).
 * 🔴 Ce que le modèle peut proposer est énuméré dans `src/agent/setup/proposition.ts` (la fiche et les mots des
 * outils maison) : ni mention légale d'IA, ni plafonds, ni modèle, ni risque, ni activation.
 * C'est le serveur qui conduit l'entretien : ordre du jour, point du tour et couverture sont calculés ici à
 * partir d'un état persisté ; le navigateur n'envoie qu'un message, le modèle formule et extrait.
 */

/**
 * Combien de messages l'écran reçoit d'un coup. Ni `MAX_TOURS_HISTORIQUE` (ce qu'on envoie au modèle) ni
 * `MAX_TOURS_CONSERVES` (ce que la base garde) : celui-ci borne le poids d'une réponse HTTP.
 */
export const MAX_MESSAGES_AFFICHES = 200;

export interface AgentSetupRouteDeps {
  /** L'état courant de l'agent, ou `null` s'il n'existe pas ou appartient à un autre tenant. */
  etatCourant(tenantId: string, agentId: string): Promise<ContexteConstruction | null>;
  /**
   * Qui a écrit chaque message : les adresses des membres de l'espace, par identifiant, résolues côté serveur (le
   * fil ne porte que des identifiants ; le navigateur n'a pas à voir la liste des comptes). Son échec laisse le
   * fil s'afficher avec « auteur inconnu ».
   */
  emailsDesMembres(tenantId: string): Promise<Record<string, string>>;
  /**
   * 🔴 Le compteur de notre dépense, partagé avec l'assistant du Meta Business Agent : cet assistant tourne sur
   * notre clé, et sans plafond un espace bavarderait à nos frais. Par espace et non par assistant : un plafond par
   * assistant multiplierait notre exposition par un nombre que le client contrôle.
   */
  depenses: DepenseStore;
  /** Le plafond mensuel, en euros. 0 = pas de plafond (`ASSISTANT_PLAFOND_EUROS_MOIS`). */
  plafondEuros: number;
  tauxEurParDollar: number;
  /**
   * Écrit les fiches d'une pièce jointe, en remplaçant celles que le même fichier avait produites, et avec leur
   * provenance : sans remplacement, redéposer le même PDF doublerait la base ; sans provenance, une fiche issue
   * d'un document serait indiscernable d'une fiche tapée à la main.
   */
  ecrireFichesDocument(
    tenantId: string, agentId: string, nom: string, fiches: Array<{ titre: string; corps: string }>,
  ): Promise<{ retirees: number; ecrites: number } | null>;
  /** L'entretien persisté. Requis : un entretien sans mémoire redeviendrait non déterministe sans que personne
   *  ne le voie. */
  entretiens: EntretienStore;
  /**
   * Appel du modèle, injecté pour rester testable sans réseau ; absent, la route répond 503. `tenantId` décide
   * quelle clé paie l'appel.
   */
  completer?(input: { tenantId: string; modele: string; messages: Array<ChatMessage | ChatMessageImage>; outils: OutilExpose[]; toolChoice: string; signal: AbortSignal }): Promise<ReponseChat>;
  /** Modèle de l'IA de construction. À ne pas confondre avec celui de l'agent : celui-ci tourne rarement et
  *  joue le rôle le plus dur, celui-là répond à chaque message d'un contact. */
  modele: string;
  /**
   * Modèle qui lit les images jointes. Vide = les images sont refusées, les documents passent quand même. Séparé
   * du modèle d'entretien : celui de la production refuse une part `image_url` (400 au corps vide).
   */
  modeleVision: string;
}

const corpsSchema = z.object({
  message: z.string().trim().min(1).max(MAX_CARACTERES_MESSAGE),
});

const pieceSchema = z.object({
  /** Le nom du fichier, qui sert de titre par défaut aux fiches. Il n'est jamais interprété comme un chemin
  *  ni comme un type : la nature du fichier vient de sa signature. */
  nom: z.string().trim().min(1).max(200),
  dataUrl: z.string().min(1),
});

/** Ce qu'on demande au modèle vision. Le cadre compte : sans lui, il raconte l'image au lieu de la relever, et
*  une base de connaissance faite de descriptions ne répond à aucune question de contact. */
const CONSIGNE_IMAGE = 'Relève TOUT le texte lisible de cette image, tel quel, en gardant sa structure (titres, '
  + 'listes, tableaux ligne par ligne). Ne commente pas, n’interprète pas, n’invente aucune valeur illisible : '
  + 'si un passage est flou, écris [illisible]. Si l’image ne contient aucun texte, décris en une phrase ce '
  + 'qu’elle montre, sans plus.';

/** Lit une image par le modèle et rend son texte avec son coût : cet appel compte dans le plafond, le jeter
*  rendrait la lecture d'image gratuite du point de vue du compteur, donc contournable. */
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
  return { texte: r.texte, coutDollars: r.usage.coutDollars };
}

/** Un tour de construction est un appel de modèle, pas une requête de base : il faut le borner ici aussi. */
const DELAI_MS = 45_000;

/**
 * Le plafond, lu avant l'appel. `true` = on peut parler. Un plafond à 0 laisse passer
 * (`ASSISTANT_PLAFOND_EUROS_MOIS=0` le désactive).
 */
async function budgetOuvert(deps: AgentSetupRouteDeps, tenantId: string): Promise<boolean> {
  if (!deps.plafondEuros) return true;
  return resteDuBudget(await deps.depenses.lire(tenantId, moisDe(new Date())), deps.plafondEuros) > 0;
}

/**
 * La dépense, notée après l'appel, au coût réel. Le dépassement du dernier tour est assumé : il est borné par
 * le coût d'un tour.
 */
async function noterDepense(deps: AgentSetupRouteDeps, tenantId: string, coutDollars: number): Promise<void> {
  await deps.depenses.ajouter(tenantId, moisDe(new Date()),
    microEurosDepuisDollars(coutDollars, deps.tauxEurParDollar));
}

/** L'avancement, tel que l'écran l'affiche. Le total est celui de l'ordre du jour effectif : un client dont
*  l'agent n'appellera jamais d'outil ne doit pas se voir annoncer un point qui n'existera jamais pour lui. */
function avancement(etat: EntretienComplet, ctx: ContexteConstruction | null): { manquants: string[]; total: number; pointOuvert: string | null } {
  // L'inventaire entre ici parce qu'il change la question du moyen, pas la liste des points : le compte et
  // l'ordre sont les mêmes, mais la question posée montre ce qui est réellement branché.
  const inv = ctx ? inventaireDe(ctx) : undefined;
  /**
   * Un champ vidé n'entre pas dans ce compte : cette couverture retient la proposition, or un champ ne se remplit
   * qu'en appliquant une proposition (l'y faire entrer enfermerait l'entretien dans un cycle). Le champ vidé est
   * signalé dans la consigne d'évolution.
   */
  const manquants = manquesDeCouverture(etat, inv);
  return {
    manquants,
    total: agendaEffectif(etat, inv).length,
    pointOuvert: prochainPoint(etat, inv)?.code ?? null,
  };
}

/**
 * Les noms d'outils retenus : ceux qui existent dans la bibliothèque de l'espace et dont le branchement
 * changerait vraiment d'état. `brancheAttendu` dit l'état dans lequel l'outil doit être maintenant pour que
 * le geste ait un sens (`false` pour brancher, `true` pour débrancher).
 */
export function brancheables(
  catalogue: ContexteConstruction['catalogue'], noms: readonly string[] | undefined, brancheAttendu: boolean,
): string[] {
  const par = new Map((catalogue ?? []).map((c) => [c.nom, c]));
  return (noms ?? []).filter((n) => par.get(n)?.branche === brancheAttendu);
}

export function registerAgentSetup(app: FastifyInstance, deps: AgentSetupRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };

  /** Contrôle d'accès commun aux trois routes : tenant du jeton, agent existant de ce tenant. */
  const ouvrir = async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = espaceVerifie(req);
    const { agentId } = req.params as { agentId: string };
    if (!estUuid(agentId)) { reply.code(404).send({ error: 'agent introuvable' }); return null; }
    const etat = await deps.etatCourant(tenant, agentId);
    if (!etat) { reply.code(404).send({ error: 'agent introuvable' }); return null; }
    return { tenant, agentId, etat, entretiens: deps.entretiens };
  };

  /** L'entretien tel qu'il est, pour rouvrir l'onglet là où on l'avait laissé. */
  app.get('/tenants/:tenantId/agents/:agentId/setup', opts, async (req, reply) => {
    const ctx = await ouvrir(req, reply);
    if (!ctx) return;
    const entretien = (await ctx.entretiens.lire(ctx.tenant, ctx.agentId)) ?? ENTRETIEN_VIERGE;
    /**
     * L'écran ne reçoit pas le fil entier : la base le conserve sans troncature, et cette route est appelée à chaque
     * ouverture de l'onglet. Le total part avec, pour que l'écran dise « 340 messages, les 200 derniers ».
     */
    const recents = entretien.messages.slice(-MAX_MESSAGES_AFFICHES);
    const auteurs = entretien.auteurs.slice(-MAX_MESSAGES_AFFICHES);
    /**
     * On ne résout que s'il y a quelque chose à résoudre : un fil entièrement anonyme ne doit pas coûter une
     * requête à chaque ouverture.
     */
    const emails = auteurs.some((a) => a !== null)
      ? await deps.emailsDesMembres(ctx.tenant).catch(() => ({} as Record<string, string>))
      : {};
    return reply.code(200).send({
      messages: recents,
      /**
       * Des adresses, pas des identifiants, et `null` quand on ne sait pas (un compte supprimé laisse un tour sans
       * auteur) : l'écran dit alors « auteur inconnu ».
       */
      auteurs: auteurs.map((a) => (a === null ? null : emails[a] ?? null)),
      total: entretien.messages.length,
      couverture: avancement(entretien, ctx.etat),
    });
  });

  /**
   * Ce que l'entretien a noté et qu'aucun écran n'a encore utilisé (l'adresse du site, lue par l'onglet Base de
   * connaissance). Route légère : `GET /setup` enverrait deux cents messages pour une chaîne. Elle ne déclenche
   * rien : l'import, avec ses contrôles, reste un geste du client.
   */
  app.get('/tenants/:tenantId/agents/:agentId/setup/suggestions', opts, async (req, reply) => {
    const ctx = await ouvrir(req, reply);
    if (!ctx) return;
    const entretien = (await ctx.entretiens.lire(ctx.tenant, ctx.agentId)) ?? ENTRETIEN_VIERGE;
    return reply.code(200).send({
      // Le champ dédié d'abord, l'extraction depuis le texte ensuite : celle-ci ne sert qu'aux entretiens
      // menés avant que le champ n'existe, et c'est pour eux que le correctif compte.
      connaissanceUrl: entretien.connaissanceUrl ?? urlDeConnaissance(entretien),
    });
  });

  /**
   * Recommencer : un entretien qui a mal tourné se jette sans supprimer l'agent ni perdre ce qui est réglé dans
   * les autres onglets.
   */
  app.delete('/tenants/:tenantId/agents/:agentId/setup', opts, async (req, reply) => {
    const ctx = await ouvrir(req, reply);
    if (!ctx) return;
    await ctx.entretiens.effacer(ctx.tenant, ctx.agentId);
    return reply.code(200).send({ efface: true, couverture: avancement(ENTRETIEN_VIERGE, ctx.etat) });
  });

  /**
   * Une pièce jointe, transformée en fiches de connaissance. La route écrit ses fiches directement : c'est le
   * client qui téléverse son propre document, et le geste est le consentement (comme l'import d'une page de son
   * site) ; tout reste relisible dans l'onglet Connaissance. Une image est lue une seule fois, ici, par le modèle
   * vision, et on n'en garde que du texte. `bodyLimit` dédié : les octets transitent en base64 (+33 %).
   */
  const optsPiece = { ...opts, bodyLimit: Math.ceil(TAILLE_DOCUMENT_MAX * 1.4) };
  app.post('/tenants/:tenantId/agents/:agentId/setup/piece-jointe', optsPiece, async (req, reply) => {
    const ctx = await ouvrir(req, reply);
    if (!ctx) return;
    const parse = pieceSchema.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'nom et dataUrl requis' });

    const bytes = octetsDepuisDataUrl(parse.data.dataUrl);
    if (!bytes) return reply.code(400).send({ error: 'fichier illisible (data URL base64 attendu)' });
    const reconnu = reconnaitre(bytes);
    // 415 et pas 400 : le corps est bien formé, c'est le type du contenu qu'on refuse. Et le refus se fonde
    // sur la signature réelle, jamais sur l'extension du nom, qui ne prouve rien.
    if (!reconnu) {
      return reply.code(415).send({ error: 'format non accepté (texte en UTF-8, CSV, PDF, Word, ou image JPEG/PNG/GIF/WebP)' });
    }
    const plafond = reconnu.nature === 'image' ? TAILLE_IMAGE_MAX : TAILLE_DOCUMENT_MAX;
    if (bytes.length > plafond) {
      return reply.code(413).send({ error: `fichier trop lourd (${Math.round(plafond / 1024 / 1024)} Mo maximum pour ce type)` });
    }

    let texte: string | null;
    if (reconnu.nature === 'image') {
      // Refus explicite plutôt qu'un appel voué à un 400 illisible : sans modèle de vision, on le dit, et les
      // documents continuent de passer par ailleurs (ils n'ont besoin d'aucun modèle).
      const vision = deps.modeleVision.trim();
      if (!deps.completer || vision === '') {
        return reply.code(503).send({ error: 'lecture d’image indisponible sur ce serveur (aucun modèle de vision configuré) ; les documents texte, PDF et Word passent quand même' });
      }
      if (!(await budgetOuvert(deps, ctx.tenant))) {
        // 422 et pas 200 : ici le client attend un import, pas une phrase. Lui dire que ce n'est pas parti
        // est le seul comportement honnête, et les documents texte, eux, continuent de passer.
        return reply.code(422).send({ error: `${MESSAGE_PLAFOND} Les documents texte, PDF et Word passent quand même.` });
      }
      /**
       * 422 et pas 502 pour une panne du fournisseur : la raison est écrite pour l'administrateur, et Cloudflare
       * remplacerait le corps d'une 5xx ; journalisée en plus. Toute autre erreur est la nôtre, relancée en 500
       * opaque (`direPanneModele`). Le `try` ne couvre que l'appel au modèle : une écriture qui lève ne doit pas être
       * annoncée « l'image n'a pas pu être lue ».
       */
      let lu: Awaited<ReturnType<typeof lireImage>>;
      try {
        lu = await lireImage(deps, ctx.tenant, vision, parse.data.dataUrl, parse.data.nom);
      } catch (err) {
        const raison = direPanneModele(err);
        if (raison === null) throw err;
        journaliser('error', 'agent_setup_image_echec', { tenantId: ctx.tenant, err });
        return reply.code(422).send({ error: `l’image n’a pas pu être lue : ${raison}` });
      }
      await noterDepense(deps, ctx.tenant, lu.coutDollars);
      texte = lu.texte;
    } else {
      texte = await extraireTexte(bytes, reconnu.nature);
    }
    if (texte === null || texte.trim() === '') {
      // 422 : le fichier est d'un type accepté mais ne porte aucun texte exploitable (PDF scanné, image sans
      // écriture, document vide). Le dire est plus utile qu'un succès à zéro fiche, que le client lirait
      // comme un import réussi.
      return reply.code(422).send({ error: 'aucun texte lisible dans ce fichier (un PDF scanné, par exemple, n’en contient pas)' });
    }

    const fiches = texteEnFiches(texte, parse.data.nom, reconnu.nature);
    if (fiches.length === 0) return reply.code(422).send({ error: 'ce fichier est trop court pour faire une fiche' });
    const bilan = await deps.ecrireFichesDocument(ctx.tenant, ctx.agentId, parse.data.nom, fiches);
    if (!bilan) return reply.code(404).send({ error: 'agent introuvable' });

    return reply.code(201).send({
      fiches: bilan.ecrites,
      remplacees: bilan.retirees,
      titres: fiches.map((f) => f.titre),
      nature: reconnu.nature,
      // Le plafond, pour que l'écran dise quand il a mordu : la suite du document n'a pas été lue.
      plafond: MAX_FICHES_PAR_PAGE,
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
     * La borne est posée à la construction du prompt, pas à l'écriture : on borne ce qui part, jamais ce qu'on
     * garde. Deux fils : `filComplet` est ce qu'on conserve, `historique` ce qu'on envoie au modèle (construire
     * l'état écrit à partir du fil borné amputerait la base à chaque tour). L'auteur est posé ici sur le message de
     * l'utilisateur, `null` pour la réponse de l'assistant.
     */
    const filComplet: TourEntretien[] = [...avant.messages, { role: 'user', content: parse.data.message }];
    const auteursComplets: Array<string | null> = [...avant.auteurs, req.auth?.userId ?? null];
    const historique: TourEntretien[] = bornerPourModele(filComplet);
    // Le point du tour est arrêté avant l'appel, sur l'état serveur : la séquence des questions n'est pas
    // négociable. Il est noté « posé » plus bas, parce que la réponse du modèle le pose.
    const pointDuTour = prochainPoint(avant, inventaireDe(ctx.etat));

    /**
     * Le plafond est vérifié avant l'appel et rend 200 : c'est une limite voulue, l'assistant la dit (un 4xx
     * afficherait un message d'infrastructure, un 5xx la page de Cloudflare). La forme de la réponse ne change pas :
     * l'écran attend `message`, `couverture`, `proposition` et `changements`.
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

    // Construits avant le `try` : une faute de programmation ici est notre panne, pas une réponse du modèle.
    const messages = construireMessages(ctx.etat, historique, avant);
    let reponse: ReponseChat;
    try {
      reponse = await deps.completer({
        tenantId: ctx.tenant,
        modele: deps.modele,
        messages,
        outils: [{
          name: OUTIL_PROPOSER,
          description: 'Rends ta réponse et, si tu en as une, ta proposition de réglage.',
          parameters: SCHEMA_PROPOSITION,
        }],
        toolChoice: OUTIL_PROPOSER,
        signal: AbortSignal.timeout(DELAI_MS),
      });
    } catch (err) {
      // Panne du fournisseur, délai dépassé, clé refusée : pas un incident de la console, d'où 422 (un 5xx serait
      // remplacé par la page de Cloudflare). Seulement ces trois-là : le reste est notre panne, relancée en 500 opaque.
      const raison = direPanneModele(err);
      if (raison === null) throw err;
      journaliser('error', 'agent_setup_tour_echec', { tenantId: ctx.tenant, err });
      return reply.code(422).send({ error: `l’assistant n’a pas répondu : ${raison}` });
    }

    // Avant toute sortie d'erreur : l'appel a eu lieu, donc il est payé. Le noter seulement sur le chemin heureux
    // rendrait le plafond contournable par un modèle qui répond de travers.
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
    // `safeParse` : ce qui n'est pas au schéma est écarté sans faire échouer le tour (un modèle qui tente une clé de
    // sécurité n'obtient rien). Assaini d'abord : l'hygiène (longueur, slug, doublon) est ramenée dans les bornes,
    // la frontière reste jugée par Zod juste après (`assainirProposition`).
    const propose = propositionSchema.safeParse(assainirProposition(brut));
    if (!propose.success) {
      /**
       * La raison est journalisée (chemins et codes d'erreur, jamais les valeurs, qui portent les mots du client) :
       * sans elle, un 422 « hors format » ne dirait pas quel champ a été refusé.
       */
      journaliser('warn', 'agent_setup_proposition_hors_schema', {
        tenantId: ctx.tenant, agentId: ctx.agentId,
        champs: propose.error.issues.map((i) => `${i.path.join('.') || '(racine)'}:${i.code}`),
      });
      return reply.code(422).send({ error: 'l’assistant a rendu une proposition hors format' });
    }

    /**
     * L'état de l'entretien est recalculé ici, et nulle part ailleurs. Les réponses extraites entrent dans l'état
     * (`fusionner` ignore les codes inconnus et les valeurs vides) ; le point du tour est noté posé, parce que le
     * message de l'assistant le pose : un point jamais montré au client ne peut pas être compté couvert.
     */
    const reponses = fusionner(avant.reponses, propose.data.reponses);
    // Les bascules vivent à part : elles sont une liste (un moment, une action, un moyen), pas une réponse à
    // un point. C'est ce qui permet de les prendre une par une au lieu de les écraser l'une sur l'autre.
    const listeBascules = fusionnerBascules(avant.bascules ?? [], propose.data.bascules ?? []);
    const poses = pointDuTour && !avant.poses.includes(pointDuTour.code)
      ? [...avant.poses, pointDuTour.code]
      : avant.poses;

    /**
     * Un message qui n'interroge rien laisserait l'entretien mort : le serveur pose alors lui-même la question du
     * point encore ouvert une fois les réponses du tour intégrées, et la note posée (sinon le tour d'après la
     * reposerait).
     */
    const ouvertApres = prochainPoint({ poses, reponses, bascules: listeBascules }, inventaireDe(ctx.etat));
    const relance = ouvertApres && !poseUneQuestion(propose.data.message) ? ouvertApres : null;
    const posesApres = relance && !poses.includes(relance.code) ? [...poses, relance.code] : poses;

    /**
     * L'état de ce tour sans son message : il sert à savoir où en est la couverture, et il faut le savoir
     * avant de connaître le message, puisque c'est la couverture qui décide s'il y a un tour de synthèse.
     */
    const etatApres: EntretienComplet = {
      messages: filComplet, auteurs: auteursComplets, reponses, bascules: listeBascules, poses: posesApres,
    };
    const suivi = avancement(etatApres, ctx.etat);
    const enEntretien = suivi.manquants.length > 0;

    let propositionFinale = propose.data;
    let message = relance ? `${propose.data.message}\n\n${relance.question}` : propose.data.message;
    let tokensIn = reponse.usage.tokensIn;
    let tokensOut = reponse.usage.tokensOut;

    /**
     * Le tour de synthèse : un second appel, une seule fois par entretien, quand l'ordre du jour vient de se
     * fermer. La consigne du tour est arrêtée avant de lire le client, donc le tour qui répond au dernier point ne
     * parle que de ce point ; sans synthèse, les autres champs resteraient vides dans le diff.
     * La condition est une transition (il manquait des points avant ce tour, plus après), pas un état : sinon chaque
     * message suivant relancerait une synthèse. Il complète le premier appel : on n'en garde que le message et les
     * champs. Tout échec retombe sur la proposition du premier appel, jamais une erreur.
     */
    if (!enEntretien && avancement(avant, ctx.etat).manquants.length > 0) {
      try {
        if (await budgetOuvert(deps, ctx.tenant)) {
          const seconde = await deps.completer({
            tenantId: ctx.tenant,
            modele: deps.modele,
            // `historique` se termine sur le message du client : la synthèse en accuse elle-même réception,
            // et y glisser le message du premier appel ferait dire deux fois la même chose.
            messages: construireMessages(ctx.etat, historique, etatApres, { synthese: true }),
            outils: [{
              name: OUTIL_PROPOSER,
              description: 'Rends ta réponse et, si tu en as une, ta proposition de réglage.',
              parameters: SCHEMA_PROPOSITION,
            }],
            toolChoice: OUTIL_PROPOSER,
            signal: AbortSignal.timeout(DELAI_MS),
          });
          await noterDepense(deps, ctx.tenant, seconde.usage.coutDollars);
          tokensIn += seconde.usage.tokensIn;
          tokensOut += seconde.usage.tokensOut;
          const appelSynthese = seconde.appelsOutils.find((a) => a.nom === OUTIL_PROPOSER);
          if (appelSynthese) {
            const proposeSynthese = propositionSchema.safeParse(
              assainirProposition(secureJsonParse(appelSynthese.argumentsJson)),
            );
            if (proposeSynthese.success) {
              propositionFinale = proposeSynthese.data;
              message = proposeSynthese.data.message;
            } else {
              journaliser('warn', 'agent_setup_synthese_hors_schema', {
                tenantId: ctx.tenant, agentId: ctx.agentId,
                champs: proposeSynthese.error.issues.map((i) => `${i.path.join('.') || '(racine)'}:${i.code}`),
              });
            }
          }
        }
      } catch (err) {
        // Le tour de synthèse échoue sans faire échouer le tour : on garde la proposition du tour. Une `SyntaxError`
        // ne se journalise que par son nom : celle de `JSON.parse` recopie les arguments du modèle, donc les mots du
        // client.
        journaliser('warn', 'agent_setup_synthese_echec', {
          tenantId: ctx.tenant, agentId: ctx.agentId, err: err instanceof SyntaxError ? err.name : err,
        });
      }
    }

    const apres: EntretienComplet = {
      // 🔴 `filComplet`, jamais `historique` : c'est la ligne qui décide si le fil perdure ou se fait amputer par
      // sa propre sauvegarde.
      messages: [...filComplet, { role: 'assistant', content: message }],
      // L'assistant n'a pas d'auteur humain : `null`, et l'écran l'affiche comme venant de l'assistant.
      auteurs: [...auteursComplets, null],
      reponses,
      bascules: listeBascules,
      poses: posesApres,
      /**
       * On garde l'ancienne adresse quand le tour n'en apporte pas : donnée au point `connaissance`, bien avant la
       * fin de l'entretien, l'écraser la perdrait dès la question suivante.
       */
      ...(propositionFinale.connaissanceUrl ?? avant.connaissanceUrl
        ? { connaissanceUrl: propositionFinale.connaissanceUrl ?? avant.connaissanceUrl }
        : {}),
    };
    await ctx.entretiens.ecrire(ctx.tenant, ctx.agentId, apres);

    /**
     * Le diff est retenu tant que l'ordre du jour n'est pas épuisé : couvrir tout le périmètre d'abord, avant
     * d'afficher les règles. La proposition n'est pas jetée, elle n'est pas montrée : le tour suivant la reformulera.
     */
    // `suivi` est celui de `etatApres` : la couverture ne lit que les réponses, les bascules et les points posés,
    // jamais les messages, donc ajouter celui de l'assistant ne la change pas.
    return reply.code(200).send({
      message,
      couverture: suivi,
      proposition: enEntretien ? { fiche: {}, outils: [], connecteurs: [], outilsBranches: [], outilsDebranches: [] } : {
        fiche: propositionFinale.fiche ?? {},
        outils: propositionFinale.outils ?? [],
        // Les connecteurs proposés sont filtrés sur ceux qui existent : l'assistant n'en crée pas, et un nom
        // inventé ne doit pas atteindre l'application, qui tenterait un patch sur un outil inconnu.
        connecteurs: (propositionFinale.connecteurs ?? []).filter((c) => (ctx.etat.connecteurs ?? []).some((x) => x.nom === c.nom)),
        /**
         * 🔴 Le branchement est filtré sur la bibliothèque de l'espace : le schéma ne connaît pas le catalogue et ne
         * peut pas refuser un nom inventé. Filtré aussi sur l'état courant : brancher ce qui l'est déjà ne produit
         * aucun geste.
         */
        outilsBranches: brancheables(ctx.etat.catalogue, propositionFinale.outilsBranches, false),
        outilsDebranches: brancheables(ctx.etat.catalogue, propositionFinale.outilsDebranches, true),
      },
      changements: enEntretien ? [] : differences(ctx.etat, propositionFinale),
      usage: { tokensIn, tokensOut },
    });
  });
}
