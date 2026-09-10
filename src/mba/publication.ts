/**
 * Ce qui va changer chez Meta si l'on publie, calculé AVANT de rien écrire.
 *
 * 🔴 ENGAGE ME FAIT FOI, ET LA PUBLICATION ÉCRASE (décision de Julien du 2026-09-10). Ce module existe pour
 * que « écraser » ne soit jamais une surprise : il compare ce que nous avons à ce que Meta a, et rend la
 * liste des gestes en toutes lettres. L'écran la montre, le client décide, et alors seulement on écrit.
 *
 * 🔴 PUR : aucune IO. C'est ce qui rend la décision testable sans réseau, et c'est la moitié qui compte. La
 * moitié qui appelle Meta est mécanique ; celle-ci porte tous les arbitrages.
 *
 * ⚠️ LA RÉCONCILIATION SE FAIT SUR LE NOM, jamais sur un identifiant Meta qu'on stockerait. Deux raisons :
 * on ne veut pas d'une table de correspondance à tenir à jour (elle dériverait dès qu'un client supprime un
 * connecteur dans WhatsApp Manager), et le nom est précisément ce que le modèle voit. Corollaire : renommer
 * un outil chez nous se lit comme « supprimer l'ancien, créer le nouveau », et l'aperçu le dit.
 *
 * ⚠️ IDEMPOTENTE : publier deux fois de suite ne doit produire AUCUN geste au second passage, et c'est le
 * seul test qui prouve que la réconciliation marche.
 */

/** Une SOURCE de chez nous, telle qu'elle devient un connecteur chez Meta. */
export interface SourceAPublier {
  id: string;
  label: string;
  baseUrl: string;
  /** `none` devient `NONE`, `bearer` et `header` deviennent `API_KEY`. */
  authKind: 'none' | 'bearer' | 'header';
  /** Nom d'en-tête pour `header`. `bearer` utilise `Authorization` avec le préfixe `Bearer `. */
  authHeaderName: string | null;
  /** Le secret EXISTE-t-il ? Sa valeur ne transite pas par ce module. */
  aAuthentification: boolean;
  /**
   * Le secret ACTUEL a-t-il déjà été posé chez Meta ?
   *
   * 🔴 C'EST LE SEUL MOYEN DE FAIRE TOURNER UN SECRET, et il manquait. Meta ne rend jamais le sien : on ne
   * peut pas comparer, seulement se souvenir de ce qu'on a posé. Le drapeau retombe à `false` dès qu'on
   * touche à l'authentification de la source, et la publication suivante repose le secret.
   */
  secretPublie: boolean;
}

/** Un OUTIL de chez nous, exposé au MBA, tel qu'il devient un tool de connecteur. */
export interface OutilAPublier {
  id: string;
  sourceId: string;
  name: string;
  description: string;
  /** La clause « quand NE PAS l'appeler », concaténée à la description envoyée à Meta. */
  nePasUtiliser: string;
  methode: string;
  chemin: string;
}

/** Ce que Meta a déjà, lu avant de comparer. */
export interface ConnecteurChezMeta {
  id: string;
  name: string;
  base_url?: string;
  auth_type?: string;
}

export interface OutilChezMeta {
  id: string;
  name: string;
  description?: string;
  /**
   * 🔴 COMPARÉ, ET IL NE L'ÉTAIT PAS. Le plan ne regardait que la `description` : changer la MÉTHODE ou le
   * CHEMIN d'une requête chez nous ne produisait AUCUN geste, et l'agent de Meta continuait d'appeler
   * l'ancienne adresse indéfiniment. Le symptôme aurait été un outil qui « ne marche plus » sans qu'aucun
   * écran ne montre d'écart, puisque l'aperçu aurait dit « rien à changer ».
   */
  request_definition?: { method?: string; path?: string };
}

export type Geste =
  | { type: 'connecteur_creer'; sourceId: string; nom: string }
  | { type: 'connecteur_modifier'; connecteurId: string; sourceId: string; nom: string }
  | { type: 'connecteur_supprimer'; connecteurId: string; nom: string }
  | { type: 'secret_poser'; sourceId: string; nom: string }
  | { type: 'outil_creer'; sourceId: string; outilId: string; nom: string }
  | { type: 'outil_modifier'; sourceId: string; outilMetaId: string; outilId: string; nom: string }
  | { type: 'outil_supprimer'; sourceId: string; outilMetaId: string; nom: string };

