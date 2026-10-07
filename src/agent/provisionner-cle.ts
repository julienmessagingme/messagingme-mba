import { dollarsDepuisMicroEuros, PLAFOND_GATEWAY_MIN_DOLLARS } from './devise';
import { creerCleGateway, majPlafondCleGateway, supprimerCleGateway, CleGatewayError, type HttpTransportSuppression } from './llm/cles-gateway';
import type { CleGatewayEspace, PgCleGatewayStore } from './cles-gateway.pg';
import type { HttpTransportPatch } from '../meta/http';
import type { TravauxEnVol } from '../lib/en-vol';

/**
 * S'assurer qu'un espace a sa clé AI Gateway, et la créer chez Vercel s'il n'en a pas.
 *
 * Déclenché à la création de l'agent, pas à son activation : le bac à sable appelle vraiment le modèle, et
 * sa mise au point doit être attribuée à l'espace. Et depuis le 2026-09-28 à la première traduction
 * (`creerAssureurDeCle`) : un espace sans agent traduit aussi sur sa clé.
 *
 * 🔴 Le plafond est le crédit acheté, jamais un nombre saisi : un plafond choisi ne protège personne, un
 * plafond égal à ce qui a été payé est une garantie. Pas de crédit, pas de clé, donc pas d'agent : sinon un
 * client à zéro mettrait son agent au point sur notre argent.
 */

/** L'espace n'a pas de quoi ouvrir une cle. Distinct d'une panne : rien n'est casse, il faut recharger. */
export class CreditInsuffisantPourCle extends Error {
  constructor(readonly soldeMicroEur: number) {
    super('credit insuffisant pour ouvrir une cle de modele');
    this.name = 'CreditInsuffisantPourCle';
  }
}

/**
 * L'espace a une ligne de clé qui ne se déchiffre pas. On n'en ouvre PAS une autre : Vercel créerait une clé que
 * l'enregistrement rejetterait sur la ligne existante, puis on la supprimerait, en boucle. C'est une panne à réparer à
 * la main (clé de chiffrement changée, ligne abîmée), déjà signalée par le dépôt.
 */
export class CleIllisible extends Error {
  constructor() {
    super('cle de modele illisible : aucune nouvelle cle ouverte');
    this.name = 'CleIllisible';
  }
}

/**
 * L'espace est verrouillé (`tenants.status = 'locked'`) : aucune clé ne s'y ouvre. Posé en premier geste de la
 * suppression d'un espace (RC8) : sans lui, une traduction ou une création d'agent en vol ROUVRIRAIT une clé derrière
 * la révocation, et la purge en perdrait l'identifiant.
 */
export class EspaceVerrouillePourCle extends Error {
  constructor() {
    super('espace verrouillé : aucune clé de modèle ne s’ouvre');
    this.name = 'EspaceVerrouillePourCle';
  }
}

export interface DepsProvisionCle {
  cles: Pick<PgCleGatewayStore, 'lire' | 'lireEtat' | 'idDe' | 'enregistrer' | 'ajusterPlafond' | 'oublier'>;
  /**
   * L'espace est-il verrouillé ? Requis : un câblage qui l'oublierait laisserait rouvrir une clé sur un espace qu'on
   * supprime, sans un mot.
   */
  espaceVerrouille(tenantId: string): Promise<boolean>;
  /** Le solde prépayé de l'espace, en micro-euros. C'est lui qui devient le plafond. */
  credits: { solde(tenantId: string): Promise<number> };
  /** Comment nommer la cle dans le tableau de bord Vercel. */
  nomEspace(tenantId: string): Promise<string | null>;
  transport: HttpTransportPatch & HttpTransportSuppression;
  jetonCompte: string;
  teamId: string;
  cleGatewayMaison: string;
  tauxEurParDollar: number;
  /**
   * Où dire qu'un plafond n'a pas pu être remonté. Requis : la remontée ne lève jamais (un crédit payé ne doit pas
   * échouer à cause de Vercel), donc sans journal son échec serait muet, et le client coupé au plafond d'avant.
   */
  journal(msg: string, err: unknown, tenantId: string): void;
}

