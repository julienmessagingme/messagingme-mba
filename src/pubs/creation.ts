import { payloadCampagne, payloadEnsemble, payloadCrea, payloadPub, type FormulairePub } from '../meta/pubs-payloads';
import type { DestinationPub } from './routage';

/**
 * LA SÉQUENCE DE CRÉATION D'UNE PUBLICITÉ, ET SON RATTRAPAGE (lot 3, commit 2, spec § 3.2). IO INJECTÉE :
 * aucun import qui tire pg ni fetch, donc la séquence entière s'exécute contre de faux objets, en
 * millisecondes, y compris ses chemins d'échec.
 *
 * 🔴 POURQUOI CE N'EST PAS UNE SUITE D'`await` DANS UNE ROUTE. Cette séquence fait cinq appels chez un tiers
 * qui DÉPENSE L'ARGENT DU CLIENT, et son intérêt principal est ce qui se passe quand l'un d'eux échoue. Un
 * chemin d'échec écrit dans une route est un chemin d'échec que personne n'exécute jamais avant le jour où
 * il compte. C'est exactement la leçon de `retirerAncienAcces` (lot 2) : la décision avait vécu dans un `if`
 * du câblage, gardée par un test qui lisait le TEXTE de ce `if`, et trois orthographes du même bug avaient
 * traversé deux relectures.
 *
 * 🔴 TOUT EST CRÉÉ EN PAUSE, SANS EXCEPTION, et c'est ce qui rend l'échec inoffensif : une campagne en pause
 * ne dépense rien. Le seul moment où quoi que ce soit se met à diffuser est la PUBLICATION, qui est un geste
 * distinct, et qui allume l'automation AVANT d'allumer Meta.
 */

/** Ce que la séquence sait faire chez Meta. Un objet minuscule, pour qu'un faux tienne en quinze lignes. */
export interface ClientCreationPub {
  /** Rend l'empreinte du visuel (`image_hash`). */
  televerserImage(base64: string): Promise<string>;
  creerCampagne(p: Record<string, unknown>): Promise<string>;
  creerEnsemble(p: Record<string, unknown>): Promise<string>;
  creerCrea(p: Record<string, unknown>): Promise<string>;
  creerPub(p: Record<string, unknown>): Promise<string>;
  /** Le rattrapage. Meta supprime en cascade ce que la campagne contient. */
  supprimerCampagne(campagneId: string): Promise<void>;
}

/** Ce que la séquence sait faire chez nous. Chaque identifiant est rangé DÈS que Meta le rend. */
export interface DepotCreationPub {
  /**
   * Ouvre la ligne de la publicité, en état `creation`. Rend son identifiant chez nous.
   *
   * ⚠️ APRÈS LA CAMPAGNE, JAMAIS AVANT, et la colonne l'impose (`campagne_id not null`). Ce n'est pas une
   * contrainte subie : tant que Meta n'a rien créé, il n'y a rien à rattraper, donc rien à garder. Le premier
   * objet qui existe chez Meta est aussi le premier fait qu'on écrit.
   */
  ouvrir(v: {
    campagneId: string; nom: string; destination: DestinationPub;
    workflowId: string | null; tagQualification: string | null;
    budgetTotal: number; debut: string; fin: string; creePar: string | null;
  }): Promise<string>;
  /** Range les identifiants que Meta vient de rendre. Appelée après CHAQUE étape, pas à la fin. */
  noterIds(id: string, v: { ensembleId?: string; creaId?: string; pubId?: string }): Promise<void>;
  marquerEtat(id: string, etat: 'prete' | 'echec_creation'): Promise<void>;
  /**
   * Mémorise « cette publicité appartient à cette campagne » (`pubs_connues`), pour que le ROUTAGE la
   * reconnaisse sans appeler Meta au premier lead.
   */
  memoriserPub(adId: string, campagneId: string): Promise<void>;
  /**
   * Crée l'automation POSSÉDÉE de cette publicité, ÉTEINTE, et la rattache. Rend son identifiant.
   *
   * ⚠️ Appelée seulement pour une destination `scenario` : une publicité qui confie ses leads à l'agent de
   * Meta n'a aucun scénario à démarrer, donc aucune automation à posséder.
   */
  creerAutomation(id: string, v: { nom: string; campagneId: string; workflowId: string }): Promise<string>;
}

/**
 * CE QUE LA CRÉATION A PRODUIT.
 *
 * ⚠️ `echec_creation` PORTE L'IDENTIFIANT DE LA LIGNE, et c'est ce qui la rend visible à l'écran. Une
 * création ratée dont la campagne n'a PAS pu être supprimée laisse un objet chez Meta : le client doit le
 * voir ici, sinon il le découvrira dans le Gestionnaire sans savoir d'où il vient.
 */
export type IssueCreation =
  | { sorte: 'creee'; publiciteId: string; campagneId: string }
  | { sorte: 'annulee'; raison: string }
  | { sorte: 'echec_creation'; publiciteId: string; campagneId: string; raison: string };

export interface DemandeCreation {
  formulaire: FormulairePub;
  imageBase64: string;
  destination: DestinationPub;
  workflowId: string | null;
  tagQualification: string | null;
  comptePubId: string;
  pageId: string;
  numeroWhatsApp: string | null;
  creePar: string | null;
}

