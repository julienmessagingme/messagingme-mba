import { payloadCampagne, payloadEnsemble, payloadCrea, payloadCreaVideo, payloadPub, type FormulairePub } from '../meta/pubs-payloads';
import type { AudiencePub, EtatVideo } from '../meta/pubs-creation';
import type { DestinationPub } from './routage';

/**
 * La séquence de création d'une publicité, et son rattrapage. IO injectée : la séquence entière, chemins
 * d'échec compris, s'exécute contre de faux objets. Cinq appels chez un tiers qui dépense l'argent du
 * client : ce qui compte est ce qui se passe quand l'un échoue.
 *
 * 🔴 Tout est créé en pause, sans exception : une campagne en pause ne dépense rien, un échec est donc
 * inoffensif. Seule la publication, geste distinct, fait diffuser, et elle allume l'automation avant Meta.
 */

/** Ce que la séquence sait faire chez Meta. Un objet minuscule, pour qu'un faux tienne en quinze lignes. */
export interface ClientCreationPub {
  /** Rend l'empreinte du visuel (`image_hash`). */
  televerserImage(base64: string): Promise<string>;
  /** L'état d'une vidéo déjà déposée chez Meta. Seul `prete` autorise la créa. */
  etatVideo(videoId: string): Promise<EtatVideo>;
  /** L'empreinte de la vignette d'une vidéo, redéposée comme image (jamais l'adresse du CDN de Meta). */
  vignetteVideo(videoId: string): Promise<string>;
  /** L'état des audiences demandées, relu chez Meta ; une audience absente de la table est inutilisable. */
  etatAudiences(ids: readonly string[]): Promise<Map<string, AudiencePub>>;
  creerCampagne(p: Record<string, unknown>): Promise<string>;
  creerEnsemble(p: Record<string, unknown>): Promise<string>;
  creerCrea(p: Record<string, unknown>): Promise<string>;
  creerPub(p: Record<string, unknown>): Promise<string>;
  /** Le rattrapage. Meta supprime en cascade ce que la campagne contient. */
  supprimerCampagne(campagneId: string): Promise<void>;
}

/** Ce que la séquence sait faire chez nous. Chaque identifiant est rangé dès que Meta le rend. */
export interface DepotCreationPub {
  /**
   * Ouvre la ligne de la publicité, en état `creation` ; rend son identifiant chez nous. Après la campagne,
   * jamais avant (`campagne_id not null`) : tant que Meta n'a rien créé, il n'y a rien à garder.
   */
  ouvrir(v: {
    campagneId: string; nom: string; destination: DestinationPub;
    workflowId: string | null; tagQualification: string | null;
    budgetTotal: number; debut: string; fin: string; creePar: string | null;
  }): Promise<string>;
  /** Range les identifiants que Meta vient de rendre. Appelée après chaque étape, pas à la fin. */
  noterIds(id: string, v: { ensembleId?: string; creaId?: string; pubId?: string }): Promise<void>;
  marquerEtat(id: string, etat: 'prete' | 'echec_creation'): Promise<void>;
  /**
   * Mémorise « cette publicité appartient à cette campagne » (`pubs_connues`), pour que le routage la
   * reconnaisse sans appeler Meta au premier lead.
   */
  memoriserPub(adId: string, campagneId: string): Promise<void>;
  /**
   * Crée l'automation possédée de cette publicité, éteinte, et la rattache ; rend son identifiant. Seulement
   * pour une destination `scenario` : une pub confiée à l'agent de Meta n'a rien à démarrer.
   */
  creerAutomation(id: string, v: { nom: string; campagneId: string; workflowId: string }): Promise<string>;
  /**
   * Défait l'automation qu'on vient de créer, quand la création échoue juste après : une automation possédée
   * est absente de l'écran Automation, et sans ce rattrapage plus personne ne pourrait l'effacer.
   */
  supprimerAutomation(automationId: string): Promise<void>;
}

/**
 * Ce que la création a produit. `echec_creation` porte l'identifiant de la ligne : une création ratée dont
 * la campagne n'a pas pu être supprimée laisse un objet chez Meta, que le client doit voir ici.
 */
