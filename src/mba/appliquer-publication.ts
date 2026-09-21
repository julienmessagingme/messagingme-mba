/**
 * APPLIQUER UN GESTE DU PLAN DE PUBLICATION chez Meta (relais du MBA, migration 0161).
 *
 * 🔴 SORTI DU CÂBLAGE POUR ÊTRE TESTÉ (revue finale du 2026-09-21). Il vivait en ligne dans `src/index.ts`,
 * et la revue a montré qu'on pouvait y débrancher la pose ou l'oubli de la clé sans qu'aucun test ne tombe :
 * l'ordre était testé dans `cle-relais.ts`, pas le fait que `appliquer` l'appelle. Il reçoit désormais tout
 * par injection, et `tests/mba-appliquer-publication.test.ts` le joue contre des faux.
 *
 * ⚠️ UN REFUS QUI VIENT DE NOUS LÈVE `ErreurPublication`, et la route le dit tel quel au lieu de
 * « Meta a refusé ». L'ancien câblage rendait la main en silence sur un connecteur ou un outil introuvable,
 * et le POST annonçait « Publié » pour un geste qui n'avait rien fait.
 */

import {
  corpsOutilMeta, corpsConnecteurRelais, NOM_CONNECTEUR_RELAIS, type Geste, type OutilAPublier,
} from './publication';
import { poserCleNeuve, oublierCle, type DepsCleRelais } from './cle-relais';

/** Un refus qui vient de NOUS, pas de Meta. */
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
  client(tenantId: string): Promise<ClientConnecteurs>;
  /** La base du connecteur (`PUBLIC_API_URL` + `CHEMIN_RELAIS`), `null` quand l'adresse publique manque. */
  adresseDuRelais(): string | null;
  outils(tenantId: string, pn: string): Promise<OutilAPublier[]>;
  cle: DepsCleRelais;
}

export function creerAppliquerGeste(deps: DepsAppliquer) {
  return async (tenantId: string, pn: string, geste: Geste, ctx: Map<string, unknown>): Promise<void> => {
    const client = await deps.client(tenantId);
    const base = deps.adresseDuRelais();
    if (base === null) throw new ErreurPublication('l’adresse publique de l’API n’est pas réglée');

    /**
     * Deux lectures MÉMORISÉES pour toute la publication : la liste des connecteurs CHEZ META et les outils
     * exposés. 🔴 La première est INVALIDÉE dès qu'on crée ou supprime un connecteur, sinon le geste suivant
     * chercherait le relais dans une photo prise AVANT sa création. La seconde ne change pas pendant une
     * publication ; la relire à chaque outil coûtait une lecture de requête par outil ET par geste.
     */
    const idDuRelais = async (): Promise<string | null> => {
      let vus = ctx.get('connecteurs') as Array<{ id: string; name: string }> | undefined;
      if (!vus) { vus = await client.listConnectors(pn); ctx.set('connecteurs', vus); }
      return vus.find((c) => c.name === NOM_CONNECTEUR_RELAIS)?.id ?? null;
    };
    const outils = async (): Promise<OutilAPublier[]> => {
      let vus = ctx.get('outils') as OutilAPublier[] | undefined;
      if (!vus) { vus = await deps.outils(tenantId, pn); ctx.set('outils', vus); }
      return vus;
    };

    // 🔴 TOUTE ÉCRITURE DU CONNECTEUR POSE UNE CLÉ NEUVE : Meta exige `auth_config` à chaque fois, et nous ne
    // gardons que l'empreinte de l'ancienne. L'ordre vit dans `poserCleNeuve`, testé là-bas.
    if (geste.type === 'connecteur_creer') {
      await poserCleNeuve(deps.cle, tenantId, async (cle) => { await client.createConnector(pn, corpsConnecteurRelais(base, cle)); });
      ctx.delete('connecteurs');
      return;
    }
    if (geste.type === 'connecteur_modifier') {
      await poserCleNeuve(deps.cle, tenantId, async (cle) => {
        await client.updateConnector(pn, geste.connecteurId, corpsConnecteurRelais(base, cle));
      });
      return;
    }
    if (geste.type === 'connecteur_supprimer') {
      await client.deleteConnector(pn, geste.connecteurId);
      // Le relais part parce que plus aucun outil n'est exposé : ses clés ne doivent pas lui survivre.
      if (geste.oublierCle) await oublierCle(deps.cle, tenantId);
      ctx.delete('connecteurs');
      return;
    }
    if (geste.type === 'outil_creer' || geste.type === 'outil_modifier') {
      const cid = await idDuRelais();
      if (!cid) throw new ErreurPublication('le connecteur EngageMe est introuvable chez Meta');
      const o = (await outils()).find((x) => x.id === geste.outilId);
      if (!o) throw new ErreurPublication(`l’outil « ${geste.nom} » n’est plus exposé`);
      const corps = corpsOutilMeta(o);
      if (geste.type === 'outil_creer') await client.createConnectorTool(pn, cid, corps);
      else await client.updateConnectorTool(pn, cid, geste.outilMetaId, corps);
      return;
    }
    if (geste.type === 'outil_supprimer') await client.deleteConnectorTool(pn, geste.connecteurId, geste.outilMetaId);
  };
}
