import type { SourceAppel } from '../sources';
import { enTetesAuthSource } from '../http-cible';
import {
  outilDepuisAnnonce,
  planifierImport,
  type ChangementMcp,
  type OutilAImporter,
  type OutilExistantMcp,
} from './import';
import { ouvrirSessionMcp, type EchecMcp, type OutilAnnonce } from '../../mcp/client';
import { resolutionPublique, type VerdictResolution } from '../../lib/adresse-privee';

/** Ce que l'import écrit, en un seul objet, pour que le store le pose dans une transaction. */
export interface EcritureImportMcp {
  nouveaux: OutilAImporter[];
  /** Schéma changé : on remplace l'annonce et les paramètres, et le consentement tombe. */
  changes: Array<{ id: string; outil: OutilAImporter }>;
  /** Ids des outils disparus : marqués indisponibles, jamais supprimés. */
  disparus: string[];
  /** Ids des outils revus, pour avancer `mcp_vu_le`. */
  vus: string[];
}

interface DepsRafraichissementMcp {
  sources: {
    pourAppel(tenantId: string, id: string): Promise<SourceAppel | null>;
    marquerEpreuve(tenantId: string, id: string, ok: boolean, erreur?: string): Promise<void>;
  };
  mcp: {
    listerServeurs(tenantId: string): Promise<Array<{ id: string; label: string }>>;
    outilsDuServeur(tenantId: string, sourceId: string): Promise<OutilExistantMcp[]>;
    nomsPris(tenantId: string): Promise<string[]>;
    appliquer(tenantId: string, sourceId: string, ecriture: EcritureImportMcp): Promise<void>;
  };
  /** Injectées pour tester sans réseau ni DNS. */
  ouvrirSession?: typeof ouvrirSessionMcp;
  verifierResolution?: (url: string) => Promise<VerdictResolution>;
}

export type ResultatRafraichissementMcp =
  | { ok: true; plan: ChangementMcp[]; tronque: boolean }
  | { ok: false; cause: 'introuvable' }
  | { ok: false; cause: 'distant'; erreur: string };

export interface RafraichissementMcp {
  apercevoir(tenantId: string, sourceId: string): Promise<ResultatRafraichissementMcp>;
  importer(tenantId: string, sourceId: string): Promise<ResultatRafraichissementMcp>;
}

interface PreparationReussie {
  ok: true;
  plan: ChangementMcp[];
  ecriture: EcritureImportMcp;
  tronque: boolean;
}

type ResultatPreparation = PreparationReussie | Exclude<ResultatRafraichissementMcp, { ok: true }>;

/**
 * Budget d'une opération d'import, en millisecondes : l'échéance de `fetch` est par requête, et un catalogue
 * paginé sur vingt pages tiendrait sinon vingt fois cette valeur, au-delà de ce qu'une passerelle laisse passer.
 */
const BUDGET_IMPORT_MS = 25_000;
const TIMEOUT_REQUETE_MS = 8_000;
/** Un catalogue entier peut être gros ; il ne traverse pas le modèle, il s'affiche. */
const MAX_OCTETS_CATALOGUE = 1_000_000;

function direEchec(e: EchecMcp): string {
  switch (e.genre) {
    case 'transport_ancien':
      return 'ce serveur parle l’ancien transport HTTP+SSE de la révision 2024-11-05, qui n’est pas pris en charge';
    case 'refus':
      return `le serveur a refusé la connexion (${e.code})`;
    case 'reseau':
      return 'le serveur est injoignable';
    case 'redirection':
      return 'le serveur a redirigé l’appel, ce qui n’est pas accepté sur un connecteur';
    case 'adresse_interne':
      return 'cette adresse ne résout pas vers une adresse publique';
    case 'budget':
      return 'le serveur a mis trop de temps à répondre (délai de l’épreuve dépassé)';
    default:
      return e.message;
  }
}

/** Ouvre une session vers un serveur, après avoir vérifié vers quoi son adresse résout. */
async function connecter(deps: DepsRafraichissementMcp, source: SourceAppel) {
  const verifier = deps.verifierResolution ?? resolutionPublique;
  // 🔴 Avant toute connexion : posée après, la vérification serait décorative.
  const verdict = await verifier(source.baseUrl);
  if (!verdict.ok) return { echec: verdict.raison ?? 'cette adresse ne résout pas vers une adresse publique' };
  const ouvrir = deps.ouvrirSession ?? ouvrirSessionMcp;
  return ouvrir({
    url: source.baseUrl,
    enTetes: enTetesAuthSource(source),
    timeoutMs: TIMEOUT_REQUETE_MS,
    budgetTotalMs: BUDGET_IMPORT_MS,
    maxOctets: MAX_OCTETS_CATALOGUE,
  });
}

