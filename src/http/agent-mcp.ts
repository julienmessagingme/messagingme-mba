import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { gardeEtendue, type Guard, type PreHandler } from '../auth/middleware';
import { LabelSourceDejaPris } from '../agent/sources';
import type { RisqueOutil } from '../agent/catalog';
import type { SourceParam } from '../agent/llm/tool-schema';
import type { RafraichissementMcp } from '../agent/mcp/rafraichissement';
import { CHAMPS_CONTACT_AUTORISES, estChampContact } from '../agent/champs-contact';
import { adresseAcceptable, authCoherente, hoteDe } from './agent-sources';
import { espaceVerifie, estUuid } from './scope';
import { makeJournal, type AuditSink } from '../audit/journal';

/**
 * Les connecteurs MCP : prévisualiser et importer le catalogue d'un serveur, régler ce qu'on en expose. Un serveur MCP est
 * une adresse que notre serveur appelle, un secret, et un catalogue d'outils écrit par un tiers dont les
 * descriptions entrent dans le contexte du modèle. Trois gardes :
 *  1. 🔴 l'adresse est vérifiée à l'écriture comme à l'appel, par la même fonction ;
 *  2. l'import montre avant d'écrire : `apercu` rend le plan, suppressions comprises ;
 *  3. un clouage désigne un champ qui existe.
 * La traduction d'une annonce en outil vit dans `src/agent/mcp/import.ts`, pure et testable.
 */

/** Un serveur MCP tel que l'écran le voit. Le secret n'y est pas, et il ne doit jamais y entrer. */
export interface ServeurMcpVue {
  id: string;
  label: string;
  baseUrl: string;
  authKind: 'none' | 'bearer' | 'header';
  authHeaderName: string | null;
  status: string;
  lastOkAt: string | null;
  lastError: string | null;
}

/**
 * Un outil importé, tel que l'écran le montre. `annonce` part au client : c'est le schéma annoncé par le serveur,
 * sans secret, la seule chose qu'il puisse montrer à son fournisseur quand un outil est refusé.
 */
export interface OutilMcpVue {
  id: string;
  name: string;
  nomDistant: string;
  title: string;
  description: string;
  nePasUtiliser: string;
  params: Array<{ name: string; type: string; source: SourceParam; required?: boolean; description?: string; cle?: string; contactPath?: string; value?: string | number | boolean; cheminMcp?: string }>;
  risk: RisqueOutil;
  annonce: unknown;
  /** `null` = activable. Sinon la raison, affichée telle quelle. */
  nonActivable: string | null;
  indisponibleLe: string | null;
  consommateursActifs: number;
  /** Proposé aux agents de l'espace (0199) : décoché, il ne s'offre à aucun agent. */
  propose: boolean;
  /** Les agents qui l'ont (rattaché, actif ou non), par leur nom : « Agent de Meta », le nom d'un agent IA. */
  utilisePar: string[];
}

/** Ce que les routes lisent et écrivent des serveurs MCP et de leurs outils importés. */
export interface McpDep {
  listerServeurs(tenantId: string): Promise<ServeurMcpVue[]>;
  /**
   * Supprime un serveur MCP. Trois états, pas un booléen : « supprimé », « introuvable » et « outils actifs »
   * (409) doivent se distinguer, sinon un serveur utilisé se supprimerait avec ses outils et consentements.
   */
  supprimerServeur(tenantId: string, id: string): Promise<'supprime' | 'introuvable' | 'outils_actifs'>;
  /** Les outils importés, pour l'écran. Séparée de la lecture d'import, qui compare et rien de plus. */
  outilsPourEcran(tenantId: string, sourceId: string): Promise<OutilMcpVue[]>;
  /** Le réglage d'un outil importé. Rend `false` si l'outil n'est pas de cet espace. */
  reglerOutil(tenantId: string, outilId: string, patch: {
    params?: Array<{ name: string; source: SourceParam; cle?: string; contactPath?: string; value?: string | number | boolean }>;
    risk?: RisqueOutil;
    nePasUtiliser?: string;
  }): Promise<boolean>;
  /**
   * Proposer ou retirer un outil aux agents de l'espace. Retirer est refusé tant qu'un agent l'a : le refus rend
   * leurs noms. `null` = outil introuvable dans cet espace.
   */
  proposer(tenantId: string, outilId: string, propose: boolean): Promise<{ ok: true } | { utilisePar: string[] } | null>;
}

