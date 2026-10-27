import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Guard } from '../auth/middleware';
import type { Fonction } from '../offres/offres';
import { corpsRefusFonction } from '../offres/refus';
import type { ChoixHubspotEcrit, ChoixHubspot } from '../settings/store.pg';
import type { HubspotPortalLink, ModeTaches } from '../account/types';
import { journaliser } from '../lib/journal';
import { espaceVerifie } from './scope';
import { ConnecteurEnReveil } from '../crm/hubspot-service';

/**
 * LE CHOIX DES FONCTIONS HUBSPOT (lot 1bis de la reprise humaine, cadrage validé par Julien le 2026-10-23) : le client
 * branche ce qui lui plaît entre Messaging Me et HubSpot, depuis Tools > Intégrations > HubSpot.
 */
export interface HubspotChoixRouteDeps {
  /** Écrit le choix en une transaction et dit si c'est la première validation (`PgTenantSettingsStore`). */
  poserChoix(tenantId: string, c: ChoixHubspotEcrit): Promise<{ choix: ChoixHubspot; listes: boolean; premiereValidation: boolean }>;
  /** Les fonctions de l'offre de l'espace. */
  fonctions(tenantId: string): Promise<ReadonlySet<Fonction>>;
  /**
   * Ce qui est EN VIGUEUR avant l'écriture : le refus d'offre ne porte que sur un passage d'éteint à allumé (un
   * espace descendu d'offre doit pouvoir tout éteindre sans renvoyer le reste à faux), et la date décide de l'allumage
   * de la synchro.
   */
  choixEnVigueur(tenantId: string): Promise<{ analyse: boolean; reponse: boolean; modeles: boolean; listes: boolean; valideLe: Date | null }>;
  /** Le portail relié, lu par le connecteur (`lireHubspotPortal`). Une panne LÈVE. */
  portail(tenantId: string): Promise<HubspotPortalLink>;
  /** Le numéro principal de l'espace et l'état de sa synchro HubSpot, null sans numéro. */
  numeroPrincipal(tenantId: string): Promise<{ id: string; hubspotConnected: boolean; hubspotPausedAt: string | null } | null>;
  /** Allume la synchro HubSpot d'un numéro de l'espace (`setHubspotConnected`, scopée espace). */
  allumerSynchro(phoneNumberId: string, tenantId: string): Promise<void>;
  /** Pose le mode des tâches du portail chez le connecteur (`poserModeTaches`). LÈVE sur échec. */
  poserModeTaches(tenantId: string, mode: ModeTaches): Promise<ModeTaches>;
}

/**
 * Le corps : cinq choix requis, et « Créer des tâches » FACULTATIF. Un champ de trop est refusé (`strict`).
 * 🔴 `taches` absent : le mode du portail n'est pas touché. Il vaut pour tout le portail (donc pour d'autres espaces),
 * et la console ne le connaît que par une lecture qui peut échouer : le renvoyer à chaque bascule d'une AUTRE ligne
 * l'écraserait depuis une valeur devinée ou périmée (relecture du lot 1bis, le seul rouge). La console ne l'envoie
 * qu'à la validation de l'étape de choix, s'il est connu, ou quand c'est sa ligne qu'on bascule.
 * 🔴 `modeles` (sous-lot « relancer ») FACULTATIF aussi : absent, il garde sa valeur. Une console d'avant le sous-lot,
 * restée ouverte, envoie cinq champs ; requis, il lui ferait refuser toute bascule, et lu absent comme faux, chaque bascule
 * d'une autre ligne l'éteindrait. Il ne vaut que réponse allumée : éteindre la réponse l'écrit à faux, pour que la
 * rallumer ne rouvre pas les modèles en silence.
 */
const corpsChoix = z.object({
  analyse: z.boolean(),
  passage: z.boolean(),
  injoignable: z.boolean(),
  reponse: z.boolean(),
  listes: z.boolean(),
  taches: z.boolean().optional(),
  modeles: z.boolean().optional(),
}).strict();

