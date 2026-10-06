import type { Pool } from 'pg';
import { z } from 'zod';
import { normalizeText } from '../automation/match';
import { estDemandeArret } from '../crm/consentement';
import { estUuid } from '../http/scope';
import { refus, type Issue } from '../lib/issue';
import { PgChannelsMeLinkStore } from '../channels-me/link-store.pg';
import { PgWorkflowStore, etatDuScenario, type EtatScenario } from '../workflow/store.pg';
import { PgWidgetStore, type DevenirWidget, type PositionWidget, type WidgetInput, type WidgetRow } from './store.pg';
import { enConflitAvec, phrasesEnConflit } from './phrases';
import { adresseDuScript, baliseDuScript, lienDuWidget, type NumeroDuWidget } from './adresses';

/**
 * LA GESTION DES WIDGETS : lister, créer, modifier, supprimer (lot 4 de
 * docs/superpowers/plans/2026-10-02-widget-whatsapp.md).
 *
 * 🔴 UNE SEULE VÉRITÉ, DEUX PORTES. La route de la console (`src/http/widgets.ts`) et les outils MCP du lot 5
 * (`src/mcp/outils.ts`) appellent CES fonctions : un widget créé par Claude Code passe exactement les mêmes
 * contrôles qu'un widget créé à la main. La route n'ajoute que ce qui est propre au HTTP (la garde
 * d'administrateur, les codes de statut), l'outil ce qui est propre à MCP (le refus lisible par un modèle).
 *
 * Les contrôles que la base ne fait pas, et qui vivent donc ici :
 *  - la saisie, bornée par Zod (`safeParse`, `.strict()` : une clé inconnue est une faute, pas un ajout) ;
 *  - 🔴 le scénario désigné appartient à CET espace. La clé étrangère de 0200 vérifie qu'il EXISTE, pas à qui il
 *    est : sans ce contrôle, un widget de l'espace A démarrerait un scénario de l'espace B, qui enverrait ses
 *    messages depuis le numéro de B aux visiteurs de A. Une fuite entre espaces ;
 *  - le scénario CHOISI a une version publiée (lot 5) : sans elle, la fiche annoncerait un scénario qui, à
 *    l'arrivée, ne démarrerait rien ;
 *  - le devenir `agent` est REFUSÉ (décision de Julien du 2026-10-02) : une session d'agent IA exige un parcours de
 *    scénario, le lot 3 le traite comme `null`, et l'accepter ici laisserait le MCP poser un choix inerte ;
 *  - la phrase : réduite à rien par `normalizeText`, en conflit avec un autre widget ou un lien de chaîne
 *    (`./phrases`), ou déjà présente dans la conversation ordinaire ;
 *  - cinq widgets au plus par espace (décision de Julien du 2026-10-02).
 */

/** Cinq widgets au plus par espace : un site vitrine, un blog, une page tarifs, et de la marge. */
export const LIMITE_WIDGETS_PAR_ESPACE = 5;
/** Le nom ne sert qu'au client, dans la liste : jamais montré au visiteur. */
export const MAX_NOM_WIDGET = 80;
/** La même borne que la phrase d'un lien de chaîne (`src/http/channels-me.ts`) : les deux vivent dans un `wa.me`. */
export const MAX_PHRASE_WIDGET = 300;
/** Le texte posé à côté de la bulle, dans une pastille de 240 pixels au plus (`src/widgets/script.ts`). */
export const MAX_LIBELLE_WIDGET = 60;
export const MAX_AVATAR_URL = 2000;
/** La même borne que le plafond horaire d'un lien de chaîne. */
export const MAX_PAR_HEURE_WIDGET = 100_000;
/** Le vert de WhatsApp, défaut de la colonne `couleur` (0200). */
export const COULEUR_PAR_DEFAUT = '#25d366';
export const POSITIONS_WIDGET = ['bas_droite', 'bas_gauche', 'haut_droite', 'haut_gauche'] as const satisfies readonly PositionWidget[];
/**
 * Le CHECK `widgets_couleur_chk`, recopié : six chiffres hexadécimaux, la forme que rend `<input type="color">`.
 * Exporté en TEXTE : le schéma d'entrée des outils MCP l'annonce tel quel (`pattern`), sans le recopier.
 */
