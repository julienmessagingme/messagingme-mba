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
 * 🔴 L'ORDRE NE LAISSE RIEN D'ORPHELIN : créer, écrire chez Meta, retenir APRÈS son accusé, puis révoquer
 * l'ancienne. Si Meta refuse, la neuve est révoquée tout de suite et l'ancienne reste la bonne.
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
}

/** La clé retenue est-elle toujours active ? Une clé révoquée par le client doit être remplacée chez Meta. */
export async function cleAJour(deps: DepsCleRelais, tenantId: string): Promise<boolean> {
  const id = await deps.cleRetenue(tenantId);
  return id !== null && (await deps.estActive(tenantId, id));
}

/** Pose une clé NEUVE chez Meta par `ecrireChezMeta`, dans l'ordre qui ne laisse rien d'orphelin. */
export async function poserCleNeuve(
  deps: DepsCleRelais,
  tenantId: string,
  ecrireChezMeta: (cle: string) => Promise<void>,
): Promise<void> {
  const ancienne = await deps.cleRetenue(tenantId);
  const neuve = await deps.creerCle(tenantId);
  try {
    await ecrireChezMeta(neuve.key);
  } catch (err) {
    await deps.revoquer(tenantId, neuve.id).catch(() => false);
    throw err;
  }
  await deps.retenir(tenantId, neuve.id);
  if (ancienne !== null && ancienne !== neuve.id) await deps.revoquer(tenantId, ancienne).catch(() => false);
}

/** Le relais quitte Meta : sa clé est révoquée, et plus aucune n'est retenue. */
export async function oublierCle(deps: DepsCleRelais, tenantId: string): Promise<void> {
  const id = await deps.cleRetenue(tenantId);
  if (id !== null) await deps.revoquer(tenantId, id).catch(() => false);
  await deps.retenir(tenantId, null);
}
