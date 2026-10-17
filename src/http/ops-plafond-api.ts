import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auteurOps, type PreHandler } from '../auth/middleware';
import { estUuid } from './scope';
import { journaliser } from '../lib/journal';
import {
  SANS_LIMITE_D_OFFRE, detailDuChangement, valeurEffective,
  type LimitesApiOffre, type PlafondApiStore, type PlafondsParDefaut, type ReglagePlafondApi, type SourceLimitesApi,
} from '../auth/plafond-espace';
import type { CompteurDebit } from '../db/debit';
import { consommationDuJour, type ConsommationDuJour } from '../api/quotas';
// Le même seuil que les autres écritures de `/ops` : importé, pas recopié.
import { MIN_NOTE } from './ops';

/**
 * Le réglage du plafond de l'API d'un espace, et de ses quotas quotidiens (modèles, réponses, fiches ; `src/api/quotas.ts`).
 * 🔴 Dans `/ops` et nulle part ailleurs : un plafond que le client écrirait lui-même n'en serait pas un. Même
 * autorité que le rechargement de crédit (la session d'exploitation), même note obligatoire (le pourquoi), la
 * ligne de journal signée de l'adresse de son auteur, et une ligne d'audit DANS l'espace (`api.limites_modifiees`),
 * la seule qui survive à la recréation du conteneur. L'état rendu porte la consommation du jour (`aujourdhui`).
 * Module à part : sans ses dépendances (magasin, cache du limiteur), ces routes ne sont pas montées et le limiteur
 * applique les défauts.
 */
export interface OpsPlafondApiDeps {
  store: PlafondApiStore;
  /**
   * Le cache du limiteur : la route y pose le réglage qu'elle vient d'écrire (sinon le nouveau plafond attendrait
   * l'expiration). Le poser plutôt que le vider le garde comme « dernier connu » si la relecture suivante échoue.
   */
  reglages: { poser(tenantId: string, reglage: ReglagePlafondApi): void };
  /** Les défauts de la configuration, pour dire ce qui s'applique réellement quand un réglage vaut `null`. */
  defauts: PlafondsParDefaut;
  /** Les plafonds et quotas de l'offre de l'espace (spec offres v2) : le défaut d'un espace sans réglage. */
  offres: SourceLimitesApi;
  /** Le compteur partagé (`compteurs_debit`) : la consommation du jour s'y lit, sous les clés que le garde écrit. */
  compteur: Pick<CompteurDebit, 'lister'>;
  /** L'horloge du jour civil ; `Date.now` par défaut. */
  maintenant?: () => number;
}


/** La borne haute d'un réglage : celle de la colonne `integer`. Au-delà, l'écriture lèverait, donc un 500. */
export const MAX_PLAFOND_REGLABLE = 2_147_483_647;

const reglageSchema = z.number().int().min(1).max(MAX_PLAFOND_REGLABLE).nullable();
/**
 * Les cinq réglages sont requis, `null` compris : un champ absent lu tantôt « inchangé », tantôt « défaut »
 * remettrait un client au défaut par accident. L'opérateur relit l'état par le `GET` et écrit les cinq.
 */
const corpsSchema = z.object({
  minute: reglageSchema, heure: reglageSchema, modelesJour: reglageSchema, reponsesJour: reglageSchema, fichesJour: reglageSchema,
  note: z.string(),
});

/**
 * Ce qui s'applique réellement à une fenêtre : le réglage, sinon le défaut de l'espace (son offre, sinon la
 * configuration) ; `null` = aucun plafond (défaut à 0).
 */
function fenetre(reglage: number | null, defaut: number): { reglage: number | null; defaut: number; effectif: number | null } {
  const effectif = reglage ?? defaut;
  return { reglage, defaut, effectif: effectif > 0 ? effectif : null };
}

function etat(tenantId: string, r: ReglagePlafondApi, defauts: PlafondsParDefaut, offre: LimitesApiOffre, aujourdhui: ConsommationDuJour | null) {
  return {
    tenantId,
    /** `null` = le compteur n'a pas répondu : inconnue, surtout pas zéro. */
    aujourdhui,
    minute: fenetre(r.minute, valeurEffective(null, offre.appelsMinute, defauts.minute)),
    heure: fenetre(r.heure, valeurEffective(null, offre.appelsHeure, defauts.heure)),
    modelesJour: fenetre(r.modelesJour, valeurEffective(null, offre.modelesJour, defauts.envoisJour)),
    reponsesJour: fenetre(r.reponsesJour, valeurEffective(null, offre.reponsesJour, defauts.envoisJour)),
    fichesJour: fenetre(r.fichesJour, defauts.fichesJour),
  };
}

