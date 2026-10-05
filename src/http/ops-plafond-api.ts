import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auteurOps, type PreHandler } from '../auth/middleware';
import { estUuid } from './scope';
import { journaliser } from '../lib/journal';
import type { PlafondApiStore, PlafondsParDefaut, ReglagePlafondApi } from '../auth/plafond-espace';
// Le même seuil que les autres écritures de `/ops` : importé, pas recopié.
import { MIN_NOTE } from './ops';

/**
 * Le réglage du plafond de l'API d'un espace, et de ses quotas quotidiens (envois, fiches ; `src/api/quotas.ts`).
 * 🔴 Dans `/ops` et nulle part ailleurs : un plafond que le client écrirait lui-même n'en serait pas un. Même
 * autorité que le rechargement de crédit (la session d'exploitation), même note obligatoire (le pourquoi), et
 * la ligne de journal signée de l'adresse de son auteur. Module à part : sans ses dépendances (magasin, cache du
 * limiteur), ces routes ne sont pas montées et le limiteur applique les défauts.
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
}


/** La borne haute d'un réglage : celle de la colonne `integer`. Au-delà, l'écriture lèverait, donc un 500. */
export const MAX_PLAFOND_REGLABLE = 2_147_483_647;

const reglageSchema = z.number().int().min(1).max(MAX_PLAFOND_REGLABLE).nullable();
/**
 * Les quatre réglages sont requis, `null` compris : un champ absent lu tantôt « inchangé », tantôt « défaut »
 * remettrait un client au défaut par accident. L'opérateur relit l'état par le `GET` et écrit les quatre.
 */
const corpsSchema = z.object({
  minute: reglageSchema, heure: reglageSchema, envoisJour: reglageSchema, fichesJour: reglageSchema, note: z.string(),
});

/** Ce qui s'applique réellement à une fenêtre : le réglage, sinon le défaut ; `null` = aucun plafond (défaut à 0). */
function fenetre(reglage: number | null, defaut: number): { reglage: number | null; defaut: number; effectif: number | null } {
  const effectif = reglage ?? defaut;
  return { reglage, defaut, effectif: effectif > 0 ? effectif : null };
}

function etat(tenantId: string, r: ReglagePlafondApi, defauts: PlafondsParDefaut) {
  return {
    tenantId,
    minute: fenetre(r.minute, defauts.minute),
    heure: fenetre(r.heure, defauts.heure),
    envoisJour: fenetre(r.envoisJour, defauts.envoisJour),
    fichesJour: fenetre(r.fichesJour, defauts.fichesJour),
  };
}

/** `garde` : la garde d'exploitation, la même instance que celle de `/ops` (`buildServer`). */
export function registerOpsPlafondApi(app: FastifyInstance, deps: OpsPlafondApiDeps, garde: PreHandler): void {
  const opts = { preHandler: garde };

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
        error: `minute, heure, envoisJour et fichesJour requis : un entier entre 1 et ${MAX_PLAFOND_REGLABLE}, ou null pour le défaut de la configuration`,
      });
    }
    const note = lu.data.note.trim().slice(0, 500);
    if (note.length < MIN_NOTE) return reply.code(400).send({ error: 'note requise : pourquoi ce plafond ou ce quota' });

    const avant = await deps.store.lire(tenantId);
    if (avant === null) return reply.code(404).send({ error: 'espace inconnu' });
    const apres: ReglagePlafondApi = { minute: lu.data.minute, heure: lu.data.heure, envoisJour: lu.data.envoisJour, fichesJour: lu.data.fichesJour };
    if (!(await deps.store.ecrire(tenantId, apres))) return reply.code(404).send({ error: 'espace inconnu' });
    // Après l'écriture : posé avant, un échec d'écriture laisserait le limiteur appliquer un réglage inexistant.
    deps.reglages.poser(tenantId, apres);
    journaliser('warn', 'ops_plafond_api', { tenantId, avant, apres, par: auteurOps(req), note, at: new Date().toISOString() });
    return reply.code(200).send(etat(tenantId, apres, deps.defauts));
  });
}
