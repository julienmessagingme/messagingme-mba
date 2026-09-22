/**
 * Le CORPS et les PARAMÈTRES D'URL d'un appel de connecteur, construits à partir de gabarits à variables.
 *
 * 🔴 CE QUI MANQUAIT, ET POURQUOI C'ÉTAIT BLOQUANT. Jusqu'ici un connecteur ne savait remplir qu'un gabarit
 * de CHEMIN (`/commandes/{numero}`). Un `POST` partait donc avec un corps VIDE, ce qui ne sert à rien : un
 * connecteur existe pour envoyer une donnée variable (une ville, la dernière phrase du contact, un champ de
 * sa fiche) et recevoir une réponse en échange. Sans corps ni paramètres d'URL, il n'y avait rien à envoyer.
 *
 * 🔴 LA DÉCISION QUI PORTE TOUTE LA SÛRETÉ DU MODULE : le gabarit de corps est du JSON VALIDE, et la
 * substitution est STRUCTURELLE, jamais textuelle.
 *
 * Le réflexe naturel serait de traiter le gabarit comme du texte et d'y remplacer `{{ville}}` par la valeur.
 * Ce serait une injection ouverte, et pas théorique : une valeur peut venir du MODÈLE, ou de la dernière
 * phrase écrite par le CONTACT, donc d'un inconnu. Il lui suffirait d'écrire `Paris", "admin": true` pour
 * ajouter un champ au corps envoyé au système du client. Un guillemet suffirait même à casser le JSON.
 *
 * Ici on PARSE le gabarit d'abord, on remplace les valeurs dans l'arbre, puis on ré-encode. Une valeur ne
 * peut donc jamais devenir de la STRUCTURE : au pire c'est une chaîne bizarre dans le champ prévu pour elle.
 *
 * ⚠️ Conséquence assumée : on ne sait pas fabriquer une clé dynamique ni un tableau de longueur variable. Ce
 * n'est pas un manque, c'est le prix de la garantie ci-dessus, et le besoin est d'envoyer des champs, pas
 * d'écrire un langage de gabarit.
 */

import { VARIABLE_DE_CHEMIN } from './http-cible';

/** Variables nommées `{{ville}}`. MÊME motif que l'éditeur de la console (`web/components/VariableBodyEditor`),
 *  pour que ce qui s'écrit à l'écran soit exactement ce qui se substitue ici. */
const VARIABLE = /\{\{\s*([\w.-]+)\s*\}\}/g;

/** Une chaîne qui n'est QUE `{{ville}}`, sans rien autour : c'est elle qui prend la valeur TYPÉE. */
const VARIABLE_SEULE = /^\{\{\s*([\w.-]+)\s*\}\}$/;

export type ValeurVariable = string | number | boolean | null;

export interface CorpsConstruit {
  ok: true;
  /** Le corps sérialisé, prêt à partir. `null` quand le connecteur n'en envoie pas. */
  corps: string | null;
}
export interface CorpsRefuse {
  ok: false;
  /** Lisible par le CLIENT (elle remonte dans la console). Ne cite jamais un secret. */
  raison: string;
}

/**
 * Remplace les variables dans une valeur de l'arbre JSON.
 *
 * Deux cas, et la distinction est ce qui rend les types utiles :
 *  - la chaîne vaut EXACTEMENT `{{ville}}` : elle prend la valeur avec SON TYPE. Un paramètre déclaré
 *    « nombre » part donc en nombre (`{"n": 42}`), pas en chaîne (`{"n": "42"}`), ce qui est la différence
 *    entre une API qui répond et une API qui renvoie 400 ;
 *  - la chaîne CONTIENT une variable parmi du texte (`"Bonjour {{prenom}}"`) : on interpole, donc le résultat
 *    est forcément une chaîne. Une valeur absente y devient vide plutôt que le littéral `{{prenom}}`, qui
 *    partirait tel quel chez le client.
 */
