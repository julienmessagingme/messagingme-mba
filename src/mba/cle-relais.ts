/**
 * LA CLÉ QUE META PRÉSENTE AU RELAIS : une clé d'API de l'espace, droit `mba:relais`, visible dans sa liste
 * sous le nom « Agent de Meta » (arbitrage de Julien, 2026-09-21 ; spec 2026-09-21-relais-mba-design.md).
 *
 * 🔴 CE DROIT N'EST PAS ATTRIBUABLE DEPUIS L'ÉCRAN (`VALID_API_SCOPES` ne le contient pas). Son porteur peut
 * appeler les outils de l'espace au nom de n'importe lequel de ses contacts, puisque c'est l'en-tête qui
 * désigne le contact : seule la publication en crée une, pour la poser chez Meta.
 *
 * 🔴 UN SECRET NE SE COMPARE PAS, IL SE SOUVIENT. Meta ne rend jamais la clé et nous n'en gardons que
 * l'empreinte : `tenant_settings.mba_relais_cle_id` (migration 0161) dit laquelle est chez Meta. Meta exige
 * `auth_config` à chaque écriture du connecteur, donc toute écriture pose une clé NEUVE.
 *
 * 🔴 L'ORDRE : créer, écrire chez Meta, retenir APRÈS son accusé, puis révoquer TOUTE AUTRE clé `mba:relais`
 * de l'espace (pas seulement l'ancienne retenue : une orpheline laissée par un échec passé part aussi).
 *
 * ⚠️ UN ÉCHEC PEUT ÊTRE AMBIGU : Meta a écrit le connecteur, mais nous recevons une erreur (délai dépassé).
 * La clé neuve est alors révoquée alors que Meta la détient, et ses appels sortent en 401. On ne peut pas
 * le savoir d'ici ; on s'assure donc que la publication SUIVANTE répare : plus aucune clé n'est retenue, donc
 * `cleAJour` rend faux et le plan repose une clé. La route dit déjà « Relancez » sur tout échec.
 */
export const NOM_CLE_RELAIS = 'Agent de Meta';
export const DROIT_RELAIS = 'mba:relais';

export interface DepsCleRelais {
  /** Crée une clé d'API de l'espace, droit `mba:relais`. La valeur claire n'existe qu'ici, une fois. */
  creerCle(tenantId: string): Promise<{ id: string; key: string }>;
  revoquer(tenantId: string, id: string): Promise<boolean>;
  cleRetenue(tenantId: string): Promise<string | null>;
  retenir(tenantId: string, id: string | null): Promise<void>;
  estActive(tenantId: string, id: string): Promise<boolean>;
  /** Révoque toutes les clés `mba:relais` actives de l'espace, sauf `garderId` (`null` = toutes). */
  revoquerAutres(tenantId: string, garderId: string | null): Promise<void>;
}

/** La clé retenue est-elle toujours active ? Une clé révoquée par le client doit être remplacée chez Meta. */
export async function cleAJour(deps: DepsCleRelais, tenantId: string): Promise<boolean> {
  const id = await deps.cleRetenue(tenantId);
  return id !== null && (await deps.estActive(tenantId, id));
}

/**
 * Pose une clé NEUVE chez Meta par `ecrireChezMeta`, dans l'ordre de l'en-tête. ⚠️ Deux poses SIMULTANÉES
 * du même espace se révoqueraient l'une l'autre (chacune garde la sienne et révoque « toutes les autres ») :
 * la route de publication les sérialise par espace, et c'est ce qui rend cet ordre sûr.
 */
export async function poserCleNeuve(
  deps: DepsCleRelais,
  tenantId: string,
  ecrireChezMeta: (cle: string) => Promise<void>,
): Promise<void> {
  const neuve = await deps.creerCle(tenantId);
  try {
    await ecrireChezMeta(neuve.key);
  } catch (err) {
    await deps.revoquer(tenantId, neuve.id).catch(() => false);
    // L'échec est peut-être ambigu (voir l'en-tête) : ne plus rien retenir force la publication suivante à
    // reposer une clé, au lieu de croire à jour une clé que Meta ne présente peut-être plus.
    await deps.retenir(tenantId, null).catch(() => {});
    throw err;
  }
  await deps.retenir(tenantId, neuve.id);
  await deps.revoquerAutres(tenantId, neuve.id).catch(() => {});
}

/** Le relais quitte Meta : TOUTES les clés du relais de l'espace sont révoquées, et plus aucune n'est retenue. */
export async function oublierCle(deps: DepsCleRelais, tenantId: string): Promise<void> {
  await deps.revoquerAutres(tenantId, null).catch(() => {});
  await deps.retenir(tenantId, null);
}
