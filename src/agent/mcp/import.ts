import type { OutilAnnonce } from '../../mcp/client';
import type { RisqueOutil } from '../catalog';
import type { ParamOutil } from '../llm/tool-schema';
import { aplatirSchema } from './aplatir';
import { normaliserNom, nomUnique } from './nommer';

/**
 * Comparer le catalogue d'un serveur MCP à ce qu'on en avait, et rendre un PLAN.
 *
 * 🔴 CE MODULE EST PUR, ET C'EST TOUT SON INTÉRÊT. Il ne lit ni la base ni le réseau : il COMPARE. L'écriture
 * est ailleurs, ce qui permet de MONTRER le plan avant de l'appliquer. Même patron que l'aperçu de
 * publication chez Meta, pour la même raison qui y est écrite : écraser n'est acceptable que si l'on montre
 * QUOI avant de le faire, suppressions comprises.
 */

/** Ce qu'on sait d'un outil MCP déjà importé, tel que le store le rend. */
export interface OutilExistantMcp {
  id: string;
  /** Notre nom local, celui exposé au modèle. */
  name: string;
  /** Le nom chez le serveur : c'est LUI qui apparie, pas le nôtre. */
  nomDistant: string;
  /** L'annonce d'avant (`agent_tools.mcp_annonce`), ou `null` si la ligne est antérieure à ce lot. */
  mcpAnnonce: unknown;
  mcpIndisponibleLe: Date | null;
  /** Combien de consommateurs l'ont ACTIVÉ. C'est ce qu'un changement fait tomber. */
  consommateursActifs: number;
}

export type ChangementMcp =
  | { type: 'nouveau'; nom: string }
  | { type: 'inchange'; nom: string }
  | { type: 'schema_change'; nom: string; consentementsTombes: number }
  | { type: 'disparu'; nom: string; consentementsTombes: number };

/**
 * Une empreinte STABLE de ce que le serveur annonce pour un outil.
 *
 * 🔴 ELLE NE DOIT PAS CHANGER QUAND LE SERVEUR RÉORDONNE SES CLÉS. La sérialisation d'un objet JSON n'a
 * aucun ordre garanti : une empreinte naïve ferait tomber TOUS les consentements du client à chaque
 * rafraîchissement, pour une différence qui n'existe pas. D'où le tri récursif.
 *
 * 🔴 ELLE COUVRE TOUTE L'ANNONCE, PAS SEULEMENT LE SCHÉMA. La `description` d'un outil distant est du texte
 * écrit par un TIERS qui arrive dans le contexte du modèle : la traiter comme cosmétique laisserait un
 * serveur réécrire ce que l'agent croit devoir faire, sans que personne ne redise oui. Les `annotations`
 * y sont aussi : elles pré-remplissent le risque proposé au client.
 */
export function empreinteAnnonce(annonce: OutilAnnonce): string {
  return JSON.stringify(trier(annonce as unknown));
}

function trier(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(trier);
  if (typeof v !== 'object' || v === null) return v;
  const entrees = Object.entries(v as Record<string, unknown>)
    .filter(([, valeur]) => valeur !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entrees.map(([cle, valeur]) => [cle, trier(valeur)]));
}

/**
 * Le plan d'un rafraîchissement, outil par outil.
 *
 * 🔴 `tronque` EST REQUIS, ET CE N'EST PAS DE LA RIGUEUR DE FORME. Un booléen optionnel valant `false` par
 * défaut ferait exactement ce qu'on cherche à empêcher le jour où un appelant l'oublie : c'est le motif
 * « dépendance optionnelle » que ce dépôt a déjà payé trois fois (`estDesabonne`, `guard`, `journal`).
 */
export function planifierImport(
  annonces: readonly OutilAnnonce[],
  existants: readonly OutilExistantMcp[],
  opts: { tronque: boolean },
): ChangementMcp[] {
  const parNomDistant = new Map(existants.map((e) => [e.nomDistant, e]));
  const plan: ChangementMcp[] = [];
  const vus = new Set<string>();

  for (const a of annonces) {
    vus.add(a.name);
    const avant = parNomDistant.get(a.name);
    if (!avant) { plan.push({ type: 'nouveau', nom: a.name }); continue; }

    /**
     * ⚠️ UNE ANNONCE ABSENTE EST TRAITÉE COMME UN CHANGEMENT, jamais comme un « inchangé ». Une ligne
     * écrite avant ce lot, ou reprise à la main, n'a pas d'annonce : on ne peut donc PAS affirmer que rien
     * n'a bougé. Dire « inchangé » laisserait un consentement couvrir un outil qu'on n'a jamais comparé.
     */
    const identique = avant.mcpAnnonce !== null
      && avant.mcpAnnonce !== undefined
      && empreinteAnnonce(avant.mcpAnnonce as OutilAnnonce) === empreinteAnnonce(a);

    if (identique) plan.push({ type: 'inchange', nom: a.name });
    else plan.push({ type: 'schema_change', nom: a.name, consentementsTombes: avant.consommateursActifs });
  }

  for (const e of existants) {
    if (vus.has(e.nomDistant)) continue;
    /**
     * 🔴 SUR UN CATALOGUE TRONQUÉ, AUCUNE DISPARITION. La liste EST partielle, légitimement : le serveur
     * annonce plus d'outils que nos bornes. Marquer « disparu » ce qui n'y figure pas ferait tomber le
     * consentement de tout ce qui vivait au delà de la borne. C'est le même danger que la liste rendue
     * après l'échec d'une page, par l'autre porte, et le contrat est écrit sur `SessionMcp.lister()` :
     * sur `tronque`, on AJOUTE et on MET À JOUR, on ne RETIRE jamais.
     *
     * ⚠️ Ce qu'on suspend est la SUPPRESSION, pas la mise à jour : un schéma qui a bougé fait tomber son
     * consentement dans les deux cas, parce que là on a bien comparé deux choses.
     */
    if (opts.tronque) continue;
    // Déjà marqué : ne pas le re-signaler à chaque rafraîchissement, sinon le plan du client se remplit
    // d'un bruit qu'il a déjà lu et qui lui cache ce qui vient de changer.
    if (e.mcpIndisponibleLe !== null) continue;
    plan.push({ type: 'disparu', nom: e.nomDistant, consentementsTombes: e.consommateursActifs });
  }

  return plan;
}

