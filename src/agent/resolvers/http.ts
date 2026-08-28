import type { EntreeResolveur, ResolveurOutil, SortieResolveur } from '../executor';
import type { SourceStore } from '../sources';
import { construireCible, enTetesAuthSource } from '../http-cible';

/**
 * Le résolveur des outils de CONNECTEUR : un appel HTTP vers le système du client (lot L2).
 *
 * 🔴 CE QU'IL PROTÈGE. Deux champs de sa sortie, `contenu` et `erreur`, repartent au MODÈLE, donc chez le
 * fournisseur. Trois choses ne doivent donc jamais s'y trouver : le secret d'authentification, le corps brut
 * d'une erreur du client (une trace de 500 porte des chemins internes et parfois des identifiants), et un
 * champ que le client n'a pas listé dans `outputPaths`.
 *
 * 🔴 IL NE LÈVE PAS sur un cas métier. Une source inactive, un gabarit cassé, un 500 du client : tout cela
 * rend `ok: false` avec une raison lisible, que le modèle peut dire au contact. Lever ferait une
 * `erreur_protocole`, qui ARRÊTE le tour, alors que le client peut corriger son outil dans sa console.
 *
 * ⚠️ `redirect: 'error'`, et ce n'est pas le choix du scraper de connaissance. Une page publique redirige
 * légitimement ; une API de connecteur qui redirige est une anomalie, et la suivre rouvrirait la porte que
 * `http-cible.ts` vient de fermer (le premier saut est validé, le second ne l'est plus).
 */

export interface DepsResolveurHttp {
  sources: Pick<SourceStore, 'pourAppel' | 'marquerEpreuve'>;
  /** Injecté pour tester sans réseau, comme partout dans ce dépôt. */
  fetchImpl?: typeof fetch;
}

/** Ce qu'on dit au modèle quand ça ne va pas. Volontairement pauvre : il n'a pas à savoir POURQUOI le système
 *  du client refuse, il a à savoir qu'il ne peut pas répondre depuis cette source. */
const MESSAGES: Record<string, string> = {
  auth: 'le système du client a refusé l’authentification de ce connecteur',
  indispo: 'le système du client n’a pas répondu',
  illisible: 'le système du client a répondu dans un format inattendu',
  trop_gros: 'la réponse du système du client est trop volumineuse',
  redirige: 'le système du client a redirigé l’appel, ce qui n’est pas accepté sur un connecteur',
};

/** Lit `binding` défensivement : c'est du jsonb écrit par la console, il peut être n'importe quoi. */
function bindingDe(v: unknown): { methode: string; chemin: string } {
  const b = (v ?? {}) as { methode?: unknown; chemin?: unknown };
  return { methode: typeof b.methode === 'string' ? b.methode : '', chemin: typeof b.chemin === 'string' ? b.chemin : '' };
}

/**
 * Extrait UN chemin pointé (`livraison.date`) d'une réponse JSON.
 *
 * Pas de joker, pas d'index de tableau : le besoin est de nommer des champs, et une syntaxe riche ici
 * deviendrait une seconde grammaire à valider, à documenter et à tester pour personne.
 */
function extraire(source: unknown, chemin: string): unknown {
  let courant: unknown = source;
  for (const cle of chemin.split('.')) {
    if (courant === null || typeof courant !== 'object') return undefined;
    courant = (courant as Record<string, unknown>)[cle];
  }
  return courant;
}