/**
 * On appelle Vercel, puis on enregistre : Vercel ne rend le secret qu'une fois, impossible d'enregistrer
 * avant.
 *
 * 🔴 Deux façons d'obtenir une clé qui facture sans servir, toutes deux rattrapées en la supprimant chez
 * Vercel : l'enregistrement échoue (chaque nouvel essai en fabriquerait une de plus), ou il réussit sur un
 * conflit (une autre création d'agent a gagné la course, sans aucune exception).
 */
export async function assurerCleGateway(deps: DepsProvisionCle, tenantId: string): Promise<CleGatewayEspace> {
  const lu = await deps.cles.lireEtat(tenantId);
  if (lu.etat === 'lue') return lu.cle;
  // Seule une ABSENCE autorise à ouvrir une clé : une ligne illisible ferait créer puis supprimer une clé chez
  // Vercel à chaque essai.
  if (lu.etat === 'illisible') throw new CleIllisible();
  // Avant le crédit et avant Vercel : un espace verrouillé n'ouvre rien, quel que soit son solde.
  if (await deps.espaceVerrouille(tenantId)) throw new EspaceVerrouillePourCle();

  const solde = await deps.credits.solde(tenantId);
  const plafond = dollarsDepuisMicroEuros(solde, deps.tauxEurParDollar);
  if (plafond === null) throw new CreditInsuffisantPourCle(solde);

  const nom = await deps.nomEspace(tenantId);
  // Le nom de l'espace peut changer ou être dupliqué, l'identifiant non : les deux, pour qu'un humain s'y
  // retrouve dans le tableau de bord Vercel.
  const etiquette = `${nom ?? 'espace'} (${tenantId})`;

  const creee = await creerCleGateway(deps.transport, {
    jetonCompte: deps.jetonCompte,
    teamId: deps.teamId,
    nom: etiquette,
    plafondDollars: plafond,
  });
  let enregistree;
  try {
    enregistree = await deps.cles.enregistrer(tenantId, { cleId: creee.id, cle: creee.cle, plafondMicroEur: solde });
  } catch (err) {
    // La clé existe chez Vercel et nulle part chez nous : on la retire avant de relever l'échec. La
    // suppression ne lève jamais, pour ne pas masquer l'erreur d'origine.
    await supprimerCleGateway(deps.transport, { jetonCompte: deps.jetonCompte, teamId: deps.teamId, cleId: creee.id });
    throw err;
  }
  // Le perdant de la course jette sa propre clé : un identifiant en base différent du nôtre veut dire
  // qu'une autre création a gagné.
  if (enregistree.cleId !== creee.id) {
    await supprimerCleGateway(deps.transport, { jetonCompte: deps.jetonCompte, teamId: deps.teamId, cleId: creee.id });
  }
  // 🔴 LE CRÉDIT ARRIVÉ PENDANT L'OUVERTURE (relecture du 2026-09-29). La clé naît plafonnée au solde lu AVANT l'appel
  // à Vercel ; un achat, une offre ou une recharge écrits entre cette lecture et l'enregistrement ont tenté de remonter
  // un plafond qui n'existait pas encore, et n'ont rien fait. On recalcule donc la cible maintenant que la ligne
  // existe : sans crédit entre-temps elle ne dépasse pas le plafond posé, et Vercel n'est pas rappelé.
  await remonterPlafondApresRecharge(deps, tenantId);
  return enregistree;
}

/**
 * Ce que rend une demande de clé pour un usage qui n'est pas la création d'un agent (la traduction) :
 *   - `prete` : l'espace a sa clé ;
 *   - `en_preparation` : pas encore de clé, son ouverture chez Vercel est en cours (quelques secondes) ;
 *   - `credit_insuffisant` : pas de clé, et trop peu de crédit pour en ouvrir une (recharger règle) ;
 *   - `indisponible` : pas de clé, et pas moyen d'en ouvrir une (provisionnement éteint, panne chez Vercel, clé
 *     illisible en base).
 */
export type VerdictCle = 'prete' | 'en_preparation' | 'credit_insuffisant' | 'indisponible';

/** Après un échec d'ouverture, Vercel n'est pas rappelé pour cet espace avant ce délai. */
export const REPIT_APRES_ECHEC_MS = 60_000;

/**
 * Un assureur de clé : la fonction qu'appelle la traduction, plus de quoi attendre une ouverture en vol (tests,
 * arrêt propre). `enVol` rend `undefined` quand rien n'est en cours pour cet espace.
 */
