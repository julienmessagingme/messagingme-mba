import type { OutilAnnonce } from '../../mcp/client';
import type { RisqueOutil } from '../catalog';
import type { ParamOutil } from '../llm/tool-schema';
import { aplatirSchema } from './aplatir';
import { normaliserNom, nomUnique } from './nommer';

/**
 * Comparer le catalogue d'un serveur MCP à ce qu'on en avait, et rendre un plan. Module pur : l'écriture est
 * ailleurs, ce qui permet de montrer le plan (suppressions comprises) avant de l'appliquer.
 */

/** Ce qu'on sait d'un outil MCP déjà importé, tel que le store le rend. */
export interface OutilExistantMcp {
  id: string;
  /** Notre nom local, celui exposé au modèle. */
  name: string;
  /** Le nom chez le serveur : c'est lui qui apparie, pas le nôtre. */
  nomDistant: string;
  /** L'annonce d'avant (`agent_tools.mcp_annonce`), ou `null` pour une ligne plus ancienne. */
  mcpAnnonce: unknown;
  mcpIndisponibleLe: Date | null;
  /**
   * Les paramètres de la version en place, avec le clouage que le client y a posé. Requis : un appelant qui
   * l'oublierait ferait retomber tous les paramètres en « remplis par le modèle » au premier changement.
   */
  params: ParamOutil[];
  /** Combien de consommateurs l'ont activé. C'est ce qu'un changement fait tomber. */
  consommateursActifs: number;
}

export type ChangementMcp =
  | { type: 'nouveau'; nom: string }
  | { type: 'inchange'; nom: string }
  | { type: 'schema_change'; nom: string; consentementsTombes: number }
  | { type: 'disparu'; nom: string; consentementsTombes: number };

/**
 * Une empreinte stable de ce que le serveur annonce pour un outil.
 *
 * Triée récursivement : un serveur qui réordonne ses clés ne doit pas faire tomber tous les consentements.
 * 🔴 Elle couvre toute l'annonce, pas seulement le schéma : la `description` est du texte d'un tiers qui
 * arrive dans le contexte du modèle, et les `annotations` pré-remplissent le risque. Un changement exige un
 * nouveau oui.
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
 * Le plan d'un rafraîchissement, outil par outil. `tronque` est requis : un booléen optionnel à `false` par
 * défaut ferait, le jour où un appelant l'oublie, marquer disparus les outils au-delà de la borne.
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
     * Une annonce absente est un changement, jamais un « inchangé » : on ne peut pas affirmer que rien n'a bougé
     * sur un outil qu'on n'a jamais comparé, et un consentement le couvrirait.
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
     * Sur un catalogue tronqué, aucune disparition : le serveur annonce plus d'outils que nos bornes, et
     * marquer « disparu » ce qui n'y figure pas ferait tomber le consentement de tout ce qui vit au-delà
     * (contrat de `SessionMcp.lister()`). On suspend la suppression, pas la mise à jour.
     */
    if (opts.tronque) continue;
    // Déjà marqué : ne pas le re-signaler à chaque rafraîchissement, sinon ce bruit cache ce qui vient de changer.
    if (e.mcpIndisponibleLe !== null) continue;
    plan.push({ type: 'disparu', nom: e.nomDistant, consentementsTombes: e.consommateursActifs });
  }

  return plan;
}

/**
 * Ce qu'un outil annoncé devient chez nous, avant toute écriture (nom exposé, paramètres, activabilité),
 * calculé ici, en pur, pour se tester sans serveur.
 */