export interface AgentMcpRouteDeps {
  /**
   * Journal d'audit (les fixtures qui ne l'observent pas passent `journalMuet`). Un serveur MCP est une sortie de
   * l'espace, comme un connecteur API : le supprimer emporte par cascade ses outils et leurs consentements.
   * 🔴 Le `detail` ne porte jamais le secret ni l'adresse complète : seulement le mode d'authentification et l'hôte.
   */
  audit: AuditSink;
  mcp: McpDep;
  /** Le cycle distant et transactionnel de l'aperçu et de l'import. */
  rafraichissement: RafraichissementMcp;
  /**
   * Déclare un serveur MCP : seul chemin qui écrit `kind = 'mcp'` (la route des connecteurs API écrit
   * `kind: 'http'`).
   */
  creerServeur(tenantId: string, input: {
    label: string; baseUrl: string;
    authKind: 'none' | 'bearer' | 'header'; authHeaderName?: string; authSecret?: string;
  }): Promise<ServeurMcpVue>;
  /** Les clés des champs personnalisés déclarés par l'espace : un clouage doit en désigner une. */
  clesDeChamps(tenantId: string): Promise<string[]>;
}

const creationSchema = z.object({
  label: z.string().trim().min(1).max(80),
  /** L'adresse du point MCP : une adresse unique, pas une racine sous laquelle on compose des chemins. */
  baseUrl: z.string().trim().min(1).max(500),
  authKind: z.enum(['none', 'bearer', 'header']),
  authHeaderName: z.string().trim().regex(/^[A-Za-z0-9-]{1,64}$/).optional(),
  authSecret: z.string().trim().min(1).max(500).optional(),
});

const CLE_CHAMP = z.string().trim().min(1).max(64);
const reglageSchema = z.object({
  risk: z.enum(['read', 'write', 'irreversible']).optional(),
  nePasUtiliser: z.string().trim().max(2000).optional(),
  params: z.array(z.object({
    name: z.string().trim().min(1).max(64),
    source: z.enum(['modele', 'contact', 'champ', 'fixe']),
    cle: CLE_CHAMP.optional(),
    contactPath: z.string().trim().min(1).max(64).optional(),
    value: z.union([z.string().max(500), z.number(), z.boolean()]).optional(),
  })).max(100).optional(),
});

const proposeSchema = z.object({ propose: z.boolean() }).strict();