export interface AssureurDeCle {
  (tenantId: string): Promise<VerdictCle>;
  enVol(tenantId: string): Promise<void> | undefined;
}

/**
 * S'assurer d'une clé au premier usage qui en a besoin, et plus seulement à la création du premier agent :
 * l'existante, sinon ouverte sur le crédit de l'espace par `assurerCleGateway`, donc avec la même garde de course.
 *
 * 🔴 L'OUVERTURE NE SE FAIT PAS ATTENDRE (relecture du lot 1, 2026-09-28). Ce chemin est sur le GET du fil, qui se
 * rafraîchit toutes les 4 secondes : attendre Vercel (jusqu'à 30 s) figeait le fil entier. L'ouverture part donc en
 * arrière-plan, UNE promesse en vol par espace, et la demande rend `en_preparation` tant qu'elle n'a pas abouti ; le
 * rafraîchissement suivant trouve la clé en base. Le crédit, lui, se lit AVANT de partir : il ne coûte qu'une lecture,
 * et un crédit trop bas se dit tout de suite (`credit_insuffisant`) au lieu de se découvrir en arrière-plan.
 *
 * 🔴 Un échec d'ouverture ne lève pas (la traduction retombe en VO, le fil s'affiche) et ouvre un RÉPIT : chaque
 * opérateur qui lit le fil rappellerait sinon Vercel toutes les 4 secondes pendant une panne. Le répit et la promesse
 * en vol vivent dans la mémoire du process : N copies de l'API font au plus N ouvertures, que la garde de course
 * d'`assurerCleGateway` ramène à une seule clé.
 *
 * Une clé ILLISIBLE en base n'ouvre rien (`CleIllisible`) : elle se journalise, une fois par répit, et la traduction
 * reste indisponible pour cet espace jusqu'à la réparation.
 *
 * 🔴 L'OUVERTURE EN VOL EST SUIVIE PAR `travaux` (relecture du 2026-09-29). Personne ne l'attend, par construction :
 * sans ce suivi, l'arrêt d'une copie de l'API fermait le pool pendant qu'elle attendait Vercel, et une clé créée chez
 * Vercel ne s'enregistrait jamais chez nous (facturable, identifiant perdu). Requis, pour qu'un câblage ne l'oublie pas.
 */
export function creerAssureurDeCle(deps: {
  cles: Pick<PgCleGatewayStore, 'lireEtat'>;
  /** `null` = provisionnement éteint sur cette instance : seule une clé existante sert. */
  provision: DepsProvisionCle | null;
  journal: (msg: string, err: unknown, tenantId: string) => void;
  /** Les travaux que l'arrêt du processus attend (`src/lib/en-vol.ts`). */
  travaux: Pick<TravauxEnVol, 'suivre'>;
  now?: () => number;
}): AssureurDeCle {
  const echecs = new Map<string, number>();
  const vols = new Map<string, Promise<void>>();
  const horloge = (): number => (deps.now ? deps.now() : Date.now());
  const enRepit = (tenantId: string, maintenant: number): boolean => {
    const dernier = echecs.get(tenantId);
    return dernier !== undefined && maintenant - dernier < REPIT_APRES_ECHEC_MS;
  };

  const assurer = async (tenantId: string): Promise<VerdictCle> => {
    const lu = await deps.cles.lireEtat(tenantId);
    if (lu.etat === 'lue') return 'prete';
    const maintenant = horloge();
    if (lu.etat === 'illisible') {
      if (!enRepit(tenantId, maintenant)) {
        echecs.set(tenantId, maintenant);
        deps.journal('cle de modele illisible, aucune cle ouverte', new CleIllisible(), tenantId);
      }
      return 'indisponible';
    }
    const provision = deps.provision;
    if (!provision) return 'indisponible';
    if (vols.has(tenantId)) return 'en_preparation';
    if (enRepit(tenantId, maintenant)) return 'indisponible';
    // Un espace verrouillé (qu'on supprime, ou suspendu) n'ouvre aucune clé ; `assurerCleGateway` le redit sous le vol.
    if (await provision.espaceVerrouille(tenantId)) return 'indisponible';
    // Pas de répit pour un crédit trop bas : Vercel n'est pas appelé, et une recharge doit ouvrir la clé tout de suite.
    if (dollarsDepuisMicroEuros(await provision.credits.solde(tenantId), provision.tauxEurParDollar) === null) {
      return 'credit_insuffisant';
    }
    // Relu après l'`await` du solde : deux demandes simultanées du même espace ne lancent qu'une ouverture.
    if (vols.has(tenantId)) return 'en_preparation';
    const vol = assurerCleGateway(provision, tenantId)
      .then(
        () => { echecs.delete(tenantId); },
        (err: unknown) => {
          // Le solde a pu baisser, ou l'espace se verrouiller, entre la lecture et l'ouverture : pas de répit, comme
          // au-dessus.
          if (err instanceof CreditInsuffisantPourCle || err instanceof EspaceVerrouillePourCle) return;
          echecs.set(tenantId, horloge());
          deps.journal('cle de modele non ouverte', err, tenantId);
        },
      )
      .finally(() => { vols.delete(tenantId); });
    vols.set(tenantId, vol);
    void deps.travaux.suivre(vol);
    return 'en_preparation';
  };
  return Object.assign(assurer, { enVol: (tenantId: string) => vols.get(tenantId) });
}

