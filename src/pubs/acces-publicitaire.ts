import type { MetaPubsCreationClient } from '../meta/pubs-creation';
import { entonnoir, ISSUES_NON_PRISES_EN_CHARGE } from './entonnoir';
import { creerLaPublicite, publierLaPublicite, type DemandeCreation, type IssueCreation } from './creation';
import type { GestesConnexionPub } from './connexion';
import type { PgPublicitesStore } from './publicites.pg';

/** Le seul module qui assemble une connexion publicitaire avec les opérations du compte Meta. */
export interface DepsAccesPublicitaire {
  connexion: Pick<GestesConnexionPub, 'avecConfiguration' | 'avecJeton'>;
  meta: Pick<MetaPubsCreationClient,
    | 'jetonDePage' | 'televerserImage' | 'etatVideo' | 'vignetteVideo' | 'etatAudiences'
    | 'creerCampagne' | 'creerEnsemble' | 'creerCrea' | 'creerPub' | 'supprimerCampagne'
    | 'demarrerDepotVideo' | 'transfererMorceauVideo' | 'terminerDepotVideo' | 'audiences' | 'changerStatut'>;
  publicites: Pick<PgPublicitesStore,
    | 'lire' | 'comptesDeLaCampagne' | 'ouvrir' | 'noterIds' | 'marquerEtat' | 'memoriserPub'
    | 'creerAutomation' | 'supprimerAutomation' | 'allumerAutomation' | 'noterStatutMeta'>;
  /** Numéro fourni par WhatsApp ; `null` laisse Meta choisir celui de la Page. */
  numeroWhatsApp(tenantId: string): Promise<string | null>;
}

/** Les opérations qui agissent sur le compte publicitaire, toutes authentifiées par sa connexion. */
export interface AccesPublicitaire {
  creerPub(tenantId: string, demande: Omit<DemandeCreation, 'comptePubId' | 'pageId' | 'numeroWhatsApp'>): Promise<IssueCreation>;
  videos: {
    demarrer(tenantId: string, taille: number): ReturnType<MetaPubsCreationClient['demarrerDepotVideo']>;
    transferer(
      tenantId: string,
      morceau: Parameters<MetaPubsCreationClient['transfererMorceauVideo']>[2],
    ): ReturnType<MetaPubsCreationClient['transfererMorceauVideo']>;
    terminer(tenantId: string, sessionId: string): ReturnType<MetaPubsCreationClient['terminerDepotVideo']>;
    etat(tenantId: string, videoId: string): ReturnType<MetaPubsCreationClient['etatVideo']>;
  };
  audiences(tenantId: string): ReturnType<MetaPubsCreationClient['audiences']>;
  publierPub(tenantId: string, publiciteId: string): Promise<void>;
  lirePub(tenantId: string, publiciteId: string): Promise<{
    publicite: Awaited<ReturnType<PgPublicitesStore['lire']>> & {};
    entonnoir: ReturnType<typeof entonnoir>;
  } | null>;
  basculerPub(tenantId: string, publiciteId: string, actif: boolean): Promise<void>;
}

/**
 * L’accès au compte et ses gestes métier forment un seul module. Les routes ne savent plus associer un jeton,
 * un compte, une Page et un client Graph ; elles ne reçoivent que des opérations par espace.
 */
