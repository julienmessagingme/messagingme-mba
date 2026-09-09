import { dollarsDepuisMicroEuros, PLAFOND_GATEWAY_MIN_DOLLARS } from './devise';
import { creerCleGateway, majPlafondCleGateway, supprimerCleGateway, CleGatewayError, type HttpTransportSuppression } from './llm/cles-gateway';
import type { CleGatewayEspace, PgCleGatewayStore } from './cles-gateway.pg';
import type { HttpTransportPatch } from '../meta/http';

/**
 * S'ASSURER QU'UN ESPACE A SA CLE AI Gateway, et la creer chez Vercel s'il n'en a pas (2026-09-09).
 *
 * 🔴 QUAND, ET POURQUOI PAS PLUS TARD. Julien : « creer automatiquement une cle API dans Vercel lorsque le
 * client cree un agent IA, pas la peine de la creer avant ». Le declencheur est la CREATION de l'agent, pas
 * son activation, et la raison est le BAC A SABLE : un agent en brouillon qu'on essaie appelle vraiment le
 * modele et brule vraiment des jetons. Provisionner a l'activation laisserait toute la mise au point, celle
 * qui tatonne donc celle qui coute, sur la cle maison, c'est-a-dire non attribuee.
 *
 * 🔴 LE PLAFOND EST LE CREDIT ACHETE, jamais un nombre saisi (tranche par Julien le 2026-09-09 : « oui c'est
 * bien le credit achete »). La nuance decide de tout : un plafond que le client choisit ne protege personne,
 * il suffit d'y taper 10 000 pour vider le pot commun ; un plafond egal a ce qu'il a paye est une garantie.
 *
 * 🔴 PAS DE CREDIT, PAS DE CLE, DONC PAS D'AGENT. C'est la consequence assumee du choix de Julien de REFUSER
 * la creation quand la cle manque. Sans cette regle, un client a zero mettrait son agent au point dans le
 * bac a sable sur notre argent.
 */

/** L'espace n'a pas de quoi ouvrir une cle. Distinct d'une panne : rien n'est casse, il faut recharger. */
export class CreditInsuffisantPourCle extends Error {
  constructor(readonly soldeMicroEur: number) {
    super('credit insuffisant pour ouvrir une cle de modele');
    this.name = 'CreditInsuffisantPourCle';
  }
}

export interface DepsProvisionCle {
  cles: Pick<PgCleGatewayStore, 'lire' | 'enregistrer' | 'noterPlafond'>;
  /** Le solde PREPAYE de l'espace, en micro-euros. C'est lui qui devient le plafond. */
  solde(tenantId: string): Promise<number>;
  /** Comment nommer la cle dans le tableau de bord Vercel. */
  nomEspace(tenantId: string): Promise<string | null>;
  transport: HttpTransportPatch & HttpTransportSuppression;
  jetonCompte: string;
  teamId: string;
  cleGatewayMaison: string;
  tauxEurParDollar: number;
}

/**
 * ⚠️ L'ORDRE DES DEUX ECRITURES N'EST PAS INTERCHANGEABLE. On appelle Vercel, PUIS on enregistre : Vercel ne
 * rend le secret QU'UNE FOIS, donc il n'existe aucune facon d'enregistrer avant. L'enregistrement est la
 * derniere chose faite, et il ne fait rien d'autre.
 *
 * 🔴 IL Y A DONC DEUX FACONS DE SE RETROUVER AVEC UNE CLE QUI FACTURE ET QUE PERSONNE NE PEUT UTILISER, et
 * la seconde est plus discrete que la premiere :
 *   1. l'enregistrement ECHOUE (base indisponible) : on leve, et le client qui reessaie fabrique une cle de
 *      plus a chaque tentative ;
 *   2. l'enregistrement REUSSIT mais sur un CONFLIT : une autre creation d'agent du meme espace a gagne la
 *      course, la cle qui fait autorite est la sienne, et la NOTRE ne sera jamais lue par personne. Aucune
 *      exception ne se leve ici, c'est pourquoi ce cas se voyait moins.
 * Les deux sont rattrapes : la cle qu'on vient de creer est SUPPRIMEE chez Vercel des qu'elle se revele
 * inutile. Sans ca, le plafond d'equipe reste le seul filet, et il ne dit rien de la fuite.
 */
