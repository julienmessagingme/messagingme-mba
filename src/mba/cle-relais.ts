/**
 * La clé que Meta présente au relais : une clé d'API de l'espace, droit `mba:relais`, nommée « Agent de Meta ».
 *
 * 🔴 Ce droit n'est pas attribuable depuis l'écran (`VALID_API_SCOPES` ne le contient pas) : son porteur peut
 * appeler les outils de l'espace au nom de n'importe quel contact. Seule la publication en crée une.
 * Meta ne rend jamais la clé et nous n'en gardons que l'empreinte (`tenant_settings.mba_relais_cle_id`) ; Meta
 * exige `auth_config` à chaque écriture du connecteur, donc toute écriture pose une clé neuve.
 * Ordre : créer, écrire chez Meta, retenir après son accusé, puis révoquer toute autre clé `mba:relais` de
 * l'espace. Un échec ambigu (Meta a écrit, nous recevons une erreur) révoque une clé que Meta détient : plus
 * aucune clé n'est alors retenue, et la publication suivante en repose une.
 */
import type { AuditSink } from '../audit/journal';
import { messageDe } from '../lib/erreur';

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

/** Les magasins dont la clé du relais a besoin : clés d'API, réglages de l'espace, journal d'audit. */
export interface StoresCleRelais {
  cles: {
    create(tenantId: string, name: string, scopes: string[]): Promise<{ id: string; key: string }>;
    revoke(tenantId: string, id: string): Promise<boolean>;
    estActive(tenantId: string, id: string): Promise<boolean>;
    revoquerDroitSauf(tenantId: string, droit: string, garderId: string | null): Promise<string[]>;
  };
  reglages: {
    mbaRelaisCleId(tenantId: string): Promise<string | null>;
    setMbaRelaisCleId(tenantId: string, id: string | null): Promise<void>;
  };
  audit: AuditSink;
}

/**
 * Les dépendances de la clé pour un acteur (l'administrateur qui publie, `null` = système). Chaque création et
 * révocation est auditée (`cle_api.creee`, `cle_api.revoquee`) au nom de cet administrateur : c'est la clé au
 * droit le plus large de l'espace. Un audit qui échoue ne bloque pas la publication, mais se voit en console.
 */
export function depsCleRelaisDepuis(stores: StoresCleRelais): (acteur: string | null) => DepsCleRelais {
  return (acteur) => {
    const auditer = (t: string, action: 'cle_api.creee' | 'cle_api.revoquee', id: string): Promise<void> =>
      stores.audit(t, { userId: acteur, email: null }, action, { kind: 'api_key', id }, { scopes: [DROIT_RELAIS], par: 'publication chez Meta' })
        // eslint-disable-next-line no-console
        .catch((err: unknown) => { console.error('audit ignoré:', messageDe(err)); });
    return {
      creerCle: async (t) => {
        const cle = await stores.cles.create(t, NOM_CLE_RELAIS, [DROIT_RELAIS]);
        await auditer(t, 'cle_api.creee', cle.id);
        return cle;
      },
      revoquer: async (t, id) => {
        const fait = await stores.cles.revoke(t, id);
        if (fait) await auditer(t, 'cle_api.revoquee', id);
        return fait;
      },
      cleRetenue: (t) => stores.reglages.mbaRelaisCleId(t),
      retenir: (t, id) => stores.reglages.setMbaRelaisCleId(t, id),
      estActive: (t, id) => stores.cles.estActive(t, id),
      revoquerAutres: async (t, garder) => {
        for (const id of await stores.cles.revoquerDroitSauf(t, DROIT_RELAIS, garder)) await auditer(t, 'cle_api.revoquee', id);
      },
    };
  };
}

/** La clé retenue est-elle toujours active ? Une clé révoquée par le client doit être remplacée chez Meta. */
export async function cleAJour(deps: DepsCleRelais, tenantId: string): Promise<boolean> {
  const id = await deps.cleRetenue(tenantId);
  return id !== null && (await deps.estActive(tenantId, id));
}

/**
 * Pose une clé neuve chez Meta par `ecrireChezMeta`, dans l'ordre de l'en-tête. Deux poses simultanées du même
 * espace se révoqueraient l'une l'autre : la route de publication les sérialise par espace.
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

/** Le relais quitte Meta : toutes les clés du relais de l'espace sont révoquées, et plus aucune n'est retenue. */
export async function oublierCle(deps: DepsCleRelais, tenantId: string): Promise<void> {
  await deps.revoquerAutres(tenantId, null).catch(() => {});
  await deps.retenir(tenantId, null);
}
