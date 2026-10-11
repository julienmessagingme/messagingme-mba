/**
 * Appliquer un geste du plan de publication chez Meta (relais du MBA). Tout arrive par injection, pour que
 * `tests/mba-appliquer-publication.test.ts` vérifie que la pose et l'oubli de la clé sont bien appelés.
 * Un refus qui vient de nous lève `ErreurPublication`, que l'orchestrateur restitue tel quel : sinon un connecteur
 * ou un outil introuvable ferait annoncer « Publié » pour un geste qui n'a rien fait.
 */

import {
  corpsOutilMeta, corpsConnecteurRelais, NOM_CONNECTEUR_RELAIS, type Geste, type OutilAPublier,
} from './publication';
import { poserCleNeuve, oublierCle, type DepsCleRelais } from './cle-relais';

/**
 * La mémoire privée d'une publication. `outils` est l'instantané exact sur lequel le plan a été calculé ;
 * `connecteurs` mémorise les lectures de Meta entre deux gestes et s'invalide quand la liste change.
 */
export interface ContextePublication {
  readonly acteurId: string | null;
  readonly outils: readonly OutilAPublier[];
  connecteurs?: Array<{ id: string; name: string }>;
}

/** Un refus qui vient de nous, pas de Meta. */
export class ErreurPublication extends Error {
  constructor(message: string) { super(message); this.name = 'ErreurPublication'; }
}

/** Ce que les gestes utilisent du client Meta, et rien de plus. */
export interface ClientConnecteurs {
  listConnectors(pn: string): Promise<Array<{ id: string; name: string }>>;
  createConnector(pn: string, corps: ReturnType<typeof corpsConnecteurRelais>): Promise<unknown>;
  updateConnector(pn: string, connecteurId: string, corps: ReturnType<typeof corpsConnecteurRelais>): Promise<unknown>;
  deleteConnector(pn: string, connecteurId: string): Promise<void>;
  createConnectorTool(pn: string, connecteurId: string, corps: ReturnType<typeof corpsOutilMeta>): Promise<unknown>;
  updateConnectorTool(pn: string, connecteurId: string, outilMetaId: string, corps: ReturnType<typeof corpsOutilMeta>): Promise<unknown>;
  deleteConnectorTool(pn: string, connecteurId: string, outilMetaId: string): Promise<void>;
}

export interface DepsAppliquer {
  meta: { mbaClientForTenant(tenantId: string): Promise<ClientConnecteurs> };
  /** La base du connecteur (`PUBLIC_API_URL` + `CHEMIN_RELAIS`), `null` quand l'adresse publique manque. */
  adresseDuRelais(): string | null;
  /** Les dépendances de la clé, pour un acteur donné (l'identifiant de l'administrateur, `null` = système). */
  cle(acteur: string | null): DepsCleRelais;
}

export function creerAppliquerGeste(deps: DepsAppliquer) {
  return async (tenantId: string, pn: string, geste: Geste, contexte: ContextePublication): Promise<void> => {
    const client = await deps.meta.mbaClientForTenant(tenantId);
    const base = deps.adresseDuRelais();
    const cleDe = deps.cle(contexte.acteurId);
    if (base === null) throw new ErreurPublication('l’adresse publique de l’API n’est pas réglée');

    /**
     * La lecture des connecteurs est mémorisée pour toute la publication, puis invalidée dès qu'on en crée ou
     * supprime un. Les outils viennent toujours de l'instantané du plan : aucune relecture ne peut publier un corps
     * différent de celui qui a été comparé.
     */
    const idDuRelais = async (): Promise<string | null> => {
      let vus = contexte.connecteurs;
      if (!vus) { vus = await client.listConnectors(pn); contexte.connecteurs = vus; }
      return vus.find((c) => c.name === NOM_CONNECTEUR_RELAIS)?.id ?? null;
    };

    // 🔴 Toute écriture du connecteur pose une clé neuve : Meta exige `auth_config` à chaque fois, et nous ne gardons
    // que l'empreinte de l'ancienne. L'ordre vit dans `poserCleNeuve`.
    if (geste.type === 'connecteur_creer') {
      await poserCleNeuve(cleDe, tenantId, async (cle) => { await client.createConnector(pn, corpsConnecteurRelais(base, cle)); });
      delete contexte.connecteurs;
      return;
    }
    if (geste.type === 'connecteur_modifier') {
      await poserCleNeuve(cleDe, tenantId, async (cle) => {
        await client.updateConnector(pn, geste.connecteurId, corpsConnecteurRelais(base, cle));
      });
      return;
    }
    if (geste.type === 'connecteur_supprimer') {
      await client.deleteConnector(pn, geste.connecteurId);
      // Le relais part parce que plus aucun outil n'est exposé : ses clés ne doivent pas lui survivre.
      if (geste.oublierCle) await oublierCle(cleDe, tenantId);
      delete contexte.connecteurs;
      return;
    }
    if (geste.type === 'outil_creer' || geste.type === 'outil_modifier') {
      const cid = await idDuRelais();
      if (!cid) throw new ErreurPublication('le connecteur EngageMe est introuvable chez Meta');
      const o = contexte.outils.find((x) => x.id === geste.outilId);
      if (!o) throw new ErreurPublication(`l’outil « ${geste.nom} » n’est plus exposé`);
      const corps = corpsOutilMeta(o);
      if (geste.type === 'outil_creer') await client.createConnectorTool(pn, cid, corps);
      else await client.updateConnectorTool(pn, cid, geste.outilMetaId, corps);
      return;
    }
    if (geste.type === 'outil_supprimer') await client.deleteConnectorTool(pn, geste.connecteurId, geste.outilMetaId);
  };
}