function substituer(noeud: unknown, valeurs: Readonly<Record<string, ValeurVariable>>, manquantes: Set<string>): unknown {
  if (typeof noeud === 'string') {
    const seule = VARIABLE_SEULE.exec(noeud);
    if (seule) {
      const nom = seule[1]!;
      if (!(nom in valeurs)) { manquantes.add(nom); return null; }
      return valeurs[nom] ?? null;
    }
    VARIABLE.lastIndex = 0;
    return noeud.replace(VARIABLE, (_m, nom: string) => {
      if (!(nom in valeurs)) { manquantes.add(nom); return ''; }
      const v = valeurs[nom];
      return v === null || v === undefined ? '' : String(v);
    });
  }
  if (Array.isArray(noeud)) return noeud.map((n) => substituer(n, valeurs, manquantes));
  if (noeud !== null && typeof noeud === 'object') {
    const out: Record<string, unknown> = {};
    // ⚠️ Les CLÉS ne sont pas substituées, volontairement : une clé variable ferait dépendre la FORME du
    // corps d'une valeur d'exécution, donc d'un texte que le contact influence. C'est exactement ce que la
    // substitution structurelle sert à empêcher.
    for (const [cle, v] of Object.entries(noeud as Record<string, unknown>)) out[cle] = substituer(v, valeurs, manquantes);
    return out;
  }
  return noeud;
}

/** Une ligne du mode « liste de champs » : une clé, et un gabarit de valeur. */
export interface ChampCorps {
  cle: string;
  /** Du texte, éventuellement à variables (`{{ville}}`), exactement comme une valeur de paramètre d'URL. */
  valeur: string;
}

/**
 * COMMENT le corps est saisi. Deux façons, et c'est une demande explicite de Julien le 2026-09-02 : « du json
 * brut pour les mecs habitués et une liste de champs ».
 *
 * 🔴 DEUX SAISIES, UN SEUL MOTEUR. Le mode `champs` est COMPILÉ vers le même arbre que le mode `json`, puis
 * les deux passent par `substituer`. C'est ce qui garantit qu'ils ne divergeront pas : deux chemins de
 * substitution tenus en parallèle finiraient par ne plus produire la même chose au premier ajustement, et
 * personne ne le verrait avant qu'un client ne s'en plaigne. La liste de champs n'est donc pas un second
 * moteur, c'est une autre porte d'entrée du même.
 */
export type GabaritCorps =
  | { mode: 'aucun' }
  | { mode: 'json'; gabarit: string }
  | { mode: 'champs'; champs: readonly ChampCorps[] };

/**
 * Construit le corps d'un appel.
 *
 * Un gabarit ILLISIBLE est un refus, jamais un corps vide envoyé quand même : partir avec un corps que
 * personne n'a voulu est pire que ne pas partir, et le client peut corriger son gabarit dans sa console.
 */
export function construireCorps(
  gabarit: GabaritCorps,
  valeurs: Readonly<Record<string, ValeurVariable>>,
): CorpsConstruit | CorpsRefuse {
  let arbre: unknown;

  if (gabarit.mode === 'aucun') return { ok: true, corps: null };

  if (gabarit.mode === 'champs') {
    // Une ligne sans clé est une ligne pas remplie, pas une erreur : même règle que les paramètres d'URL.
    const lignes = gabarit.champs.filter((c) => c.cle.trim() !== '');
    if (lignes.length === 0) return { ok: true, corps: null };
    const objet: Record<string, unknown> = {};
    for (const c of lignes) objet[c.cle.trim()] = c.valeur;
    arbre = objet;
  } else {
    const brut = gabarit.gabarit.trim();
    if (brut === '') return { ok: true, corps: null };
    try {
      arbre = JSON.parse(brut);
    } catch {
      return { ok: false, raison: 'le corps de la requête n’est pas du JSON valide' };
    }
  }

  const manquantes = new Set<string>();
  const rempli = substituer(arbre, valeurs, manquantes);
  if (manquantes.size > 0) {
    // Nommer TOUTES les manquantes d'un coup : les donner une par une ferait corriger le connecteur autant
    // de fois qu'il manque de variables.
    return { ok: false, raison: `variable(s) sans valeur dans le corps : ${[...manquantes].sort().join(', ')}` };
  }
  return { ok: true, corps: JSON.stringify(rempli) };
}

/**
 * Traduit une liste de champs en gabarit JSON, pour que l'écran puisse proposer « passer en JSON brut » sans
 * faire recommencer la saisie.
 *
 * ⚠️ SENS UNIQUE, et l'écran doit le dire. Tout JSON n'est pas représentable en liste de champs (un objet
 * imbriqué, un tableau), donc la bascule inverse ferait perdre du travail en silence. Proposer un aller sans
 * retour, en le disant, vaut mieux qu'un aller-retour qui ampute.
 */