export function registerAgentMcp(
  app: FastifyInstance,
  deps: AgentMcpRouteDeps,
  garde: Guard,
  limiteCouteuse?: PreHandler,
): void {
  const opts = { preHandler: garde };
  const journal = makeJournal(deps.audit);
  // L'aperçu et l'import sont lourds (session vers un serveur tiers, catalogue paginé) : ils portent
  // `RATE_LIMIT_COUTEUX_PAR_MINUTE`, comme l'import CSV et l'aperçu d'un site.
  const lourd = gardeEtendue(garde, limiteCouteuse);

  app.get('/tenants/:tenantId/mcp', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    return reply.code(200).send({ serveurs: await deps.mcp.listerServeurs(tenant) });
  });

  /**
   * Déclarer un serveur MCP. L'adresse est validée à l'écriture, par la même fonction que les connecteurs API.
   * Le secret est chiffré par le store, jamais ici.
   */
  app.post('/tenants/:tenantId/mcp', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const parse = creationSchema.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'libellé, adresse et mode d’authentification requis' });
    const { label, baseUrl, authKind, authHeaderName, authSecret } = parse.data;
    if (!adresseAcceptable(baseUrl)) {
      return reply.code(400).send({ error: 'adresse refusée : elle doit être publique et en HTTPS' });
    }
    const pb = authCoherente(authKind, authSecret, authHeaderName);
    if (pb) return reply.code(400).send({ error: pb });
    /**
     * Un libellé déjà pris rend 409, pas 500 : l'index unique `(tenant_id, lower(label))` porte sur tous les
     * `kind`, connecteurs API compris.
     */
    let serveur: ServeurMcpVue;
    try {
      serveur = await deps.creerServeur(tenant, {
        label, baseUrl, authKind,
        ...(authHeaderName ? { authHeaderName } : {}),
        ...(authSecret ? { authSecret } : {}),
      });
    } catch (err) {
      if (err instanceof LabelSourceDejaPris) {
        return reply.code(409).send({ error: `le nom « ${label} » est déjà pris par un autre connecteur` });
      }
      throw err;
    }
    await journal(tenant, req, 'connecteur.cree', { kind: 'connecteur', id: serveur.id }, {
      mcp: true, authKind: parse.data.authKind, hote: hoteDe(parse.data.baseUrl),
    });
    return reply.code(201).send({ serveur });
  });

  /**
   * Supprimer un serveur : refusé tant qu'un outil actif en dépend (409), comme un connecteur API. La garde vit
   * dans la même transaction que la suppression.
   */
  app.delete('/tenants/:tenantId/mcp/:sourceId', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { sourceId } = req.params as { sourceId: string };
    if (!estUuid(sourceId)) return reply.code(400).send({ error: 'identifiant invalide' });
    const verdict = await deps.mcp.supprimerServeur(tenant, sourceId);
    if (verdict === 'introuvable') return reply.code(404).send({ error: 'serveur introuvable' });
    if (verdict === 'outils_actifs') {
      return reply.code(409).send({ error: 'ce serveur porte encore des outils actifs : désactivez-les d’abord' });
    }
    await journal(tenant, req, 'connecteur.supprime', { kind: 'connecteur', id: sourceId }, { mcp: true });
    return reply.code(204).send();
  });

  /** Les outils importés d'un serveur : sans cette lecture, l'écran ne pourrait ni les voir ni les clouer. */
  app.get('/tenants/:tenantId/mcp/:sourceId/outils', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { sourceId } = req.params as { sourceId: string };
    if (!estUuid(sourceId)) return reply.code(400).send({ error: 'identifiant invalide' });
    /**
     * Les deux listes de clouage partent avec : l'écran propose un choix, pas un champ libre, et les recopier côté
     * navigateur ferait diverger la liste proposée de la liste acceptée.
     */
    const [outils, champs] = await Promise.all([
      deps.mcp.outilsPourEcran(tenant, sourceId),
      deps.clesDeChamps(tenant),
    ]);
    return reply.code(200).send({ outils, champs, champsContact: [...CHAMPS_CONTACT_AUTORISES] });
  });

  /**
   * L'aperçu : le plan, sans rien écrire dans le catalogue. En `POST` : ce chemin ouvre une connexion sortante et
   * écrit `marquerEpreuve`, et en `GET` un préchargement ou un robot suffirait à le déclencher.
   */
  app.post('/tenants/:tenantId/mcp/:sourceId/apercu', lourd, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { sourceId } = req.params as { sourceId: string };
    if (!estUuid(sourceId)) return reply.code(400).send({ error: 'identifiant invalide' });
    const r = await deps.rafraichissement.apercevoir(tenant, sourceId);
    if (!r.ok && r.cause === 'introuvable') return reply.code(404).send({ error: 'serveur introuvable' });
    if (!r.ok) return reply.code(422).send({ error: r.erreur });
    return reply.code(200).send({ plan: r.plan, tronque: r.tronque });
  });

  /** L'import : le même plan, appliqué. */
  app.post('/tenants/:tenantId/mcp/:sourceId/importer', lourd, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { sourceId } = req.params as { sourceId: string };
    if (!estUuid(sourceId)) return reply.code(400).send({ error: 'identifiant invalide' });
    const r = await deps.rafraichissement.importer(tenant, sourceId);
    if (!r.ok && r.cause === 'introuvable') return reply.code(404).send({ error: 'serveur introuvable' });
    if (!r.ok) return reply.code(422).send({ error: r.erreur });
    return reply.code(200).send({ plan: r.plan, tronque: r.tronque });
  });

  /**
   * Le réglage d'un outil importé : la source de chaque paramètre, le risque, et quand ne pas l'appeler. Un
   * clouage désigne un champ qui existe, vérifié ici : sinon le paramètre partirait vide à chaque appel.
   */
  app.patch('/tenants/:tenantId/mcp/outils/:outilId', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { outilId } = req.params as { outilId: string };
    if (!estUuid(outilId)) return reply.code(400).send({ error: 'identifiant invalide' });

    const parse = reglageSchema.safeParse(req.body);
    if (!parse.success) return reply.code(400).send({ error: 'réglage invalide' });
    const d = parse.data;

    if (d.params) {
      const cles = await deps.clesDeChamps(tenant);
      for (const p of d.params) {
        if (p.source === 'champ') {
          if (!p.cle) return reply.code(400).send({ error: `le paramètre « ${p.name} » doit désigner un champ` });
          if (!cles.includes(p.cle)) return reply.code(400).send({ error: `le champ « ${p.cle} » n’existe pas dans cet espace` });
        }
        /**
         * 🔴 Un clouage `contact` désigne un attribut de la liste fermée (`champs-contact.ts`), rien d'autre :
         * sinon `contactPath: 'champs'` enverrait tout le jsonb des champs du contact au serveur tiers. Et sans
         * `contactPath`, l'exécuteur chercherait `p.name` sur le contact et enverrait `null`.
         */
        if (p.source === 'contact') {
          if (!p.contactPath) return reply.code(400).send({ error: `le paramètre « ${p.name} » doit désigner un attribut de la fiche` });
          if (!estChampContact(p.contactPath)) {
            return reply.code(400).send({ error: `« ${p.contactPath} » n’est pas un attribut de fiche autorisé` });
          }
        }
        // `fixe` sans valeur est refusé, comme un `champ` sans clé : le paramètre partirait vide à chaque appel.
        if (p.source === 'fixe' && p.value === undefined) {
          return reply.code(400).send({ error: `le paramètre « ${p.name} » doit porter une valeur` });
        }
      }
    }

    const ok = await deps.mcp.reglerOutil(tenant, outilId, d);
    return ok ? reply.code(200).send({ ok: true }) : reply.code(404).send({ error: 'outil introuvable' });
  });

  /**
   * Proposer un outil importé aux agents de l'espace, ou le retirer (Julien, 2026-10-02 : on choisit d'abord ici, puis
   * sur chaque agent). Retirer un outil qu'un agent a déjà est refusé en 409, avec les noms.
   */
  app.put('/tenants/:tenantId/mcp/outils/:outilId/propose', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { outilId } = req.params as { outilId: string };
    if (!estUuid(outilId)) return reply.code(400).send({ error: 'identifiant invalide' });
    const parse = proposeSchema.safeParse(req.body);
    if (!parse.success) return reply.code(400).send({ error: 'valeur booléenne requise' });
    const r = await deps.mcp.proposer(tenant, outilId, parse.data.propose);
    if (r === null) return reply.code(404).send({ error: 'outil introuvable' });
    if ('utilisePar' in r) {
      return reply.code(409).send({
        error: `utilisé par ${r.utilisePar.join(', ')} : retirez-le d’abord de ${r.utilisePar.length > 1 ? 'ces agents' : 'cet agent'}`,
        utilisePar: r.utilisePar,
      });
    }
    return reply.code(200).send({ propose: parse.data.propose });
  });
}
