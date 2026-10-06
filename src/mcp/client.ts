import { lireCorpsBorne } from '../lib/corps-borne';
import { fetchPublic, estRefusAdresseInterne, estRedirectionRefusee } from '../lib/connexion-publique';
import { objetOuNull } from '../webhooks/json';
// Version du protocole et identité viennent du serveur : c'est le même produit, qui doit parler la même révision
// dans les deux sens. L'alias dit qu'ici, cette identité est celle du client.
import { VERSION_PROTOCOLE, SERVEUR_INFO as IDENTITE_PRODUIT } from './serveur';

/**
 * Le client MCP : Messaging Me va chercher des outils chez un tiers (`serveur.ts` fait l'inverse). Tout ce qui en
 * sort est du tiers : chaque champ est vérifié avant d'être cru, jamais un `as` sur une réponse.
 *
 * La spec impose `initialize` puis `notifications/initialized` avant toute requête, et un `Mcp-Session-Id` assigné
 * doit être porté par la suite : d'où une session, ouverte pour une opération et jetée après. Jamais mise en cache
 * entre deux opérations : l'API, le worker et un déploiement sont des process distincts, et un identifiant partagé
 * rendrait un 404.
 * Écrit à la main : la surface utile tient en quatre méthodes.
 */

/** Ce qu'il faut pour joindre un serveur. `enTetes` porte l'authentification, construite par l'appelant. */
export interface CibleMcp {
  /** L'adresse du point MCP (l'endpoint unique), pas une racine sous laquelle on composerait un chemin. */
  url: string;
  enTetes: Record<string, string>;
  /** Échéance d'une requête. */
  timeoutMs: number;
  /**
   * Échéance de toute l'opération, requise : l'échéance de `fetch` est par requête, et un catalogue paginé sur
   * vingt pages vaudrait vingt fois `timeoutMs`. Sans défaut : seul l'appelant connaît son budget (tour d'agent ou
   * import).
   */
  budgetTotalMs: number;
  maxOctets: number;
}

/** Un outil tel que le serveur l'annonce. Les champs optionnels le sont dans la spec. */
export interface OutilAnnonce {
  name: string;
  title?: string;
  description?: string;
  /**
   * `unknown` et non objet : un tiers l'écrit, et peut l'omettre ou envoyer une chaîne. Substituer un objet vide
   * ferait passer « paramètres inconnus » pour « aucun paramètre », et l'outil partirait au modèle sans rien. La
   * valeur voyage telle quelle jusqu'à `aplatirSchema`, seul à savoir la refuser avec sa raison.
   */
  inputSchema: unknown;
  outputSchema?: Record<string, unknown>;
  /** Non fiables, dit la spec : elles pré-remplissent ce qu'on propose au client, jamais ne décident à sa place. */
  annotations?: Record<string, unknown>;
}

export type EchecMcp =
  /** Le serveur ne parle que l'ancien transport HTTP+SSE de la révision 2024-11-05. */
  | { genre: 'transport_ancien' }
  | { genre: 'reseau'; message: string }
  /**
   * Le nom a résolu vers l'intérieur à la connexion (DNS rebinding, fermé par `fetchPublic`). Son propre genre : la
   * connexion doit dire « adresse non publique » comme la vérification préalable, pas une panne réseau.
   */
  | { genre: 'adresse_interne' }
  /** Le serveur a répondu par une redirection, que `redirect: 'error'` refuse de suivre. */
  | { genre: 'redirection' }
  /** Notre échéance, pas une faute du serveur : sous `protocole`, on accuserait le tiers de notre minuterie. */
  | { genre: 'budget' }
  /** Réponse illisible, corps trop gros, flux cassé : ce qui n'est ni un refus ni une panne réseau. */
  | { genre: 'protocole'; message: string }
  | { genre: 'refus'; code: number; message: string };

export type ResultatAppel = { texte: string; estErreur: boolean } | { echec: EchecMcp };

