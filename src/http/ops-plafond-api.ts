import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { makeRequireOps } from '../auth/middleware';
import type { SurveillanceOps } from '../ops/tentatives';
import { estUuid } from './scope';
import { journaliser } from '../lib/journal';
import type { PlafondApiStore, PlafondsParDefaut, ReglagePlafondApi } from '../auth/plafond-espace';

/**
 * LE RÉGLAGE DU PLAFOND DE L'API D'UN ESPACE (décision de Julien du 2026-09-25, migration 0181).
 *
 * 🔴 DANS `/ops`, ET NULLE PART AILLEURS : un réglage que le client pourrait écrire lui-même depuis la console
 * ne serait pas un plafond. Même autorité que le rechargement de crédit et le verrou d'espace (le jeton
 * d'exploitation, jamais le JWT d'un client), même NOTE obligatoire, et même trace : le jeton est partagé, cette
 * note est la seule chose qui dise qui a relevé le plafond d'un client, et pourquoi.
 *
 * ⚠️ UN MODULE À PART, pas une route de plus dans `ops.ts` : il a ses propres dépendances (le magasin et le cache
 * du limiteur), qu'il reçoit ensemble ou pas du tout. Absentes, ces routes ne sont pas montées, et le limiteur
 * applique les défauts de la configuration à tous les espaces.
 */
export interface OpsPlafondApiDeps {
  store: PlafondApiStore;
  /** Le cache du limiteur : vidé pour l'espace réglé, sans quoi le nouveau plafond attendrait l'expiration. */
  reglages: { invalider(tenantId: string): void };
  /** Les défauts de la configuration, pour dire ce qui s'applique réellement quand un réglage vaut `null`. */
  defauts: PlafondsParDefaut;
}

/** Même seuil que les autres écritures de `/ops` (`MIN_NOTE` de `ops.ts`, non exporté). */
const MIN_NOTE = 3;

/** La borne haute d'un réglage : celle de la colonne `integer`. Au-delà, l'écriture lèverait, donc un 500. */
export const MAX_PLAFOND_REGLABLE = 2_147_483_647;

const reglageSchema = z.number().int().min(1).max(MAX_PLAFOND_REGLABLE).nullable();
/**
 * LES DEUX FENÊTRES SONT REQUISES, `null` compris. Un champ absent qui voudrait dire « inchangé » ou « défaut »
 * selon le lecteur est le genre d'ambiguïté qui remet un client au défaut par accident : l'opérateur relit l'état
 * par le `GET`, et écrit les deux.
 */
const corpsSchema = z.object({ minute: reglageSchema, heure: reglageSchema, note: z.string() });

/** Ce qui s'applique réellement à une fenêtre : le réglage, sinon le défaut ; `null` = aucun plafond (défaut à 0). */
function fenetre(reglage: number | null, defaut: number): { reglage: number | null; defaut: number; effectif: number | null } {
  const effectif = reglage ?? defaut;
  return { reglage, defaut, effectif: effectif > 0 ? effectif : null };
}

function etat(tenantId: string, r: ReglagePlafondApi, defauts: PlafondsParDefaut) {
  return { tenantId, minute: fenetre(r.minute, defauts.minute), heure: fenetre(r.heure, defauts.heure) };
}

export function registerOpsPlafondApi(
  app: FastifyInstance,
  deps: OpsPlafondApiDeps,
  opsToken: string,
  surveillance?: SurveillanceOps,
): void {
  const opts = { preHandler: makeRequireOps(opsToken, surveillance) };

  app.get('/ops/plafond-api/:tenantId', opts, async (req, reply) => {
    const { tenantId } = req.params as { tenantId: string };
    // Un identifiant mal formé partirait dans un `where id = $1` sur une colonne `uuid` : 22P02, donc 500.
    if (!estUuid(tenantId)) return reply.code(404).send({ error: 'espace inconnu' });
    const reglage = await deps.store.lire(tenantId);
    if (reglage === null) return reply.code(404).send({ error: 'espace inconnu' });
    return reply.code(200).send(etat(tenantId, reglage, deps.defauts));
  });

  app.put('/ops/plafond-api/:tenantId', opts, async (req, reply) => {
    const { tenantId } = req.params as { tenantId: string };
    if (!estUuid(tenantId)) return reply.code(404).send({ error: 'espace inconnu' });
    const lu = corpsSchema.safeParse(req.body ?? {});
    if (!lu.success) {
      return reply.code(400).send({
        error: `minute et heure requis : un entier entre 1 et ${MAX_PLAFOND_REGLABLE}, ou null pour le défaut de la configuration`,
      });
    }
    const note = lu.data.note.trim().slice(0, 500);
    if (note.length < MIN_NOTE) return reply.code(400).send({ error: 'note requise : qui règle ce plafond, et pourquoi' });

    const avant = await deps.store.lire(tenantId);
    if (avant === null) return reply.code(404).send({ error: 'espace inconnu' });
    const apres: ReglagePlafondApi = { minute: lu.data.minute, heure: lu.data.heure };
    if (!(await deps.store.ecrire(tenantId, apres))) return reply.code(404).send({ error: 'espace inconnu' });
    // APRÈS l'écriture : vidé avant, le cache pourrait être rempli de l'ancienne valeur par un appel concurrent.
    deps.reglages.invalider(tenantId);
    journaliser('warn', 'ops_plafond_api', { tenantId, avant, apres, note, at: new Date().toISOString() });
    return reply.code(200).send(etat(tenantId, apres, deps.defauts));
  });
}
