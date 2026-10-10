import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auteurOps, type PreHandler } from '../auth/middleware';
import { estUuid } from './scope';
import { journaliser } from '../lib/journal';
import type { EcritureEntreprise, ReglageEntreprise } from '../offres/offre.pg';
// Le même seuil que les autres écritures de `/ops` : importé, pas recopié.
import { MIN_NOTE } from './ops';
import { makeTraceOps, type AuditSink } from '../audit/journal';

/**
 * L'ENTREPRISE D'UN ESPACE, POSÉE PAR L'EXPLOITATION (lot 6, tâche 6, spec § 3). L'Entreprise est sur devis : elle ne
 * s'achète pas en ligne, elle se pose ici après signature, avec sa limite d'utilisateurs et sa conservation des
 * conversations. 🔴 Dans `/ops` et nulle part ailleurs, avec la même autorité (la session d'exploitation), la même note
 * obligatoire et la ligne de journal signée de son auteur que le plafond de l'API. Sert aussi à ramener un espace
 * d'essai en Base.
 */
export interface OpsOffreDeps {
  store: {
    lireEntreprise(tenantId: string): Promise<ReglageEntreprise | null>;
    ecrireEntreprise(tenantId: string, r: EcritureEntreprise): Promise<boolean>;
  };
  /** Le cache de l'offre de CE process : l'espace change d'offre tout de suite ici, en moins de 30 s ailleurs. */
  invalider(tenantId: string): void;
  /** Le journal des actions de l'espace (lot 5) : l'offre posée, avant et après, l'exploitant pour acteur. */
  audit: AuditSink;
}

/** 10 utilisateurs proposés à l'écran ; la route accepte toute limite positive, ou `null` (sans limite). */
export const UTILISATEURS_ENTREPRISE_PROPOSES = 10;

/**
 * L'offre et les utilisateurs sont requis, `null` compris, comme pour le plafond de l'API. 🔴 La conservation, elle, est
 * FACULTATIVE et ABSENTE = INCHANGÉE (relecture finale du lot 6) : requise, elle était réécrite à chaque changement
 * d'offre, et ramener un espace en Base avec une valeur basse lançait la purge irréversible de ses conversations. Elle va
 * de 0 (jamais purgée) à 3650 jours, les bornes de `conversation_retention_days` ; `null` = le défaut de l'instance.
 */
const corpsSchema = z.object({
  entreprise: z.boolean(),
  utilisateurs: z.number().int().min(1).max(10_000).nullable(),
  conservationJours: z.number().int().min(0).max(3650).nullable().optional(),
  note: z.string(),
}).strict();

/** `garde` : la garde d'exploitation, la même instance que celle de `/ops` (`buildServer`). */
export function registerOpsOffre(app: FastifyInstance, deps: OpsOffreDeps, garde: PreHandler): void {
  const opts = { preHandler: garde };
  const tracer = makeTraceOps(deps.audit);

  app.get('/ops/offre/:tenantId', opts, async (req, reply) => {
    const { tenantId } = req.params as { tenantId: string };
    if (!estUuid(tenantId)) return reply.code(404).send({ error: 'espace inconnu' });
    const r = await deps.store.lireEntreprise(tenantId);
    if (r === null) return reply.code(404).send({ error: 'espace inconnu' });
    return reply.code(200).send({ tenantId, ...r, utilisateursProposes: UTILISATEURS_ENTREPRISE_PROPOSES });
  });

  app.put('/ops/offre/:tenantId', opts, async (req, reply) => {
    const { tenantId } = req.params as { tenantId: string };
    if (!estUuid(tenantId)) return reply.code(404).send({ error: 'espace inconnu' });
    const lu = corpsSchema.safeParse(req.body ?? {});
    if (!lu.success) {
      return reply.code(400).send({
        error: 'entreprise (booléen) et utilisateurs (entier positif ou null) requis, avec une note ; conservationJours (0 à 3650, ou null) facultatif, absent = inchangé',
      });
    }
    const note = lu.data.note.trim().slice(0, 500);
    if (note.length < MIN_NOTE) return reply.code(400).send({ error: 'note requise : pourquoi cette offre' });

    const avant = await deps.store.lireEntreprise(tenantId);
    if (avant === null) return reply.code(404).send({ error: 'espace inconnu' });
    const ecriture: EcritureEntreprise = {
      entreprise: lu.data.entreprise, utilisateurs: lu.data.utilisateurs,
      ...(lu.data.conservationJours !== undefined ? { conservationJours: lu.data.conservationJours } : {}),
    };
    if (!(await deps.store.ecrireEntreprise(tenantId, ecriture))) return reply.code(404).send({ error: 'espace inconnu' });
    // L'état RELU, pour la réponse et la trace : une conservation absente n'a pas été écrite.
    const apres: ReglageEntreprise = (await deps.store.lireEntreprise(tenantId)) ?? { ...ecriture, conservationJours: avant.conservationJours };
    deps.invalider(tenantId);
    journaliser('warn', 'ops_offre', { tenantId, avant, apres, par: auteurOps(req), note, at: new Date().toISOString() });
    await tracer(tenantId, auteurOps(req), 'ops.offre_posee', {
      entreprise: apres.entreprise, utilisateurs: apres.utilisateurs, conservationJours: apres.conservationJours,
      entrepriseAvant: avant.entreprise, utilisateursAvant: avant.utilisateurs, conservationJoursAvant: avant.conservationJours,
    });
    return reply.code(200).send({ tenantId, ...apres, utilisateursProposes: UTILISATEURS_ENTREPRISE_PROPOSES });
  });
}
