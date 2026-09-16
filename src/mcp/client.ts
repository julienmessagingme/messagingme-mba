import { lireCorpsBorne } from '../lib/corps-borne';
// ⚠️ LES DEUX VIENNENT DU SERVEUR, ET C'EST DÉLIBÉRÉ : c'est le MÊME produit, qui parle la MÊME révision du
// protocole des deux côtés. Les recopier ici créerait deux vérités, et le jour où l'une des deux bouge,
// on parlerait une révision en serveur et une autre en client sans que rien ne le signale. L'alias dit
// simplement qu'ici, cette identité est celle du CLIENT.
import { VERSION_PROTOCOLE, SERVEUR_INFO as IDENTITE_PRODUIT } from './serveur';

/**
 * Le CLIENT MCP : Engage Me va chercher des outils chez un TIERS.
 *
 * 🔴 NE PAS CONFONDRE AVEC `serveur.ts`, QUI VA DANS L'AUTRE SENS. Celui-là expose nos outils à Claude ou
 * ChatGPT ; celui-ci nous rend consommateur d'un serveur que nous ne contrôlons pas. Tout ce qui en sort est
 * du tiers : chaque champ est vérifié avant d'être cru, jamais un `as` sur une réponse.
 *
 * 🔴 UN APPEL N'EST PAS UN POST ISOLÉ, et c'est le fait qui décide de la forme de ce module. La spec impose
 * `initialize` puis la notification `notifications/initialized` avant toute autre requête, et si le serveur
 * assigne un `Mcp-Session-Id`, il DOIT être porté par tout ce qui suit. D'où une session, ouverte pour une
 * opération et jetée après.
 *
 * ⚠️ ELLE N'EST JAMAIS MISE EN CACHE ENTRE DEUX OPÉRATIONS. L'API et le worker sont deux process, le
 * déploiement en lance d'autres, et un identifiant de session partagé entre deux process rend un 404 qu'il
 * faudrait rattraper. Le coût assumé est de deux allers-retours au premier appel d'un tour, dans un budget
 * qui est déjà de 8 secondes par outil.
 *
 * 🔴 ÉCRIT À LA MAIN, comme le serveur, et pour la même raison écrite là-bas : la surface dont on a besoin
 * tient en quatre méthodes, et une dépendance qu'on n'utilise qu'à 10 % est une dépendance qu'on subira à
 * 100 % le jour où elle changera de contrat.
 */

/** Ce qu'il faut pour joindre un serveur. `enTetes` porte l'authentification, construite par l'appelant. */
export interface CibleMcp {
  /** L'adresse du POINT MCP (l'endpoint unique), pas une racine sous laquelle on composerait un chemin. */
  url: string;
  enTetes: Record<string, string>;
  /** Échéance d'UNE requête. */
  timeoutMs: number;
  /**
   * Échéance de toute l'OPÉRATION, et elle est REQUISE.
   *
   * 🔴 SANS ELLE, `lister()` VAUT VINGT FOIS `timeoutMs`. L'échéance de `fetch` est par requête : un
   * catalogue paginé sur vingt pages à huit secondes tiendrait la route d'import cent soixante secondes,
   * bien au delà de ce qu'une passerelle laisse passer, et l'appelant n'aurait rien pour le borner.
   *
   * ⚠️ Elle n'a pas de défaut, délibérément : seul l'appelant sait son budget, et il n'est pas le même
   * pour un tour d'agent en conversation et pour un import déclenché par un administrateur.
   */
  budgetTotalMs: number;
  maxOctets: number;
}

/** Un outil tel que le serveur l'annonce. Les champs optionnels le sont dans la spec. */
export interface OutilAnnonce {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  /**
   * ⚠️ NON FIABLES, LA SPEC LE DIT EXPRESSÉMENT : « clients MUST consider tool annotations to be untrusted
   * unless they come from trusted servers ». Elles servent à PRÉ-REMPLIR ce qu'on propose au client, jamais
   * à décider à sa place.
   */
  annotations?: Record<string, unknown>;
}

export type EchecMcp =
  /** Le serveur ne parle que l'ancien transport HTTP+SSE de la révision 2024-11-05. */
  | { genre: 'transport_ancien' }
  | { genre: 'reseau'; message: string }
  /** Réponse illisible, corps trop gros, flux cassé : ce qui n'est ni un refus ni une panne réseau. */
  | { genre: 'protocole'; message: string }
  | { genre: 'refus'; code: number; message: string };

export type ResultatAppel = { texte: string; estErreur: boolean } | { echec: EchecMcp };