export interface SessionMcp {
  /**
   * Toutes les pages suivies. `tronque` dit qu'on a buté sur une borne, et doit remonter à l'écran.
   *
   * 🔴 Une page qui échoue rend un échec, jamais la liste partielle : prise pour le catalogue entier, elle ferait
   * marquer « disparus » les autres outils et tomber leur consentement.
   * `tronque: true` porte le même danger : sur `tronque`, on ajoute et on met à jour, on ne retire jamais (tenu par
   * un test de l'import).
   */
  lister(): Promise<{ outils: OutilAnnonce[]; tronque: boolean } | { echec: EchecMcp }>;
  appeler(nom: string, args: Record<string, unknown>): Promise<ResultatAppel>;
  fermer(): Promise<void>;
}

/**
 * Bornes de la pagination : un curseur vient du tiers, et un `nextCursor` perpétuel nous ferait boucler. Les
 * atteindre pose `tronque`, que l'écran dit ; un plafond silencieux se lirait comme une couverture complète.
 */
const MAX_PAGES = 20;
const MAX_OUTILS = 500;

/** Les en-têtes que la configuration d'un client ne peut pas poser : chacun porte une décision de protocole. */
const RESERVES = ['content-type', 'accept', 'mcp-protocol-version', 'mcp-session-id'] as const;

/** Ce qu'un bloc de contenu non textuel devient dans le texte rendu au modèle. */
const MENTION: Record<string, string> = {
  image: '[image]',
  audio: '[audio]',
  resource: '[ressource]',
  resource_link: '[lien vers une ressource]',
};


/**
 * Lit une réponse et en extrait le message JSON-RPC portant `id`.
 *
 * La spec laisse le serveur répondre `application/json` ou `text/event-stream` à un POST : il faut lire les deux.
 * Le flux est lu jusqu'au message attendu, pas jusqu'à la fin : le serveur n'est que supposé le fermer, et
 * attendre la fermeture transformerait une réponse reçue en délai dépassé.
 */
async function lireReponse(
  res: Response,
  id: number,
  maxOctets: number,
): Promise<Record<string, unknown> | { echec: EchecMcp }> {
  const type = (res.headers.get('content-type') ?? '').toLowerCase();

  if (!type.startsWith('text/event-stream')) {
    const corps = await lireCorpsBorne(res, maxOctets);
    if (corps.trop_gros) return { echec: { genre: 'protocole', message: 'réponse trop grosse' } };
    // Un flux coupé n'est pas un corps vide : sans `casse`, on annoncerait un succès sur une lecture ratée.
    if (corps.casse) return { echec: { genre: 'protocole', message: 'la réponse a été coupée en cours de lecture' } };
    try {
      const m = objetOuNull(JSON.parse(corps.texte));
      if (m === null) return { echec: { genre: 'protocole', message: 'réponse JSON-RPC attendue' } };
      // L'identifiant se vérifie aussi ici : un serveur qui répond à côté rendrait un résultat pris pour le nôtre.
      if (m.id !== id) {
        return { echec: { genre: 'protocole', message: 'la réponse ne correspond pas à la requête envoyée' } };
      }
      return m;
    } catch {
      return { echec: { genre: 'protocole', message: 'corps JSON illisible' } };
    }
  }

  const flux = res.body as ReadableStream<Uint8Array> | null | undefined;
  if (!flux || typeof flux.getReader !== 'function') {
    return { echec: { genre: 'protocole', message: 'flux d’événements annoncé mais absent' } };
  }
  const lecteur = flux.getReader();
  const decodeur = new TextDecoder();
  let tampon = '';
  let octets = 0;
  try {
    for (;;) {
      const { done, value } = await lecteur.read();
      if (done) break;
      if (!value) continue;
      octets += value.byteLength;
      if (octets > maxOctets) {
        await lecteur.cancel().catch(() => {});
        return { echec: { genre: 'protocole', message: 'réponse trop grosse' } };
      }
      tampon += decodeur.decode(value, { stream: true });

      // Les événements sont séparés par une ligne vide ; un événement à cheval sur deux morceaux reste au tampon.
      for (;;) {
        const separateur = /\r?\n\r?\n/.exec(tampon);
        if (separateur === null) break;
        const evenement = tampon.slice(0, separateur.index);
        tampon = tampon.slice(separateur.index + separateur[0].length);
        const donnees = evenement
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n');
        if (donnees !== '') {
          try {
            const m = objetOuNull(JSON.parse(donnees));
            // On s'arrête au message qui répond à notre requête : le reste est notification ou requête du serveur.
            if (m && m.id === id) {
              await lecteur.cancel().catch(() => {});
              return m;
            }
          } catch { /* un événement illisible ne condamne pas le flux */ }
        }
      }
    }
  } catch {
    return { echec: { genre: 'protocole', message: 'le flux d’événements a été coupé' } };
  } finally {
    lecteur.releaseLock?.();
  }
  return { echec: { genre: 'protocole', message: 'le flux s’est terminé sans porter la réponse attendue' } };
}

