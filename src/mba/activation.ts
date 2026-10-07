import { texteDe } from '../lib/erreur';
/**
 * Allumer ou éteindre l'agent de Meta, en une décision prise côté serveur, qui sait tout, tout le temps : laissé
 * au navigateur, avec une connaissance partielle (session, compte, état chez Meta), l'écran annonçait
 * « désactivé » pendant que l'agent de Meta répondait aux clients.
 * On n'écrit jamais notre drapeau sur une incertitude : un état local qui annonce ce que Meta n'a pas fait rend
 * le problème invisible. Chaque chemin finit par « appliqué chez Meta », « volontairement local, et on dit
 * pourquoi », ou une exception.
 */

/** Ce que l'appel a réellement fait, rendu à l'écran tel quel. */
export interface ResultatActivation {
  /** L'état effectif de notre drapeau après l'appel. */
  enabled: boolean;
  /**
   * Ce qui s'est passé du côté de Meta : `applique` (agent allumé ou éteint), `aucun_numero` (pas d'agent à
   * piloter), `non_eligible` (fonctionnalité non ouverte sur ce numéro). Les deux derniers ne sont pas des échecs :
   * notre drapeau garde son sens (il ouvre le bloc MBA du constructeur), mais ils se disent.
   */
  chezMeta: 'applique' | 'aucun_numero' | 'non_eligible';
  /** Le numéro piloté, quand il y en a un. Sert à l'écran à relire l'état sans le redemander. */
  phoneNumberId: string | null;
}

/**
 * L'état chez Meta n'a pas pu être lu ; rien n'a été écrit, ni chez Meta ni chez nous. « An error is not a
 * negative answer » (Meta) : un 401 ou un 404 veut dire que la question n'a pas pu être posée, pas que le
 * numéro est inéligible.
 */
export class EtatMetaIllisible extends Error {
  constructor(cause: unknown) {
    super(`l’état de l’agent chez Meta n’a pas pu être lu : ${texteDe(cause)}`);
    this.name = 'EtatMetaIllisible';
  }
}

/** Meta a refusé l'écriture. Notre drapeau n'a pas bougé : l'écran continue de dire la vérité. */
export class MetaARefuse extends Error {
  constructor(cause: unknown) {
    super(`Meta a refusé de changer l’état de l’agent : ${texteDe(cause)}`);
    this.name = 'MetaARefuse';
  }
}

export interface ActivationDeps {
  /** Numéro Meta du client. `null` = aucun numéro connecté. */
  numeroDuTenant(tenantId: string): Promise<string | null>;
  /** Meta a-t-il ouvert l'agent sur ce numéro ? Lève si la question n'a pas pu être posée. */
  eligible(tenantId: string, phoneNumberId: string): Promise<boolean>;
  /** Écrit `rollout.enabled` chez Meta, en préservant les autres réglages. Lève si Meta refuse. */
  ecrireChezMeta(tenantId: string, phoneNumberId: string, enabled: boolean): Promise<void>;
  /** Écrit notre drapeau (`tenant_settings.mba_enabled`). */
  ecrireDrapeau(tenantId: string, enabled: boolean): Promise<void>;
}

/**
 * L'agent de Meta peut-il être allumé sur cet espace : un numéro relié, et Meta a ouvert son agent dessus ? La question
 * de la carte « Qui répond au client » (RC6, position « MBA » grisée sinon) et du choix du mode `mba`
 * (`src/repondeur/reglage.ts`). Les deux mêmes lectures que `appliquerActivation`, dans le même ordre ; lève
 * `EtatMetaIllisible` si la question n'a pas pu être posée (« an error is not a negative answer »).
 */
export async function agentDeMetaConfigurable(
  deps: Pick<ActivationDeps, 'numeroDuTenant' | 'eligible'>,
  tenantId: string,
): Promise<boolean> {
  const phoneNumberId = await deps.numeroDuTenant(tenantId);
  if (!phoneNumberId) return false;
  try {
    return await deps.eligible(tenantId, phoneNumberId);
  } catch (err) {
    throw new EtatMetaIllisible(err);
  }
}

/**
 * Applique la décision : Meta d'abord, nous ensuite. Dans l'autre ordre, l'écran afficherait un temps un état
 * que Meta n'a pas, et un échec obligerait à « défaire » ; ainsi, un échec ne change simplement rien.
 */
export async function appliquerActivation(
  deps: ActivationDeps,
  tenantId: string,
  enabled: boolean,
): Promise<ResultatActivation> {
  const phoneNumberId = await deps.numeroDuTenant(tenantId);

  // Aucun numéro : il n'y a aucun agent Meta à piloter, notre drapeau se suffit et garde son sens propre.
  if (!phoneNumberId) {
    await deps.ecrireDrapeau(tenantId, enabled);
    return { enabled, chezMeta: 'aucun_numero', phoneNumberId: null };
  }

  let ouvert: boolean;
  try {
    ouvert = await deps.eligible(tenantId, phoneNumberId);
  } catch (err) {
    // On ne touche à rien : « Meta dit non » n'est pas « on n'a pas pu demander ».
    throw new EtatMetaIllisible(err);
  }

  // Éligibilité lue, et négative : notre drapeau seul, et on le dit.
  if (!ouvert) {
    await deps.ecrireDrapeau(tenantId, enabled);
    return { enabled, chezMeta: 'non_eligible', phoneNumberId };
  }

  try {
    await deps.ecrireChezMeta(tenantId, phoneNumberId, enabled);
  } catch (err) {
    // Notre drapeau n'a pas bougé : l'écran continue d'annoncer l'état d'avant, qui est le vrai.
    throw new MetaARefuse(err);
  }

  await deps.ecrireDrapeau(tenantId, enabled);
  return { enabled, chezMeta: 'applique', phoneNumberId };
}