export interface SessionMcp {
  /**
   * Toutes les pages suivies. `tronque` dit qu'on a buté sur une borne, et il doit remonter à l'écran.
   *
   * 🔴 UNE PAGE QUI ÉCHOUE REND UN ÉCHEC, JAMAIS LA LISTE PARTIELLE, et c'est ce qui rend l'import sûr.
   * Un appelant qui recevrait les outils de la page 1 après un échec en page 2 les prendrait pour le
   * catalogue ENTIER : le rafraîchissement marquerait alors « disparus » tous les outils de la page 2 et
   * ferait tomber leur consentement. Une panne réseau d'une seconde débrancherait la moitié des outils
   * d'un client, sans que rien ne le dise.
   *
   * 🔴 ET `tronque: true` PORTE EXACTEMENT LE MÊME DANGER PAR L'AUTRE PORTE. La liste est alors RÉELLEMENT
   * partielle, légitimement (le serveur annonce plus d'outils que nos bornes), mais elle reste partielle :
   * **un appelant qui supprime ou marque « disparu » ce qui n'y figure pas se trompe de la même façon.**
   * Le contrat est donc : sur `tronque`, on AJOUTE et on MET À JOUR, on ne RETIRE jamais. Ce n'est pas une
   * recommandation, c'est la seule lecture correcte de ce drapeau, et un test de l'import la tient.
   */
  lister(): Promise<{ outils: OutilAnnonce[]; tronque: boolean } | { echec: EchecMcp }>;
  appeler(nom: string, args: Record<string, unknown>): Promise<ResultatAppel>;
  fermer(): Promise<void>;
}

/**
 * Bornes de la pagination.
 *
 * 🔴 ELLES EXISTENT PARCE QU'UN CURSEUR VIENT DU TIERS : un serveur qui rend toujours un `nextCursor` nous
 * ferait boucler jusqu'au bout du budget. Les atteindre pose `tronque`, et l'écran le dit. Un plafond
 * silencieux se lit comme une couverture complète.
 */
const MAX_PAGES = 20;
const MAX_OUTILS = 500;

/**
 * Les en-têtes que la configuration d'un client ne peut pas poser.
 *
 * ⚠️ Ce ne sont pas des interdits de politesse : chacun porte une décision de PROTOCOLE, et un client qui
 * en écraserait un casserait la connexion sans qu'aucune erreur ne le nomme.
 */
const RESERVES = ['content-type', 'accept', 'mcp-protocol-version', 'mcp-session-id'] as const;

/** Ce qu'un bloc de contenu non textuel devient dans le texte rendu au modèle. */
const MENTION: Record<string, string> = {
  image: '[image]',
  audio: '[audio]',
  resource: '[ressource]',
  resource_link: '[lien vers une ressource]',
};

function objet(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null;
}

