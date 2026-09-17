import type { EntreeResolveur, ResolveurOutil, SortieResolveur } from '../executor';
import type { SourceStore } from '../sources';
import { enTetesAuthSource } from '../http-cible';
import { paramsOutil, type ParamOutil } from '../llm/tool-schema';
import { resolutionPublique, type VerdictResolution } from '../../lib/adresse-privee';
import { ouvrirSessionMcp, type CibleMcp, type EchecMcp, type SessionMcp } from '../../mcp/client';

/**
 * Le résolveur des outils venus d'un SERVEUR MCP tiers.
 *
 * 🔴 SANS LUI, UN OUTIL `origin = 'mcp'` ARRÊTE LE TOUR. L'exécuteur dispatche sur
 * `deps.resolveurs[outil.origin]` et, faute de résolveur, rend `erreur_protocole` avec `fatal: true`. Le
 * câbler dans le même lot que l'import n'est donc pas une commodité de rangement, c'est une condition.
 *
 * 🔴 IL NE PASSE PAS PAR `creerAppelConnecteur`, ET C'EST DÉLIBÉRÉ. Ce point de passage-là construit une
 * cible HTTP depuis une ligne de `connector_requests` et applique sept gardes qui en dépendent ; un outil
 * MCP n'a pas de requête, ses paramètres viennent du schéma distant, et son transport a son propre module
 * (`src/mcp/client.ts`), qui porte déjà la lecture bornée et le cycle de vie du protocole. Les forcer dans
 * le même moule ferait deux moitiés de fonction qui ne s'appliquent chacune qu'à la moitié des appels, ce
 * qui est la façon dont on finit par sauter une garde sans s'en apercevoir.
 *
 * 🔴 CE QU'IL PROTÈGE, comme son voisin HTTP : `contenu` et `erreur` repartent au MODÈLE, donc chez le
 * fournisseur. Le secret d'authentification n'y entre jamais.
 *
 * 🔴 IL NE LÈVE PAS sur un cas métier. Une source inactive, un serveur qui refuse, un `isError` : tout cela
 * rend `ok: false` avec une raison lisible, que le modèle peut dire au contact. Lever ferait une
 * `erreur_protocole`, qui ARRÊTE le tour, alors que le client peut corriger son branchement dans sa console.
 */

export interface DepsResolveurMcp {
  /**
   * 🔴 RELUE À CHAQUE APPEL, jamais figée. Une source que le client vient de désactiver doit cesser d'être
   * appelée tout de suite : la figer la laisserait tourner jusqu'au prochain redémarrage.
   */
  sources: Pick<SourceStore, 'pourAppel' | 'marquerEpreuve'>;
  /** Injectée pour tester sans réseau, comme partout dans ce dépôt. */
  ouvrirSession?: typeof ouvrirSessionMcp;
  /** Injectée pour tester la garde de résolution sans DNS. Défaut : la vraie résolution. */
  verifierResolution?: (url: string) => Promise<VerdictResolution>;
}

/** Un refus MÉTIER : lisible par le modèle, sans rien divulguer du secret ni de l'interne. */
function refus(raison: string): SortieResolveur {
  return { ok: false, contenu: { erreur: raison }, erreur: raison };
}

/** Le message qu'on montre pour chaque genre d'échec du transport. Aucun ne porte le secret. */
function direEchec(e: EchecMcp): string {
  switch (e.genre) {
    case 'transport_ancien':
      return 'ce serveur MCP parle un transport que nous ne prenons pas en charge';
    case 'refus':
      return `le serveur MCP a refusé l’appel (${e.code})`;
    case 'reseau':
      return 'le serveur MCP est injoignable';
    default:
      return 'le serveur MCP a répondu quelque chose d’illisible';
  }
}

