import type { EntreeResolveur, ResolveurOutil, SortieResolveur } from '../executor';
import type { SourceStore } from '../sources';
import type { RequeteStore } from '../requetes';
import { construireCible, enTetesAuthSource } from '../http-cible';
import { resolutionPublique, type VerdictResolution } from '../../lib/adresse-privee';
import { lireCorpsBorne } from '../../lib/corps-borne';
import { assemblerAppel } from '../requete-http';
import { resoudreVariable, type ValeurResolue } from '../variables';

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
  /** La requête DÉSIGNÉE par l'outil (migration 0105) : méthode, chemin, corps, variables. */
  requetes: Pick<RequeteStore, 'parId'>;
  /**
   * Les valeurs que seule la base connaît, chargées PARESSEUSEMENT : ces fonctions ne sont appelées que si la
   * requête déclare une variable qui en dépend. Un connecteur qui n'envoie qu'un numéro ne doit pas coûter
   * deux requêtes de plus par appel, sur un chemin déjà chaud. Même raisonnement que `buildCtx` dans
   * l'exécuteur de scénario, qui ne construit son contexte que si le graphe s'en sert.
   *
   * ⚠️ Les CHAMPS PERSONNALISÉS ne sont pas dans cette liste, et ce n'est pas un oubli : la projection du
   * contact les porte déjà (`lireContact` rend `{nom, tags, champs}`), donc les recharger serait une requête
   * pour une donnée qu'on a sous la main.
   */
  derniereSaisie?: (tenantId: string, waId: string) => Promise<string | null>;
  fuseau?: (tenantId: string) => Promise<string>;
  /** Injecté pour tester sans réseau, comme partout dans ce dépôt. */
  fetchImpl?: typeof fetch;
  /** Injectée pour que la valeur système « maintenant » soit reproductible en test. */
  now?: () => Date;
  /** Injectée pour tester la garde de résolution sans DNS. Défaut : la vraie résolution. */
  verifierResolution?: (url: string) => Promise<VerdictResolution>;
}

/** Ce qu'on dit au modèle quand ça ne va pas. Volontairement pauvre : il n'a pas à savoir POURQUOI le système
 *  du client refuse, il a à savoir qu'il ne peut pas répondre depuis cette source. */
const MESSAGES: Record<string, string> = {
  auth: 'le système du client a refusé l’authentification de ce connecteur',
  indispo: 'le système du client n’a pas répondu',
  illisible: 'le système du client a répondu dans un format inattendu',
  trop_gros: 'la réponse du système du client est trop volumineuse',
  coupe: 'le système du client a interrompu sa réponse en cours d’envoi',
  redirige: 'le système du client a redirigé l’appel, ce qui n’est pas accepté sur un connecteur',
  interne: 'l’adresse de ce connecteur n’est pas joignable depuis notre infrastructure',
};

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

/**
 * CE QU'IL FAUT SAVOIR POUR APPELER UN CONNECTEUR, quel que soit l'appelant.
 *
 * 🔴 CE TYPE EXISTE PARCE QU'IL Y A DEUX APPELANTS DEPUIS LE 2026-09-11 : l'agent IA (qui a un outil et un
 * modèle qui fournit des arguments) et le bloc « appel HTTP » d'un scénario (qui n'a ni l'un ni l'autre).
 * Réécrire l'appel pour le second aurait dupliqué SEPT gardes (source active, filtre de sortie, variables
 * requises, adresse interne, redirection, échéance, corps borné), et la copie aurait divergé au premier
 * correctif. La leçon est celle d'`enTetesAuthSource`, payée deux fois dans ce dépôt.
 */
export interface AppelConnecteur {
  tenantId: string;
  waId: string;
  /**
   * Projection du contact (`{nom, tags, champs}`), source des variables `champ` et `contact`.
   *
   * ⚠️ MÊME TYPE QUE `ContexteAppel.contact` : `null` quand l'appelant n'a pas chargé la fiche, et l'appel
   * est alors REFUSÉ si une variable la réclame, jamais envoyé avec une valeur inventée.
   */
  contact: Record<string, unknown> | null;
  /** La requête à jouer (`connector_requests`). */
  requestId: string;
  /** Plafond de lecture du corps, en octets. */
  maxBytes: number;
  /**
   * Valeurs des variables d'origine `modele`.
   *
   * ⚠️ VIDE POUR UN SCÉNARIO, et ce n'est pas un manque : un scénario n'a pas de modèle qui décide. Une
   * requête qui déclare une variable `modele` REQUISE sera donc refusée avec sa raison, ce qui est le bon
   * comportement (l'appel partirait sinon sans l'identifiant qui le rend juste).
   */
  args: Record<string, unknown>;
  signal: AbortSignal;
}

