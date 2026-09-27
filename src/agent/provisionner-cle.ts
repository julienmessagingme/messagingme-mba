import { dollarsDepuisMicroEuros, PLAFOND_GATEWAY_MIN_DOLLARS } from './devise';
import { creerCleGateway, majPlafondCleGateway, supprimerCleGateway, CleGatewayError, type HttpTransportSuppression } from './llm/cles-gateway';
import type { CleGatewayEspace, PgCleGatewayStore } from './cles-gateway.pg';
import type { HttpTransportPatch } from '../meta/http';

/**
 * S'assurer qu'un espace a sa clé AI Gateway, et la créer chez Vercel s'il n'en a pas.
 *
 * Déclenché à la création de l'agent, pas à son activation : le bac à sable appelle vraiment le modèle, et
 * sa mise au point doit être attribuée à l'espace.
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

export interface DepsProvisionCle {
  cles: Pick<PgCleGatewayStore, 'lire' | 'enregistrer' | 'noterPlafond' | 'oublier'>;
  /** Le solde prépayé de l'espace, en micro-euros. C'est lui qui devient le plafond. */
  credits: { solde(tenantId: string): Promise<number> };
  /** Comment nommer la cle dans le tableau de bord Vercel. */
  nomEspace(tenantId: string): Promise<string | null>;
  transport: HttpTransportPatch & HttpTransportSuppression;
  jetonCompte: string;
  teamId: string;
  cleGatewayMaison: string;
  tauxEurParDollar: number;
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
  const existante = await deps.cles.lire(tenantId);
  if (existante) return existante;

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
  return enregistree;
}

/**
 * Remonte le plafond après un rechargement du crédit.
 *
 * N'appelle Vercel que si le plafond change : on compare au dernier plafond posé, pas au solde qui descend
 * à chaque tour. Ne descend jamais : Vercel mesure ce que la clé a déjà dépensé, notre solde ce qui reste,
 * donc le plafond est le cumul de ce qui a été acheté. Ne lève pas : un rechargement payé ne doit jamais
 * échouer à cause de Vercel. Rend `true` si Vercel a été appelé.
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

/**
 * Révoquer la clé d'un espace : chez Vercel, puis chez nous.
 *
 * 🔴 `agent_gateway_keys.tenant_id` porte un `on delete cascade` : supprimer un espace sans passer par ici
 * laisserait chez Vercel une clé facturable dont l'identifiant est perdu. Vercel d'abord : commencer par
 * notre ligne perdrait l'identifiant si l'appel échouait. Rend `false` quand l'espace n'avait pas de clé.
 */
export async function revoquerCleGateway(deps: DepsProvisionCle, tenantId: string): Promise<boolean> {
  const cle = await deps.cles.lire(tenantId);
  if (!cle) return false;
  const supprimee = await supprimerCleGateway(deps.transport, {
    jetonCompte: deps.jetonCompte, teamId: deps.teamId, cleId: cle.cleId,
  });
  // On n'oublie la ligne que si Vercel a confirmé : sinon on garde l'identifiant, seul moyen de réessayer.
  if (!supprimee) throw new CleGatewayError('revocation', null, 'Vercel n a pas confirme la suppression');
  await deps.cles.oublier(tenantId);
  return true;
}

/** Le minimum de Vercel, réexporté pour que les messages d'erreur de l'écran parlent du même chiffre. */
export { PLAFOND_GATEWAY_MIN_DOLLARS };
