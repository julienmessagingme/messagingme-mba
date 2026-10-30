import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auteurOps, type PreHandler } from '../auth/middleware';
import { journaliser } from '../lib/journal';
import { lireGrilleCsv } from '../credit-whatsapp/grille-csv';
import type { ChargementGrille, ResumeGrille } from '../credit-whatsapp/reglages.pg';
import type { GrilleMeta } from '../credit-whatsapp/grille';
import type { LigneCredit, NumeroPourLaLigne } from '../credit-whatsapp/lignes.pg';
import type { ProvisionVue } from '../credit-whatsapp/credit';
import { makeTraceOps, type AuditSink } from '../audit/journal';
import { estUuid } from './scope';
// Le même seuil et la même signature que les autres écritures de `/ops` : importés, pas recopiés.
import { MIN_NOTE, noteSignee } from './ops';

/**
 * LES RÉGLAGES DU CRÉDIT WHATSAPP DANS `/ops` (plan du Crédit WhatsApp, tâche 2) : la grille de Meta, chargée depuis le
 * fichier en euros que Meta publie, et la commission des messages. Même autorité que la grille de prix (la session
 * d'exploitation), même note obligatoire, même ligne de journal signée de son auteur. Montées avec `/ops`
 * (`src/server.ts`), sous la même garde. Depuis la tâche 8, un numéro d'un espace s'y pose sur la ligne ou s'en retire à
 * la main (un numéro d'essai avant l'option du lot 2), tracé dans le journal de l'espace.
 */
export interface OpsCreditWhatsappDeps {
  reglages: {
    resumeGrille(): Promise<ResumeGrille | null>;
    /** La grille que la garde lit : sans elle, tout envoi d'un numéro de la ligne est refusé. */
    grilleEnVigueur(): Promise<GrilleMeta | null>;
    chargerGrille(c: ChargementGrille): Promise<string>;
    commission(): Promise<number>;
    reglerCommission(pct: number, par: string): Promise<void>;
  };
  lignes: {
    numeroDeLEspace(tenantId: string, phoneNumberId: string): Promise<NumeroPourLaLigne | null>;
    lignesDeLEspace(tenantId: string): Promise<LigneCredit[]>;
    poser(tenantId: string, phoneNumberId: string, wabaId: string | null, origine: 'ops', note: string): Promise<boolean>;
    retirer(tenantId: string, phoneNumberId: string): Promise<boolean>;
  };
  /** Le journal des actions de l'espace : le numéro posé ou retiré, l'exploitant pour acteur. */
  audit: AuditSink;
  /** Le solde et les dernières provisions de l'espace, montrés avec ses lignes (l'essai réel du lot 1). */
  credit: {
    solde(tenantId: string): Promise<number>;
    dernieresProvisions(tenantId: string, n?: number): Promise<ProvisionVue[]>;
  };
}

const CORPS_GRILLE = z.object({
  csv: z.string().min(1).max(500_000),
  enVigueurLe: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  note: z.string(),
}).strict();

const CORPS_COMMISSION = z.object({
  commissionPct: z.number().int().min(0).max(100),
  note: z.string(),
}).strict();

/** Un identifiant de numéro de Meta : des chiffres. */
const CORPS_LIGNE = z.object({
  phoneNumberId: z.string().regex(/^[0-9]{5,32}$/),
  poser: z.boolean(),
  note: z.string(),
}).strict();