/** L'échec d'un appel qui a levé : un refus d'adresse à la connexion, ou une vraie panne réseau. */
function echecReseau(err: unknown): EchecMcp {
  if (estRefusAdresseInterne(err)) return { genre: 'adresse_interne' };
  if (estRedirectionRefusee(err)) return { genre: 'redirection' };
  return { genre: 'reseau', message: err instanceof Error ? err.message : 'appel impossible' };
}

export function ouvrirSessionMcp(
  cible: CibleMcp,
  /** `now` est injectée pour que le budget soit reproductible en test, comme ailleurs dans ce dépôt. */
  opts: { fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<SessionMcp | { echec: EchecMcp }> {
  // Défaut : le fetch vérifié à la connexion (DNS rebinding), `src/lib/connexion-publique.ts`.
  return ouvrir(cible, opts.fetchImpl ?? fetchPublic, opts.now ?? (() => Date.now()));
}

async function ouvrir(
  cible: CibleMcp,
  appeler: typeof fetch,
  maintenant: () => number,
): Promise<SessionMcp | { echec: EchecMcp }> {
  let prochainId = 1;
  let sessionId: string | null = null;
  let version = VERSION_PROTOCOLE;
  // L'échéance de l'opération entière, posée une fois : initialisation, pagination et appels puisent dedans.
  const finAbsolue = maintenant() + cible.budgetTotalMs;

  /**
   * Les en-têtes d'une requête. `apresInit` ajoute ce que la spec n'autorise qu'ensuite.
   * Les en-têtes de protocole sont posés en dernier, et l'ordre est la garde : ceux du client (saisis par lui)
   * écraseraient `Accept`. Leurs clés passent en minuscules, sinon un `Accept` majuscule partirait en double.
   */
  function enTetes(apresInit: boolean): Record<string, string> {
    const duClient: Record<string, string> = {};
    for (const [k, v] of Object.entries(cible.enTetes)) duClient[k.toLowerCase()] = v;
    for (const reserve of RESERVES) delete duClient[reserve];
    return {
      ...duClient,
      'content-type': 'application/json',
      // Les deux, toujours : la spec l'impose, et c'est ce qui autorise le serveur à répondre en flux.
      accept: 'application/json, text/event-stream',
      ...(apresInit ? { 'mcp-protocol-version': version } : {}),
      // Jamais d'en-tête vide : un serveur qui exige une session répondrait 400.
      ...(apresInit && sessionId !== null ? { 'mcp-session-id': sessionId } : {}),
    };
  }

  async function envoyer(
    methode: string,
    params: Record<string, unknown> | undefined,
    apresInit: boolean,
  ): Promise<Record<string, unknown> | { echec: EchecMcp }> {
    const id = prochainId++;
    const restant = finAbsolue - maintenant();
    if (restant <= 0) {
      return { echec: { genre: 'budget' } };
    }
    let res: Response;
    try {
      res = await appeler(cible.url, {
        method: 'POST',
        headers: enTetes(apresInit),
        body: JSON.stringify({ jsonrpc: '2.0', id, method: methode, ...(params ? { params } : {}) }),
        // Le plus court des deux : l'échéance de cette requête, et ce qui reste du budget de l'opération.
        signal: AbortSignal.timeout(Math.min(cible.timeoutMs, restant)),
        // Suivre une redirection rouvrirait la porte que la garde d'adresse vient de fermer.
        redirect: 'error',
      });
    } catch (err) {
      return { echec: echecReseau(err) };
    }
    if (!res.ok) {
      // Corps jeté explicitement, sinon la connexion reste retenue jusqu'au ramasse-miettes.
      await res.body?.cancel().catch(() => {});
      return { echec: { genre: 'refus', code: res.status, message: `le serveur a répondu ${res.status}` } };
    }
    return lireReponse(res, id, cible.maxOctets);
  }

  /** Une notification : pas d'identifiant, donc pas de réponse. Le serveur doit rendre 202 sans corps. */
  async function notifier(methode: string): Promise<void> {
    try {
      const res = await appeler(cible.url, {
        method: 'POST',
        headers: enTetes(true),
        body: JSON.stringify({ jsonrpc: '2.0', method: methode }),
        signal: AbortSignal.timeout(cible.timeoutMs),
        redirect: 'error',
      });
      // Un corps éventuel est jeté, sinon la connexion reste retenue.
      await res.body?.cancel().catch(() => {});
    } catch { /* une notification perdue n'empêche pas la suite : le serveur n'y répond rien */ }
  }

  // ---- Initialisation -------------------------------------------------------------------------------
  let premiereReponse: Response;
  const idInit = prochainId++;
  try {
    premiereReponse = await appeler(cible.url, {
      method: 'POST',
      headers: enTetes(false),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: idInit,
        method: 'initialize',
        params: {
          protocolVersion: VERSION_PROTOCOLE,
          capabilities: {},
          clientInfo: { name: IDENTITE_PRODUIT.name, title: IDENTITE_PRODUIT.title, version: IDENTITE_PRODUIT.version },
        },
      }),
      signal: AbortSignal.timeout(Math.min(cible.timeoutMs, Math.max(1, finAbsolue - maintenant()))),
      redirect: 'error',
    });
  } catch (err) {
    return { echec: echecReseau(err) };
  }

  if (!premiereReponse.ok) {
    await premiereReponse.body?.cancel().catch(() => {});
    // 405 et 404 sont la signature de l'ancien transport (2024-11-05, qui attend un GET ouvrant un flux) : on le
    // nomme. Pas les autres 4xx : un 401 est un jeton refusé, pas une adresse à corriger.
    if (premiereReponse.status === 405 || premiereReponse.status === 404) {
      return { echec: { genre: 'transport_ancien' } };
    }
    return {
      echec: {
        genre: 'refus',
        code: premiereReponse.status,
        message: `le serveur a répondu ${premiereReponse.status} à l’initialisation`,
      },
    };
  }

  const init = await lireReponse(premiereReponse, idInit, cible.maxOctets);
  if ('echec' in init) return init as { echec: EchecMcp };
  const refusInit = objetOuNull(init.error);
  if (refusInit !== null) return refusRpc(refusInit, 'initialisation refusée');
  const resultat = objetOuNull(init.result);
  if (resultat === null) return { echec: { genre: 'protocole', message: 'initialisation sans résultat' } };
  if (typeof resultat.protocolVersion === 'string' && resultat.protocolVersion !== '') {
    // On reprend la version retenue par le serveur : elle voyage dans l'en-tête des requêtes suivantes.
    version = resultat.protocolVersion;
  }
  const assigne = premiereReponse.headers.get('mcp-session-id');
  if (assigne !== null && assigne !== '') sessionId = assigne;

  await notifier('notifications/initialized');

  // ---- La session -----------------------------------------------------------------------------------
  return {
    async lister() {
      const outils: OutilAnnonce[] = [];
      let curseur: string | undefined;
      let tronque = false;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const rep = await envoyer('tools/list', curseur === undefined ? {} : { cursor: curseur }, true);
        // On propage, on ne rend pas ce qu'on a : une page 1 seule serait prise pour le catalogue entier.
        if ('echec' in rep) return rep as { echec: EchecMcp };
        const err = objetOuNull(rep.error);
        if (err !== null) return refusRpc(err, 'liste refusée');
        const r = objetOuNull(rep.result);
        if (r === null) return { echec: { genre: 'protocole', message: 'tools/list sans résultat' } };
        for (const brut of Array.isArray(r.tools) ? r.tools : []) {
          const o = lireOutil(brut);
          // Une entrée illisible est écartée, jamais fatale : un outil mal formé ne coûte pas les autres.
          if (o !== null) outils.push(o);
          if (outils.length >= MAX_OUTILS) { tronque = true; break; }
        }
        if (tronque) break;
        curseur = typeof r.nextCursor === 'string' && r.nextCursor !== '' ? r.nextCursor : undefined;
        if (curseur === undefined) return { outils, tronque: false };
        if (page === MAX_PAGES - 1) tronque = true;
      }
      return { outils, tronque };
    },

    async appeler(nom, args) {
      const rep = await envoyer('tools/call', { name: nom, arguments: args }, true);
      if ('echec' in rep) return rep as { echec: EchecMcp };
      const err = objetOuNull(rep.error);
      if (err !== null) return refusRpc(err, 'appel refusé');
      const r = objetOuNull(rep.result);
      if (r === null) return { echec: { genre: 'protocole', message: 'appel sans résultat' } };
      return { texte: texteDeContenu(r.content), estErreur: r.isError === true };
    },

    async fermer() {
      if (sessionId === null) return;
      // Le serveur a le droit de refuser (405) : la session expirera d'elle-même.
      try {
        await appeler(cible.url, {
          method: 'DELETE',
          headers: enTetes(true),
          signal: AbortSignal.timeout(cible.timeoutMs),
          redirect: 'error',
        });
      } catch { /* fermer est un geste de politesse, pas une étape dont dépend le résultat */ }
    },
  };
}