/**
 * Ce qu'un outil annoncé devient chez nous, avant toute écriture.
 *
 * 🔴 PUR, COMME LE RESTE DE CE MODULE. La traduction d'une annonce en ligne d'`agent_tools` est ce qui
 * décide de tout (le nom exposé au modèle, les paramètres, l'activabilité) : la faire dans une route la
 * rendrait intestable sans monter un serveur, et c'est précisément ce qui n'a jamais été éprouvé ailleurs.
 */
export interface OutilAImporter {
  /** Le nom chez le serveur. C'est LUI qu'on renvoie à l'appel, et lui qui apparie au rafraîchissement. */
  nomDistant: string;
  /** Notre nom local, préfixé et unique dans l'espace. */
  name: string;
  title: string;
  description: string;
  nePasUtiliser: string;
  params: ParamOutil[];
  annonce: OutilAnnonce;
  /** `null` = activable. Sinon la raison, telle qu'elle partira à l'écran. */
  nonActivable: string | null;
  risk: RisqueOutil;
}

/**
 * Le risque PROPOSÉ pour un outil annoncé.
 *
 * 🔴 PRÉ-REMPLI, JAMAIS DÉCIDÉ. La spec MCP dit en toutes lettres que les annotations d'un outil sont à
 * considérer comme NON FIABLES sauf serveur de confiance : un serveur qui se déclarerait `readOnlyHint`
 * désarmerait la garde d'autonomie sur une action irréversible. Elles servent donc à proposer, et c'est le
 * client qui confirme, exactement comme il le fait déjà pour l'autonomie d'un outil.
 *
 * ⚠️ LE DÉFAUT EST `write`, PAS `read`. Quand le serveur ne dit rien, on ne sait pas : le défaut penche vers
 * la prudence, parce qu'entre les deux erreurs possibles, une seule se rattrape.
 */
export function risquePropose(annonce: OutilAnnonce): RisqueOutil {
  const a = annonce.annotations;
  if (a && a.destructiveHint === true) return 'irreversible';
  if (a && a.readOnlyHint === true) return 'read';
  return 'write';
}

export function outilDepuisAnnonce(
  annonce: OutilAnnonce,
  libelleSource: string,
  pris: ReadonlySet<string>,
): OutilAImporter {
  const aplati = aplatirSchema(annonce.inputSchema);
  return {
    nomDistant: annonce.name,
    // 🔴 PRÉFIXÉ PAR LE SERVEUR. Le nom est unique par ESPACE depuis 0127 : deux serveurs qui exposent
    // chacun un `search` entreraient sinon en collision, et le second échouerait à l'import sur une
    // contrainte de base, ce qui est illisible pour le client. Le modèle y gagne aussi : il VOIT d'où
    // vient l'outil quand il en a quinze sous les yeux.
    name: nomUnique(`${normaliserNom(libelleSource)}_${normaliserNom(annonce.name)}`, pris),
    title: (annonce.title ?? annonce.name).slice(0, 120),
    description: (annonce.description ?? '').slice(0, 2000),
    // ⚠️ VIDE À L'IMPORT, et c'est au client de l'écrire : « quand NE PAS l'appeler » est le seul levier qui
    // décide quand un outil se déclenche, et le serveur distant n'en sait rien.
    nePasUtiliser: '',
    /**
     * ⚠️ TOUT ARRIVE EN `modele`, ET C'EST LE POINT DE DÉPART, PAS L'ARRIVÉE. Le client cloue ensuite ce qui
     * doit l'être. Un import qui devinerait qu'un paramètre nommé `email` doit venir de la fiche poserait
     * une garde d'identité que personne n'a demandée, sur une correspondance de nom : le jour où elle se
     * trompe, l'appel part sur la mauvaise ressource sans que rien ne le dise.
     */
    params: aplati.feuilles.map((f) => ({
      name: f.name,
      type: f.type,
      source: 'modele' as const,
      cheminMcp: f.cheminMcp,
      ...(f.description ? { description: f.description } : {}),
      ...(f.required ? { required: true } : {}),
      ...(f.enum ? { enum: f.enum } : {}),
    })),
    annonce,
    nonActivable: aplati.raisonNonActivable,
    risk: risquePropose(annonce),
  };
}