export function creerResolveurHttp(deps: DepsResolveurHttp): ResolveurOutil {
  const appeler = deps.fetchImpl ?? fetch;

  return async (entree: EntreeResolveur): Promise<SortieResolveur> => {
    const { outil, args, ctx, signal } = entree;

    // 1. LE FILTRE DE SORTIE D'ABORD. Un outil sans `outputPaths` est une déclaration incomplète (la route
    // l'exige, décision D-L2-2) : si l'on en trouve un quand même, il ne divulgue RIEN plutôt que tout.
    if (!Array.isArray(outil.outputPaths) || outil.outputPaths.length === 0) {
      return { ok: false, contenu: { erreur: 'ce connecteur ne déclare aucun champ à lire' }, erreur: 'outputPaths vide' };
    }

    // 2. LA SOURCE. Absente, d'un autre tenant, ou pas active : aucun appel réseau ne part.
    const sourceId = typeof outil.sourceId === 'string' ? outil.sourceId : '';
    const source = sourceId === '' ? null : await deps.sources.pourAppel(ctx.tenantId, sourceId);
    if (!source) return { ok: false, contenu: { erreur: 'ce connecteur n’est pas configuré' }, erreur: 'source introuvable' };
    if (source.status !== 'active') {
      return { ok: false, contenu: { erreur: 'ce connecteur n’est pas actif' }, erreur: `source ${source.status}` };
    }

    // 3. LA CIBLE. Toutes les gardes d'adresse et de chemin sont là, et elles passent AVANT le réseau.
    const cible = construireCible({ baseUrl: source.baseUrl, binding: bindingDe(outil.binding), args });
    if (!cible.ok) return { ok: false, contenu: { erreur: 'ce connecteur est mal configuré' }, erreur: cible.raison };

    // 4. L'APPEL. Le secret n'existe que dans cet objet d'en-têtes, et n'en sort pas.
    const headers = enTetesAuthSource(source);

    let res: Response;
    try {
      res = await appeler(cible.url, { method: cible.methode, headers, redirect: 'error', signal });
    } catch (err) {
      // Panne réseau, DNS, échéance, ou redirection refusée par `redirect: 'error'`. On note l'échec SUR LA
      // SOURCE : c'est ce qui rend un connecteur mort visible dans la console avant qu'un contact ne le
      // découvre. Best-effort : une écriture qui trébuche ne doit pas transformer un échec d'outil en panne
      // de tour.
      const redirige = String((err as Error)?.message ?? '').toLowerCase().includes('redirect');
      await deps.sources.marquerEpreuve(ctx.tenantId, source.id, false, redirige ? 'redirection refusée' : 'injoignable').catch(() => {});
      const cle = redirige ? 'redirige' : 'indispo';
      return { ok: false, contenu: { erreur: MESSAGES[cle] }, erreur: cle };
    }

    // Certaines implémentations de `fetch` rendent la redirection au lieu de lever : on la refuse aussi ici.
    if (res.status >= 300 && res.status < 400) {
      await deps.sources.marquerEpreuve(ctx.tenantId, source.id, false, 'redirection refusée').catch(() => {});
      return { ok: false, contenu: { erreur: MESSAGES.redirige }, erreur: 'redirige', httpStatus: res.status };
    }

    // 5. LE CORPS, BORNÉ. Le plafond est vérifié sur ce qu'on a LU, pas sur `content-length` : un serveur peut
    // mentir. Au-delà, on refuse plutôt que de tronquer : un JSON tronqué est illisible de toute façon, et
    // remplirait le contexte du modèle pour rien.
    const brut = await res.text().catch(() => '');
    if (brut.length > outil.maxBytes) {
      return { ok: false, contenu: { erreur: MESSAGES.trop_gros }, erreur: 'trop_gros', httpStatus: res.status };
    }

    // 6. LE STATUT. Un 4xx/5xx est un échec MÉTIER : le modèle doit le savoir, sans le corps brut de l'erreur
    // (une trace de 500 porte des chemins internes, parfois des identifiants).
    if (!res.ok) {
      const authentification = res.status === 401 || res.status === 403;
      // Un 4xx est une RÉPONSE du système du client, pas une panne : la source reste réputée saine, sauf si
      // c'est l'authentification qui est refusée, ce qui est exactement le symptôme d'un jeton mort.
      const sourceSaine = res.status >= 400 && res.status < 500 && !authentification;
      await deps.sources.marquerEpreuve(ctx.tenantId, source.id, sourceSaine, authentification ? 'authentification refusée' : `HTTP ${res.status}`).catch(() => {});
      return {
        ok: false,
        contenu: { erreur: authentification ? MESSAGES.auth : MESSAGES.indispo },
        erreur: authentification ? 'auth' : `http_${res.status}`,
        httpStatus: res.status,
      };
    }

    // 7. LE FILTRE. Ce qui repart au modèle est EXACTEMENT ce que le client a listé, et rien d'autre.
    let json: unknown;
    try {
      json = JSON.parse(brut) as unknown;
    } catch {
      await deps.sources.marquerEpreuve(ctx.tenantId, source.id, true).catch(() => {});
      return { ok: false, contenu: { erreur: MESSAGES.illisible }, erreur: 'illisible', httpStatus: res.status };
    }
    const contenu: Record<string, unknown> = {};
    for (const chemin of outil.outputPaths) {
      const v = extraire(json, chemin);
      if (v !== undefined) contenu[chemin] = v;
    }
    await deps.sources.marquerEpreuve(ctx.tenantId, source.id, true).catch(() => {});
    return { contenu, httpStatus: res.status };
  };
}
