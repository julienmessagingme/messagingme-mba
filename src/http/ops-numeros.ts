import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auteurOps, type PreHandler } from '../auth/middleware';
import { journaliser } from '../lib/journal';
import { ErreurDidww, type ClientDidww } from '../didww/client';
import { DidDejaDeclare, type PgNumerosFournisStore } from '../otp/store.pg';
// Le même seuil que les autres écritures de `/ops` : importé, pas recopié.
import { MIN_NOTE } from './ops';

/**
 * LA RÉSERVE DE NUMÉROS FOURNIS DANS /ops (lot 3a, spec `docs/superpowers/specs/2026-10-05-pont-du-code-design.md`, § 3
 * et § 5). Julien achète un numéro chez DIDWW, puis le déclare ici : le serveur le retrouve dans l'inventaire, le
 * branche sur le trunk de l'Asterisk, et l'inscrit `libre`. La lecture montre la réserve et le dernier code capté par
 * numéro, le seul endroit où le voir tant que les lots 3b et 3c n'existent pas.
 *
 * Même autorité que le reste de `/ops` (la session d'exploitation nominative, avec second facteur), même note
 * obligatoire, et la ligne de journal signée de l'adresse de son auteur. Module à part : sans ses dépendances, ces
 * routes ne sont pas montées.
 */

export interface OpsNumerosDeps {
  numeros: Pick<PgNumerosFournisStore, 'declarer' | 'lister'>;
  /** `null` = la clé DIDWW ou le trunk ne sont pas configurés : la déclaration rend 503, la lecture marche. */
  didww: { client: ClientDidww; trunkId: string } | null;
}

const corpsSchema = z.object({ numero: z.string().max(40), note: z.string() });

/** Chiffres seuls, au format `wa_id` : « +44 20 7123 4567 » et « 442071234567 » désignent le même numéro. */
export function numeroEnChiffres(saisie: string): string | null {
  const chiffres = saisie.replace(/[\s().+-]/g, '');
  return /^[1-9][0-9]{6,14}$/.test(chiffres) ? chiffres : null;
}

export function registerOpsNumeros(app: FastifyInstance, deps: OpsNumerosDeps, garde: PreHandler): void {
  const opts = { preHandler: garde };

  app.get('/ops/numeros-fournis', opts, async (_req, reply) => {
    const numeros = await deps.numeros.lister();
    return reply.code(200).send({
      configure: deps.didww !== null,
      libres: numeros.filter((n) => n.statut === 'libre').length,
      numeros,
    });
  });

  app.post('/ops/numeros-fournis', opts, async (req, reply) => {
    const lu = corpsSchema.safeParse(req.body ?? {});
    if (!lu.success) return reply.code(400).send({ error: 'numero et note requis' });
    const numero = numeroEnChiffres(lu.data.numero);
    if (numero === null) return reply.code(400).send({ error: 'numéro invalide : l’indicatif pays puis le numéro, par exemple +44 20 7123 4567' });
    const note = lu.data.note.trim().slice(0, 500);
    if (note.length < MIN_NOTE) return reply.code(400).send({ error: 'note requise : d’où vient ce numéro' });
    if (deps.didww === null) return reply.code(503).send({ error: 'DIDWW n’est pas configuré sur ce serveur (clé ou trunk absent)' });

    // 4xx, jamais 5xx : Cloudflare remplacerait le corps, et l'opérateur ne saurait pas ce que DIDWW a refusé.
    let did;
    try {
      did = await deps.didww.client.trouverDid(numero);
    } catch (err) {
      journaliser('error', 'ops_numero_didww_illisible', { err, numero });
      return reply.code(422).send({ error: err instanceof ErreurDidww ? err.message : 'DIDWW injoignable' });
    }
    if (did === null) return reply.code(404).send({ error: 'ce numéro n’est pas dans l’inventaire DIDWW : l’acheter d’abord' });
    try {
      await deps.didww.client.brancher(did.id, deps.didww.trunkId);
    } catch (err) {
      journaliser('error', 'ops_numero_non_branche', { err, numero, didId: did.id });
      return reply.code(422).send({ error: err instanceof ErreurDidww ? err.message : 'branchement refusé par DIDWW' });
    }
    try {
      const r = await deps.numeros.declarer(numero, did.id);
      journaliser('warn', 'ops_numero_declare', { numero, didId: did.id, cree: r.cree, par: auteurOps(req), note, at: new Date().toISOString() });
      return reply.code(r.cree ? 201 : 200).send({ numero: r.numero, cree: r.cree });
    } catch (err) {
      if (err instanceof DidDejaDeclare) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });
}