/** Ce que l'offre doit ouvrir pour ALLUMER une fonction. Éteindre, ou laisser allumé ce qui l'était, n'est jamais refusé. */
const FONCTION_REQUISE: ReadonlyArray<['analyse' | 'listes' | 'reponse' | 'modeles', Fonction]> = [
  ['analyse', 'analyse'],
  ['listes', 'crm'],
  ['reponse', 'inbox'],
  ['modeles', 'inbox'],
];

/**
 * `PUT /tenants/:tenantId/hubspot/choix` (admin). Écrit le choix, et :
 * - à la PREMIÈRE validation (date encore nulle), allume la synchro du numéro principal : jusque-là une installation ne branchait rien,
 *   le callback OAuth ne posant jamais la porte du numéro. Un numéro EN PAUSE n'est pas touché : la pause est un geste
 *   du client ;
 * - transmet « Créer des tâches », S'IL EST DANS LE CORPS, au connecteur, qui le pose sur le PORTAIL (donc pour tous les espaces qui le
 *   partagent). Un échec ne défait pas le reste : `tachesAppliquees` le dit, jamais un succès muet.
 * 409 sans portail relié : l'écran ne propose le choix qu'après l'installation.
 */
export function registerHubspotChoix(app: FastifyInstance, deps: HubspotChoixRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };

  app.put('/tenants/:tenantId/hubspot/choix', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const parsed = corpsChoix.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'corps invalide : analyse, passage, injoignable, reponse et listes (booléens) sont requis, taches et modeles (booléens) sont facultatifs' });
    const brut = parsed.data;

    const [fonctions, avant] = await Promise.all([deps.fonctions(tenant), deps.choixEnVigueur(tenant)]);
    // L'état EFFECTIF après écriture (`modeles` absent = inchangé, réponse éteinte = éteint), sur lequel juger l'offre.
    const c = { ...brut, modeles: brut.reponse && (brut.modeles ?? avant.modeles) };
    for (const [champ, fonction] of FONCTION_REQUISE) {
      if (c[champ] && !avant[champ] && !fonctions.has(fonction)) return reply.code(402).send(corpsRefusFonction(fonction));
    }

    let portail: HubspotPortalLink;
    try {
      portail = await deps.portail(tenant);
    } catch (err) {
      if (!(err instanceof ConnecteurEnReveil)) throw err;
      return reply.code(503).send({ error: 'HubSpot se réveille : réessayez dans quelques secondes. Rien n’a été enregistré.' });
    }
    if (!portail.connected) return reply.code(409).send({ error: 'hubspot_non_relie' });

    // La synchro du numéro s'allume AVANT d'écrire la date de validation : si elle échoue, la route échoue sans avoir
    // posé la date, et la validation suivante réessaie (posée d'abord, la date aurait fait perdre l'allumage pour de bon).
    if (avant.valideLe === null) {
      const numero = await deps.numeroPrincipal(tenant);
      if (numero && !numero.hubspotConnected && numero.hubspotPausedAt === null) await deps.allumerSynchro(numero.id, tenant);
    }

    const { choix, listes, premiereValidation } = await deps.poserChoix(tenant, {
      analyse: c.analyse, passage: c.passage, injoignable: c.injoignable, reponse: c.reponse, modeles: c.modeles, listes: c.listes,
    });

    let routingMode: ModeTaches | null = null;
    if (c.taches !== undefined) {
      try {
        routingMode = await deps.poserModeTaches(tenant, c.taches ? 'mm_routing' : 'hubspot_native');
      } catch (err) {
        journaliser('error', 'hubspot_mode_taches_impossible', { err, tenantId: tenant });
      }
    }

    return reply.code(200).send({
      hubspotAnalyse: choix.analyse,
      hubspotPassage: choix.passage,
      hubspotInjoignable: choix.injoignable,
      hubspotReponse: choix.reponse,
      hubspotModeles: choix.modeles,
      hubspotListsEnabled: listes,
      hubspotChoixValideLe: choix.valideLe ? choix.valideLe.toISOString() : null,
      // Le mode posé par CETTE requête, null s'il n'était pas demandé ou s'il a échoué ; `tachesAppliquees` ne dit faux
      // que pour un mode demandé et non posé.
      routingMode,
      tachesAppliquees: c.taches === undefined || routingMode !== null,
      premiereValidation,
    });
  });
}
