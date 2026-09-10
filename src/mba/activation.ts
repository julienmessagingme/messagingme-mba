/**
 * Allumer ou éteindre l'agent de Meta, en UNE décision prise côté serveur.
 *
 * 🔴 CE MODULE EXISTE PARCE QUE LE MÊME DÉFAUT EST REVENU TROIS FOIS DANS LA MÊME JOURNÉE (2026-09-10), et
 * que les deux premiers correctifs n'ont bouché qu'un trou chacun. Le bouton de la page d'accueil orchestrait
 * TROIS états asynchrones côté navigateur (la session, le compte, l'état chez Meta) et décidait d'appeler
 * Meta ou non selon lesquels étaient arrivés :
 *
 *  1. le matin, il n'appelait Meta nulle part : il n'écrivait que notre drapeau ;
 *  2. corrigé, il ne l'appelait que si l'état Meta était déjà lu : un clic rapide retombait sur notre drapeau ;
 *  3. corrigé, il ne l'appelait que si le NUMÉRO était déjà chargé : `Boolean(undefined)` valant `false`, le
 *     garde-fou du point 2 ne se déclenchait même pas.
 *
 * À chaque fois, l'écran annonçait « désactivé » pendant que l'agent de Meta répondait aux clients. Le défaut
 * n'était aucune de ces trois lignes : c'était de laisser le NAVIGATEUR décider, avec une connaissance
 * partielle. Ici le serveur sait tout, tout le temps, et il n'y a plus de combinaison à couvrir.
 *
 * ⚠️ RÈGLE QUI PORTE TOUT LE MODULE : ON N'ÉCRIT JAMAIS NOTRE DRAPEAU SUR UNE INCERTITUDE. Un état local qui
 * annonce ce que Meta n'a pas fait est PIRE qu'une erreur, parce qu'il rend le problème invisible. Chaque
 * chemin ci-dessous se termine donc par « appliqué chez Meta », « volontairement local, et on dit pourquoi »,
 * ou une exception. Jamais par un silence.
 */

/** Ce que l'appel a RÉELLEMENT fait. Rendu à l'écran tel quel : il n'a plus rien à déduire. */
export interface ResultatActivation {
  /** L'état effectif de NOTRE drapeau après l'appel. */
  enabled: boolean;
  /**
   * Ce qui s'est passé du côté de Meta.
   *  - `applique` : l'agent de Meta a bien été allumé ou éteint ;
   *  - `aucun_numero` : aucun numéro connecté, il n'y a pas d'agent à piloter ;
   *  - `non_eligible` : Meta n'a pas ouvert la fonctionnalité sur ce numéro.
   *
   * ⚠️ Les deux derniers ne sont PAS des échecs : notre drapeau garde son sens propre (il ouvre le bloc MBA
   * du constructeur de scénario). Mais ils se DISENT, au lieu d'être devinés à l'écran.
   */
  chezMeta: 'applique' | 'aucun_numero' | 'non_eligible';
  /** Le numéro piloté, quand il y en a un. Sert à l'écran à relire l'état sans le redemander. */
  phoneNumberId: string | null;
}

/**
 * L'état chez Meta n'a PAS PU ÊTRE LU. Rien n'a été écrit, ni chez Meta ni chez nous.
 *
 * 🔴 « An error is not a negative answer », et c'est une phrase de Meta que notre propre documentation cite
 * depuis le 18 août. Un 401 ou un 404 veut dire que la question n'a pas pu être posée, pas que le numéro est
 * inéligible. Traiter l'échec comme un « non » est exactement ce que faisait la route `/status`
 * (`.catch(() => false)`), et c'est ce qui rendait la panne muette.
 */
export class EtatMetaIllisible extends Error {
  constructor(cause: unknown) {
    super(`l’état de l’agent chez Meta n’a pas pu être lu : ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'EtatMetaIllisible';
  }
}

/** Meta a refusé l'écriture. Notre drapeau n'a PAS bougé : l'écran continue de dire la vérité. */
export class MetaARefuse extends Error {
  constructor(cause: unknown) {
    super(`Meta a refusé de changer l’état de l’agent : ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'MetaARefuse';
  }
}

export interface ActivationDeps {
  /** Numéro Meta du client. `null` = aucun numéro connecté. */
  numeroDuTenant(tenantId: string): Promise<string | null>;
  /** Meta a-t-il ouvert l'agent sur ce numéro ? LÈVE si la question n'a pas pu être posée. */
  eligible(tenantId: string, phoneNumberId: string): Promise<boolean>;
  /** Écrit `rollout.enabled` chez Meta, en préservant les autres réglages. LÈVE si Meta refuse. */
  ecrireChezMeta(tenantId: string, phoneNumberId: string, enabled: boolean): Promise<void>;
  /** Écrit NOTRE drapeau (`tenant_settings.mba_enabled`). */
  ecrireDrapeau(tenantId: string, enabled: boolean): Promise<void>;
}

/**
 * Applique la décision, dans l'ordre qui rend le mensonge impossible : Meta d'abord, nous ensuite.
 *
 * ⚠️ L'ORDRE N'EST PAS UNE PRÉFÉRENCE DE STYLE. Écrire notre drapeau en premier, puis appeler Meta, laisse
 * une fenêtre où l'écran affiche un état que Meta n'a pas ; et si l'appel échoue, il faut « défaire », ce qui
 * suppose que le défaire ne peut pas échouer à son tour. En écrivant Meta d'abord, un échec ne laisse
 * simplement rien de changé.
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
    // 🔴 ON NE TOUCHE À RIEN. C'est la différence entre « Meta dit non » et « on n'a pas pu demander ».
    throw new EtatMetaIllisible(err);
  }

  // Éligibilité lue, et négative : Meta n'a pas ouvert la fonctionnalité. Notre drapeau seul, et on le DIT.
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