export interface OutilAImporter {
  /** Le nom chez le serveur : c'est lui qu'on renvoie à l'appel, et lui qui apparie au rafraîchissement. */
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
 * Le risque proposé pour un outil annoncé : pré-rempli, jamais décidé. La spec MCP tient les annotations
 * pour non fiables, et un `readOnlyHint` menteur désarmerait la garde d'autonomie ; le client confirme. Sans
 * annotation, `write` : entre les deux erreurs, une seule se rattrape.
 */
export function risquePropose(annonce: OutilAnnonce): RisqueOutil {
  const a = annonce.annotations;
  if (a && a.destructiveHint === true) return 'irreversible';
  if (a && a.readOnlyHint === true) return 'read';
  return 'write';
}

/**
 * Reporte sur les paramètres neufs le clouage que le client avait posé sur les anciens.
 *
 * 🔴 Une annonce distante ne porte aucune source : sans ce report, un changement de schéma (ou de simple
 * `description`) remettrait tout en « rempli par le modèle », et le client, en redonnant son consentement
 * depuis un autre écran, réactiverait un identifiant redevenu libre (IDOR). L'appariement se fait sur
 * `cheminMcp`, stable, pas sur notre nom. Le clouage est reporté même si le type a changé : un paramètre
 * trop cloué se voit et se corrige, un paramètre libéré à tort fuit sans bruit.
 */
export function reporterClouage(neufs: ParamOutil[], anciens: readonly ParamOutil[]): ParamOutil[] {
  const parChemin = new Map(anciens.filter((p) => p.cheminMcp).map((p) => [p.cheminMcp!, p]));
  return neufs.map((p) => {
    const avant = p.cheminMcp ? parChemin.get(p.cheminMcp) : undefined;
    if (!avant || avant.source === 'modele') return p;
    return {
      ...p,
      source: avant.source,
      ...(avant.cle ? { cle: avant.cle } : {}),
      ...(avant.contactPath ? { contactPath: avant.contactPath } : {}),
      ...(avant.value !== undefined ? { value: avant.value } : {}),
    };
  });
}

export function outilDepuisAnnonce(
  annonce: OutilAnnonce,
  libelleSource: string,
  pris: ReadonlySet<string>,
  /** Les paramètres de la version précédente, quand il y en a une. Leur clouage est reporté. */
  anciens: readonly ParamOutil[] = [],
): OutilAImporter {
  const aplati = aplatirSchema(annonce.inputSchema);
  return {
    nomDistant: annonce.name,
    // Préfixé par le serveur : le nom est unique par espace, deux serveurs qui exposent chacun un `search`
    // entreraient en collision. Le modèle voit aussi d'où vient l'outil.
    name: nomUnique(`${normaliserNom(libelleSource)}_${normaliserNom(annonce.name)}`, pris),
    title: (annonce.title ?? annonce.name).slice(0, 120),
    description: (annonce.description ?? '').slice(0, 2000),
    // Vide à l'import : « quand ne pas l'appeler » est au client d'écrire, le serveur distant n'en sait rien.
    nePasUtiliser: '',
    /**
     * Tout arrive en `modele` à la première importation, et le client cloue ensuite ce qui doit l'être. Pas de
     * clouage deviné sur un nom (`email`) : le jour où la correspondance se tromperait, l'appel viserait la
     * mauvaise ressource sans rien dire.
     */
    /**
     * Un outil devenu non activable garde ses paramètres d'avant : écrire `feuilles: []` effacerait le
     * clouage, et un serveur n'aurait qu'à publier un schéma irreprésentable puis revenir au précédent pour
     * tout remettre « rempli par le modèle ». Les garder ne coûte rien : l'outil est refusé à l'activation et à
     * l'exécution.
     */
    params: aplati.raisonNonActivable !== null
      ? [...anciens]
      : reporterClouage(aplati.feuilles.map((f) => ({
        name: f.name,
        type: f.type,
        source: 'modele' as const,
        cheminMcp: f.cheminMcp,
        ...(f.description ? { description: f.description } : {}),
        ...(f.required ? { required: true } : {}),
        ...(f.enum ? { enum: f.enum } : {}),
      })), anciens),
    annonce,
    nonActivable: aplati.raisonNonActivable,
    risk: risquePropose(annonce),
  };
}