/**
 * L'appel lui-même, partagé par l'agent IA et le bloc de scénario.
 *
 * Tout ce qui suit était le corps de `creerResolveurHttp`, déplacé tel quel : les deux appelants passent
 * donc par les mêmes gardes, dans le même ordre, avec les mêmes messages.
 */
export function creerAppelConnecteur(deps: DepsResolveurHttp): (p: AppelConnecteur) => Promise<SortieResolveur> {
  const appeler = deps.fetchImpl ?? fetch;
  const estPublique = deps.verifierResolution ?? ((url: string) => resolutionPublique(url));

  return async (p: AppelConnecteur): Promise<SortieResolveur> => {
    const { args, signal } = p;
    // Les deux locales gardent leur nom d'avant l'extraction : le corps ci-dessous n'a pas changé d'une ligne,
    // et c'est ce qui rend ce déplacement relisable.
    const ctx = { tenantId: p.tenantId, waId: p.waId, contact: p.contact };
    const outil = { requestId: p.requestId, maxBytes: p.maxBytes };

    // 1. LA REQUÊTE. Un outil de connecteur en DÉSIGNE une (migration 0105) : sans elle, il n'y a rien à
    // appeler. Un outil orphelin (requête supprimée malgré la contrainte) refuse au lieu d'inventer un appel.
    const requestId = typeof outil.requestId === 'string' ? outil.requestId : '';
    const requete = requestId === '' ? null : await deps.requetes.parId(ctx.tenantId, requestId);
    if (!requete) return { ok: false, contenu: { erreur: 'ce connecteur n’est pas configuré' }, erreur: 'requête introuvable' };

    // 2. LE FILTRE DE SORTIE, AVANT TOUT LE RESTE. Une requête sans `outputPaths` est une déclaration
    // incomplète (la route l'exige) : si l'on en trouve une quand même, elle ne divulgue RIEN plutôt que tout.
    if (!Array.isArray(requete.outputPaths) || requete.outputPaths.length === 0) {
      return { ok: false, contenu: { erreur: 'ce connecteur ne déclare aucun champ à lire' }, erreur: 'outputPaths vide' };
    }

    // 3. LA SOURCE. Absente, d'un autre tenant, ou pas active : aucun appel réseau ne part.
    const source = await deps.sources.pourAppel(ctx.tenantId, requete.sourceId);
    if (!source) return { ok: false, contenu: { erreur: 'ce connecteur n’est pas configuré' }, erreur: 'source introuvable' };
    if (source.status !== 'active') {
      return { ok: false, contenu: { erreur: 'ce connecteur n’est pas actif' }, erreur: `source ${source.status}` };
    }

    // 4. LES VALEURS. Celles du MODÈLE viennent de `args`, déjà validées par l'exécuteur ; les autres sont
    // calculées ici. Le chargement est paresseux : on ne va chercher les champs du contact, sa dernière
    // saisie ou le fuseau que si une variable les réclame vraiment.
    const besoin = (t: string, c?: string): boolean =>
      requete.variables.some((v) => v.origine.type === t && (c === undefined || (v.origine as { cle?: string }).cle === c));
    // Les champs personnalisés viennent de la projection, lue défensivement : elle est construite par
    // l'appelant, et un harnais de test peut légitimement l'abréger. Absents -> les variables `champ` valent
    // `null`, donc l'appel est REFUSÉ avec une raison lisible, jamais envoyé avec une valeur inventée.
    const brutChamps = ctx.contact ? (ctx.contact as { champs?: unknown }).champs : null;
    const champs = brutChamps !== null && typeof brutChamps === 'object' && !Array.isArray(brutChamps)
      ? (brutChamps as Record<string, unknown>) : null;
    const derniereSaisie = besoin('systeme', 'derniere_saisie') && deps.derniereSaisie
      ? await deps.derniereSaisie(ctx.tenantId, ctx.waId) : null;
    // Le fuseau ne sert qu'à « maintenant ». Sans dépendance fournie, on retombe sur UTC en le DISANT dans la
    // valeur (`+00:00`), plutôt que d'afficher une heure locale fausse.
    const fuseau = besoin('systeme', 'maintenant') && deps.fuseau ? await deps.fuseau(ctx.tenantId) : 'UTC';

    const contexte = {
      waId: ctx.waId, contact: ctx.contact, champs, derniereSaisie,
      maintenant: deps.now ? deps.now() : new Date(), fuseau,
    };
    const valeurs: Record<string, ValeurResolue> = {};
    for (const v of requete.variables) {
      valeurs[v.nom] = v.origine.type === 'modele'
        ? ((args[v.nom] ?? null) as ValeurResolue)
        : resoudreVariable(v.origine, contexte);
    }

    // 4bis. LES VARIABLES OBLIGATOIRES. Une valeur inconnue vaut `null`, ce qui est honnête, mais toutes les
    // absences ne se valent pas : « chercher les commandes de ce contact » sans son identifiant n'interroge
    // pas la bonne ressource, ou les interroge TOUTES. C'est `requis` qui tranche, et c'est au client de le
    // dire, requête par requête, parce que lui seul sait ce que son API fait d'un champ vide.
    const absentes = requete.variables.filter((v) => v.requis === true && (valeurs[v.nom] === null || valeurs[v.nom] === undefined));
    if (absentes.length > 0) {
      const noms = absentes.map((v) => v.nom).sort().join(', ');
      return {
        ok: false,
        // Le modèle doit pouvoir le DIRE au contact, donc le message lui parle de l'information manquante,
        // jamais de la configuration du connecteur, qu'il ne peut pas corriger.
        contenu: { erreur: `information manquante pour interroger le système du client : ${noms}` },
        erreur: `variables requises absentes : ${noms}`,
      };
    }

    // 5. L'ASSEMBLAGE. Adresse (avec ses gardes), paramètres d'URL, corps, en-têtes : un seul point de
    // passage, partagé avec le bouton « Test » de la console, pour que le test n'annonce jamais un appel que
    // l'exécution ne sait pas faire.
    const appel = assemblerAppel({
      baseUrl: source.baseUrl, methode: requete.methode, chemin: requete.chemin,
      parametres: requete.parametres, entetes: requete.entetes, corps: requete.corps,
      valeurs, construireCible,
    });
    if (!appel.ok) return { ok: false, contenu: { erreur: 'ce connecteur est mal configuré' }, erreur: appel.raison };

    // 5bis. OÙ CE NOM MÈNE-T-IL VRAIMENT ? `construireCible` a déjà refusé les hôtes internes et tous les
    // littéraux d'adresse, y compris leurs formes exotiques. Elle lit le TEXTE, donc elle ne peut rien contre
    // `crm.exemple.fr` dont l'enregistrement A pointe sur `169.254.169.254` (les métadonnées du fournisseur)
    // ou sur `172.18.x.x` (le réseau Docker du VPS, où vivent l'admin NPM et tous les autres conteneurs).
    // Placée ICI, après l'assemblage et avant l'appel : c'est l'URL FINALE qu'il faut vérifier, pas l'adresse
    // de base, puisque le gabarit peut en changer l'hôte si une garde d'assemblage venait à tomber.
    const resolution = await estPublique(appel.url);
    if (!resolution.ok) {
      await deps.sources.marquerEpreuve(ctx.tenantId, source.id, false, 'adresse interne').catch(() => {});
      return { ok: false, contenu: { erreur: MESSAGES.interne }, erreur: `resolution_interne: ${resolution.raison ?? '?'}` };
    }

    // 6. L'APPEL. Le secret n'existe que dans cet objet d'en-têtes, et n'en sort pas. ⚠️ L'authentification
    // est superposée EN DERNIER : aucun en-tête saisi dans la requête ne peut la recouvrir, même si la garde
    // de saisie venait à tomber.
    const headers = { ...appel.entetes, ...enTetesAuthSource(source) };

    let res: Response;
    try {
      res = await appeler(appel.url, {
        method: appel.methode,
        headers,
        ...(appel.corps !== null ? { body: appel.corps } : {}),
        redirect: 'error',
        signal,
      });
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

    // 7. LE CORPS, BORNÉ. Le plafond est vérifié sur ce qu'on a LU, pas sur `content-length` : un serveur peut
    // mentir. Au-delà, on refuse plutôt que de tronquer : un JSON tronqué est illisible de toute façon, et
    // remplirait le contexte du modèle pour rien.
    // ⚠️ Le plafond était vérifié APRÈS `res.text()`, donc après avoir tout chargé en mémoire, et il comptait
    // des unités UTF-16 et non des octets (un corps d'idéogrammes passait à deux ou trois fois sa taille
    // réelle). La lecture est désormais bornée EN FLUX : on coupe à l'octet qui dépasse.
    const corps = await lireCorpsBorne(res, outil.maxBytes);
    if (corps.trop_gros) {
      return { ok: false, contenu: { erreur: MESSAGES.trop_gros }, erreur: 'trop_gros', httpStatus: res.status };
    }
    /**
     * 🔴 UN FLUX COUPÉ MARQUAIT LA SOURCE COMME SAINE (2026-09-04), et ce n'est PAS le défaut que ce correctif
     * a d'abord prétendu fermer. La première version de ce commentaire affirmait que le modèle recevait un
     * faux succès : c'est faux sur CE chemin, et il a fallu le mesurer pour s'en apercevoir. Un corps vide
     * fait lever `JSON.parse('')`, donc l'étape 9 attrapait déjà le cas et rendait `ok: false / illisible`.
     * Le modèle n'a jamais rien conclu de travers ici.
     *
     * Ce qui était réellement cassé est plus discret et plus durable : ce même `catch` appelle
     * `marquerEpreuve(..., true)`, donc une source dont la connexion LÂCHE à chaque appel était marquée SAINE
     * dans la console, et sa dernière erreur effacée. Le connecteur mourait sans que rien ne devienne rouge,
     * ce qui est exactement ce que `marquerEpreuve` existe pour empêcher.
     *
     * ⚠️ La leçon vaut plus que la ligne : **un correctif juste peut porter une justification fausse**, et une
     * justification fausse est pire qu'aucune, parce qu'elle sera recopiée. Celle-ci a été trouvée par une
     * relecture adverse qui a EXÉCUTÉ le chemin, pas par une relecture qui l'a lu.
     */
    if (corps.casse) {
      // Marquée en ÉCHEC, comme ses voisines « injoignable » et « redirection refusée » : c'est ce qui rend un
      // connecteur mort visible dans la console avant qu'un contact ne le découvre.
      await deps.sources.marquerEpreuve(ctx.tenantId, source.id, false, 'réponse interrompue').catch(() => {});
      // Clé de journal DISTINCTE d'`illisible` : sans elle, la seule trace persistante ne séparait toujours
      // pas une coupure de connexion d'un JSON invalide, qui est pourtant l'objet même de ce drapeau.
      return { ok: false, contenu: { erreur: MESSAGES.coupe }, erreur: 'coupe', httpStatus: res.status };
    }
    const brut = corps.texte;

    // 8. LE STATUT. Un 4xx/5xx est un échec MÉTIER : le modèle doit le savoir, sans le corps brut de l'erreur
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

    // 9. LE FILTRE. Ce qui repart au modèle est EXACTEMENT ce que le client a listé, et rien d'autre.
    let json: unknown;
    try {
      json = JSON.parse(brut) as unknown;
    } catch {
      await deps.sources.marquerEpreuve(ctx.tenantId, source.id, true).catch(() => {});
      return { ok: false, contenu: { erreur: MESSAGES.illisible }, erreur: 'illisible', httpStatus: res.status };
    }
    const contenu: Record<string, unknown> = {};
    for (const chemin of requete.outputPaths) {
      const v = extraire(json, chemin);
      if (v !== undefined) contenu[chemin] = v;
    }
    await deps.sources.marquerEpreuve(ctx.tenantId, source.id, true).catch(() => {});
    return { contenu, httpStatus: res.status };
  };
}

/**
 * Le résolveur d'OUTIL D'AGENT : un adaptateur au-dessus de `creerAppelConnecteur`.
 *
 * ⚠️ Il ne reste ici que la TRADUCTION d'un appel d'outil en appel de connecteur. Tout ce qui décide vit dans
 * la fonction partagée, donc un correctif de garde profite aux deux appelants sans qu'on ait à y penser.
 */
export function creerResolveurHttp(deps: DepsResolveurHttp): ResolveurOutil {
  const appel = creerAppelConnecteur(deps);
  return async (entree: EntreeResolveur): Promise<SortieResolveur> => appel({
    tenantId: entree.ctx.tenantId,
    waId: entree.ctx.waId,
    contact: entree.ctx.contact,
    requestId: typeof entree.outil.requestId === 'string' ? entree.outil.requestId : '',
    maxBytes: entree.outil.maxBytes,
    args: entree.args,
    signal: entree.signal,
  });
}