export type IssueCreation =
  | { sorte: 'creee'; publiciteId: string; campagneId: string }
  | { sorte: 'annulee'; raison: string }
  /**
   * Refusée AVANT tout appel qui crée quelque chose, sur une précondition que le client peut réparer (une vidéo
   * encore en traitement, une audience inutilisable) : ni une panne ni un refus de Meta, un état du parcours.
   */
  | { sorte: 'refusee'; code: 'video_pas_prete' | 'audience_inutilisable'; raison: string }
  | { sorte: 'echec_creation'; publiciteId: string; campagneId: string; raison: string };

/**
 * Le visuel d'une publicité : une image dont on a les octets, OU une vidéo déjà déposée chez Meta, dont on n'a
 * que l'identifiant. Une union et pas deux champs facultatifs : « les deux » et « aucun » ne se construisent pas.
 */
export type VisuelDemande =
  | { sorte: 'image'; base64: string }
  | { sorte: 'video'; videoId: string };

export interface DemandeCreation {
  formulaire: FormulairePub;
  visuel: VisuelDemande;
  destination: DestinationPub;
  workflowId: string | null;
  tagQualification: string | null;
  comptePubId: string;
  pageId: string;
  numeroWhatsApp: string | null;
  creePar: string | null;
}

/**
 * Crée la publicité chez Meta, en pause, et range ce qui en revient. Ordre des appels :
 *  0. les PRÉCONDITIONS, en lecture seule : les audiences demandées sont utilisables, la vidéo est prête. Un refus
 *     ici est `refusee` : rien n'a été créé, et le client sait quoi réparer ;
 *  1. le visuel (l'image, ou la vignette de la vidéo), qui ne crée rien de facturable : s'il échoue, la demande
 *     est `annulee` ;
 *  2. la campagne, racine de tout le reste, donc seule chose à supprimer en cas d'échec ;
 *  3. l'ensemble (budget, dates, ciblage) ;
 *  4. la créa, puis la publicité.
 *
 * Dès que la campagne existe, tout échec tente de la supprimer ; la ligne dit `echec_creation` dans les deux
 * cas, et c'est le seul endroit où le client verra qu'un objet subsiste, en pause. Ne lève jamais : la route
 * rend la raison de Meta, pas une pile.
 */