/** Une date du calendrier, vraie : '2026-02-30' a la bonne forme et n'existe pas. */
function dateValide(jour: string): boolean {
  const d = new Date(`${jour}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === jour;
}

export function registerOpsCreditWhatsapp(app: FastifyInstance, deps: OpsCreditWhatsappDeps, garde: PreHandler): void {
  const opts = { preHandler: garde };
  const tracer = makeTraceOps(deps.audit);
  /** Ce que la fenêtre de l'offre montre d'un espace : ses numéros sur la ligne, son solde, ses dernières provisions. */
  const vue = async (tenantId: string) => {
    const [lignes, soldeMicroEur, provisions] = await Promise.all([
      deps.lignes.lignesDeLEspace(tenantId), deps.credit.solde(tenantId), deps.credit.dernieresProvisions(tenantId, 50),
    ]);
    return { tenantId, lignes, soldeMicroEur, provisions };
  };

  app.get('/ops/credit-whatsapp/reglages', opts, async (_req, reply) => {
    const [grille, commissionPct] = await Promise.all([deps.reglages.resumeGrille(), deps.reglages.commission()]);
    return reply.code(200).send({ grille, commissionPct });
  });

  /**
   * Charger la grille de Meta. Le fichier est lu ICI, une seule lecture pour toutes les copies : il refuse au lieu de
   * deviner, et la réponse nomme la ligne fautive. 🔴 Note obligatoire : d'où vient ce fichier, et pourquoi maintenant.
   */
  app.put('/ops/credit-whatsapp/grille', opts, async (req, reply) => {
    const c = CORPS_GRILLE.safeParse(req.body);
    if (!c.success) return reply.code(400).send({ error: 'corps invalide : le fichier (csv), la date d’entrée en vigueur (AAAA-MM-JJ) et une note sont attendus' });
    const note = c.data.note.trim().slice(0, 500);
    if (note.length < MIN_NOTE) return reply.code(400).send({ error: 'note requise : d’où vient cette grille' });
    if (!dateValide(c.data.enVigueurLe)) return reply.code(400).send({ error: 'date d’entrée en vigueur invalide' });
    const lue = lireGrilleCsv(c.data.csv);
    if (!lue.ok) return reply.code(400).send({ error: lue.erreur });
    const par = auteurOps(req);
    const id = await deps.reglages.chargerGrille({ enVigueurLe: c.data.enVigueurLe, tarifs: lue.tarifs, auteur: par, note });
    journaliser('warn', 'ops_grille_meta', { id, enVigueurLe: c.data.enVigueurLe, tarifs: lue.tarifs.length, par, note });
    return reply.code(200).send({ grille: await deps.reglages.resumeGrille() });
  });

  /** La commission des messages, une pour tous les espaces (l'Entreprise négocie la sienne avec son offre). */
  app.put('/ops/credit-whatsapp/commission', opts, async (req, reply) => {
    const c = CORPS_COMMISSION.safeParse(req.body);
    if (!c.success) return reply.code(400).send({ error: 'commission invalide : un entier de 0 à 100, et une note' });
    const note = c.data.note.trim().slice(0, 500);
    if (note.length < MIN_NOTE) return reply.code(400).send({ error: 'note requise : pourquoi ce changement de commission' });
    const par = auteurOps(req);
    await deps.reglages.reglerCommission(c.data.commissionPct, noteSignee(par, note));
    journaliser('warn', 'ops_commission_messages', { commissionPct: c.data.commissionPct, par, note });
    return reply.code(200).send({ commissionPct: c.data.commissionPct });
  });

  app.get('/ops/credit-whatsapp/ligne/:tenantId', opts, async (req, reply) => {
    const { tenantId } = req.params as { tenantId: string };
    if (!estUuid(tenantId)) return reply.code(404).send({ error: 'espace inconnu' });
    return reply.code(200).send(await vue(tenantId));
  });

  /**
   * Poser un numéro de l'espace sur la ligne, ou l'en retirer. 🔴 Le numéro à poser est lu DANS l'espace
   * (`numeroDeLEspace`) : celui d'un autre espace rend 404, comme un inconnu. Ne passent pas sur la ligne : un numéro
   * 360dialog (facturé chez 360dialog, la garde ne le voit pas), un numéro en coexistence (l'application WhatsApp Business
   * envoie sans nous, donc sans provision), un numéro délié (il n'envoie plus rien), et aucun numéro tant qu'aucune grille
   * de Meta n'est en vigueur (la garde refuserait tous ses envois). Retirer ne lit que la ligne en cours de l'espace : un
   * numéro déconnecté depuis, ou relié à un autre espace, se retire encore.
   */
  app.post('/ops/credit-whatsapp/ligne/:tenantId', opts, async (req, reply) => {
    const { tenantId } = req.params as { tenantId: string };
    if (!estUuid(tenantId)) return reply.code(404).send({ error: 'espace inconnu' });
    const c = CORPS_LIGNE.safeParse(req.body);
    if (!c.success) return reply.code(400).send({ error: 'corps invalide : phoneNumberId (l’identifiant Meta du numéro), poser (booléen) et une note sont attendus' });
    const note = c.data.note.trim().slice(0, 500);
    if (note.length < MIN_NOTE) return reply.code(400).send({ error: 'note requise : pourquoi ce numéro' });
    const { phoneNumberId, poser } = c.data;
    const par = auteurOps(req);
    if (poser) {
      const numero = await deps.lignes.numeroDeLEspace(tenantId, phoneNumberId);
      if (numero === null) return reply.code(404).send({ error: 'numéro inconnu dans cet espace' });
      if (numero.fournisseur !== 'meta') return reply.code(409).send({ error: 'un numéro 360dialog ne passe pas sur la ligne : ses messages sont facturés chez 360dialog' });
      if (numero.coexistence) return reply.code(409).send({ error: 'un numéro en coexistence ne passe pas sur la ligne : l’application WhatsApp Business envoie sans passer par nous' });
      if (numero.delie) return reply.code(409).send({ error: 'numéro délié : il n’envoie plus rien, rien à mettre sur la ligne' });
      if ((await deps.reglages.grilleEnVigueur()) === null) {
        return reply.code(409).send({ error: 'aucune grille de Meta en vigueur : chargez-la avant de poser un numéro sur la ligne' });
      }
      if (!(await deps.lignes.poser(tenantId, phoneNumberId, numero.wabaId, 'ops', noteSignee(par, note)))) {
        return reply.code(409).send({ error: 'numéro déjà sur la ligne' });
      }
    } else if (!(await deps.lignes.retirer(tenantId, phoneNumberId))) {
      return reply.code(404).send({ error: 'numéro pas sur la ligne de cet espace' });
    }
    journaliser('warn', 'ops_ligne_credit_whatsapp', { tenantId, phoneNumberId, poser, par, note });
    await tracer(tenantId, par, poser ? 'ops.ligne_credit_posee' : 'ops.ligne_credit_retiree', { phoneNumberId });
    return reply.code(200).send(await vue(tenantId));
  });
}