/** Vérifie une annonce d'outil champ par champ. Rend `null` sur une entrée inutilisable. */
function lireOutil(brut: unknown): OutilAnnonce | null {
  const o = objetOuNull(brut);
  if (o === null) return null;
  if (typeof o.name !== 'string' || o.name.trim() === '') return null;
  return {
    name: o.name,
    ...(typeof o.title === 'string' ? { title: o.title } : {}),
    ...(typeof o.description === 'string' ? { description: o.description } : {}),
    // Aucune substitution : un `inputSchema` absent ou illisible passe tel quel, `aplatirSchema` le refusera avec
    // la raison affichée au client.
    inputSchema: o.inputSchema,
    ...(objetOuNull(o.outputSchema) !== null ? { outputSchema: objetOuNull(o.outputSchema)! } : {}),
    ...(objetOuNull(o.annotations) !== null ? { annotations: objetOuNull(o.annotations)! } : {}),
  };
}

/**
 * Le texte d'un résultat d'outil. Un bloc non textuel devient une mention, il ne disparaît pas : un texte qui paraît
 * complet mais amputé ferait répondre le modèle sur une base fausse.
 */
function texteDeContenu(contenu: unknown): string {
  if (!Array.isArray(contenu)) return '';
  const morceaux: string[] = [];
  for (const brut of contenu) {
    const b = objetOuNull(brut);
    if (b === null) continue;
    if (b.type === 'text' && typeof b.text === 'string') morceaux.push(b.text);
    else if (typeof b.type === 'string') morceaux.push(MENTION[b.type] ?? `[${b.type}]`);
  }
  return morceaux.join('\n');
}

/** Le refus d'un serveur MCP (une erreur JSON-RPC), avec son code et son message, ou le message par défaut. */
function refusRpc(e: Record<string, unknown>, parDefaut: string): { echec: EchecMcp } {
  return { echec: { genre: 'refus', code: typeof e.code === 'number' ? e.code : 0, message: String(e.message ?? parDefaut) } };
}
