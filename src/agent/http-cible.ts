import { urlRecuperable } from '../lib/page-distante';
import type { RisqueOutil } from './catalog';

/**
 * L'URL FINALE d'un appel de connecteur, et le risque qu'une méthode HTTP porte.
 *
 * 🔴 C'EST LA GARDE DU LOT L2. Le serveur vit dans le réseau Docker du VPS : il voit l'admin NPM, les autres
 * conteneurs et le service de métadonnées du fournisseur. Une adresse mal contrôlée fait d'un connecteur
 * client un lecteur de l'intérieur. Et une valeur de paramètre mal encodée fait d'un gabarit de chemin un
 * IDOR : la valeur vient du MODÈLE, donc d'un texte qu'un contact influence, et il suffirait de demander à
 * l'agent la commande de quelqu'un d'autre.
 *
 * Module PUR, sans réseau ni base : tout se teste, et `tests/agent-http-cible.test.ts` l'éprouve garde par
 * garde. Il est le seul endroit où une URL de connecteur se construit.
 */

/** Les méthodes du lot. Volontairement fermé : `CONNECT` et `TRACE` n'ont rien à faire sur un connecteur. */
export const METHODES = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type MethodeConnecteur = (typeof METHODES)[number];

export interface CibleConstruite {
  ok: true;
  url: string;
  methode: MethodeConnecteur;
}
export interface CibleRefusee {
  ok: false;
  /** Lisible par le CLIENT (elle remonte dans la console) et par le modèle. Ne cite jamais un secret. */
  raison: string;
}

function estMethode(v: unknown): v is MethodeConnecteur {
  return typeof v === 'string' && (METHODES as readonly string[]).includes(v);
}

/**
 * Une valeur de paramètre utilisable dans un chemin. Les objets et les tableaux sont refusés : ils n'ont pas
 * de représentation évidente dans une URL, et `String({})` produirait `[object Object]`, c'est-à-dire un
 * appel silencieusement faux plutôt qu'un refus lisible.
 */
function valeurDeChemin(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() === '' ? null : v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return String(v);
  return null;
}

/** Découpe l'URL en segments non vides. Sert à vérifier que la cible reste SOUS la base, segment par segment. */
function segments(chemin: string): string[] {
  return chemin.split('/').filter((s) => s !== '');
}

/**
 * `{{ nom }}` (noms à points et tirets, comme dans le corps) ou `{nom}`. Voir l'étape 2 de `construireCible`.
 * ⚠️ Expression `/g` PARTAGÉE (`requete-http.ts` l'inventorie) : `replace` et `matchAll` s'en accommodent, un
 * `.test()` ou un `.exec()` laisserait un `lastIndex` qui fausserait l'appelant suivant.
 */
export const VARIABLE_DE_CHEMIN = /\{\{\s*([\w.-]+)\s*\}\}|\{([a-zA-Z0-9_]+)\}/g;

/**
 * Construit l'URL finale, ou refuse en le disant.
 *
 * QUATRE GARDES, dans cet ordre, et aucune n'est facultative :
 *  1. l'adresse de base est HTTPS et passe `urlRecuperable` (pas d'hôte interne, pas de littéral privé) ;
 *  2. chaque `{{param}}` ou `{param}` est remplacé par une valeur ENCODÉE : sans ça, une valeur contenant `/`
 *     change le chemin, et une valeur contenant `?` ajoute des paramètres de requête que personne n'a prévus.
 *     Une valeur `.` ou `..` est REFUSÉE : l'encodage laisse passer les points, et `new URL` résout ces
 *     segments, donc `/commandes/{{ref}}` avec `ref = '.'` appelait `/commandes/`, le trou de la garde 4 ;
 *  3. l'URL résultante reste SOUS l'adresse de base, même origine ET même préfixe de segments : c'est ce qui
 *     survit à un `..` du GABARIT, écrit par l'administrateur et donc jamais encodé ;
 *  4. un gabarit qui référence un paramètre absent est un REFUS, jamais un chemin à trou : `/commandes/`
 *     appellerait la liste ENTIÈRE des commandes du client, et l'agent la lirait.
 */