export const MOTIF_COULEUR = '^#[0-9A-Fa-f]{6}$';
const COULEUR_RE = new RegExp(MOTIF_COULEUR);
/** Le début qu'une adresse d'avatar doit avoir (`widgets_avatar_https_chk`), annoncé aussi aux modèles. */
export const DEBUT_AVATAR = 'https://';

/**
 * Le CHECK `widgets_avatar_https_chk` (`^https://`, sensible à la casse), plus une adresse qui se lit : une valeur
 * que le CHECK refuserait finirait sinon en 500, et le client ne saurait pas pourquoi.
 */
function estAdresseHttps(v: string): boolean {
  if (!v.startsWith(DEBUT_AVATAR)) return false;
  try {
    return new URL(v).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Un champ facultatif vidé arrive en chaîne vide depuis un formulaire : il vaut « rien », donc null. */
const texteFacultatif = (max: number) =>
  z.string().trim().max(max).nullable().transform((v) => (v === null || v === '' ? null : v));

const CHAMPS = {
  nom: z.string().trim().min(1).max(MAX_NOM_WIDGET),
  phrase: z.string().trim().min(1).max(MAX_PHRASE_WIDGET),
  // `agent` passe ici pour être refusé plus loin AVEC sa raison (« à venir »), plutôt que noyé dans un refus de forme.
  devenir: z.enum(['agent', 'mba', 'scenario']).nullable(),
  workflowId: z.string().uuid().nullable(),
  couleur: z.string().regex(COULEUR_RE),
  position: z.enum(POSITIONS_WIDGET),
  libelle: texteFacultatif(MAX_LIBELLE_WIDGET),
  avatarUrl: texteFacultatif(MAX_AVATAR_URL).refine((v) => v === null || estAdresseHttps(v)),
  actif: z.boolean(),
  // Même règle que la base (`widgets_max_par_heure_chk`) : 0 voudrait dire « aucun plafond » dans la convention du
  // dépôt, le contraire de ce que veut celui qui le tape. Retirer le plafond, c'est écrire null.
  maxParHeure: z.number().int().min(1).max(MAX_PAR_HEURE_WIDGET).nullable(),
};

/**
 * ⚠️ `badge` N'EST PAS DANS LA SAISIE, délibérément. « Propulsé par Messaging Me » disparaît en offre Pro (spec,
 * section 4), et la colonne le dit : le retirer est un acte COMMERCIAL, qui doit se décider explicitement. Tant que
 * cette offre n'existe pas, ni l'écran ni le MCP ne peuvent l'éteindre ; une modification garde la valeur en base.
 *
 * Exportés pour UNE raison : le schéma d'entrée des outils MCP doit annoncer chaque borne qu'ils appliquent, et
 * `tests/mcp-widgets.test.ts` la lit ICI plutôt que dans une copie.
 */
export const saisieDeModification = z.object(CHAMPS).partial().strict();
export const saisieDeCreation = z.object(CHAMPS).partial().required({ nom: true, phrase: true }).strict();
type Saisie = z.infer<typeof saisieDeModification>;
/** Les champs qu'une saisie peut porter, la même liste pour la route et pour les outils MCP. */
export type ChampWidget = keyof Saisie;

/** Ce qu'il faut savoir d'un champ refusé pour corriger sa saisie, sans lire le code. */
const AIDE_DES_CHAMPS: Readonly<Record<string, string>> = {
  nom: `le nom (1 à ${MAX_NOM_WIDGET} caractères)`,
  phrase: `la phrase (1 à ${MAX_PHRASE_WIDGET} caractères)`,
  devenir: 'le devenir (null pour le réglage de l’espace, « mba » ou « scenario »)',
  workflowId: 'le scénario (l’identifiant d’un scénario de l’espace)',
  couleur: 'la couleur (six chiffres hexadécimaux, comme #25d366)',
  position: `la position (${POSITIONS_WIDGET.join(', ')})`,
  libelle: `le libellé (${MAX_LIBELLE_WIDGET} caractères au plus)`,
  avatarUrl: 'l’avatar (une adresse qui commence par https://)',
  actif: 'actif (vrai ou faux)',
  maxParHeure: `le plafond horaire (un entier de 1 à ${MAX_PAR_HEURE_WIDGET}, ou null)`,
};

function messageDeSaisie(erreur: z.ZodError): string {
  const premier = erreur.issues[0];
  if (premier?.code === 'unrecognized_keys') return `Champ inconnu : ${premier.keys.join(', ')}.`;
  const aide = AIDE_DES_CHAMPS[String(premier?.path[0] ?? '')];
  return aide ? `Valeur invalide pour ${aide}.` : 'Corps de requête invalide.';
}

export const WIDGET_INCONNU = 'Widget inconnu dans cet espace.';
export const DEVENIR_AGENT_A_VENIR =
  'Un widget ne se confie pas à un agent IA précis : faites de l’agent le répondeur de l’espace, puis choisissez le répondeur automatique pour ce widget.';
const SCENARIO_A_CHOISIR = 'Choisissez le scénario que ce widget démarre.';
const SCENARIO_SANS_DEVENIR = 'Un scénario ne se désigne qu’avec le devenir « scénario ».';
const SCENARIO_INCONNU = 'Ce scénario n’existe pas dans cet espace.';
export const SCENARIO_NON_PUBLIE =
  'Ce scénario n’a aucune version publiée : publiez-le d’abord, sinon ce widget ne démarrerait rien.';
const PHRASE_VIDE = 'Cette phrase ne contient aucun caractère exploitable : choisissez une phrase lisible.';
const PHRASE_ARRET =
  'Ce message commence par un mot d’arrêt (« stop », « arrêt », « désabonner »…) : chaque visiteur qui l’enverrait serait désabonné. Commencez-le autrement.';
const PHRASE_DEJA_PRISE = 'Un autre widget de cet espace porte déjà cette phrase.';
const LIMITE_ATTEINTE =
  `Cet espace a déjà ${LIMITE_WIDGETS_PAR_ESPACE} widgets, le maximum : supprimez-en un avant d’en créer un autre.`;

export interface DepsGestionWidgets {
  widgets: {
    lister(tenantId: string): Promise<WidgetRow[]>;
    creer(tenantId: string, w: WidgetInput): Promise<WidgetRow>;
    modifier(tenantId: string, id: string, w: WidgetInput): Promise<WidgetRow | null>;
    supprimer(tenantId: string, id: string): Promise<boolean>;
  };
  /** Les phrases des liens de chaîne de l'espace (`PgChannelsMeLinkStore.phrasesDesLiens`). */
  phrasesDesLiens(tenantId: string): Promise<string[]>;
  /**
   * Combien de messages reçus récents contiennent déjà cette phrase, HORS arrivées par un widget
   * (`PgChannelsMeLinkStore.messagesContenantLaPhrase`).
   */
  messagesContenantLaPhrase(tenantId: string, phrase: string): Promise<number>;
  /**
   * Ce scénario peut-il démarrer, et est-il de CET espace (`etatDuScenario`) ? Un scénario d'un autre espace rend
   * 'inconnu', comme un identifiant qui n'existe pas.
   */
  scenarioEtat(tenantId: string, workflowId: string): Promise<EtatScenario>;
}

/**
 * L'assemblage de production, appelé par le câblage de l'API (`src/index.ts`) et par le test d'intégration, qui
 * éprouve ainsi les VRAIES requêtes, dont celle qui dit à quel espace appartient un scénario.
 */
export function gestionDesWidgetsEnBase(pool: Pool): DepsGestionWidgets {
  const liens = new PgChannelsMeLinkStore(pool);
  const scenarios = new PgWorkflowStore(pool);
  return {
    widgets: new PgWidgetStore(pool),
    phrasesDesLiens: (tenantId) => liens.phrasesDesLiens(tenantId),
    // Le comptage des liens de chaîne (`tenant_id = $1`, une fenêtre de 90 jours, la casse ignorée, les messages
    // à jeton de lien écartés), PLUS les arrivées par un widget écartées (lot 5) : elles sont le succès d'un widget,
    // pas de la conversation ordinaire, et les compter refusait de reprendre une phrase qui avait servi.
    messagesContenantLaPhrase: (tenantId, phrase) =>
      liens.messagesContenantLaPhrase(tenantId, phrase, { horsArriveesDeWidget: true }),
    // `getById` filtre sur `id` ET `tenant_id` : un scénario d'un autre espace y est introuvable. La lecture est
    // celle du bouton d'un lien de chaîne (`etatDuScenario`), câblée pour lui dans `src/index.ts`.
    scenarioEtat: async (tenantId, workflowId) => etatDuScenario(await scenarios.getById(workflowId, tenantId)),
  };
}

/**
 * L'état que la saisie produit, contrôlé. `courant` = null à la création. Les contrôles statiques passent avant
 * ceux qui lisent la base.
 */
async function preparer(
  deps: DepsGestionWidgets,
  tenantId: string,
  existants: readonly WidgetRow[],
  courant: WidgetRow | null,
  s: Saisie,
): Promise<Issue<WidgetInput>> {
  // L'état EFFECTIF, jamais le seul corps de la requête : une garde posée sur le corps ne fermerait qu'un sens.
  const devenir: DevenirWidget | null = s.devenir !== undefined ? s.devenir : (courant?.devenir ?? null);
  if (devenir === 'agent') return refus(400, DEVENIR_AGENT_A_VENIR);

  let workflowId: string | null = null;
  // La requête CHOISIT-elle le scénario ? Toujours à la création ; à la modification, quand elle porte le devenir ou
  // le scénario. Une modification de la couleur seule ne choisit rien.
  const choisitLeScenario = courant === null || s.devenir !== undefined || s.workflowId !== undefined;
  if (devenir === 'scenario') {
    workflowId = s.workflowId !== undefined ? s.workflowId : (courant?.workflowId ?? null);
    // Un scénario manquant n'est refusé que si la requête CHOISIT le devenir. Un widget devenu inerte (scénario
    // supprimé après coup, `on delete set null`) reste ainsi modifiable, sa couleur par exemple : l'écran dit qu'il
    // ne démarre plus rien et invite à choisir un autre scénario, sans l'exiger pour toucher au reste.
    if (workflowId === null && choisitLeScenario) return refus(400, SCENARIO_A_CHOISIR);
  } else if (s.workflowId !== undefined && s.workflowId !== null) {
    // Sinon la base refuserait (`widgets_scenario_sans_devenir_chk`), en 500.
    return refus(400, SCENARIO_SANS_DEVENIR);
  }

  // La création exige la phrase et la modification part d'un widget qui en a une : `undefined` ne se produit pas,
  // et se refuserait comme une phrase vide.
  const phrase = s.phrase ?? courant?.phrase;
  if (phrase === undefined) return refus(400, PHRASE_VIDE);
  // Le CHECK `widgets_phrase_non_vide_chk` ne voit que le cas flagrant : des diacritiques seuls passent `trim`, et
  // `normalizeText` les réduit à rien. Une phrase vide serait contenue dans TOUS les messages.
  if (normalizeText(phrase) === '') return refus(400, PHRASE_VIDE);

  if (workflowId !== null) {
    const etat = await deps.scenarioEtat(tenantId, workflowId);
    // 🔴 L'espace, à chaque désignation, y compris inchangée : une requête de plus, contre un contrôle qui ne dépend
    // pas de l'histoire de la ligne. C'est un contrôle d'ISOLATION, il ne connaît pas d'exception.
    if (etat === 'inconnu') return refus(400, SCENARIO_INCONNU);
    // La version publiée, seulement quand la requête CHOISIT le scénario : c'est une hygiène, pas une frontière. Un
    // widget dont le scénario n'est pas publié (créé avant ce contrôle, ou dépublié depuis) ne démarre rien, comme un
    // widget inerte, et reste modifiable comme lui : sinon on ne pourrait même plus l'éteindre. 409 et non 400 :
    // la saisie est juste, c'est l'état du scénario qui ne l'est pas encore.
    if (etat === 'vide' && choisitLeScenario) return refus(409, SCENARIO_NON_PUBLIE);
  }

  // Une phrase inchangée (à la normalisation près) n'a rien à reprouver : ses conflits n'ont pas bougé, et la
  // recompter la jugerait sur ce qu'elle a déjà capté. Une phrase qui CHANGE est recomptée, hors arrivées par un
  // widget (lot 5) : raccourcir une phrase qui a servi n'est plus refusé à cause de son propre succès.
  const changeDePhrase = courant === null || normalizeText(phrase) !== normalizeText(courant.phrase);
  if (changeDePhrase) {
    // 🔴 Un message qui COMMENCE par un mot d'arrêt désabonnerait chaque visiteur : le STOP est reconnu par
    // `processInbound` AVANT l'étape du widget (`estDemandeArret`, ancré en début de message), et le scénario serait
    // ensuite refusé par la garde du désabonnement. Seulement quand la phrase change : un widget existant reste
    // éteignable (revue finale du widget, 2026-10-03).
    if (estDemandeArret(phrase)) return refus(400, PHRASE_ARRET);
    // Éteints compris : un widget éteint se rallume, et sa balise est toujours posée. Le widget modifié est exclu,
    // sinon une phrase qui prolonge la sienne (« … du site » vers « … du site web ») se heurterait à elle-même.
    const voisin = existants.find((w) => w.id !== courant?.id && phrasesEnConflit(phrase, w.phrase));
    if (voisin) {
      return refus(409, `Cette phrase entre en conflit avec celle du widget « ${voisin.nom} » (l’une contient l’autre) : un seul message déclencherait les deux.`);
    }
    if (enConflitAvec(phrase, await deps.phrasesDesLiens(tenantId))) {
      return refus(409, 'Cette phrase entre en conflit avec celle d’un lien de chaîne WhatsApp (l’une contient l’autre) : un seul message déclencherait les deux.');
    }
    const dejaVus = await deps.messagesContenantLaPhrase(tenantId, phrase);
    if (dejaVus > 0) {
      // Le nombre est dit : « trop banale » sans chiffre laisse le client deviner ce qu'on lui reproche.
      return refus(409, `Cette phrase apparaît déjà dans ${dejaVus} message(s) reçu(s) : ce widget s’appliquerait à des conversations ordinaires. Choisissez une phrase plus spécifique.`);
    }
  }

  return {
    ok: true,
    valeur: {
      nom: s.nom ?? courant?.nom ?? '',
      phrase,
      devenir,
      // Le devenir `agent` étant refusé, aucun agent ne s'écrit par ici.
      agentId: null,
      workflowId,
      couleur: s.couleur ?? courant?.couleur ?? COULEUR_PAR_DEFAUT,
      position: s.position ?? courant?.position ?? 'bas_droite',
      libelle: s.libelle !== undefined ? s.libelle : (courant?.libelle ?? null),
      avatarUrl: s.avatarUrl !== undefined ? s.avatarUrl : (courant?.avatarUrl ?? null),
      badge: courant?.badge ?? true,
      actif: s.actif ?? courant?.actif ?? true,
      maxParHeure: s.maxParHeure !== undefined ? s.maxParHeure : (courant?.maxParHeure ?? null),
    },
  };
}

/**
 * Le filet de l'index `widgets_phrase_key` : deux créations simultanées passent toutes les deux le contrôle, la base
 * tranche. Le nom de la contrainte est vérifié, pas seulement le code : une collision sur `widgets_code_key` (un
 * tirage de 60 bits) n'est pas une phrase prise, et le dire au client le ferait chercher une faute qu'il n'a pas faite.
 */
function estPhraseDejaPrise(err: unknown): boolean {
  return typeof err === 'object' && err !== null
    && 'code' in err && err.code === '23505'
    && 'constraint' in err && err.constraint === 'widgets_phrase_key';
}

export async function creerWidget(deps: DepsGestionWidgets, tenantId: string, corps: unknown): Promise<Issue<WidgetRow>> {
  const lu = saisieDeCreation.safeParse(corps ?? {});
  if (!lu.success) return refus(400, messageDeSaisie(lu.error));
  const existants = await deps.widgets.lister(tenantId);
  // ⚠️ Deux créations simultanées peuvent passer à 4 et finir à 6 : un dépassement d'un widget, sans conséquence,
  // qui ne justifie pas un verrou. La limite borne un usage, pas une ressource.
  if (existants.length >= LIMITE_WIDGETS_PAR_ESPACE) return refus(409, LIMITE_ATTEINTE);
  const pret = await preparer(deps, tenantId, existants, null, lu.data);
  if (!pret.ok) return pret;
  try {
    return { ok: true, valeur: await deps.widgets.creer(tenantId, pret.valeur) };
  } catch (err) {
    if (estPhraseDejaPrise(err)) return refus(409, PHRASE_DEJA_PRISE);
    throw err;
  }
}

/** Une modification PARTIELLE : un champ absent garde sa valeur, `null` efface un champ facultatif. */
export async function modifierWidget(
  deps: DepsGestionWidgets, tenantId: string, id: string, corps: unknown,
): Promise<Issue<WidgetRow>> {
  if (!estUuid(id)) return refus(404, WIDGET_INCONNU);
  const lu = saisieDeModification.safeParse(corps ?? {});
  if (!lu.success) return refus(400, messageDeSaisie(lu.error));
  // `lister` et non une lecture par identifiant : elle porte aussi les AUTRES widgets, contre lesquels la phrase se
  // compare, et c'est elle qui permet d'exclure le widget lui-même de cette comparaison.
  const existants = await deps.widgets.lister(tenantId);
  const courant = existants.find((w) => w.id === id) ?? null;
  if (courant === null) return refus(404, WIDGET_INCONNU);
  const pret = await preparer(deps, tenantId, existants, courant, lu.data);
  if (!pret.ok) return pret;
  try {
    const modifie = await deps.widgets.modifier(tenantId, id, pret.valeur);
    return modifie ? { ok: true, valeur: modifie } : refus(404, WIDGET_INCONNU);
  } catch (err) {
    if (estPhraseDejaPrise(err)) return refus(409, PHRASE_DEJA_PRISE);
    throw err;
  }
}

/**
 * La balise déjà posée chez le client ne casse pas : un code inconnu rend un script inerte (lot 2), donc la bulle
 * disparaît du site sans erreur.
 */
export async function supprimerWidget(deps: DepsGestionWidgets, tenantId: string, id: string): Promise<Issue<null>> {
  if (!estUuid(id)) return refus(404, WIDGET_INCONNU);
  return (await deps.widgets.supprimer(tenantId, id)) ? { ok: true, valeur: null } : refus(404, WIDGET_INCONNU);
}

/** Un widget tel que la console et le MCP le montrent : la ligne, et ce qu'il faut pour le poser sur un site. */
export interface VueWidget {
  id: string;
  code: string;
  nom: string;
  phrase: string;
  devenir: DevenirWidget | null;
  workflowId: string | null;
  couleur: string;
  position: PositionWidget;
  libelle: string | null;
  avatarUrl: string | null;
  badge: boolean;
  actif: boolean;
  maxParHeure: number | null;
  createdAt: string;
  updatedAt: string;
  /** L'adresse du script, servie par `GET /widget/<code>.js`. */
  adresseScript: string;
  /** La balise à coller sur le site. */
  balise: string;
  /** Le lien `wa.me` de la bulle ; null = la bulle s'affiche grisée (aucun numéro, ou numéro délié). */
  waMeUrl: string | null;
  /**
   * Le devenir dit « scénario » et il n'y en a plus : supprimé après coup (`on delete set null`, décision de Julien
   * du 2026-10-02). Le widget pose encore son étiquette, mais ne démarre plus rien.
   */
  scenarioSupprime: boolean;
}

/**
 * Champ par champ, sans étaler la ligne : `tenantId` et `agentId` n'ont rien à faire dans ce que l'écran ou un
 * assistant reçoit, et un champ ajouté demain à `WidgetRow` ne doit pas sortir sans qu'on l'ait décidé ici.
 */
export function vueDuWidget(w: WidgetRow, baseApi: string, numero: NumeroDuWidget | null): VueWidget {
  const adresseScript = adresseDuScript(baseApi, w.code);
  return {
    id: w.id,
    code: w.code,
    nom: w.nom,
    phrase: w.phrase,
    devenir: w.devenir,
    workflowId: w.workflowId,
    couleur: w.couleur,
    position: w.position,
    libelle: w.libelle,
    avatarUrl: w.avatarUrl,
    badge: w.badge,
    actif: w.actif,
    maxParHeure: w.maxParHeure,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
    adresseScript,
    balise: baliseDuScript(adresseScript),
    waMeUrl: lienDuWidget(numero, w.phrase),
    scenarioSupprime: w.devenir === 'scenario' && w.workflowId === null,
  };
}

/**
 * Les deux portes reçoivent le MÊME objet du câblage (`src/index.ts`) : la gestion, et de quoi montrer un widget. Un
 * second assemblage pour le MCP pourrait montrer un autre numéro, donc un autre lien `wa.me`, que celui de la console.
 */
export interface DepsWidgets {
  gestion: DepsGestionWidgets;
  /** Le numéro principal de l'espace (`PgPhoneStatusStore.getPhoneNumber`), pour le lien `wa.me` de la bulle. */
  numero(tenantId: string): Promise<NumeroDuWidget | null>;
  /**
   * La base des routes d'API (`adressesPubliques(...).avecPrefixe`), celle de l'adresse du script. Ni la route ni
   * l'outil ne la recomposent : l'écran et l'assistant reçoivent l'adresse et la balise prêtes à copier.
   */
  baseApi: string;
}

/**
 * La mise en vue des widgets d'un espace. 🔴 Le numéro est lu AVANT toute écriture : lu après, sa panne rendrait une
 * erreur sur un widget pourtant créé, et celui qui réessaierait se ferait refuser sa propre phrase.
 */
export async function miseEnVue(deps: DepsWidgets, tenantId: string): Promise<(w: WidgetRow) => VueWidget> {
  const numero = await deps.numero(tenantId);
  return (w) => vueDuWidget(w, deps.baseApi, numero);
}

/** La liste d'un espace telle que la console et le MCP la rendent, avec la limite qui s'applique à la création. */
export async function listerEnVue(deps: DepsWidgets, tenantId: string): Promise<{ widgets: VueWidget[]; limite: number }> {
  const [widgets, vue] = await Promise.all([deps.gestion.widgets.lister(tenantId), miseEnVue(deps, tenantId)]);
  return { widgets: widgets.map(vue), limite: LIMITE_WIDGETS_PAR_ESPACE };
}
