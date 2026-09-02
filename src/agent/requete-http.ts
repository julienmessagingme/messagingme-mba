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

/**
 * Construit le corps d'un appel.
 *
 * `gabarit` est le JSON tel que le client l'a écrit dans la console. Vide ou absent = pas de corps, ce qui
 * est le cas normal d'un `GET`.
 *
 * Un gabarit ILLISIBLE est un refus, jamais un corps vide envoyé quand même : partir avec un corps que
 * personne n'a voulu est pire que ne pas partir, et le client peut corriger son gabarit dans sa console.
 */
export function construireCorps(
  gabarit: string | null | undefined,
  valeurs: Readonly<Record<string, ValeurVariable>>,
): CorpsConstruit | CorpsRefuse {
  const brut = (gabarit ?? '').trim();
  if (brut === '') return { ok: true, corps: null };

  let arbre: unknown;
  try {
    arbre = JSON.parse(brut);
  } catch {
    return { ok: false, raison: 'le corps de la requête n’est pas du JSON valide' };
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

export interface ParametreUrl {
  cle: string;
  /** Gabarit de valeur : du texte, éventuellement à variables (`{{ville}}`). */
  valeur: string;
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
 * Les noms de variables qu'un gabarit RÉCLAME, pour que l'écran puisse dire « tu utilises `{{ville}}` mais tu
 * ne l'as pas déclarée » AVANT l'envoi, et pour que la fenêtre de création d'un agent puisse annoncer au
 * client ce qui partira réellement dans la requête.
 *
 * Balaye le corps ET les paramètres d'URL : les deux portent des variables, et n'en lire qu'un ferait mentir
 * la liste à moitié.
 */
export function variablesUtilisees(gabaritCorps: string | null | undefined, parametres: readonly ParametreUrl[] | null | undefined, chemin?: string): string[] {
  const vues = new Set<string>();
  const balayer = (s: string): void => {
    VARIABLE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = VARIABLE.exec(s)) !== null) vues.add(m[1]!);
  };
  balayer(gabaritCorps ?? '');
  for (const p of parametres ?? []) balayer(p.valeur);
  // Le CHEMIN utilise la notation `{nom}` (une seule accolade), héritée de `http-cible.ts` : on la lit aussi,
  // sinon la liste annoncée au client oublierait les variables de l'URL elle-même.
  for (const m of (chemin ?? '').matchAll(/\{([a-zA-Z0-9_]+)\}/g)) vues.add(m[1]!);
  return [...vues].sort();
}