export function construireCible(input: {
  baseUrl: string;
  binding: { methode: string; chemin: string };
  args: Record<string, unknown>;
}): CibleConstruite | CibleRefusee {
  const { baseUrl, binding, args } = input;

  if (!estMethode(binding.methode)) return { ok: false, raison: `méthode non acceptée : ${String(binding.methode)}` };

  // 1. L'adresse de base. `urlRecuperable` porte déjà le refus des hôtes internes et des littéraux privés :
  // elle est IMPORTÉE, pas recopiée, sinon un durcissement appliqué d'un seul côté serait silencieux.
  const brute = String(baseUrl ?? '').trim();
  if (!urlRecuperable(brute)) return { ok: false, raison: 'adresse de base refusée (elle doit être publique)' };
  let base: URL;
  try {
    base = new URL(brute);
  } catch {
    return { ok: false, raison: 'adresse de base illisible' };
  }
  // HTTPS SEULEMENT : en clair, le secret d'authentification voyagerait en clair. `urlRecuperable` accepte
  // http (elle sert aussi à lire une page publique), c'est donc ici que la restriction se pose.
  if (base.protocol !== 'https:') return { ok: false, raison: 'adresse de base : HTTPS obligatoire' };

  // 2. Le gabarit, paramètre par paramètre. Une valeur manquante refuse.
  // 🔴 LES DEUX FORMES (2026-09-23) : `{nom}`, historique des outils d'agent IA, et `{{nom}}`, celle que la pastille
  // de l'écran des Connecteurs API insère, comme partout ailleurs dans une requête. Seule la première était
  // lue : dans `/users/{{id}}`, l'accolade intérieure était remplacée et l'extérieure partait telle quelle,
  // donc l'appel visait `/users/%7B123%7D`. La forme double se lit EN PREMIER, sinon la simple la mangerait.
  let manquant: string | null = null;
  let pointe: string | null = null;
  const chemin = String(binding.chemin ?? '').trim().replace(VARIABLE_DE_CHEMIN, (_m, double: string | undefined, simple: string | undefined) => {
    const nom = (double ?? simple)!;
    const v = valeurDeChemin(args[nom]);
    if (v === null) { manquant = nom; return ''; }
    // 🔴 `.` et `..` : un segment que `new URL` RÉSOUT (revue du 2026-09-23). La valeur vient du modèle.
    if (v === '.' || v === '..') { pointe = nom; return ''; }
    return encodeURIComponent(v);
  });
  if (manquant !== null) return { ok: false, raison: `paramètre « ${manquant} » manquant` };
  if (pointe !== null) return { ok: false, raison: `paramètre « ${pointe} » refusé : « . » et « .. » déplaceraient l’appel dans le chemin` };
  if (chemin === '') return { ok: false, raison: 'chemin vide' };
  // Un gabarit qui RESSEMBLE à une adresse (schéma explicite, ou `//hote` relatif au protocole) est refusé
  // plutôt que rattaché sous la base. Le rattacher en silence transformerait `//evil.test/x` en segment de
  // chemin : personne n'a voulu ça, c'est une faute de saisie de l'administrateur, et on la lui dit.
  if (/^[a-z][a-z0-9+.-]*:/i.test(chemin) || chemin.startsWith('//')) {
    // ⚠️ LE MESSAGE DIT LE GESTE, PAS SEULEMENT LA RÈGLE (2026-09-15). « Le chemin doit être relatif à
    // l'adresse de base » est vrai et n'apprend rien à qui vient de coller l'adresse de sa documentation :
    // l'adresse de base est DÉJÀ déclarée sur le système, il ne faut garder que ce qui la suit.
    return {
      ok: false,
      raison: 'le chemin ne doit pas contenir d’adresse complète : l’adresse du système est déjà déclarée, '
        + 'ne gardez que ce qui la suit (par exemple « /subscriber/add-tag »)',
    };
  }

  // 3. La cible. `new URL(chemin, base)` résout les `..` du gabarit ET une adresse absolue : les deux sont
  // rattrapés par la comparaison de segments juste après.
  const cheminBase = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
  let cible: URL;
  try {
    cible = new URL(chemin.replace(/^\/+/, ''), `${base.origin}${cheminBase}`);
  } catch {
    return { ok: false, raison: 'chemin illisible' };
  }
  if (cible.origin !== base.origin) return { ok: false, raison: 'le chemin sort de l’adresse de base' };
  const attendus = segments(base.pathname);
  const obtenus = segments(cible.pathname);
  if (obtenus.length < attendus.length || attendus.some((s, i) => obtenus[i] !== s)) {
    return { ok: false, raison: 'le chemin sort de l’adresse de base' };
  }

  return { ok: true, url: cible.toString(), methode: binding.methode };
}

