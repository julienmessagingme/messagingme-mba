import type { EntreeResolveur, ResolveurOutil, SortieResolveur } from '../executor';
import type { SourceStore } from '../sources';
import { enTetesAuthSource } from '../http-cible';
import { paramsOutil, type ParamOutil } from '../llm/tool-schema';
import { resolutionPublique, type VerdictResolution } from '../../lib/adresse-privee';
import { ouvrirSessionMcp, type CibleMcp, type EchecMcp, type SessionMcp } from '../../mcp/client';

/**
 * Le résolveur des outils venus d'un serveur MCP tiers. Sans lui, un outil `origin = 'mcp'` arrête le tour
 * (`erreur_protocole`, `fatal: true`).
 *
 * Il ne passe pas par `creerAppelConnecteur` : ce point de passage construit une cible HTTP depuis une
 * requête de connecteur, et ses gardes en dépendent ; un outil MCP n'a pas de requête, et son transport
 * (`src/mcp/client.ts`) porte déjà la lecture bornée et le cycle de vie du protocole.
 *
 * 🔴 `contenu` et `erreur` repartent au modèle, donc chez le fournisseur : le secret n'y entre jamais. Pas
 * d'exception sur un cas métier (source inactive, refus, `isError`) : `ok: false` avec une raison lisible,
 * puisqu'une `erreur_protocole` arrêterait le tour.
 */

export interface DepsResolveurMcp {
  /** Relue à chaque appel, jamais figée : une source désactivée doit cesser d'être appelée tout de suite. */
  sources: Pick<SourceStore, 'pourAppel' | 'marquerEpreuve'>;
  /** Injectée pour tester sans réseau, comme partout dans ce dépôt. */
  ouvrirSession?: typeof ouvrirSessionMcp;
  /** Injectée pour tester la garde de résolution sans DNS. Défaut : la vraie résolution. */
  verifierResolution?: (url: string) => Promise<VerdictResolution>;
}

/** Un refus métier : lisible par le modèle, sans rien divulguer du secret ni de l'interne. */
function refus(raison: string): SortieResolveur {
  return { ok: false, contenu: { erreur: raison }, erreur: raison };
}

/** Le message qu'on montre pour chaque genre d'échec du transport. Aucun ne porte le secret. */
function direEchec(e: EchecMcp): string {
  switch (e.genre) {
    case 'budget':
      // Le délai est le nôtre, on le dit : le client peut l'augmenter sur la fiche de l'outil, au lieu
      // d'enquêter chez son fournisseur.
      return 'l’appel a dépassé le délai fixé pour cet outil';
    case 'transport_ancien':
      return 'ce serveur MCP parle un transport que nous ne prenons pas en charge';
    case 'refus':
      return `le serveur MCP a refusé l’appel (${e.code})`;
    case 'reseau':
      return 'le serveur MCP est injoignable';
    case 'redirection':
      return 'le serveur MCP a redirigé l’appel, ce qui n’est pas accepté sur un connecteur';
    case 'adresse_interne':
      // Même phrase que la vérification préalable (plus bas) : c'est la même cause, vue plus tard.
      return 'l’adresse de ce serveur MCP ne résout pas vers une adresse publique';
    default:
      /**
       * Le message part avec : ce genre couvre aussi bien un corps illisible (le serveur) qu'une réponse trop
       * grosse (notre plafond `max_bytes`), et une phrase unique attribuerait au serveur une coupure décidée par
       * nous. Ces messages sont écrits dans `src/mcp/client.ts`, sans secret.
       */
      return `le serveur MCP a répondu quelque chose d’illisible (${e.message})`;
  }
}

/**
 * Pose une valeur au bout d'un chemin, en créant les objets intermédiaires. Un maillon déjà occupé par un
 * scalaire (schéma qui déclare `a` et `a.b`) arrête la pose plutôt que de l'écraser, pour un appel
 * reproductible quel que soit l'ordre des paramètres.
 */
function poser(cible: Record<string, unknown>, chemin: string[], valeur: unknown): void {
  let courant = cible;
  for (let i = 0; i < chemin.length - 1; i += 1) {
    const cle = chemin[i]!;
    const suivant = courant[cle];
    if (suivant === undefined) courant[cle] = {};
    else if (typeof suivant !== 'object' || suivant === null || Array.isArray(suivant)) return;
    courant = courant[cle] as Record<string, unknown>;
  }
  courant[chemin[chemin.length - 1]!] = valeur;
}

/**
 * Les arguments tels que le serveur distant les attend, recomposés par `cheminMcp` (sinon un paramètre
 * imbriqué partirait à plat, sous une clé inconnue du serveur). Une valeur `null` est transmise, une valeur
 * absente ne l'est pas : un champ vide part vide, et le serveur décide.
 */
export function argumentsDistants(params: ParamOutil[], args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of params) {
    const v = args[p.name];
    if (v === undefined) continue;
    poser(out, (p.cheminMcp ?? p.name).split('.'), v);
  }
  return out;
}