/**
 * Remonte le plafond de la clé après un crédit (achat, offre, recharge manuelle), ou après l'ouverture de la clé.
 *
 * La CIBLE est le cumul crédité depuis l'ouverture de la clé, recalculé depuis le solde et les mouvements sous le
 * verrou de la clé (`PgCleGatewayStore.ajusterPlafond`, qui dit pourquoi) : elle ne dépend pas du montant de CE
 * crédit, donc deux remontées simultanées, tardives ou rejouées convergent vers la même valeur, et un achat arrivé
 * pendant l'ouverture de la clé n'est pas perdu.
 *
 * N'appelle Vercel que si la cible dépasse le dernier plafond posé : le solde descend à chaque tour, pas la cible. Ne
 * descend jamais : Vercel mesure ce que la clé a déjà dépensé, notre solde ce qui reste. Ne lève pas : un crédit payé
 * ne doit jamais échouer à cause de Vercel ; l'échec va au journal et la remontée suivante rattrape. Rend `true` si
 * un plafond a été posé chez Vercel.
 */
export async function remonterPlafondApresRecharge(deps: DepsProvisionCle, tenantId: string): Promise<boolean> {
  try {
    return await deps.cles.ajusterPlafond(tenantId, async (cle, cible) => {
      if (cible <= cle.plafondMicroEur) return null;
      const dollars = dollarsDepuisMicroEuros(cible, deps.tauxEurParDollar);
      if (dollars === null) return null;
      await majPlafondCleGateway(deps.transport, {
        cleGatewayMaison: deps.cleGatewayMaison,
        cleId: cle.cleId,
        plafondDollars: dollars,
      });
      return cible;
    });
  } catch (err) {
    deps.journal('plafond gateway non remonte', err instanceof CleGatewayError ? err.message : err, tenantId);
    return false;
  }
}

/**
 * Révoquer la clé d'un espace : chez Vercel, puis chez nous.
 *
 * 🔴 `agent_gateway_keys.tenant_id` porte un `on delete cascade` : supprimer un espace sans passer par ici
 * laisserait chez Vercel une clé facturable dont l'identifiant est perdu. Vercel d'abord : commencer par
 * notre ligne perdrait l'identifiant si l'appel échouait. Rend `false` quand l'espace n'avait pas de clé.
 * L'identifiant se lit sans déchiffrer le secret (`idDe`) : une clé illisible se révoque aussi.
 */
export async function revoquerCleGateway(deps: DepsProvisionCle, tenantId: string): Promise<boolean> {
  const cleId = await deps.cles.idDe(tenantId);
  if (cleId === null) return false;
  const supprimee = await supprimerCleGateway(deps.transport, {
    jetonCompte: deps.jetonCompte, teamId: deps.teamId, cleId,
  });
  // On n'oublie la ligne que si Vercel a confirmé : sinon on garde l'identifiant, seul moyen de réessayer.
  if (!supprimee) throw new CleGatewayError('revocation', null, 'Vercel n a pas confirme la suppression');
  await deps.cles.oublier(tenantId);
  return true;
}

/** Le minimum de Vercel, réexporté pour que les messages d'erreur de l'écran parlent du même chiffre. */
export { PLAFOND_GATEWAY_MIN_DOLLARS };