export interface EtatMeta {
  connecteurs: ConnecteurChezMeta[];
  /** Les outils de Meta, par identifiant de connecteur. */
  outilsParConnecteur: Record<string, OutilChezMeta[]>;
}

/**
 * La description envoyée à Meta : la nôtre, suivie de la clause « quand ne pas l'appeler ».
 *
 * 🔴 `ne_pas_utiliser` N'A PAS DE CHAMP CHEZ META, et c'est le SEUL levier qui décide quand un outil se
 * déclenche. Le laisser de côté ferait travailler le client sur un texte qui ne produirait rien, ce qui est
 * exactement ce qui s'est passé chez nous jusqu'au correctif du 2026-08-29.
 */
export function descriptionPourMeta(o: { description: string; nePasUtiliser: string }): string {
  const clause = o.nePasUtiliser.trim();
  return clause === '' ? o.description : `${o.description}\n\nNe pas l'utiliser : ${clause}`;
}

/**
 * Le plan de publication : ce qui sera créé, modifié, supprimé.
 *
 * ⚠️ L'ORDRE DES GESTES EST CELUI DE L'EXÉCUTION, et il n'est pas indifférent : un outil ne peut pas être
 * créé avant son connecteur, et un connecteur ne peut pas être supprimé avant ses outils. La liste est donc
 * lisible de haut en bas comme une recette, et l'écran l'affiche telle quelle.
 */
export function planifierPublication(
  sources: SourceAPublier[],
  outils: OutilAPublier[],
  meta: EtatMeta,
): Geste[] {
  const gestes: Geste[] = [];
  const parNom = new Map(meta.connecteurs.map((c) => [c.name, c]));
  const nosNoms = new Set(sources.map((s) => s.label));

  // 1. Les connecteurs : créer ce qui manque, modifier ce qui a bougé.
  for (const s of sources) {
    const chezMeta = parNom.get(s.label);
    if (!chezMeta) {
      gestes.push({ type: 'connecteur_creer', sourceId: s.id, nom: s.label });
      if (s.aAuthentification) gestes.push({ type: 'secret_poser', sourceId: s.id, nom: s.label });
      continue;
    }
    // 🔴 LE SECRET SE REPOSE QUAND IL A CHANGÉ CHEZ NOUS, jamais « au cas où ». Meta ne rend pas le sien,
    // donc on ne compare pas : on se souvient de ce qu'on a posé (`secretPublie`), et toute écriture sur
    // l'authentification de la source remet ce drapeau à zéro. Le reposer à CHAQUE publication marcherait
    // aussi, mais on perdrait le seul test qui prouve que la réconciliation fonctionne (« publier deux fois
    // ne produit aucun geste ») ; ne jamais le reposer laissait un secret périmé pour toujours, et c'était
    // le comportement d'avant le 2026-09-10.
    if (s.aAuthentification && !s.secretPublie) {
      gestes.push({ type: 'secret_poser', sourceId: s.id, nom: s.label });
    }
    // ⚠️ ON NE COMPARE QUE CE QUE META REND, pour le reste.
    if (chezMeta.base_url !== s.baseUrl || chezMeta.auth_type !== authTypeMeta(s.authKind)) {
      gestes.push({ type: 'connecteur_modifier', connecteurId: chezMeta.id, sourceId: s.id, nom: s.label });
    }
  }

  // 2. Les connecteurs de Meta que nous n'avons plus : ils partent, avec leurs outils.
  for (const c of meta.connecteurs) {
    if (!nosNoms.has(c.name)) {
      for (const o of meta.outilsParConnecteur[c.id] ?? []) {
        gestes.push({ type: 'outil_supprimer', sourceId: '', outilMetaId: o.id, nom: o.name });
      }
      gestes.push({ type: 'connecteur_supprimer', connecteurId: c.id, nom: c.name });
    }
  }

  // 3. Les outils, connecteur par connecteur.
  for (const s of sources) {
    const chezMeta = parNom.get(s.label);
    const dejaLa = chezMeta ? (meta.outilsParConnecteur[chezMeta.id] ?? []) : [];
    const parNomOutil = new Map(dejaLa.map((o) => [o.name, o]));
    const nosOutils = outils.filter((o) => o.sourceId === s.id);

    for (const o of nosOutils) {
      const existant = parNomOutil.get(o.name);
      if (!existant) {
        gestes.push({ type: 'outil_creer', sourceId: s.id, outilId: o.id, nom: o.name });
      } else if (aChange(existant, o)) {
        gestes.push({ type: 'outil_modifier', sourceId: s.id, outilMetaId: existant.id, outilId: o.id, nom: o.name });
      }
    }
    const nosNomsOutils = new Set(nosOutils.map((o) => o.name));
    for (const o of dejaLa) {
      if (!nosNomsOutils.has(o.name)) {
        gestes.push({ type: 'outil_supprimer', sourceId: s.id, outilMetaId: o.id, nom: o.name });
      }
    }
  }

  return gestes;
}