export async function creerLaPublicite(
  d: DemandeCreation,
  client: ClientCreationPub,
  depot: DepotCreationPub,
): Promise<IssueCreation> {
  const refus = await preconditions(d, client);
  if (refus !== null) return refus;

  let imageHash: string;
  try {
    imageHash = d.visuel.sorte === 'image'
      ? await client.televerserImage(d.visuel.base64)
      : await client.vignetteVideo(d.visuel.videoId);
  } catch (err) {
    // Rien n'existe encore chez Meta : il n'y a rien à défaire, et rien à garder.
    return { sorte: 'annulee', raison: raisonDe(err) };
  }

  let campagneId: string;
  try {
    campagneId = await client.creerCampagne(payloadCampagne(d.formulaire.nom));
  } catch (err) {
    return { sorte: 'annulee', raison: raisonDe(err) };
  }

  // À partir d'ici, un objet existe chez Meta : tout ce qui suit est sous rattrapage, et la ligne est ouverte
  // avant le reste, pour que la campagne soit connue même si notre base tombe ensuite.
  let publiciteId: string;
  try {
    publiciteId = await depot.ouvrir({
      campagneId,
      nom: d.formulaire.nom,
      destination: d.destination,
      workflowId: d.workflowId,
      tagQualification: d.tagQualification,
      budgetTotal: d.formulaire.budgetTotal,
      debut: d.formulaire.debut,
      fin: d.formulaire.fin,
      creePar: d.creePar,
    });
  } catch (err) {
    // On ne sait pas ranger cette campagne : on la supprime, et on le dit.
    await client.supprimerCampagne(campagneId).catch(() => undefined);
    return { sorte: 'annulee', raison: raisonDe(err) };
  }

  // Retenu pour le rattrapage : une automation possédée laissée derrière serait invisible de l'écran
  // Automation et intouchable par son propriétaire disparu.
  let automationId: string | null = null;
  try {
    const ensembleId = await client.creerEnsemble(payloadEnsemble(d.formulaire, {
      campagneId, pageId: d.pageId, numeroWhatsApp: d.numeroWhatsApp,
    }));
    await depot.noterIds(publiciteId, { ensembleId });

    const creaId = await client.creerCrea(d.visuel.sorte === 'image'
      ? payloadCrea(d.formulaire, { pageId: d.pageId, imageHash })
      : payloadCreaVideo(d.formulaire, { pageId: d.pageId, videoId: d.visuel.videoId, imageHash }));
    await depot.noterIds(publiciteId, { creaId });

    const pubId = await client.creerPub(payloadPub(d.formulaire.nom, { ensembleId, creaId }));
    await depot.noterIds(publiciteId, { pubId });

    // Le routage doit connaître cette publicité avant son premier lead, sans appeler Meta sur le chemin chaud
    // d'un message entrant.
    await depot.memoriserPub(pubId, campagneId);

    // L'automation possédée, éteinte : la publication l'allume, avant Meta.
    if (d.destination === 'scenario' && d.workflowId !== null) {
      automationId = await depot.creerAutomation(publiciteId, { nom: d.formulaire.nom, campagneId, workflowId: d.workflowId });
    }

    await depot.marquerEtat(publiciteId, 'prete');
    return { sorte: 'creee', publiciteId, campagneId };
  } catch (err) {
    const raison = raisonDe(err);
    try {
      await client.supprimerCampagne(campagneId);
    } catch (errSuppression) {
      // eslint-disable-next-line no-console
      console.error(`création de publicité : campagne ${campagneId} NON supprimée après échec, elle reste chez Meta EN PAUSE :`, raisonDe(errSuppression));
    }
    // Et l'automation qu'on venait peut-être de créer, qui survivrait sinon à la publicité.
    if (automationId !== null) await depot.supprimerAutomation(automationId).catch(() => undefined);
    // Même état que la suppression ait réussi ou non : il dit « la création a échoué ». Ce qui reste chez Meta
    // vit dans le journal, seul endroit où c'est certain.
    await depot.marquerEtat(publiciteId, 'echec_creation').catch(() => undefined);
    return { sorte: 'echec_creation', publiciteId, campagneId, raison };
  }
}

/** Le message de Meta, tel quel : c'est son compte, et lui seul peut agir sur ce qu'il refuse. */
function raisonDe(err: unknown): string {
  return err instanceof Error ? err.message : 'erreur inconnue';
}

/**
 * Les préconditions d'une création, lues chez Meta AVANT tout appel qui crée : `null` si tout va, sinon le refus.
 *
 * 🔴 La vidéo doit être `prete` : lancer une créa sur une vidéo en traitement, c'est au mieux un refus de Meta
 * APRÈS avoir créé la campagne (donc un rattrapage), au pire une publicité sans vidéo. On lit, on ne patiente
 * pas : l'attente vit à l'écran, qui la montre, et une route qui dormirait tiendrait une requête ouverte.
 *
 * 🔴 Chaque audience demandée doit être utilisable (`delivery_status` 200) : une audience trop petite ou en
 * cours de calcul ferait diffuser une publicité qui ne touche personne, ou dont l'exclusion ne vaut rien.
 */
async function preconditions(d: DemandeCreation, client: ClientCreationPub): Promise<IssueCreation | null> {
  const ids = [...d.formulaire.audiencesIncluses, ...d.formulaire.audiencesExclues];
  if (ids.length > 0) {
    let etats: Map<string, AudiencePub>;
    try {
      etats = await client.etatAudiences(ids);
    } catch (err) {
      return { sorte: 'refusee', code: 'audience_inutilisable', raison: raisonDe(err) };
    }
    const inutilisables = ids.filter((id) => etats.get(id)?.utilisable !== true);
    if (inutilisables.length > 0) {
      const detail = inutilisables.map((id) => {
        const a = etats.get(id);
        if (a === undefined) return `${id} (introuvable pour ce compte publicitaire)`;
        return `${a.nom ?? id}${a.raison !== null ? ` (${a.raison})` : ''}`;
      }).join(', ');
      return { sorte: 'refusee', code: 'audience_inutilisable', raison: `audience(s) inutilisable(s) : ${detail}` };
    }
  }

  if (d.visuel.sorte === 'video') {
    let etat: EtatVideo;
    try {
      etat = await client.etatVideo(d.visuel.videoId);
    } catch (err) {
      return { sorte: 'refusee', code: 'video_pas_prete', raison: raisonDe(err) };
    }
    if (etat.etat === 'erreur') {
      return { sorte: 'refusee', code: 'video_pas_prete', raison: 'Meta n’a pas pu traiter cette vidéo : déposez-en une autre' };
    }
    if (etat.etat !== 'prete') {
      return {
        sorte: 'refusee', code: 'video_pas_prete',
        raison: 'la vidéo est encore en traitement chez Meta : réessayez quand elle est prête',
      };
    }
  }
  return null;
}