export function creerResolveurMcp(deps: DepsResolveurMcp): ResolveurOutil {
  const ouvrir = deps.ouvrirSession ?? ouvrirSessionMcp;
  const verifier = deps.verifierResolution ?? resolutionPublique;

  return async (entree: EntreeResolveur): Promise<SortieResolveur> => {
    const { outil, ctx } = entree;

    // 1. La source. Un outil non maison en a forcément une (`agent_tools_origin_src_chk`), mais on ne le
    //    suppose pas : un `null` ici produirait un appel dans le vide.
    if (typeof outil.sourceId !== 'string' || outil.sourceId === '') {
      return refus('cet outil n’est rattaché à aucun serveur MCP');
    }
    /**
     * La ceinture : une ligne activée avant qu'un rafraîchissement ne la déclare non activable ou disparue peut
     * encore être appelée, et partirait avec zéro paramètre, donc `{}` à chaque tour.
     */
    if (outil.mcpNonActivable) return refus(`cet outil n’est pas appelable : ${outil.mcpNonActivable}`);
    if (outil.mcpIndisponibleLe) return refus('cet outil a disparu du serveur MCP');

    const source = await deps.sources.pourAppel(ctx.tenantId, outil.sourceId);
    if (!source) return refus('le serveur MCP de cet outil est introuvable');
    // 🔴 La source est-elle bien un serveur MCP ? La clé étrangère de `source_kind` ne couvre pas les lignes
    // anciennes (MATCH SIMPLE) : sans cette ligne, on posterait une enveloppe JSON-RPC sur l'API d'un client,
    // avec son secret.
    if (source.kind !== 'mcp') return refus('le connecteur de cet outil n’est pas un serveur MCP');
    if (source.status !== 'active') return refus('le serveur MCP de cet outil n’est pas actif');

    // 2. 🔴 L'adresse, avant toute connexion (après, la vérification serait décorative) : le texte de l'hôte a
    //    été validé à l'écriture, on vérifie ici ce vers quoi il résout.
    const verdict = await verifier(source.baseUrl);
    if (!verdict.ok) {
      return refus('l’adresse de ce serveur MCP ne résout pas vers une adresse publique');
    }

    // 3. La session. Le budget total vaut l'échéance de l'outil : initialisation, notification et appel y
    //    puisent ensemble. Un serveur lent peut l'épuiser dès l'initialisation : `budget` le dit au client
    //    comme un délai à augmenter, pas comme une faute du serveur.
    const cible: CibleMcp = {
      url: source.baseUrl,
      enTetes: enTetesAuthSource(source),
      timeoutMs: outil.timeoutMs,
      budgetTotalMs: outil.timeoutMs,
      maxOctets: outil.maxBytes,
    };
    const ouverte = await ouvrir(cible);
    if ('echec' in ouverte) {
      // Une source injoignable est marquée : un connecteur mort se voit dans la console avant qu'un contact ne
      // le découvre.
      await deps.sources.marquerEpreuve(ctx.tenantId, source.id, false, direEchec(ouverte.echec)).catch(() => {});
      return refus(direEchec(ouverte.echec));
    }
    const session: SessionMcp = ouverte;

    try {
      /**
       * Pas de repli sur `outil.name` : notre nom local est préfixé par le libellé du serveur (`notion_search`),
       * donc inconnu du serveur par construction. On refuse ici, avec la raison.
       */
      const nomDistant = outil.binding.outilDistant;
      if (typeof nomDistant !== 'string' || nomDistant === '') {
        return refus('cet outil ne dit pas quel outil appeler sur le serveur MCP, il faut le réimporter');
      }
      const resultat = await session.appeler(nomDistant, argumentsDistants(paramsOutil(outil.params), entree.args));

      if ('echec' in resultat) {
        await deps.sources.marquerEpreuve(ctx.tenantId, source.id, false, direEchec(resultat.echec)).catch(() => {});
        return refus(direEchec(resultat.echec));
      }

      // Le serveur a répondu, même non : la source est saine. La marquer morte sur un refus métier enverrait
      // chercher une panne qui n'existe pas.
      await deps.sources.marquerEpreuve(ctx.tenantId, source.id, true).catch(() => {});

      if (resultat.estErreur) {
        return { ok: false, contenu: { erreur: resultat.texte }, erreur: resultat.texte };
      }

      // 🔴 Un outil qui pousse rend le verdict seul : la réponse d'un outil qui agit porte souvent la ressource
      // entière, l'agent n'a aucune raison de l'envoyer au fournisseur du modèle.
      if (outil.nature === 'pousse') return { ok: true, contenu: { ok: true } };

      // Le texte part entier : le filtre par chemins ne s'applique pas à un retour textuel (voir
      // `src/agent/executor.ts`), il rendrait `{}`.
      return { ok: true, contenu: { texte: resultat.texte } };
    } finally {
      // Fermer est un geste de politesse envers le serveur, jamais une étape dont dépend le résultat.
      await session.fermer().catch(() => {});
    }
  };
}