export function champsVersJson(champs: readonly ChampCorps[]): string {
  const objet: Record<string, unknown> = {};
  for (const c of champs) {
    const cle = c.cle.trim();
    if (cle !== '') objet[cle] = c.valeur;
  }
  return JSON.stringify(objet, null, 2);
}

export interface ParametreUrl {
  cle: string;
  /** Gabarit de valeur : du texte, éventuellement à variables (`{{ville}}`). */
  valeur: string;
}

/** Un en-tête SUPPLÉMENTAIRE de la requête. Voir `EN_TETES_RESERVES` pour ce qui n'a rien à faire ici. */
export interface EnTete {
  nom: string;
  valeur: string;
}

/**
 * Les en-têtes que le client NE PEUT PAS poser lui-même sur une requête.
 *
 * 🔴 `authorization` d'abord, et ce n'est pas du zèle. L'authentification d'un connecteur vit sur la SOURCE,
 * chiffrée, et `enTetesAuthSource` en est l'unique point de passage. Laisser saisir un `authorization` ici
 * ferait deux chemins d'authentification, dont un qui stocke le secret EN CLAIR dans la configuration de la
 * requête, visible de tout écran qui l'affiche et de tout export qui la copie. Le champ existerait « parce
 * que Postman l'a », et il deviendrait la façon la plus naturelle de s'authentifier, donc la plus utilisée.
 *
 * `content-type` ensuite, pour une raison plus terre à terre : il est posé par la construction du corps, en
 * accord avec ce qui part réellement. Le laisser saisir permettrait d'annoncer du XML en envoyant du JSON.
 *
 * `host` et `content-length` enfin : ils décrivent le transport, les fixer à la main casse l'appel.
 */
export const EN_TETES_RESERVES = ['authorization', 'content-type', 'content-length', 'host'] as const;

export function estEnTeteReserve(nom: string): boolean {
  return (EN_TETES_RESERVES as readonly string[]).includes(nom.trim().toLowerCase());
}

/**
 * Construit la chaîne de requête (`?ville=Paris&depuis=2026-01-01`).
 *
 * ⚠️ `URLSearchParams` encode chaque valeur : une valeur contenant `&` ou `=` ne peut donc pas ajouter de
 * paramètre. C'est la même garantie que la substitution structurelle du corps, appliquée à l'URL.
 *
 * Un paramètre dont la valeur est VIDE après substitution est OMIS plutôt qu'envoyé vide. Beaucoup d'API
 * traitent `?ville=` comme un filtre sur la chaîne vide, donc comme zéro résultat, ce qui ferait dire à
 * l'agent « je n'ai rien trouvé » là où la bonne réponse est « je n'ai pas cette information ».
 */
export function construireParametres(
  parametres: readonly ParametreUrl[] | null | undefined,
  valeurs: Readonly<Record<string, ValeurVariable>>,
): { ok: true; query: string } | CorpsRefuse {
  const liste = parametres ?? [];
  if (liste.length === 0) return { ok: true, query: '' };

  const sp = new URLSearchParams();
  const manquantes = new Set<string>();
  for (const p of liste) {
    const cle = p.cle.trim();
    if (cle === '') continue; // une ligne vide de l'écran n'est pas une erreur, c'est une ligne pas remplie
    VARIABLE.lastIndex = 0;
    const valeur = p.valeur.replace(VARIABLE, (_m, nom: string) => {
      if (!(nom in valeurs)) { manquantes.add(nom); return ''; }
      const v = valeurs[nom];
      return v === null || v === undefined ? '' : String(v);
    });
    if (valeur !== '') sp.set(cle, valeur);
  }
  if (manquantes.size > 0) {
    return { ok: false, raison: `variable(s) sans valeur dans les paramètres d’URL : ${[...manquantes].sort().join(', ')}` };
  }
  const query = sp.toString();
  return { ok: true, query };
}