/**
 * Le plan d'un rafraîchissement et l'écriture qui l'applique, calculés ensemble : l'aperçu montre exactement ce
 * que l'application fera.
 */
function planEtEcriture(
  annonces: readonly OutilAnnonce[],
  existants: readonly OutilExistantMcp[],
  tronque: boolean,
  libelleSource: string,
  nomsPris: readonly string[],
): { plan: ChangementMcp[]; ecriture: EcritureImportMcp } {
  const plan = planifierImport(annonces, existants, { tronque });
  const parNom = new Map(existants.map((e) => [e.nomDistant, e]));
  const annoncesParNom = new Map(annonces.map((a) => [a.name, a]));
  /**
   * Les noms déjà pris dans l'espace le restent tous. En retirer ceux de ce serveur laisserait un outil neuf se
   * normaliser vers le nom d'un outil inchangé (`get-contact` et `get_contact`) et annuler tout l'import.
   */
  const pris = new Set(nomsPris);

  const ecriture: EcritureImportMcp = { nouveaux: [], changes: [], disparus: [], vus: [] };
  for (const c of plan) {
    const annonce = annoncesParNom.get(c.nom);
    const avant = parNom.get(c.nom);
    if (c.type === 'nouveau' && annonce) {
      const outil = outilDepuisAnnonce(annonce, libelleSource, pris);
      pris.add(outil.name);
      ecriture.nouveaux.push(outil);
    } else if (c.type === 'schema_change' && annonce && avant) {
      // Le nom local ne bouge pas : il est peut-être écrit dans une consigne d'agent. `avant.params` préserve
      // aussi la garde d'identité des paramètres déjà cloués.
      const outil = { ...outilDepuisAnnonce(annonce, libelleSource, pris, avant.params), name: avant.name };
      pris.add(outil.name);
      ecriture.changes.push({ id: avant.id, outil });
    } else if (c.type === 'disparu' && avant) {
      ecriture.disparus.push(avant.id);
    } else if (c.type === 'inchange' && avant) {
      ecriture.vus.push(avant.id);
    }
  }
  return { plan, ecriture };
}

/**
 * Possède le cycle complet d'un rafraîchissement MCP : source, connexion, catalogue, plan et écriture. L'adaptateur
 * HTTP ne connaît ainsi ni le protocole distant ni la transaction d'import.
 */
export function creerRafraichissementMcp(deps: DepsRafraichissementMcp): RafraichissementMcp {
  async function preparer(tenantId: string, sourceId: string): Promise<ResultatPreparation> {
    const source = await deps.sources.pourAppel(tenantId, sourceId);
    // `pourAppel` ne filtre pas le kind. Ne jamais parler MCP à un connecteur HTTP avec son secret.
    if (!source || source.kind !== 'mcp') return { ok: false, cause: 'introuvable' };

    const ouverte = await connecter(deps, source);
    if ('echec' in ouverte) {
      const raison = typeof ouverte.echec === 'string' ? ouverte.echec : direEchec(ouverte.echec);
      await deps.sources.marquerEpreuve(tenantId, sourceId, false, raison);
      return { ok: false, cause: 'distant', erreur: raison };
    }

    try {
      const catalogue = await ouverte.lister();
      if ('echec' in catalogue) {
        const raison = direEchec(catalogue.echec);
        await deps.sources.marquerEpreuve(tenantId, sourceId, false, raison);
        return { ok: false, cause: 'distant', erreur: raison };
      }
      await deps.sources.marquerEpreuve(tenantId, sourceId, true);
      const [existants, nomsPris] = await Promise.all([
        deps.mcp.outilsDuServeur(tenantId, sourceId),
        deps.mcp.nomsPris(tenantId),
      ]);
      const serveurs = await deps.mcp.listerServeurs(tenantId);
      const libelle = serveurs.find((s) => s.id === sourceId)?.label ?? 'mcp';
      const { plan, ecriture } = planEtEcriture(
        catalogue.outils,
        existants,
        catalogue.tronque,
        libelle,
        nomsPris,
      );
      return { ok: true, plan, ecriture, tronque: catalogue.tronque };
    } finally {
      await ouverte.fermer();
    }
  }

  return {
    async apercevoir(tenantId, sourceId) {
      const r = await preparer(tenantId, sourceId);
      if (!r.ok) return r;
      return { ok: true, plan: r.plan, tronque: r.tronque };
    },
    async importer(tenantId, sourceId) {
      const r = await preparer(tenantId, sourceId);
      if (!r.ok) return r;
      // `preparer` a fermé la session dans son `finally` avant que l'écriture transactionnelle commence.
      await deps.mcp.appliquer(tenantId, sourceId, r.ecriture);
      return { ok: true, plan: r.plan, tronque: r.tronque };
    },
  };
}