/**
 * CRÉE LA PUBLICITÉ CHEZ META, EN PAUSE, ET RANGE CE QUI EN REVIENT.
 *
 * 🔴 L'ORDRE DES CINQ APPELS N'EST PAS NÉGOCIABLE, et chacun a une raison :
 *
 *  1. **Le visuel d'abord**, parce que c'est le seul qui ne crée RIEN de facturable. S'il échoue, il n'y a
 *     ni campagne, ni ligne chez nous, ni rattrapage : la demande est simplement `annulee`.
 *  2. **La campagne**, qui devient la racine de tout ce qui suit, donc la seule chose à supprimer en cas
 *     d'échec.
 *  3. **L'ensemble**, qui porte le budget et les dates.
 *  4. **La créa**, puis **la publicité**, qui les marie.
 *
 * 🔴 ET LE RATTRAPAGE EST LE VRAI SUJET. Dès que la campagne existe, tout échec ultérieur tente de la
 * supprimer. Si la suppression réussit, rien ne reste chez Meta et la ligne dit `echec_creation` quand même,
 * avec sa raison. Si la suppression ÉCHOUE, la ligne est le seul endroit où le client verra qu'un objet
 * subsiste chez Meta. Dans les deux cas, ce qui subsiste est EN PAUSE, donc ne dépense rien.
 *
 * ⚠️ ELLE NE LÈVE JAMAIS. Son appelant est une route HTTP qui doit rendre la raison de Meta au client, pas
 * une trace de pile. Tout sort par `IssueCreation`.
 */
export async function creerLaPublicite(
  d: DemandeCreation,
  client: ClientCreationPub,
  depot: DepotCreationPub,
): Promise<IssueCreation> {
  let imageHash: string;
  try {
    imageHash = await client.televerserImage(d.imageBase64);
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

  // 🔴 À PARTIR D'ICI, UN OBJET EXISTE CHEZ META. Tout ce qui suit est sous rattrapage, et la ligne est
  // ouverte AVANT le reste : si notre base tombe à l'étape suivante, la campagne est quand même connue.
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
    // On ne sait pas ranger cette campagne : on la supprime, et on le dit. Sans ligne chez nous, il n'y a
    // pas d'autre trace possible que ce refus et le journal.
    await client.supprimerCampagne(campagneId).catch(() => undefined);
    return { sorte: 'annulee', raison: raisonDe(err) };
  }

  try {
    const ensembleId = await client.creerEnsemble(payloadEnsemble(d.formulaire, {
      campagneId, pageId: d.pageId, numeroWhatsApp: d.numeroWhatsApp,
    }));
    await depot.noterIds(publiciteId, { ensembleId });

    const creaId = await client.creerCrea(payloadCrea(d.formulaire, { pageId: d.pageId, imageHash }));
    await depot.noterIds(publiciteId, { creaId });

    const pubId = await client.creerPub(payloadPub(d.formulaire.nom, { ensembleId, creaId }));
    await depot.noterIds(publiciteId, { pubId });

    // 🔴 LE ROUTAGE DOIT CONNAÎTRE CETTE PUBLICITÉ AVANT SON PREMIER LEAD. Sans cette mémorisation, le
    // premier prospect provoquerait un appel à Meta pour retrouver sa campagne, sur le chemin chaud d'un
    // message entrant, alors qu'on vient de créer la correspondance nous-mêmes.
    await depot.memoriserPub(pubId, campagneId);

    // L'automation possédée, ÉTEINTE. C'est la publication qui l'allume, et elle l'allume AVANT Meta.
    if (d.destination === 'scenario' && d.workflowId !== null) {
      await depot.creerAutomation(publiciteId, { nom: d.formulaire.nom, campagneId, workflowId: d.workflowId });
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
    // ⚠️ L'ÉTAT EST LE MÊME QUE LA SUPPRESSION AIT RÉUSSI OU NON, et c'est voulu : ce que l'état dit, c'est
    // « cette création a échoué », pas « il reste quelque chose chez Meta ». Le second fait vit dans le
    // journal, qui est le seul endroit où il est certain ; prétendre le porter dans une colonne obligerait à
    // distinguer deux échecs de nettoyage que nous ne savons pas distinguer.
    await depot.marquerEtat(publiciteId, 'echec_creation').catch(() => undefined);
    return { sorte: 'echec_creation', publiciteId, campagneId, raison };
  }
}

/** Le message de Meta, tel quel : c'est SON compte, et lui seul peut agir sur ce qu'il refuse. */
function raisonDe(err: unknown): string {
  return err instanceof Error ? err.message : 'erreur inconnue';
}

/**
 * PUBLIER : ALLUMER L'AUTOMATION D'ABORD, META ENSUITE.
 *
 * 🔴 L'ORDRE EST TOUTE LA RÈGLE (spec § 3.2) : « un échec ne laisse jamais une pub active sans routage ».
 * Dans un sens, si Meta refuse après que l'automation est allumée, on a une automation qui attend des leads
 * qui n'arriveront pas : inoffensif. Dans l'autre, si l'automation échoue après que Meta diffuse, chaque
 * clic payé tombe dans le vide, et on ne s'en aperçoit qu'en lisant les conversations.
 *
 * 🔴 ET LES TROIS NIVEAUX S'ALLUMENT, PAS SEULEMENT LA CAMPAGNE. Meta est explicite : une campagne en pause
 * met en pause tout ce qu'elle contient. Comme on a TOUT créé en pause, allumer la seule campagne ne
 * diffuserait rien, en silence. La campagne est allumée EN DERNIER, ce qui fait d'elle l'interrupteur
 * unique : tant qu'elle est éteinte, rien ne part, quel que soit l'état des deux autres.
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
  await depot.allumerAutomation(publiciteId);
  // De l'intérieur vers l'extérieur : la campagne en dernier, parce que c'est elle qui décide.
  if (objets.pubId !== null) await client.allumer(objets.pubId);
  if (objets.ensembleId !== null) await client.allumer(objets.ensembleId);
  await client.allumer(objets.campagneId);
  await depot.marquerPubliee(publiciteId);
}