/**
 * L'APPEL COMPLET : l'adresse finale, la méthode, les en-têtes et le corps, à partir de la requête déclarée
 * et des valeurs résolues. C'est le point de passage obligé, partagé par l'exécution réelle et par le bouton
 * « Test » de la console.
 *
 * 🔴 PARTAGÉ EXPRÈS, et c'est la leçon que `enTetesAuthSource` porte déjà : le jour où le test et l'exécution
 * construisent leur requête séparément, le test dit « ça marche » d'un appel que l'exécution ne sait pas
 * faire. C'est exactement la divergence que l'audit du 2026-08-18 a payée une centaine de fois.
 *
 * ⚠️ L'AUTHENTIFICATION N'EST PAS ICI. Les en-têtes rendus sont ceux de la requête ; l'appelant y superpose
 * ceux de la source EN DERNIER, pour qu'aucun en-tête saisi ne puisse la recouvrir. La saisie d'un en-tête
 * réservé est refusée en amont par la route, mais cet ordre-là tient même si cette garde-là tombe.
 */
export function assemblerAppel(input: {
  baseUrl: string;
  methode: string;
  chemin: string;
  parametres?: readonly ParametreUrl[] | null;
  entetes?: readonly EnTete[] | null;
  corps: GabaritCorps;
  valeurs: Readonly<Record<string, ValeurVariable>>;
  /** Injectée pour tester la garde d'adresse sans dupliquer ses cas ici. */
  construireCible: (i: { baseUrl: string; binding: { methode: string; chemin: string }; args: Record<string, unknown> })
  => { ok: true; url: string; methode: string } | { ok: false; raison: string };
}): { ok: true; url: string; methode: string; entetes: Record<string, string>; corps: string | null } | CorpsRefuse {
  // 1. L'ADRESSE, avec toutes ses gardes (HTTPS, hôte public, cible sous la base). Elle passe AVANT le reste :
  // inutile de construire un corps pour une adresse qu'on refusera.
  const cible = input.construireCible({
    baseUrl: input.baseUrl,
    binding: { methode: input.methode, chemin: input.chemin },
    args: input.valeurs as Record<string, unknown>,
  });
  if (!cible.ok) return { ok: false, raison: cible.raison };

  // 2. LES PARAMÈTRES D'URL.
  const q = construireParametres(input.parametres, input.valeurs);
  if (!q.ok) return q;
  const url = q.query === '' ? cible.url : `${cible.url}${cible.url.includes('?') ? '&' : '?'}${q.query}`;

  // 3. LE CORPS.
  const c = construireCorps(input.corps, input.valeurs);
  if (!c.ok) return c;

  // 4. LES EN-TÊTES. Un en-tête réservé saisi malgré tout est IGNORÉ plutôt que transmis : la route le refuse
  // déjà, et deux gardes qui se recouvrent valent mieux qu'une seule sur un chemin qui porte un secret.
  // 🔴 SUBSTITUÉS COMME LES PARAMÈTRES D'URL (2026-09-23) : l'écran propose d'y insérer une variable, et
  // `{{client_id}}` partait tel quel chez le client. Une valeur à retour à la ligne est REFUSÉE : glissée dans
  // un en-tête, elle en fabriquerait un second (injection d'en-tête), et elle peut venir du modèle.
  const entetes: Record<string, string> = { accept: 'application/json' };
  const manquantes = new Set<string>();
  for (const e of input.entetes ?? []) {
    const nom = e.nom.trim().toLowerCase();
    if (nom === '' || estEnTeteReserve(nom)) continue;
    VARIABLE.lastIndex = 0;
    const valeur = e.valeur.replace(VARIABLE, (_m, v: string) => {
      if (!(v in input.valeurs)) { manquantes.add(v); return ''; }
      const x = input.valeurs[v];
      return x === null || x === undefined ? '' : String(x);
    });
    if (/[\r\n]/.test(valeur)) return { ok: false, raison: `l’en-tête « ${e.nom.trim()} » contiendrait un retour à la ligne : il n’est pas envoyé` };
    // Vide après substitution : omis, comme un paramètre d'URL. Un en-tête vide fait répondre 400 à certaines API.
    if (valeur !== '') entetes[nom] = valeur;
  }
  if (manquantes.size > 0) {
    return { ok: false, raison: `variable(s) sans valeur dans les en-têtes : ${[...manquantes].sort().join(', ')}` };
  }
  // Posé d'après ce qui part RÉELLEMENT, jamais d'après une déclaration : annoncer un corps qu'on n'envoie
  // pas fait répondre 400 à certaines API.
  if (c.corps !== null) entetes['content-type'] = 'application/json';

  return { ok: true, url, methode: cible.methode, entetes, corps: c.corps };
}