/**
 * Lit une réponse et en extrait le message JSON-RPC portant `id`.
 *
 * 🔴 DEUX TYPES DE CORPS, ET LE CLIENT DOIT SAVOIR LIRE LES DEUX : la spec autorise le serveur à répondre
 * `application/json` OU `text/event-stream` à un POST, au choix. Un client qui ne sait lire que du JSON
 * tombe donc en marche sur une moitié des serveurs conformes, sans que rien ne l'explique.
 *
 * ⚠️ LE FLUX EST LU JUSQU'AU MESSAGE ATTENDU, PAS JUSQU'À LA FIN. Le serveur a le droit d'envoyer des
 * notifications avant la réponse, et il n'est que SUPPOSÉ fermer le flux après. Lire jusqu'à la fermeture
 * ferait donc attendre l'échéance entière à un serveur qui tient son flux ouvert, et transformerait une
 * réponse reçue en délai dépassé.
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
    // Un flux coupé n'est pas un corps vide : sans cette distinction, on annoncerait un succès sur une
    // lecture ratée (c'est la raison d'être du drapeau `casse`).
    if (corps.casse) return { echec: { genre: 'protocole', message: 'la réponse a été coupée en cours de lecture' } };
    try {
      const m = objet(JSON.parse(corps.texte));
      if (m === null) return { echec: { genre: 'protocole', message: 'réponse JSON-RPC attendue' } };
      // ⚠️ L'IDENTIFIANT SE VÉRIFIE ICI AUSSI. Le chemin en flux le fait déjà, parce qu'il doit choisir
      // parmi plusieurs messages ; celui-ci ne le faisait pas, et l'asymétrie n'avait aucune raison d'être.
      // Un serveur qui répond à côté rendrait alors un résultat qu'on prendrait pour le nôtre.
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

      // Les événements sont séparés par une ligne vide. On ne traite que les complets ; un événement à
      // cheval sur deux morceaux reste dans le tampon.
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
            const m = objet(JSON.parse(donnees));
            // On s'arrête au message qui répond À NOTRE requête : tout ce qui précède est une notification
            // ou une requête du serveur, dont un consommateur d'outils n'a rien à faire.
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

export function ouvrirSessionMcp(
  cible: CibleMcp,
  /** `now` est injectée pour que le budget soit reproductible en test, comme ailleurs dans ce dépôt. */
  opts: { fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<SessionMcp | { echec: EchecMcp }> {
  return ouvrir(cible, opts.fetchImpl ?? fetch, opts.now ?? (() => Date.now()));
}

async function ouvrir(
  cible: CibleMcp,
  appeler: typeof fetch,
  maintenant: () => number,
): Promise<SessionMcp | { echec: EchecMcp }> {
  let prochainId = 1;
  let sessionId: string | null = null;
  let version = VERSION_PROTOCOLE;
  // L'échéance de l'OPÉRATION ENTIÈRE, posée une fois : l'initialisation, la pagination et les appels
  // puisent dedans. C'est elle qui empêche vingt pages de valoir vingt fois l'échéance d'une requête.
  const finAbsolue = maintenant() + cible.budgetTotalMs;

  /**
   * Les en-têtes d'une requête. `apresInit` ajoute ce que la spec n'autorise qu'ensuite.
   *
   * 🔴 LES EN-TÊTES DE PROTOCOLE SONT POSÉS EN DERNIER, ET L'ORDRE EST LA GARDE. Ceux de l'appelant
   * viennent de la configuration du CLIENT (`auth_header_name` est un texte qu'il saisit) : étalés en
   * dernier, ils écraseraient `Accept`, et nous deviendrions incapables de lire une réponse en flux sans
   * qu'aucune erreur ne le dise. Leurs clés sont mises en minuscules avant d'être posées, sinon un
   * `Accept` majuscule ne collisionnerait avec rien dans l'objet et partirait EN DOUBLE.
   */
  function enTetes(apresInit: boolean): Record<string, string> {
    const duClient: Record<string, string> = {};
    for (const [k, v] of Object.entries(cible.enTetes)) duClient[k.toLowerCase()] = v;
    for (const reserve of RESERVES) delete duClient[reserve];
    return {
      ...duClient,
      'content-type': 'application/json',
      // 🔴 LES DEUX, TOUJOURS. La spec l'impose (« MUST include an Accept header, listing both »), et c'est
      // ce qui autorise le serveur à répondre en flux : ne pas l'annoncer ferait échouer des serveurs
      // parfaitement conformes.
      accept: 'application/json, text/event-stream',
      ...(apresInit ? { 'mcp-protocol-version': version } : {}),
      // Jamais d'en-tête vide : un serveur qui exige une session répondrait 400 à un identifiant vide,
      // et notre propre serveur, sans état, n'en assigne aucun.
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
      return { echec: { genre: 'protocole', message: 'le budget de l’opération est épuisé' } };
    }
    let res: Response;
    try {
      res = await appeler(cible.url, {
        method: 'POST',
        headers: enTetes(apresInit),
        body: JSON.stringify({ jsonrpc: '2.0', id, method: methode, ...(params ? { params } : {}) }),
        // Le plus court des deux : l'échéance de CETTE requête, et ce qui reste du budget de l'opération.
        signal: AbortSignal.timeout(Math.min(cible.timeoutMs, restant)),
        // Une API qui redirige est une anomalie, et la suivre rouvrirait la porte que la garde d'adresse
        // vient de fermer : le premier saut est validé, le second ne l'est plus.
        redirect: 'error',
      });
    } catch (err) {
      return { echec: { genre: 'reseau', message: err instanceof Error ? err.message : 'appel impossible' } };
    }
    if (!res.ok) {
      // Le corps d'une réponse qu'on n'exploite pas se JETTE explicitement : sans ça, la connexion reste
      // retenue jusqu'au ramasse-miettes, et un import qui enchaîne vingt pages en laisse vingt derrière lui.
      await res.body?.cancel().catch(() => {});
      return { echec: { genre: 'refus', code: res.status, message: `le serveur a répondu ${res.status}` } };
    }
    return lireReponse(res, id, cible.maxOctets);
  }

  /** Une NOTIFICATION : pas d'identifiant, donc pas de réponse. Le serveur doit rendre 202 sans corps. */
  async function notifier(methode: string): Promise<void> {
    try {
      const res = await appeler(cible.url, {
        method: 'POST',
        headers: enTetes(true),
        body: JSON.stringify({ jsonrpc: '2.0', method: methode }),
        signal: AbortSignal.timeout(cible.timeoutMs),
        redirect: 'error',
      });
      // La réponse attendue est un 202 SANS corps, mais un serveur peut en mettre un. On le jette, sinon
      // la connexion reste retenue pour une réponse qu'on n'a par définition pas à lire.
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
    return { echec: { genre: 'reseau', message: err instanceof Error ? err.message : 'appel impossible' } };
  }

  if (!premiereReponse.ok) {
    await premiereReponse.body?.cancel().catch(() => {});
    // 🔴 405 ET 404 SONT LA SIGNATURE DE L'ANCIEN TRANSPORT, et la spec la décrit telle quelle : un serveur
    // resté en 2024-11-05 n'accepte pas de POST sur son endpoint, il attend un GET qui ouvre un flux. On le
    // NOMME plutôt que d'échouer en silence ou de basculer sur un transport qu'on a choisi de ne pas parler.
    //
    // ⚠️ MAIS PAS TOUTE ERREUR 4xx : un 401 est un jeton refusé. Les confondre enverrait le client corriger
    // son adresse alors que c'est son secret qui est en cause.
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
  if (objet(init.error) !== null) {
    const e = objet(init.error)!;
    return { echec: { genre: 'refus', code: typeof e.code === 'number' ? e.code : 0, message: String(e.message ?? 'initialisation refusée') } };
  }
  const resultat = objet(init.result);
  if (resultat === null) return { echec: { genre: 'protocole', message: 'initialisation sans résultat' } };
  if (typeof resultat.protocolVersion === 'string' && resultat.protocolVersion !== '') {
    // On ÉCHO la version que le serveur a retenue : c'est ce que la négociation demande, et c'est elle
    // qui doit voyager dans l'en-tête de toutes les requêtes suivantes.
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
        // 🔴 ON PROPAGE, ON NE REND PAS CE QU'ON A. Rendre une liste partielle ferait prendre la page 1
        // pour le catalogue entier, et le rafraîchissement déclarerait « disparu » tout le reste.
        if ('echec' in rep) return rep as { echec: EchecMcp };
        const err = objet(rep.error);
        if (err !== null) {
          return { echec: { genre: 'refus', code: typeof err.code === 'number' ? err.code : 0, message: String(err.message ?? 'liste refusée') } };
        }
        const r = objet(rep.result);
        if (r === null) return { echec: { genre: 'protocole', message: 'tools/list sans résultat' } };
        for (const brut of Array.isArray(r.tools) ? r.tools : []) {
          const o = lireOutil(brut);
          // Une entrée illisible est ÉCARTÉE, jamais fatale : le catalogue vient d'un tiers, et perdre les
          // quinze outils valides à cause d'un seizième mal formé serait le pire des comportements.
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
      const err = objet(rep.error);
      if (err !== null) {
        return {
          echec: {
            genre: 'refus',
            code: typeof err.code === 'number' ? err.code : 0,
            message: String(err.message ?? 'appel refusé'),
          },
        };
      }
      const r = objet(rep.result);
      if (r === null) return { echec: { genre: 'protocole', message: 'appel sans résultat' } };
      return { texte: texteDeContenu(r.content), estErreur: r.isError === true };
    },

    async fermer() {
      if (sessionId === null) return;
      // Le serveur a le droit de refuser (405) : on n'a rien à en faire, la session expirera d'elle-même.
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
  const o = objet(brut);
  if (o === null) return null;
  if (typeof o.name !== 'string' || o.name.trim() === '') return null;
  const entree = objet(o.inputSchema);
  return {
    name: o.name,
    ...(typeof o.title === 'string' ? { title: o.title } : {}),
    ...(typeof o.description === 'string' ? { description: o.description } : {}),
    // Un outil sans schéma d'entrée est un outil sans paramètre : l'objet vide est la lecture juste, et
    // c'est l'aplatisseur qui dira s'il est activable.
    inputSchema: entree ?? { type: 'object', properties: {} },
    ...(objet(o.outputSchema) !== null ? { outputSchema: objet(o.outputSchema)! } : {}),
    ...(objet(o.annotations) !== null ? { annotations: objet(o.annotations)! } : {}),
  };
}

/**
 * Le texte d'un résultat d'outil.
 *
 * ⚠️ UN BLOC NON TEXTUEL DEVIENT UNE MENTION, il ne disparaît pas. Le jeter rendrait un texte qui paraît
 * complet alors qu'il manque la moitié de la réponse, et le modèle répondrait au contact sur cette base.
 * La spec prévoit par ailleurs qu'un outil rendant du contenu structuré en rende AUSSI la forme sérialisée
 * dans un bloc texte, donc le texte porte l'essentiel dans le cas général.
 */
function texteDeContenu(contenu: unknown): string {
  if (!Array.isArray(contenu)) return '';
  const morceaux: string[] = [];
  for (const brut of contenu) {
    const b = objet(brut);
    if (b === null) continue;
    if (b.type === 'text' && typeof b.text === 'string') morceaux.push(b.text);
    else if (typeof b.type === 'string') morceaux.push(MENTION[b.type] ?? `[${b.type}]`);
  }
  return morceaux.join('\n');
}
