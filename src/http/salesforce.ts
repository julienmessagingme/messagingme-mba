import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { gardeEtendue, type Guard, type PreHandler } from '../auth/middleware';
import { makeJournal, type AuditSink } from '../audit/journal';
import { espaceVerifie } from './scope';
import type { IssueConnexion, IssueDeconnexion } from '../salesforce/connexion';
import type { ReglagesSalesforce, VueOrgSalesforce } from '../salesforce/store.pg';

/**
 * PARAMÈTRES > INTÉGRATIONS > SALESFORCE (plan 2026-09-26, lot L1) : l'interrupteur de l'espace, la connexion de
 * l'org, ses réglages, la déconnexion.
 *
 * 🔴 RÉSERVÉ AUX ADMINS, LECTURE COMPRISE (monté sous `g.admin`) : relier une org fait sortir des données de
 * contacts de l'espace vers le système du client, c'est une décision de la marque.
 *
 * 🔴 UN REFUS NE SORT JAMAIS EN 5xx NI EN 401. Cloudflare remplacerait le corps d'un 5xx (l'admin ne lirait pas ce
 * qui manque), et la console viderait la session sur un 401. Un manque ou une panne passagère de Salesforce
 * sortent en 422, avec les étapes du guide ; une configuration absente de l'instance, en 503 lisible, comme les
 * autres intégrations.
 *
 * ⚠️ L'INTERRUPTEUR VIT ICI, PAS DANS `settings.ts` : la carte lit tout par cette route, et l'intégration n'a rien
 * à demander au module des réglages. La colonne, elle, est dans `tenant_settings` (0183), réglage de l'espace.
 *
 * 🔴 LE SECRET NE REVIENT JAMAIS : ni dans une réponse, ni dans le journal d'audit. Il est tiré, chiffré et posé par
 * la connexion (`src/salesforce/connexion.ts`) ; cette route n'en voit pas la couleur.
 */
export interface SalesforceRouteDeps {
  /** L'org reliée de l'espace. */
  orgs: {
    lire(tenantId: string): Promise<VueOrgSalesforce | null>;
    enregistrerReglages(tenantId: string, r: ReglagesSalesforce): Promise<boolean>;
  };
  /** L'interrupteur Salesforce de l'espace. */
  reglages: {
    salesforceActif(tenantId: string): Promise<boolean>;
    setSalesforceActif(tenantId: string, actif: boolean): Promise<void>;
  };
  connecter(tenantId: string, adresse: string, auteurId: string | null): Promise<IssueConnexion>;
  deconnecter(tenantId: string): Promise<IssueDeconnexion>;
  /** La clé d'app (`SALESFORCE_CLIENT_ID` et `_SECRET`) est posée sur l'instance. Calculé une fois au câblage. */
  cleAppPosee: boolean;
  /** `ENCRYPTION_KEY` sait chiffrer. Sans elle, aucun secret d'org ne peut être gardé. Sondé au câblage. */
  chiffrementPret: boolean;
  /** Construits par le câblage depuis la version publiée du package ; `null` tant qu'elle ne l'est pas. */
  liensInstallation: { production: string; sandbox: string } | null;
  audit: AuditSink;
}

/** La cible d'audit nomme l'outil : décision de Julien du 2026-09-26 (le journal nomme l'outil, Batch compris). */
const CIBLE = { kind: 'integration', id: 'salesforce' };

const corpsActif = z.object({ actif: z.boolean() }).strict();
const corpsConnexion = z.object({ adresse: z.string().trim().min(1).max(300) }).strict();
const consentement = z.object({
  champ: z.string().trim().min(1).max(80),
  valeurOui: z.string().trim().min(1).max(255).nullable(),
  valeurNon: z.string().trim().min(1).max(255).nullable(),
}).strict().nullable();
const corpsReglages = z.object({
  consentementLead: consentement,
  consentementContact: consentement,
  envoyerResume: z.boolean(),
  proprietaireRepli: z.string().regex(/^(005|00G)[0-9A-Za-z]{15}$/, 'identifiant d’utilisateur ou de file Salesforce attendu').nullable(),
}).strict();

const raisonCorps = (e: z.ZodError): string => {
  const i = e.issues[0];
  return `${i && i.path.length > 0 ? i.path.join('.') : 'corps'} : ${i?.message ?? 'invalide'}`;
};

