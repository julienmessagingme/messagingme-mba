import { dollarsDepuisMicroEuros, PLAFOND_GATEWAY_MIN_DOLLARS } from './devise';
import { creerCleGateway, majPlafondCleGateway, CleGatewayError } from './llm/cles-gateway';
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
  transport: HttpTransportPatch;
  jetonCompte: string;
  teamId: string;
  cleGatewayMaison: string;
  tauxEurParDollar: number;
}

/**
 * ⚠️ L'ORDRE DES DEUX ECRITURES N'EST PAS INTERCHANGEABLE. On appelle Vercel, PUIS on enregistre. Vercel ne
 * rend le secret QU'UNE FOIS : si l'enregistrement echoue, la cle est perdue pour nous mais continue
 * d'exister (et de pouvoir facturer) chez eux. C'est pour ca que l'enregistrement est la derniere chose
 * faite, et qu'il ne fait rien d'autre.
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
  return deps.cles.enregistrer(tenantId, { cleId: creee.id, cle: creee.cle, plafondMicroEur: solde });
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