export async function assurerCleGateway(deps: DepsProvisionCle, tenantId: string): Promise<CleGatewayEspace> {
  const existante = await deps.cles.lire(tenantId);
  if (existante) return existante;

  const solde = await deps.solde(tenantId);
  const plafond = dollarsDepuisMicroEuros(solde, deps.tauxEurParDollar);
  if (plafond === null) throw new CreditInsuffisantPourCle(solde);

  const nom = await deps.nomEspace(tenantId);
  // Le nom de l'espace peut changer ou etre duplique ; l'identifiant, non. Les deux, pour qu'un humain s'y
  // retrouve dans le tableau de bord Vercel sans avoir a croiser une base.
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
    // 🔴 LA CLE EXISTE CHEZ VERCEL ET NULLE PART CHEZ NOUS. Elle facture, personne ne peut s en servir, et
    // le client qui reessaie en fabrique une deuxieme, puis une troisieme : une base indisponible une minute
    // laissait autant de cles orphelines que de tentatives. On la retire avant de relever l echec.
    // ⚠️ La suppression ne leve jamais et son resultat n est PAS teste : on est deja dans un chemin qui
    // echoue, et masquer l erreur d origine par une seconde erreur ferait chercher au mauvais endroit.
    await supprimerCleGateway(deps.transport, { jetonCompte: deps.jetonCompte, teamId: deps.teamId, cleId: creee.id });
    throw err;
  }
  // 🔴 LE PERDANT DE LA COURSE JETTE SA PROPRE CLE. `enregistrer` rend ce qui est EN BASE apres coup : un
  // identifiant different du notre veut dire qu'une autre creation d'agent a gagne, et que la cle qu'on
  // vient de fabriquer ne sera jamais lue par personne. Elle facturerait pourtant. Aucune exception ne se
  // leve sur ce chemin, ce qui est precisement pourquoi il se voyait moins que l'echec d'ecriture.
  if (enregistree.cleId !== creee.id) {
    await supprimerCleGateway(deps.transport, { jetonCompte: deps.jetonCompte, teamId: deps.teamId, cleId: creee.id });
  }
  return enregistree;
}

/**
 * Remonte le plafond apres un RECHARGEMENT du credit.
 *
 * ⚠️ N'appelle Vercel QUE si le plafond change vraiment. Le solde descend a chaque tour d'agent ; suivre le
 * solde ferait un appel reseau par tour, pour reecrire le meme nombre. On compare donc au dernier plafond
 * POSE, pas au solde.
 *
 * ⚠️ NE DESCEND JAMAIS le plafond. Chez Vercel, le compteur mesure ce que la cle a DEJA depense ; notre
 * solde, lui, est ce qui RESTE. Les aligner en cours de route couperait le client bien avant qu'il ait
 * consomme ce qu'il a paye. Le plafond est donc un CUMUL de ce qui a ete achete, et il ne fait que monter.
 *
 * Rend `true` si Vercel a ete appele. Ne leve pas : un plafond en retard laisse le client dans les limites
 * de son ancien credit, ce qui est genant mais pas casse, et surtout un rechargement paye ne doit jamais
 * echouer a cause de Vercel.
 */
export async function remonterPlafondApresRecharge(
  deps: DepsProvisionCle,
  tenantId: string,
  achetteMicroEur: number,
  journal?: (msg: string, err: unknown) => void,
): Promise<boolean> {
  const cle = await deps.cles.lire(tenantId);
  if (!cle) return false;
  const cible = cle.plafondMicroEur + Math.max(0, Math.round(achetteMicroEur));
  if (cible <= cle.plafondMicroEur) return false;
  const dollars = dollarsDepuisMicroEuros(cible, deps.tauxEurParDollar);
  if (dollars === null) return false;
  try {
    await majPlafondCleGateway(deps.transport, {
      cleGatewayMaison: deps.cleGatewayMaison,
      cleId: cle.cleId,
      plafondDollars: dollars,
    });
  } catch (err) {
    journal?.('plafond gateway non remonte', err instanceof CleGatewayError ? err.message : err);
    return false;
  }
  await deps.cles.noterPlafond(tenantId, cible);
  return true;
}

/** Le minimum de Vercel, re-exporte pour que les messages d'erreur d'IHM parlent du meme chiffre. */
export { PLAFOND_GATEWAY_MIN_DOLLARS };