export function registerSalesforce(app: FastifyInstance, deps: SalesforceRouteDeps, garde: Guard, limiteCouteuse?: PreHandler): void {
  const opts = { preHandler: garde };
  // La connexion appelle Salesforce plusieurs fois, et tire un secret : sous le plafond des routes coûteuses.
  const optsLourds = gardeEtendue(garde, limiteCouteuse);
  const journal = makeJournal(deps.audit);

  const vue = async (tenant: string) => ({
    actif: await deps.reglages.salesforceActif(tenant),
    cleAppPosee: deps.cleAppPosee,
    chiffrementPret: deps.chiffrementPret,
    liensInstallation: deps.liensInstallation,
    org: await deps.orgs.lire(tenant),
  });

  app.get('/tenants/:tenantId/integrations/salesforce', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    return reply.code(200).send(await vue(tenant));
  });

  app.patch('/tenants/:tenantId/integrations/salesforce/actif', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const corps = corpsActif.safeParse(req.body ?? {});
    if (!corps.success) return reply.code(400).send({ error: raisonCorps(corps.error) });
    // 🔴 Éteindre par-dessus une org reliée mentirait : elle continuerait de recevoir. Le refus se dit AVANT.
    if (!corps.data.actif && (await deps.orgs.lire(tenant)) !== null) {
      return reply.code(409).send({ error: 'Une org Salesforce est reliée : déconnectez-la d’abord pour éteindre Salesforce.' });
    }
    await deps.reglages.setSalesforceActif(tenant, corps.data.actif);
    await journal(tenant, req, corps.data.actif ? 'salesforce.allumee' : 'salesforce.eteinte', CIBLE);
    return reply.code(200).send({ salesforceActif: corps.data.actif });
  });

  app.post('/tenants/:tenantId/integrations/salesforce/connexion', optsLourds, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const corps = corpsConnexion.safeParse(req.body ?? {});
    if (!corps.success) return reply.code(400).send({ error: raisonCorps(corps.error) });
    if (!deps.cleAppPosee) return reply.code(503).send({ error: 'L’app Salesforce n’est pas configurée sur cette instance.' });
    if (!deps.chiffrementPret) return reply.code(503).send({ error: 'Le chiffrement des secrets n’est pas configuré sur cette instance : impossible de relier une org.' });
    if (!(await deps.reglages.salesforceActif(tenant))) return reply.code(409).send({ error: 'Allumez d’abord Salesforce pour cet espace.' });
    const issue = await deps.connecter(tenant, corps.data.adresse, req.auth?.userId ?? null);
    if (issue.ok) {
      await journal(tenant, req, 'salesforce.connectee', CIBLE, { orgId: issue.orgId, sandbox: issue.sandbox });
      return reply.code(200).send(issue);
    }
    if ('passager' in issue) return reply.code(422).send({ error: issue.message, passager: true });
    return reply.code(422).send({ error: issue.manques[0]?.message ?? 'Connexion impossible.', manques: issue.manques });
  });

  app.put('/tenants/:tenantId/integrations/salesforce/reglages', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const corps = corpsReglages.safeParse(req.body ?? {});
    if (!corps.success) return reply.code(400).send({ error: raisonCorps(corps.error) });
    if (!(await deps.orgs.enregistrerReglages(tenant, corps.data))) {
      return reply.code(404).send({ error: 'Aucune org Salesforce n’est reliée à cet espace.' });
    }
    await journal(tenant, req, 'salesforce.modifiee', CIBLE, {
      consentementLead: corps.data.consentementLead?.champ ?? null,
      consentementContact: corps.data.consentementContact?.champ ?? null,
      envoyerResume: corps.data.envoyerResume,
    });
    return reply.code(200).send(await vue(tenant));
  });

  app.delete('/tenants/:tenantId/integrations/salesforce', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const issue = await deps.deconnecter(tenant);
    if (!issue.ok) return reply.code(404).send({ error: 'Aucune org Salesforce n’est reliée à cet espace.' });
    await journal(tenant, req, 'salesforce.deconnectee', CIBLE, { effaceDansOrg: issue.effaceDansOrg });
    return reply.code(200).send({ effaceDansOrg: issue.effaceDansOrg });
  });
}