/**
 * Publier : allumer l'automation d'abord, Meta ensuite. 🔴 Un échec ne laisse jamais une pub active sans
 * routage : une automation allumée sans diffusion est inoffensive, une diffusion sans automation fait tomber
 * chaque clic payé dans le vide.
 *
 * Les trois niveaux s'allument, pas seulement la campagne : tout a été créé en pause, et une campagne en
 * pause met en pause son contenu. La campagne s'allume en dernier, interrupteur unique.
 */
export interface ClientPublicationPub {
  allumer(objetId: string): Promise<void>;
}

export interface DepotPublicationPub {
  /** Allume l'automation possédée. `false` = il n'y en a pas (destination agent de Meta, ou scénario perdu). */
  allumerAutomation(publiciteId: string): Promise<boolean>;
  marquerPubliee(publiciteId: string): Promise<void>;
}

export interface ObjetsMeta {
  campagneId: string;
  ensembleId: string | null;
  pubId: string | null;
  /**
   * L'état local de la publicité au moment de publier. Seul `prete` se publie : une `echec_creation` n'a
   * souvent ni ensemble ni publicité chez Meta, et serait marquée `publiee` sans rien diffuser, donc sortie du
   * suivi ; une `creation` est en cours d'écriture par un autre appel.
   */
  etat: 'creation' | 'echec_creation' | 'prete' | 'publiee';
  /** La destination, parce qu'une publicité « scénario » ne se publie pas sans routage derrière. */
  destination: 'scenario' | 'agent_meta';
}

/** Une publication refusée avant tout appel à Meta : rien n'a bougé, et la raison est lisible. */
export class PublicationRefusee extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicationRefusee';
  }
}

/**
 * Publie. Lève si Meta refuse : l'appelant (une route) traduit, et l'automation reste allumée, ce qui est
 * le bon sens du compromis (elle n'a simplement rien à faire tant que rien ne diffuse).
 */
export async function publierLaPublicite(
  publiciteId: string,
  objets: ObjetsMeta,
  client: ClientPublicationPub,
  depot: DepotPublicationPub,
): Promise<void> {
  /**
   * Les deux refus se posent avant le premier appel à Meta : posés après, ils regarderaient une campagne qui
   * diffuse déjà.
   */
  if (objets.etat !== 'prete') {
    throw new PublicationRefusee(
      objets.etat === 'publiee' ? 'cette publicité est déjà publiée'
        : 'cette publicité n’est pas prête à être publiée',
    );
  }

  /**
   * Le booléen de l'automation est lu : si l'allumage échoue, on n'allume pas Meta, sinon chaque clic payé
   * tomberait dans le vide. Une publicité « agent de Meta » n'a aucune automation : il ne décide que pour une
   * destination `scenario`.
   */
  const allumee = await depot.allumerAutomation(publiciteId);
  if (objets.destination === 'scenario' && !allumee) {
    throw new PublicationRefusee(
      'le scénario de cette publicité n’a pas pu être branché : rien ne répondrait aux prospects',
    );
  }
  // De l'intérieur vers l'extérieur : la campagne en dernier, parce que c'est elle qui décide.
  if (objets.pubId !== null) await client.allumer(objets.pubId);
  if (objets.ensembleId !== null) await client.allumer(objets.ensembleId);
  await client.allumer(objets.campagneId);
  await depot.marquerPubliee(publiciteId);
}
