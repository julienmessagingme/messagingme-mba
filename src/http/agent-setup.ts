import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Guard } from '../auth/middleware';
import { octetsDepuisDataUrl } from '../rcs/image';
import { MAX_FICHES_PAR_PAGE, type FicheExtraite } from '../agent/scrape';
import {
  lireDocumentHorsBoucle, texteEnFichesHorsBoucle, TAILLE_DOCUMENT_MAX, TAILLE_IMAGE_MAX,
} from '../agent/setup/piece-jointe';
import { MAX_CARACTERES_MESSAGE, type ContexteConstruction } from '../agent/setup/conversation';
import { urlDeConnaissance } from '../agent/setup/couverture';
import { ENTRETIEN_VIERGE, type EntretienStore } from '../agent/setup/entretien-store';
import { avancementEntretien } from '../agent/setup/avancement';
import {
  creerTourEntretien, type ResultatTourEntretien, type TourEntretienDeps,
} from '../agent/setup/tour-entretien';
import { espaceVerifie, estUuid } from './scope';
import type { OutilBibliotheque } from '../agent/catalog';
import { budgetOuvert, MESSAGE_PLAFOND, noterDepense } from '../assistant/budget';
import { direPanneModele } from '../llm/errors';
import { journaliser } from '../lib/journal';

/**
 * La conversation de construction d'un agent : elle propose, le client corrige.
 * Cette route n'écrit rien de l'agent : elle rend une proposition et son diff, l'écriture passe par le `PATCH`
 * de la fiche et les routes d'outils. La conversation n'est jamais le seul chemin d'édition ; elle n'écrit que
 * son propre état (`agent_setup_conversations`).
 * 🔴 Ce que le modèle peut proposer est énuméré dans `src/agent/setup/proposition.ts` (la fiche et les mots des
 * outils maison) : ni mention légale d'IA, ni plafonds, ni modèle, ni risque, ni activation.
 * C'est le module `tour-entretien` qui conduit l'entretien depuis l'état persisté ; cette route authentifie,
 * valide le message puis traduit son résultat. Le navigateur n'envoie qu'un message, le modèle formule et extrait.
 */

/**
 * Combien de messages l'écran reçoit d'un coup. Ni `MAX_TOURS_HISTORIQUE` (ce qu'on envoie au modèle) ni
 * `MAX_TOURS_CONSERVES` (ce que la base garde) : celui-ci borne le poids d'une réponse HTTP.
 */
export const MAX_MESSAGES_AFFICHES = 200;