/**
 * Cet outil a-t-il bougé depuis la dernière publication ?
 *
 * 🔴 LES TROIS CHAMPS COMPTENT, et n'en comparer qu'un est la faute qui rend une publication silencieusement
 * incomplète : la DESCRIPTION (qui porte aussi la clause « ne pas utiliser », seul levier qui décide quand
 * l'outil se déclenche), la MÉTHODE et le CHEMIN (sans quoi Meta appellerait l'ancienne adresse pour
 * toujours, avec un aperçu qui annonce « rien à changer »).
 *
 * ⚠️ Un `request_definition` ABSENT de la réponse de Meta ne vaut PAS « identique » : on ne peut pas
 * comparer ce qu'on n'a pas reçu, donc on demande la mise à jour. Le prix est un geste de trop à chaque
 * publication si Meta cessait un jour de rendre ce champ ; le prix de l'inverse est un outil cassé pour
 * toujours, en silence.
 */
function aChange(chezMeta: OutilChezMeta, chezNous: OutilAPublier): boolean {
  if (chezMeta.description !== descriptionPourMeta(chezNous)) return true;
  const rd = chezMeta.request_definition;
  if (!rd) return true;
  return rd.method !== chezNous.methode || rd.path !== chezNous.chemin;
}

/**
 * Notre `authKind` traduit dans l'énumération de Meta.
 *
 * ⚠️ `bearer` ET `header` DEVIENNENT TOUS DEUX `API_KEY`, et ce n'est pas un raccourci : Meta n'a pas de
 * type « bearer », il a un mécanisme d'en-têtes où `Authorization: Bearer <secret>` est un cas particulier.
 * La différence se joue dans `upsertApiKey`, pas dans `auth_type`.
 *
 * ⚠️ La spec dit que seuls `NONE`, `API_KEY` et `OAUTH2_CLIENT_CREDENTIALS` sont réellement supportés
 * aujourd'hui : on n'émet donc jamais `BASIC` ni `CUSTOM`, même si l'énumération les accepte.
 */
export function authTypeMeta(authKind: SourceAPublier['authKind']): 'NONE' | 'API_KEY' {
  return authKind === 'none' ? 'NONE' : 'API_KEY';
}

/**
 * Le corps de `upsertApiKey` pour une source.
 *
 * ⚠️ `bearer` porte le préfixe `Bearer ` DANS le champ `prefix`, pas collé au secret : Meta concatène
 * lui-même, et coller le préfixe au secret produirait `Bearer Bearer <secret>` le jour où quelqu'un règle
 * aussi le préfixe.
 */
export function corpsApiKey(
  source: Pick<SourceAPublier, 'authKind' | 'authHeaderName'>,
  secret: string,
): { api_key_config: { headers: Array<{ field_name: string; value: string; prefix: string | null }> } } {
  const champ = source.authKind === 'bearer' ? 'Authorization' : (source.authHeaderName ?? 'X-API-Key');
  const prefixe = source.authKind === 'bearer' ? 'Bearer ' : null;
  return { api_key_config: { headers: [{ field_name: champ, value: secret, prefix: prefixe }] } };
}