export function creerAccesPublicitaire(deps: DepsAccesPublicitaire): AccesPublicitaire {
  const { connexion, meta, publicites } = deps;

  return {
    creerPub: async (tenantId, demande) => connexion.avecConfiguration(tenantId, async ({ comptePubId, pageId, appelerMeta }) => {
      // Le jeton de Page ne sert qu'à la créa et n'est jamais conservé. Quand Meta ne le rend pas, on garde
      // le jeton du compte publicitaire.
      const jetonCrea = await appelerMeta((jeton) => meta.jetonDePage(pageId, jeton));
      const affiche = await deps.numeroWhatsApp(tenantId);
      const numeroWhatsApp = affiche === null ? null : affiche.replace(/[^0-9]/g, '');

      return creerLaPublicite(
        { ...demande, comptePubId, pageId, numeroWhatsApp },
        {
          televerserImage: (base64) => appelerMeta((jeton) => meta.televerserImage(comptePubId, jeton, base64)),
          etatVideo: (videoId) => appelerMeta((jeton) => meta.etatVideo(videoId, jeton)),
          vignetteVideo: (videoId) => appelerMeta((jeton) => meta.vignetteVideo(comptePubId, jeton, videoId)),
          etatAudiences: (ids) => appelerMeta((jeton) => meta.etatAudiences(comptePubId, ids, jeton)),
          creerCampagne: (payload) => appelerMeta((jeton) => meta.creerCampagne(comptePubId, jeton, payload)),
          creerEnsemble: (payload) => appelerMeta((jeton) => meta.creerEnsemble(comptePubId, jeton, payload)),
          creerCrea: (payload) => appelerMeta((jeton) => meta.creerCrea(comptePubId, jetonCrea ?? jeton, payload)),
          creerPub: (payload) => appelerMeta((jeton) => meta.creerPub(comptePubId, jeton, payload)),
          supprimerCampagne: (id) => appelerMeta((jeton) => meta.supprimerCampagne(id, jeton)),
        },
        {
          ouvrir: (values) => publicites.ouvrir(tenantId, values),
          noterIds: (id, values) => publicites.noterIds(tenantId, id, values),
          marquerEtat: (id, etat) => publicites.marquerEtat(tenantId, id, etat),
          memoriserPub: (id, campagneId) => publicites.memoriserPub(tenantId, id, campagneId),
          creerAutomation: (id, values) => publicites.creerAutomation(tenantId, id, values),
          supprimerAutomation: (id) => publicites.supprimerAutomation(tenantId, id),
        },
      );
    }),

    videos: {
      demarrer: (tenantId, taille) => connexion.avecConfiguration(tenantId, ({ comptePubId, appelerMeta }) =>
        appelerMeta((jeton) => meta.demarrerDepotVideo(comptePubId, jeton, taille))),
      transferer: (tenantId, morceau) => connexion.avecConfiguration(tenantId, ({ comptePubId, appelerMeta }) =>
        appelerMeta((jeton) => meta.transfererMorceauVideo(comptePubId, jeton, morceau))),
      terminer: (tenantId, sessionId) => connexion.avecConfiguration(tenantId, ({ comptePubId, appelerMeta }) =>
        appelerMeta((jeton) => meta.terminerDepotVideo(comptePubId, jeton, sessionId))),
      etat: (tenantId, videoId) => connexion.avecConfiguration(tenantId, ({ appelerMeta }) =>
        appelerMeta((jeton) => meta.etatVideo(videoId, jeton))),
    },

    audiences: (tenantId) => connexion.avecConfiguration(tenantId, ({ comptePubId, appelerMeta }) =>
      appelerMeta((jeton) => meta.audiences(comptePubId, jeton))),

    publierPub: async (tenantId, publiciteId) => {
      const pub = await publicites.lire(tenantId, publiciteId);
      if (pub === null) throw new Error('cette publicité n’existe pas');
      await connexion.avecJeton(tenantId, (appelerMeta) => publierLaPublicite(
        publiciteId,
        { campagneId: pub.campagneId, ensembleId: pub.ensembleId, pubId: pub.pubId, etat: pub.etat, destination: pub.destination },
        { allumer: (objetId) => appelerMeta((jeton) => meta.changerStatut(objetId, jeton, 'ACTIVE')) },
        {
          allumerAutomation: (id) => publicites.allumerAutomation(tenantId, id),
          marquerPubliee: (id) => publicites.marquerEtat(tenantId, id, 'publiee'),
        },
      ));
    },

    lirePub: async (tenantId, publiciteId) => {
      const publicite = await publicites.lire(tenantId, publiciteId);
      if (publicite === null) return null;
      const comptes = await publicites.comptesDeLaCampagne(tenantId, publicite.campagneId, ISSUES_NON_PRISES_EN_CHARGE);
      return {
        publicite,
        entonnoir: entonnoir({
          depense: publicite.depense, clics: publicite.clics,
          impressions: publicite.impressions, couverture: publicite.couverture, ...comptes,
        }),
      };
    },

    basculerPub: async (tenantId, publiciteId, actif) => {
      const pub = await publicites.lire(tenantId, publiciteId);
      if (pub === null) throw new Error('cette publicité n’existe pas');
      await connexion.avecJeton(tenantId, (appelerMeta) =>
        appelerMeta((jeton) => meta.changerStatut(pub.campagneId, jeton, actif ? 'ACTIVE' : 'PAUSED')));
      // Écrire immédiatement le statut évite que l'écran affiche l'ancien état jusqu'au prochain balayage.
      await publicites.noterStatutMeta(tenantId, publiciteId, actif ? 'ACTIVE' : 'PAUSED');
    },
  };
}