export interface AgentSetupRouteDeps extends TourEntretienDeps {
  /** L'état courant de l'agent, ou `null` s'il n'existe pas ou appartient à un autre tenant. */
  etatCourant(tenantId: string, agentId: string): Promise<ContexteConstruction | null>;
  /**
   * Qui a écrit chaque message : les adresses des membres de l'espace, par identifiant, résolues côté serveur (le
   * fil ne porte que des identifiants ; le navigateur n'a pas à voir la liste des comptes). Son échec laisse le
   * fil s'afficher avec « auteur inconnu ».
   */
  emailsDesMembres(tenantId: string): Promise<Record<string, string>>;
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
 * Ce que l'assistant voit de la bibliothèque de l'espace, pour un agent : chaque outil, et s'il est branché sur lui.
 * 🔴 SEULS Y SONT CE QU'ON PEUT LUI OFFRIR (`offrables`, la règle unique du catalogue) ET CE QU'IL A DÉJÀ (pour qu'on
 * puisse proposer de le débrancher). Cette fonction ne recalcule rien elle-même : elle filtrait l'enregistrement d'un
 * outil MCP et pas sa mort, donc l'assistant proposait de brancher un outil que l'agent ne pouvait pas appeler, et
 * l'application échouait APRÈS avoir écrit la fiche. `brancheables` écarte ensuite tout nom absent d'ici : c'est la
 * ceinture, côté application. Pour la même raison, une offre dont l'agent porte déjà le nom (`nomPris`, 0211) n'y est
 * pas : la porte la refuserait, sur une fiche déjà enregistrée. Le drapeau vient du catalogue, rien n'est recalculé ici.
 */
export function catalogueBranchable(
  bibliotheque: readonly Pick<OutilBibliotheque, 'name' | 'title' | 'consommateurs'>[],
  offrables: readonly Pick<OutilBibliotheque, 'name' | 'nomPris'>[],
  agentId: string,
): NonNullable<ContexteConstruction['catalogue']> {
  const offrable = new Set(offrables.filter((o) => !o.nomPris).map((o) => o.name));
  return bibliotheque
    .map((o) => ({ o, branche: o.consommateurs.some((c) => c.agentId === agentId) }))
    .filter(({ o, branche }) => branche || offrable.has(o.name))
    .map(({ o, branche }) => ({ nom: o.name, titre: o.title, branche }));
}

/** Traduit les issues du module en contrat HTTP sans reprendre son orchestration. */
function repondreAuTour(reply: FastifyReply, resultat: ResultatTourEntretien): FastifyReply {
  switch (resultat.issue) {
    case 'repondu':
    case 'budget_epuise':
      return reply.code(200).send(resultat.reponse);
    case 'assistant_indisponible':
      return reply.code(503).send({ error: 'assistant de construction indisponible (aucun modèle configuré)' });
    case 'modele_en_panne':
      return reply.code(422).send({ error: `l’assistant n’a pas répondu : ${resultat.raison}` });
    case 'proposition_absente':
      return reply.code(422).send({ error: 'l’assistant n’a pas rendu de proposition exploitable' });
    case 'proposition_illisible':
      return reply.code(422).send({ error: 'l’assistant a rendu une proposition illisible' });
    case 'proposition_hors_format':
      return reply.code(422).send({ error: 'l’assistant a rendu une proposition hors format' });
  }
}

export function registerAgentSetup(app: FastifyInstance, deps: AgentSetupRouteDeps, garde: Guard): void {
  const tourEntretien = creerTourEntretien(deps);
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
      couverture: avancementEntretien(entretien, ctx.etat),
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
    return reply.code(200).send({ efface: true, couverture: avancementEntretien(ENTRETIEN_VIERGE, ctx.etat) });
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
    // Nature, texte et fiches d'un document en UN seul worker : seules les fiches reviennent, jamais le texte. Une
    // image, elle, revient sans fiches : c'est le modèle de vision qui la lit, plus bas.
    const doc = await lireDocumentHorsBoucle(bytes, parse.data.nom, TAILLE_DOCUMENT_MAX);
    const reconnu = doc.reconnu;
    // 415 et pas 400 : le corps est bien formé, c'est le type du contenu qu'on refuse. Et le refus se fonde
    // sur la signature réelle, jamais sur l'extension du nom, qui ne prouve rien.
    if (!reconnu) {
      return reply.code(415).send({ error: 'format non accepté (texte en UTF-8, CSV, PDF, Word, ou image JPEG/PNG/GIF/WebP)' });
    }
    const plafond = reconnu.nature === 'image' ? TAILLE_IMAGE_MAX : TAILLE_DOCUMENT_MAX;
    if (bytes.length > plafond) {
      return reply.code(413).send({ error: `fichier trop lourd (${Math.round(plafond / 1024 / 1024)} Mo maximum pour ce type)` });
    }

    let fiches: FicheExtraite[] | null | undefined;
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
      fiches = lu.texte === null || lu.texte.trim() === '' ? null : await texteEnFichesHorsBoucle(lu.texte, parse.data.nom, reconnu.nature);
    } else {
      fiches = doc.fiches;
    }
    if (!fiches) {
      // 422 : le fichier est d'un type accepté mais ne porte aucun texte exploitable (PDF scanné, image sans
      // écriture, document vide). Le dire est plus utile qu'un succès à zéro fiche, que le client lirait
      // comme un import réussi.
      return reply.code(422).send({ error: 'aucun texte lisible dans ce fichier (un PDF scanné, par exemple, n’en contient pas)' });
    }
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
    if (tourEntretien.indisponibilite) {
      return repondreAuTour(reply, { issue: 'assistant_indisponible' });
    }

    const parse = corpsSchema.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'message requis (texte non vide)' });

    const resultat = await tourEntretien.executer({
      tenantId: ctx.tenant,
      agentId: ctx.agentId,
      auteurId: req.auth?.userId ?? null,
      message: parse.data.message,
      contexte: ctx.etat,
    });
    return repondreAuTour(reply, resultat);
  });
}