/**
 * Les en-têtes d'authentification d'une source, construits en UN endroit.
 *
 * 🔴 POINT DE PASSAGE OBLIGÉ. Deux appelants les posent : le résolveur (l'appel d'un outil) et l'épreuve de
 * source (le bouton « Éprouver » de la console). Écrits deux fois, un troisième mode d'authentification
 * ajouté un jour ne serait branché que d'un côté, et l'épreuve dirait « ça répond » d'une source que les
 * appels réels ne savent pas authentifier. C'est exactement la divergence que l'audit du 2026-08-18 a payée
 * une centaine de fois.
 *
 * ⚠️ Le secret ne sort PAS de l'objet rendu : il ne doit apparaître ni dans un journal, ni dans un message
 * d'erreur, ni dans ce qui repart au modèle.
 */
export function enTetesAuthSource(source: {
  authKind: 'none' | 'bearer' | 'header'; authSecret: string | null; authHeaderName: string | null;
}): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (source.authKind === 'bearer' && source.authSecret) headers.authorization = `Bearer ${source.authSecret}`;
  // 🔴 EN MINUSCULES, comme `assemblerAppel` range ceux de la requête (revue du 2026-09-23). Sinon un en-tête de
  // requête `x-api-key` et celui de la source `X-Api-Key` sont deux clés : le secret ne l'ÉCRASE pas, `Headers`
  // les FUSIONNE (« valeur, secret »), et la première moitié peut venir du modèle.
  if (source.authKind === 'header' && source.authSecret && source.authHeaderName) headers[source.authHeaderName.toLowerCase()] = source.authSecret;
  return headers;
}

/**
 * Le risque qu'une méthode porte, décision D-L2-1 (tranchée le 2026-08-28).
 *
 * 🔴 IL EST DÉRIVÉ, PAS DÉCLARÉ. Pour un outil maison, le risque vient du catalogue et le client ne le règle
 * pas : il règle l'autonomie, pas la dangerosité. Un connecteur n'a pas de catalogue, mais laisser le client
 * déclarer librement lui permettrait de marquer `read` un `DELETE`, donc de désarmer la garde d'autonomie sur
 * une action irréversible. Il peut MONTER le risque (son `GET` interroge un système sensible), jamais le
 * descendre.
 */
export function risqueSelonMethode(methode: MethodeConnecteur): RisqueOutil {
  if (methode === 'GET') return 'read';
  if (methode === 'DELETE') return 'irreversible';
  return 'write';
}

const ECHELLE: Record<RisqueOutil, number> = { read: 0, write: 1, irreversible: 2 };

/** `declare` est-il au moins aussi prudent que `plancher` ? */
export function risqueAuMoins(plancher: RisqueOutil, declare: RisqueOutil): boolean {
  return ECHELLE[declare] >= ECHELLE[plancher];
}