/**
 * Pose une valeur au bout d'un chemin, en créant les objets intermédiaires.
 *
 * ⚠️ UN MAILLON DÉJÀ OCCUPÉ PAR UN SCALAIRE ARRÊTE LA POSE plutôt que de l'écraser. Le cas vient d'un
 * schéma distant qui déclarerait à la fois `a` et `a.b` : écraser ferait dépendre le résultat de l'ordre des
 * paramètres, donc rendrait l'appel non reproductible. On préfère ne pas poser, et le serveur dira ce qui
 * lui manque.
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
 * Les arguments tels que le SERVEUR DISTANT les attend.
 *
 * 🔴 NOTRE `name` EST UNE ÉTIQUETTE LOCALE, le `cheminMcp` est la donnée de protocole. Sans cette
 * recomposition, un paramètre imbriqué partirait à plat, sous une clé que le serveur ne connaît pas, et
 * l'appel échouerait pour une raison que personne ne saurait lire.
 *
 * ⚠️ UNE VALEUR `null` EST TRANSMISE, une valeur ABSENTE ne l'est pas. La distinction porte la décision du
 * 2026-09-16 : un champ du mini-CRM vide part vide, et c'est le serveur qui décide quoi en faire.
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

    // 1. LA SOURCE. Un outil non maison en a forcément une (contrainte `agent_tools_origin_src_chk`), mais
    //    on ne le SUPPOSE pas : un `null` ici produirait un appel dans le vide.
    if (typeof outil.sourceId !== 'string' || outil.sourceId === '') {
      return refus('cet outil n’est rattaché à aucun serveur MCP');
    }
    /**
     * 🔴 LA CEINTURE. L'activation est déjà refusée en base, mais une ligne activée AVANT que le
     * rafraîchissement ne la déclare non activable ou disparue resterait là : le consentement tombe au
     * rafraîchissement, oui, mais entre les deux un appel peut passer. Un outil non activable partirait
     * alors au modèle avec ZÉRO paramètre et appellerait le serveur avec `{}` à chaque tour.
     */
    if (outil.mcpNonActivable) return refus(`cet outil n’est pas appelable : ${outil.mcpNonActivable}`);
    if (outil.mcpIndisponibleLe) return refus('cet outil a disparu du serveur MCP');

    const source = await deps.sources.pourAppel(ctx.tenantId, outil.sourceId);
    if (!source) return refus('le serveur MCP de cet outil est introuvable');
    if (source.status !== 'active') return refus('le serveur MCP de cet outil n’est pas actif');

    // 2. L'ADRESSE, AVANT TOUTE CONNEXION. 🔴 L'ORDRE EST LA GARDE : une vérification posée après l'ouverture
    //    serait décorative, la connexion aurait déjà eu lieu, donc le dégât aussi. Le texte de l'hôte a été
    //    validé à l'écriture ; ce qui se vérifie ici est ce vers quoi il RÉSOUT, qu'un texte ne peut pas dire.
    const verdict = await verifier(source.baseUrl);
    if (!verdict.ok) {
      return refus('l’adresse de ce serveur MCP ne résout pas vers une adresse publique');
    }

    // 3. LA SESSION. Le budget TOTAL vaut l'échéance de l'outil : l'initialisation, la notification et
    //    l'appel y puisent ensemble, sinon trois allers-retours vaudraient trois fois l'échéance.
    const cible: CibleMcp = {
      url: source.baseUrl,
      enTetes: enTetesAuthSource(source),
      timeoutMs: outil.timeoutMs,
      budgetTotalMs: outil.timeoutMs,
      maxOctets: outil.maxBytes,
    };
    const ouverte = await ouvrir(cible);
    if ('echec' in ouverte) {
      // Une source qu'on n'a pas su joindre est MARQUÉE : c'est ce qui rend un connecteur mort visible dans
      // la console avant qu'un contact ne le découvre.
      await deps.sources.marquerEpreuve(ctx.tenantId, source.id, false, direEchec(ouverte.echec)).catch(() => {});
      return refus(direEchec(ouverte.echec));
    }
    const session: SessionMcp = ouverte;

    try {
      const nomDistant = typeof outil.binding.outilDistant === 'string' ? outil.binding.outilDistant : outil.name;
      const resultat = await session.appeler(nomDistant, argumentsDistants(paramsOutil(outil.params), entree.args));

      if ('echec' in resultat) {
        await deps.sources.marquerEpreuve(ctx.tenantId, source.id, false, direEchec(resultat.echec)).catch(() => {});
        return refus(direEchec(resultat.echec));
      }

      // ⚠️ LE SERVEUR A RÉPONDU, MÊME S'IL A RÉPONDU NON : la source est SAINE. La marquer morte sur un
      // refus métier enverrait le client chercher une panne qui n'existe pas.
      await deps.sources.marquerEpreuve(ctx.tenantId, source.id, true).catch(() => {});

      if (resultat.estErreur) {
        return { ok: false, contenu: { erreur: resultat.texte }, erreur: resultat.texte };
      }

      // 🔴 UN OUTIL QUI POUSSE REND LE VERDICT SEUL. La réponse d'un outil qui AGIT porte très souvent la
      // ressource entière qu'on vient de modifier ; l'agent n'a aucune raison de l'envoyer au fournisseur
      // du modèle. Même doctrine que le résolveur HTTP depuis 0150.
      if (outil.nature === 'pousse') return { ok: true, contenu: { ok: true } };

      // 🔴 LE TEXTE PART ENTIER, et le filtre par chemins ne s'applique pas ici : voir la garde posée dans
      // `src/agent/executor.ts`, qui saute `extraire` pour cette origine. Un filtre sur un retour textuel
      // rendrait `{}`, c'est-à-dire exactement le défaut que la migration 0150 a corrigé ailleurs.
      return { ok: true, contenu: { texte: resultat.texte } };
    } finally {
      // Fermer est un geste de politesse envers le serveur, jamais une étape dont dépend le résultat.
      await session.fermer().catch(() => {});
    }
  };
}