/**
 * Les chemins LISIBLES d'une réponse, pour que l'écran les propose à cocher après un test au lieu de demander
 * au client d'écrire `livraison.date` de tête.
 *
 * 🔴 C'est ce qui rend l'écran utilisable par quelqu'un qui ne connaît pas les API : il lance le test, il voit
 * la réponse, il coche ce qu'il veut. Écrire un chemin à la main suppose de savoir lire du JSON, et une faute
 * de frappe ne se voit qu'à l'exécution, en pleine conversation.
 *
 * ⚠️ N'offre QUE ce que l'extracteur sait résoudre. Il ne descend pas dans les tableaux (pas d'index, décision
 * assumée du résolveur), donc un tableau est proposé ENTIER, comme une feuille. Proposer `commandes.0.total`
 * fabriquerait un chemin cochable qui ne rendrait jamais rien : une case qui ment est pire qu'une case
 * absente, parce qu'on ne la soupçonne pas.
 *
 * Bornée en PROFONDEUR et en NOMBRE : une réponse profonde ou large produirait une liste illisible, et
 * l'écran doit rester utilisable sur la réponse d'une API qu'on découvre.
 */
export function cheminsDeLaReponse(valeur: unknown, max = 200, profondeurMax = 5): string[] {
  const out: string[] = [];
  const marcher = (n: unknown, prefixe: string, profondeur: number): void => {
    if (out.length >= max) return;
    // Un tableau est une FEUILLE : voir le commentaire ci-dessus.
    if (n !== null && typeof n === 'object' && !Array.isArray(n) && profondeur < profondeurMax) {
      const entrees = Object.entries(n as Record<string, unknown>);
      if (entrees.length === 0 && prefixe !== '') out.push(prefixe);
      for (const [cle, v] of entrees) {
        // Une clé contenant un point casserait la notation : le chemin `a.b` désignerait deux niveaux alors
        // qu'il n'y en a qu'un. On l'omet plutôt que d'offrir un chemin ambigu.
        if (cle.includes('.')) continue;
        marcher(v, prefixe === '' ? cle : `${prefixe}.${cle}`, profondeur + 1);
      }
      return;
    }
    if (prefixe !== '') out.push(prefixe);
  };
  marcher(valeur, '', 0);
  return out;
}

/**
 * Les noms de variables qu'un gabarit RÉCLAME, pour que l'écran puisse dire « tu utilises `{{ville}}` mais tu
 * ne l'as pas déclarée » AVANT l'envoi, et pour que la fenêtre de création d'un agent puisse annoncer au
 * client ce qui partira réellement dans la requête.
 *
 * Balaye le corps, les paramètres d'URL, le chemin ET les en-têtes : tous portent des variables, et en oublier
 * un ferait mentir la liste (les en-têtes l'ont été jusqu'au 2026-09-23).
 */
export function variablesUtilisees(
  corps: GabaritCorps,
  parametres: readonly ParametreUrl[] | null | undefined,
  chemin?: string,
  entetes?: readonly EnTete[] | null,
): string[] {
  const vues = new Set<string>();
  const balayer = (s: string): void => {
    VARIABLE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = VARIABLE.exec(s)) !== null) vues.add(m[1]!);
  };
  // Les DEUX modes de saisie portent des variables : n'en lire qu'un ferait mentir la liste selon la façon
  // dont le client a rempli son corps, ce qui est exactement le genre d'écart que personne ne soupçonne.
  if (corps.mode === 'json') balayer(corps.gabarit);
  if (corps.mode === 'champs') for (const c of corps.champs) balayer(c.valeur);
  for (const p of parametres ?? []) balayer(p.valeur);
  for (const e of entetes ?? []) balayer(e.valeur);
  // Le CHEMIN admet `{{nom}}` ET `{nom}` : la même expression que la substitution (`http-cible.ts`), pour que la
  // liste annoncée ne diverge jamais de ce qui est réellement remplacé.
  for (const m of (chemin ?? '').matchAll(VARIABLE_DE_CHEMIN)) vues.add((m[1] ?? m[2])!);
  return [...vues].sort();
}