/** `garde` : la garde d'exploitation, la même instance que celle de `/ops` (`buildServer`). */
export function registerOpsPlafondApi(app: FastifyInstance, deps: OpsPlafondApiDeps, garde: PreHandler): void {
  const opts = { preHandler: garde };
  const maintenant = deps.maintenant ?? Date.now;

  /** La consommation du jour, ou `null` si le compteur ne répond pas : l'écran le dit, le réglage reste lisible. */
  const lireAujourdhui = async (tenantId: string): Promise<ConsommationDuJour | null> => {
    try {
      return await consommationDuJour(deps.compteur, tenantId, maintenant());
    } catch (err) {
      journaliser('error', 'ops_plafond_api_consommation_illisible', { tenantId, err });
      return null;
    }
  };

  /** L'offre de l'espace ; illisible, la configuration (ce que le limiteur applique alors aussi). */
  const lireOffre = async (tenantId: string): Promise<LimitesApiOffre> => {
    try {
      return await deps.offres.limitesApi(tenantId);
    } catch (err) {
      journaliser('error', 'ops_plafond_api_offre_illisible', { tenantId, err });
      return SANS_LIMITE_D_OFFRE;
    }
  };

  app.get('/ops/plafond-api/:tenantId', opts, async (req, reply) => {
    // En minuscules : `estUuid` accepte les majuscules, la base aussi, mais pas la clé du compteur ni celle du cache.
    const tenantId = (req.params as { tenantId: string }).tenantId.toLowerCase();
    // Un identifiant mal formé partirait dans un `where id = $1` sur une colonne `uuid` : 22P02, donc 500.
    if (!estUuid(tenantId)) return reply.code(404).send({ error: 'espace inconnu' });
    const reglage = await deps.store.lire(tenantId);
    if (reglage === null) return reply.code(404).send({ error: 'espace inconnu' });
    return reply.code(200).send(etat(tenantId, reglage, deps.defauts, await lireOffre(tenantId), await lireAujourdhui(tenantId)));
  });

  app.put('/ops/plafond-api/:tenantId', opts, async (req, reply) => {
    // En minuscules : `estUuid` accepte les majuscules, la base aussi, mais pas la clé du compteur ni celle du cache.
    const tenantId = (req.params as { tenantId: string }).tenantId.toLowerCase();
    if (!estUuid(tenantId)) return reply.code(404).send({ error: 'espace inconnu' });
    const lu = corpsSchema.safeParse(req.body ?? {});
    if (!lu.success) {
      return reply.code(400).send({
        error: `minute, heure, modelesJour, reponsesJour et fichesJour requis : un entier entre 1 et ${MAX_PLAFOND_REGLABLE}, ou null pour le défaut de l’espace (son offre, sinon la configuration)`,
      });
    }
    const note = lu.data.note.trim().slice(0, 500);
    if (note.length < MIN_NOTE) return reply.code(400).send({ error: 'note requise : pourquoi ce plafond ou ce quota' });

    const avant = await deps.store.lire(tenantId);
    if (avant === null) return reply.code(404).send({ error: 'espace inconnu' });
    const apres: ReglagePlafondApi = {
      minute: lu.data.minute, heure: lu.data.heure, modelesJour: lu.data.modelesJour, reponsesJour: lu.data.reponsesJour, fichesJour: lu.data.fichesJour,
    };
    if (!(await deps.store.ecrire(tenantId, apres))) return reply.code(404).send({ error: 'espace inconnu' });
    // Après l'écriture : posé avant, un échec d'écriture laisserait le limiteur appliquer un réglage inexistant.
    deps.reglages.poser(tenantId, apres);
    const par = auteurOps(req);
    journaliser('warn', 'ops_plafond_api', { tenantId, avant, apres, par, note, at: new Date().toISOString() });
    // La trace durable, dans le journal d'audit de l'espace. Après l'écriture, et sans la faire échouer : le réglage
    // est posé, un audit en panne ne doit pas faire croire le contraire (la ligne ci-dessus reste).
    // Rien n'a bougé : aucune ligne, qui se lirait « limites modifiées » sans rien dire.
    // `detailDuChangement` porte la liste des champs : au-delà de `par`, chaque clé est un champ qui a bougé.
    const change = Object.keys(detailDuChangement(avant, apres)).length > 1;
    if (change) {
      try {
        await deps.store.tracer(tenantId, { par, avant, apres });
      } catch (err) {
        journaliser('error', 'ops_plafond_api_audit_ignore', { tenantId, err });
      }
    }
    return reply.code(200).send(etat(tenantId, apres, deps.defauts, await lireOffre(tenantId), await lireAujourdhui(tenantId)));
  });
}
