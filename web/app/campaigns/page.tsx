'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { AppShell } from '@/components/AppShell';
import type { Session } from '@/lib/session';
import { explainMetaError } from '@/lib/meta-errors';
import { fmtCost, campaignSendLabel } from '@/lib/format';
import { getCoutParCampagne } from '@/lib/api/stats';
import { presetRange } from '@/lib/range';
import { useT, useLocale } from '@/lib/i18n';
import { formatDate, hourMin } from '@/lib/day';
import {
  listCampaigns,
  listCampaignDrafts,
  deleteCampaignDraft,
  type CampaignDraft,
  getCampaign,
  runCampaign,
  retryRecipient,
  updateContact,
  cancelSchedule,
  archiveCampaign,
  unarchiveCampaign,
  stopCampaign,
  pauseCampaign,
  deleteCampaign,
  getTemplateStats,
  type CampaignSummary,
  type CampaignDetail,
  type CampaignRecipient,
  type PricingSummary,
} from '@/lib/api';
import { LaunchCounts } from '@/components/LaunchCounts';
import { Bouton, classesBouton } from '@/components/Bouton';
import { TitrePage } from '@/components/TitrePage';

/**
 * LE COUT D'UNE CAMPAGNE VIENT DU SERVEUR, IL NE SE CALCULE PLUS ICI.
 *
 * 🔴 CE QUE CETTE PAGE FAISAIT, ET POURQUOI C'ETAIT FAUX (Julien, 2026-09-23). Elle multipliait les
 * DESTINATAIRES par le tarif Meta de la CATEGORIE de la campagne, sans regarder le canal ni ce qui etait
 * reellement parti. Mesure sur l'espace d'essai : 5 campagnes sur 7 affichaient un prix faux. Quatre
 * campagnes a scenario n'avaient envoye AUCUN modele facturable et affichaient pourtant 0,0712 € chacune ;
 * une campagne RCS affichait le tarif d'un modele Meta alors que le RCS a ses propres prix.
 *
 * 🔴 ET LE CHIFFRE VIENT DE LA MEME ROUTE QUE LA FICHE DE PERFORMANCE LAB, pas d'une seconde source. C'est
 * ce qui garantit que les deux ecrans ne peuvent plus se contredire : ils lisent le meme calcul, avec les
 * memes regles (modeles facturables au tarif Meta marge, RCS au tarif simple ou conversationnel selon que
 * le contact a reagi). Deux calculs « equivalents » divergent le jour ou l'un des deux change.
 *
 * ⚠️ TROIS CAS RENDENT UN COUT INCONNU, et l'ecran ecrit alors « indisponible » plutot qu'un zero : une
 * campagne plus vieille que la plage lue, une campagne au-dela des cinquante que ce tableau rend, et une
 * campagne dont rien n'a pu etre chiffre. Zero se lirait « ca n'a rien coute ».
 *
 * 🔴 QUATRE-VINGT-DIX JOURS, ET C'EST LA CORRECTION DU SEUL ROUGE DE LA REVUE FINALE DU 2026-09-23. Cette
 * plage valait 366, le maximum que l'API accepte, « puisqu'on peut ». Or cet ecran n'est pas un ecran
 * d'analyse qu'on ouvre pour se faire une idee : c'est l'ecran de travail des campagnes, ouvert en
 * permanence, et chaque montage declenchait l'agregation la plus lourde du produit sur la fenetre la plus
 * large, plus un aller-retour chez Meta. Une campagne plus vieille que 90 jours garde sa case
 * « indisponible », ce qui est la reponse juste (on ne l'a pas lue) et pas un prix invente.
 *
 * ⚠️ ET LA CONTREPARTIE ANNONCEE N'EXISTAIT PAS, ce qui est le vrai defaut que la relecture a trouve : cette
 * phrase disait « son cout exact reste a un clic, sur sa fiche de resultats ». C'est faux des deux cotes. Le
 * panneau de detail de CET ecran recoit le meme cout que la liste (`cout={couts?.get(detail.id)}`), donc il
 * reaffiche « indisponible » ; et « Voir les resultats » mene au Funnel, qui n'affiche aucun cout. Le cout
 * d'une campagne plus ancienne se lit dans Performance Lab > SYNTHESE, carte « Couts », en DEPLACANT la
 * periode (l'elargir bute sur les 366 jours de `MAX_SPAN_DAYS`) ; « Performance Lab > Couts » est un AUTRE
 * ecran, qui ne porte ni le cout par engagement ni la fiche d'une campagne. Une
 * justification fausse se recopie : celle-ci l'avait deja ete, du code vers `features.md`, donc vers les
 * fiches d'aide servies au client.
 *
 * ⚠️ ET LA PLAGE SE CALCULE A CHAQUE CHARGEMENT, PAS AU CHARGEMENT DU MODULE (meme revue). Evaluee une fois
 * pour toutes, un onglet laisse ouvert traverse minuit avec un `to` de la veille ; pire, une page chargee
 * juste apres minuit cote navigateur, alors que le serveur n'a pas encore bascule, prend un 400 « to ne
 * peut pas etre dans le futur » qui eteint toute la colonne.
 */
const JOURS_COUT = 90;

export default function CampaignsPage() {
  return <AppShell active="campagnes" fullBleed>{(session) => <CampaignsInner session={session} />}</AppShell>;
}

// Chaque statut porte ses DEUX libellés [fr, en] (résolus au rendu via t) : la const vit hors composant, donc
// useT() y est inappelable -> on fait porter les deux langues à la valeur.
const STATUS: Record<string, { text: [string, string]; cls: string }> = {
  draft: { text: ['brouillon', 'draft'], cls: 'bg-ink-100 text-ink-500' },
  scheduled: { text: ['planifiée', 'scheduled'], cls: 'bg-ink-100 text-ink-900' },
  running: { text: ['en cours', 'running'], cls: 'bg-brand-50 text-brand-700' },
  paused: { text: ['en pause', 'paused'], cls: 'bg-alerte-50 text-alerte-700' },
  completed: { text: ['terminée', 'completed'], cls: 'bg-succes-50 text-succes-700' },
  failed: { text: ['échec', 'failed'], cls: 'bg-danger-50 text-danger-700' },
  pending: { text: ['en attente', 'pending'], cls: 'bg-ink-100 text-ink-500' },
  sending: { text: ['envoi', 'sending'], cls: 'bg-brand-50 text-brand-700' },
  sent: { text: ['envoyé', 'sent'], cls: 'bg-ink-100 text-ink-900' },
  skipped: { text: ['ignoré', 'skipped'], cls: 'bg-alerte-50 text-alerte-700' },
  // Statuts de livraison Meta
  delivered: { text: ['délivré', 'delivered'], cls: 'bg-brand-50 text-brand-700' },
  read: { text: ['lu', 'read'], cls: 'bg-succes-50 text-succes-700' },
};
function Badge({ status }: { status: string }) {
  const t = useT();
  const s = STATUS[status] ?? { text: [status, status] as [string, string], cls: 'bg-ink-100 text-ink-500' };
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${s.cls}`}>{t(...s.text)}</span>;
}

function CampaignsInner({ session }: { session: Session }) {
  const t = useT();
  /**
   * 🔴 LA CREATION A SON PROPRE ECRAN DEPUIS LE 2026-09-13, ET CETTE PAGE N'EN PORTE PLUS AUCUN
   * MORCEAU. Elle hebergeait l'ancien formulaire dans un mode « create » : l'assistant, lui, vit a
   * `/campaigns/nouvelle`, avec son adresse, ses etapes partageables (`?etape=`) et la reprise d'un
   * brouillon par son identifiant (`?brouillon=`). Un mode local ne peut rien de tout cela.
   */
  const router = useRouter();
  const { locale } = useLocale();
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [detail, setDetail] = useState<CampaignDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [polling, setPolling] = useState(false);
  /**
   * 🔴 CE QUI FAIT RELIRE LE COÛT, ET RIEN D'AUTRE (jaune du 2026-09-23). Il était chargé une seule fois par
   * montage : lancer une campagne depuis cet écran laissait donc sa case sur la valeur d'AVANT l'envoi, en
   * général « indisponible », jusqu'à ce qu'on recharge la page. Un chiffre périmé qui a l'air frais est le
   * défaut que ce tableau existe pour éviter.
   *
   * ⚠️ UN COMPTEUR, PAS UN APPEL DE PLUS DANS `reload()`. La raison écrite plus bas tient toujours : `reload`
   * est sondée six fois en douze secondes pendant un envoi, et marteler une agrégation à cette cadence
   * coûterait cher pour un chiffre qui ne bouge pas si vite. On le fait avancer UNE fois, quand le sondage
   * est fini. Passer par l'effet plutôt que par un appel direct garde son garde-fou `vivant`, qui est ce qui
   * empêche une réponse tardive d'écraser l'état d'un autre espace.
   */
  const [coutsVersion, setCoutsVersion] = useState(0);
  // Corbeille : la liste montre SOIT les campagnes actives SOIT les archivées, jamais les deux mélangées.
  const [showArchived, setShowArchived] = useState(false);
  // Tarifs Meta chargés UNE fois au montage (hors reload() pollé 6×/2s pendant l'envoi -> pas de martèlement).
  const [pricing, setPricing] = useState<PricingSummary | null>(null);
  /**
   * Le cout REEL de chaque campagne, par identifiant, lu sur la route du cout par campagne.
   *
   * ⚠️ `null` = pas encore charge, ou route indisponible : l'ecran dit « indisponible », il n'invente pas.
   * Une campagne absente de la carte est dans le meme cas (trop vieille, ou au-dela des cinquante rendues).
   */
  const [couts, setCouts] = useState<Map<string, number | null> | null>(null);
  const [deviseCout, setDeviseCout] = useState<string | null>(null);
  /**
   * Brouillons de COMPOSITION : des campagnes qu'on a commencé à écrire. Chargés à part de `reload()`, qui
   * est pollé pendant un envoi : un brouillon ne bouge pas six fois en douze secondes.
   */
  const [brouillons, setBrouillons] = useState<CampaignDraft[]>([]);

  const rechargerBrouillons = useCallback(async () => {
    // Silencieux : l'absence de brouillons ne doit jamais masquer la liste des campagnes, qui est l'essentiel
    // de l'écran. Un backend plus ancien que ce front n'a pas la route, et la section reste simplement vide.
    //
    // 🔴 `Array.isArray` et pas seulement le try/catch : une réponse 200 sans `drafts` (backend antérieur,
    // proxy qui renvoie un objet vide) passerait le catch et poserait `undefined` dans un état typé tableau.
    // Le rendu suivant lit `.length` dessus et TOUTE la page casse, pas seulement cette section.
    try {
      const r = await listCampaignDrafts(session.tenantId);
      setBrouillons(Array.isArray(r?.drafts) ? r.drafts : []);
    } catch {
      setBrouillons([]);
    }
  }, [session.tenantId]);

  useEffect(() => { void rechargerBrouillons(); }, [rechargerBrouillons]);

  useEffect(() => {
    getTemplateStats(session.tenantId).then((ts) => setPricing(ts.pricing)).catch(() => setPricing(null));
  }, [session.tenantId]);

  /**
   * ⚠️ IL SUIT LA CORBEILLE. Le tableau du cout exclut les campagnes archivees par defaut ; quand la liste
   * montre les archivees, il faut les demander, sinon toute la corbeille afficherait « indisponible ».
   *
   * ⚠️ HORS DE `reload()`, qui est sondee six fois en douze secondes pendant un envoi : un cout ne bouge pas
   * a cette cadence, et le marteler couterait une agregation a chaque battement.
   */
  useEffect(() => {
    let vivant = true;
    getCoutParCampagne(session.tenantId, presetRange(JOURS_COUT), showArchived)
      .then((r) => {
        if (!vivant) return;
        setCouts(new Map((r.lignes ?? []).map((l) => [l.campaignId, l.cout])));
        setDeviseCout(r.currency ?? null);
      })
      .catch(() => { if (vivant) setCouts(null); });
    return () => { vivant = false; };
  }, [session.tenantId, showArchived, coutsVersion]);

  /**
   * ⚠️ ELLE NE CHARGE PLUS QUE LES CAMPAGNES, ET C'EST UNE CONSÉQUENCE DU RETRAIT DU 2026-09-13. Les
   * numéros Meta et le drapeau RCS ne servaient QU'au formulaire de création que cette page hébergeait :
   * lui parti, ils n'avaient plus un seul lecteur ici. Et `reload` est SONDÉE pendant un envoi (six fois
   * en douze secondes), donc chaque tour payait une lecture des numéros dont personne ne faisait rien.
   */
  const reload = useCallback(async () => {
    setError(null);
    try {
      const c = await listCampaigns(session.tenantId, { archived: showArchived });
      setCampaigns(c.campaigns);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Chargement impossible', 'Loading failed'));
    } finally {
      setLoading(false);
    }
  }, [session.tenantId, showArchived, t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function openDetail(id: string) {
    try {
      setDetail(await getCampaign(session.tenantId, id));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Détail indisponible', 'Detail unavailable'));
    }
  }

  async function run(id: string) {
    setError(null);
    try {
      await runCampaign(id);
      await openDetail(id); // ouvre le détail de la campagne lancée
      // Le worker traite en ~1-2s : on rafraîchit quelques fois pour voir les statuts évoluer.
      setPolling(true);
      for (let i = 0; i < 6; i += 1) {
        await new Promise((r) => setTimeout(r, 2000));
        await reload();
        await openDetail(id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Lancement impossible', 'Launch failed'));
    } finally {
      setPolling(false);
      // Le sondage est fini : la campagne a envoyé, donc son coût a changé. Une relecture, une seule.
      setCoutsVersion((v) => v + 1);
    }
  }

  // Annule la programmation d'une campagne « scheduled » : elle repasse en brouillon côté backend, puis on
  // rafraîchit la liste pour refléter le nouveau statut.
  async function cancelSched(id: string) {
    setError(null);
    try {
      await cancelSchedule(id);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Annulation impossible', 'Cancellation failed'));
    }
  }

  // Sort la campagne de la liste courante : son panneau de détail ouvert n'a plus de ligne à laquelle se
  // rattacher, on le referme d'abord pour ne pas laisser un détail orphelin à l'écran.
  async function mutateAndReload(id: string, action: () => Promise<unknown>, failure: string) {
    setError(null);
    try {
      await action();
      if (detail?.id === id) setDetail(null);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : failure);
    }
  }

  async function archive(id: string) {
    await mutateAndReload(id, () => archiveCampaign(session.tenantId, id), t('Archivage impossible', 'Archiving failed'));
  }
  async function unarchive(id: string) {
    await mutateAndReload(id, () => unarchiveCampaign(session.tenantId, id), t('Restauration impossible', 'Restore failed'));
  }
  /**
   * Arrête une campagne AU FIL DE L'EAU. Confirmation demandée parce que le geste est SANS RETOUR : elle
   * passe en terminée, et reprendre les arrivants suppose d'en créer une nouvelle. Ce qui est déjà parti
   * reste parti, l'historique n'est pas touché.
   */
  async function stop(c: CampaignSummary) {
    const ok = window.confirm(t(
      `Arrêter « ${c.name} » ? Elle cessera de prendre les contacts qui arrivent. Pour la rouvrir, il faudra créer une nouvelle campagne.`,
      `Stop “${c.name}”? It will stop taking incoming contacts. Reopening it means creating a new campaign.`,
    ));
    if (!ok) return;
    await mutateAndReload(c.id, () => stopCampaign(session.tenantId, c.id), t('Arrêt impossible', 'Stop failed'));
  }
  /**
   * SUSPEND un envoi en cours : c'est le geste d'urgence quand on s'aperçoit qu'on vise mal. Sans confirmation,
   * justement parce qu'il est urgent et réversible (« Reprendre » repart au destinataire suivant). Ce qui est
   * déjà parti reste parti : aucun message WhatsApp livré ne se rappelle.
   *
   * On ne referme PAS le panneau de détail (contrairement à `mutateAndReload`) : c'est là qu'on lit combien
   * sont partis avant la coupure, et c'est la première chose qu'on veut voir.
   */
  async function pause(c: CampaignSummary) {
    setError(null);
    try {
      await pauseCampaign(session.tenantId, c.id);
      await reload();
      if (detail?.id === c.id) await openDetail(c.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Suspension impossible', 'Pause failed'));
    }
  }
  async function remove(c: CampaignSummary) {
    const ok = window.confirm(t(
      `Supprimer définitivement « ${c.name} » ? Cette campagne n'a jamais rien envoyé, elle sera effacée pour de bon.`,
      `Permanently delete “${c.name}”? This campaign never sent anything, it will be erased for good.`,
    ));
    if (!ok) return;
    await mutateAndReload(c.id, () => deleteCampaign(session.tenantId, c.id), t('Suppression impossible', 'Deletion failed'));
  }

  // Écran par défaut : dashboard de suivi des campagnes. Même conteneur scrollable pleine largeur que la création.
  return (
    <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-6">
    <section>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <TitrePage className="tabular-nums">
            {showArchived ? t('Campagnes archivées', 'Archived campaigns') : t('Campagnes', 'Campaigns')} ({campaigns.length})
          </TitrePage>
          {couts !== null ? (
            /* « des campagnes affichées », et non « total » : la somme porte sur la liste RENDUE, qui exclut
               désormais les archivées. Le dashboard, lui, compte tout. Deux chiffres différents sur deux écrans
               sont acceptables tant que chacun dit sur quoi il porte ; « total » ici serait un mensonge.
               ⚠️ LA CONDITION SUIT LA SOURCE DU CHIFFRE, et elle a changé avec elle (2026-09-23) : ce total
               dépendait des tarifs Meta parce qu'il les multipliait lui-même. Il lit maintenant le coût rendu
               par le serveur, donc c'est SON absence qui doit faire taire la ligne. Laisser la condition sur
               `pricing` aurait affiché un total à 0 € quand la route du coût est indisponible. */
            <p className="mt-0.5 text-xs text-ink-500">
              {t('coût estimé des campagnes affichées', 'estimated cost of listed campaigns')} ≈ <span className="font-semibold text-ink-900" data-testid="campagnes-cout-total">{fmtCost(campaigns.reduce((acc, c) => acc + (couts?.get(c.id) ?? 0), 0), locale, deviseCout ?? pricing?.currency)}</span>{!(deviseCout ?? pricing?.currency) && <span className="text-ink-400"> ({t('devise du compte', 'account currency')})</span>}
              {/* ⚠️ IL DIT CE QU'IL NE COMPTE PAS. Une campagne dont le coût est inconnu vaut zéro dans cette
                  somme, ce qui est la seule addition possible, mais la taire ferait lire le total comme
                  complet. On nomme donc les campagnes écartées plutôt que de les fondre dedans. */}
              {couts !== null && campaigns.some((c) => (couts.get(c.id) ?? null) === null) && (
                <span className="text-ink-400" data-testid="campagnes-cout-partiel">
                  {' '}({campaigns.filter((c) => (couts.get(c.id) ?? null) === null).length} {t('sans coût connu', 'without a known cost')})
                </span>
              )}
            </p>
          ) : (
            /* ⚠️ IL PORTE UN `data-testid`, ET CE N'EST PAS DE LA DÉCORATION. Son test le cherchait par son
               TEXTE, or CETTE PHRASE EST RENDUE PLUSIEURS FOIS : ici pour le total, et une fois PAR
               CAMPAGNE plus bas, où la ligne dit « coût estimé » suivi d'un span « indisponible », donc un
               texte complet identique. Le compte passait de 1 à 1 + le nombre de campagnes selon que la
               liste avait eu le temps de paraître, d'où un échec intermittent qui se lit comme un défaut du
               code alors que c'est le localisateur qui est imprécis.
               🔴 LA PREMIÈRE VERSION DE CE COMMENTAIRE DISAIT « un getByText matche aussi les ancêtres ».
               C'ÉTAIT FAUX, et vérifié dans la source de Playwright : son moteur de texte écarte un élément
               dès qu'un de ses enfants matche aussi. Une explication commode qui serait recopiée. */
            <p className="mt-0.5 text-xs text-ink-400" data-testid="campagnes-cout-indisponible">{t('coût estimé indisponible', 'estimated cost unavailable')}</p>
          )}
        </div>
        <div className="flex items-center gap-3">
          {polling ? (
            <span className="flex items-center gap-1.5 text-xs text-ink-400">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500" />
              {t('actualisation...', 'refreshing...')}
            </span>
          ) : (
            <button onClick={reload} className="text-xs text-brand-600 hover:underline">{t('Rafraîchir', 'Refresh')}</button>
          )}
          {/* Bascule actives / archivées. `reload` dépend de showArchived, donc l'effet de montage la rejoue
              tout seul au changement : pas d'appel manuel ici, sinon on chargerait deux fois. */}
          <button
            onClick={() => { setDetail(null); setShowArchived((v) => !v); }}
            className="text-xs text-ink-500 hover:text-ink-900 hover:underline"
          >
            {showArchived ? t('Voir les campagnes actives', 'View active campaigns') : t('Voir les archivées', 'View archived')}
          </button>
          <Bouton
            onClick={() => router.push('/campaigns/nouvelle')}
          >
            + {t('Ajouter une campagne', 'Add a campaign')}
          </Bouton>
        </div>
      </div>
      {error && <p className="mb-3 rounded-lg bg-danger-50 px-3 py-2 text-sm text-danger-700">{error}</p>}

      {/* Campagnes COMMENCÉES mais pas encore créées. Volontairement au-dessus de la liste et visuellement
          distinctes : ce ne sont pas des campagnes, elles n'ont ni destinataire ni envoi possible. Masquées
          dans la corbeille, qui ne parle que de campagnes archivées. */}
      {!showArchived && brouillons.length > 0 && (
        <section className="mb-4" data-testid="campaign-drafts">
          <h3 className="mb-2 text-xs font-medium text-ink-500">
            {t('Brouillons en cours', 'Drafts in progress')}
          </h3>
          <ul className="space-y-2">
            {brouillons.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 rounded-xl border border-dashed border-ink-300 bg-white px-4 py-2.5">
                <div className="min-w-0">
                  <span className="truncate text-sm font-medium text-ink-900">{d.name}</span>
                  <span className="ml-2 rounded bg-ink-100 px-1.5 py-0.5 text-xs text-ink-500">{t('brouillon', 'draft')}</span>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <button
                    data-testid={`draft-resume-${d.id}`}
                    /* ⚠️ LE BROUILLON VOYAGE PAR SON IDENTIFIANT, PAS PAR L'ETAT DE CETTE PAGE : l'ecran de
                       creation le relit lui-meme, donc le lien se partage et survit a un rechargement. */
                    onClick={() => router.push(`/campaigns/nouvelle?brouillon=${d.id}`)}
                    className="text-sm font-medium text-brand-600 hover:underline"
                  >
                    {t('Reprendre', 'Resume')}
                  </button>
                  <button
                    onClick={() => {
                      if (!window.confirm(t(`Supprimer le brouillon « ${d.name} » ?`, `Delete draft "${d.name}"?`))) return;
                      void deleteCampaignDraft(session.tenantId, d.id).then(rechargerBrouillons).catch(() => {});
                    }}
                    className="text-sm text-ink-400 hover:text-danger-600"
                  >
                    {t('Supprimer', 'Delete')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {loading ? (
        <p className="text-sm text-ink-500">{t('Chargement...', 'Loading...')}</p>
      ) : campaigns.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-ink-300 bg-white px-4 py-10 text-center text-sm text-ink-500">
          {showArchived
            ? t('Aucune campagne archivée.', 'No archived campaigns.')
            : t('Aucune campagne. Clique « + Ajouter une campagne » pour en créer une.', 'No campaigns. Click "+ Add a campaign" to create one.')}
        </div>
      ) : (
          <ul className="space-y-2">
            {campaigns.map((c) => (
              <li key={c.id} className="rounded-2xl border border-ink-200 bg-white p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{c.name}</span>
                      <Badge status={c.status} />
                      <span className="text-xs text-ink-400">{c.category}</span>
                      {/* Une campagne au fil de l'eau se lit « en cours » comme les autres, alors qu'elle ne
                          se terminera jamais d'elle-même. Sans cette pastille, son statut mentirait par
                          omission : c'est ce marqueur qui explique pourquoi elle est encore là. */}
                      {c.webhookId && (
                        <span className="rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-600" data-testid="campaign-badge-fil">
                          {t('au fil de l\'eau', 'continuous')}{c.webhookName ? ` · ${c.webhookName}` : ''}
                        </span>
                      )}
                    </div>
                    {c.status === 'scheduled' && c.scheduledAt && (
                      <p className="mt-0.5 text-xs font-medium text-ink-500">
                        {t('Planifiée le', 'Scheduled for')} {new Date(c.scheduledAt).toLocaleString()}
                      </p>
                    )}
                    <p className="mt-0.5 text-xs text-ink-500">
                      {campaignSendLabel(c, locale)} · {c.counts.total} {t('destinataires', 'recipients')}
                    </p>
                    <LaunchCounts counts={c.counts} className="mt-1 text-xs text-ink-500" />
                    {(() => {
                      // `?? null` et pas `?? undefined` : une campagne absente de la carte est un coût INCONNU,
                      // au même titre qu'un coût rendu vide. Les deux s'affichent « indisponible ».
                      const cost = couts?.get(c.id) ?? null;
                      return (
                        <p className="mt-1 text-xs text-ink-400">
                          {t('coût estimé', 'estimated cost')} {cost != null ? <>≈ <span className="font-medium text-ink-900" data-testid={`campagne-cout-${c.id}`}>{fmtCost(cost, locale, deviseCout ?? pricing?.currency)}</span>{!(deviseCout ?? pricing?.currency) && ` (${t('devise du compte', 'account currency')})`}</> : <span data-testid={`campagne-cout-${c.id}`}>{t('indisponible', 'unavailable')}</span>}
                        </p>
                      );
                    })()}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    {/* « Lancer » pour un brouillon (jamais envoyée) ; « Reprendre » pour une campagne mise
                        en pause par le quality gate (elle relance ses destinataires restants). Une campagne
                        en cours / terminée / en échec ne se (re)lance pas depuis la liste. */}
                    {(c.status === 'draft' || c.status === 'paused') && (
                      <Bouton taille="petite"
                        onClick={() => run(c.id)}
                        disabled={polling}
                      >
                        {c.status === 'paused' ? t('Reprendre', 'Resume') : t('Lancer', 'Launch')}
                      </Bouton>
                    )}
                    {/* ARRÊT D'URGENCE d'un envoi en cours. Jusqu'ici une campagne lancée n'avait aucun frein :
                        une erreur de ciblage sur 5 000 destinataires partait jusqu'au bout. L'envoi s'arrête
                        dans les secondes qui suivent, et le bouton devient « Reprendre » (statut en pause). */}
                    {c.status === 'running' && (
                      <button
                        onClick={() => pause(c)}
                        data-testid="campaign-pause"
                        title={t('L\'envoi s\'arrête dans quelques secondes. Ce qui est déjà parti reste parti.', 'Sending stops within seconds. What has already gone out stays out.')}
                        className="rounded-lg border border-alerte-300 bg-alerte-50 px-3 py-1 text-xs font-medium text-alerte-800 hover:bg-alerte-100"
                      >
                        {t('Mettre en pause', 'Pause')}
                      </button>
                    )}
                    {/* Seul point final d'une campagne au fil de l'eau : elle n'en a aucun par elle-même.
                        Le bouton n'existe donc QUE là, et pas sur une campagne ordinaire, qui se termine
                        quand son dernier destinataire est parti. */}
                    {c.webhookId && (c.status === 'running' || c.status === 'paused') && (
                      <Bouton variante="secondaire" taille="petite"
                        onClick={() => stop(c)}
                        data-testid="campaign-stop"
                      >
                        {t('Arrêter', 'Stop')}
                      </Bouton>
                    )}
                    {/* Une campagne programmée part seule à l'échéance : pas de « Lancer », mais on peut annuler
                        la programmation (retour brouillon). */}
                    {c.status === 'scheduled' && (
                      <Bouton variante="secondaire" taille="petite"
                        onClick={() => cancelSched(c.id)}
                      >
                        {t('Annuler la planification', 'Cancel schedule')}
                      </Bouton>
                    )}
                    <button
                      onClick={() => (detail?.id === c.id ? setDetail(null) : openDetail(c.id))}
                      className="text-xs text-brand-600 hover:underline"
                    >
                      {detail?.id === c.id ? t('Masquer', 'Hide') : t('Détails', 'Details')}
                    </button>
                    {/* Sortie de liste. Une campagne qui a envoyé ne peut QUE s'archiver : ses destinataires
                        portent l'historique lu par les analytics. Seul un brouillon dont aucun destinataire n'a
                        bougé se supprime pour de bon. Le serveur retient la même garde et répond 409 s'il
                        n'est pas d'accord : ce test local ne fait qu'éviter de proposer un bouton perdant. */}
                    {c.archivedAt ? (
                      <button onClick={() => unarchive(c.id)} className="text-xs text-ink-500 hover:text-ink-900 hover:underline">
                        {t('Restaurer', 'Restore')}
                      </button>
                    ) : c.status === 'draft' && c.counts.total === c.counts.pending ? (
                      <button onClick={() => remove(c)} className="text-xs text-danger-600 hover:underline">
                        {t('Supprimer', 'Delete')}
                      </button>
                    ) : (
                      <button onClick={() => archive(c.id)} className="text-xs text-ink-500 hover:text-ink-900 hover:underline">
                        {t('Archiver', 'Archive')}
                      </button>
                    )}
                  </div>
                </div>
                {detail?.id === c.id && (
                  <div className="mt-3">
                    <DetailPanel detail={detail} cout={couts?.get(detail.id) ?? null} devise={deviseCout ?? pricing?.currency ?? null} tenantId={session.tenantId} onClose={() => setDetail(null)} onRetried={() => void openDetail(detail.id)} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
    </section>
    </div>
  );
}

/** Codes d'erreur Meta « variable de template » renvoyables après correction (F7). Aligné sur le back. */
const RETRYABLE_VAR_CODES = new Set([131009, 132012, 132000]);

function DetailPanel({ detail, cout, devise, tenantId, onClose, onRetried }: {
  detail: CampaignDetail;
  /**
   * Le coût rendu par le serveur pour CETTE campagne. `null` = inconnu, et l'écran l'écrit.
   *
   * 🔴 IL N'EST PLUS RECALCULE ICI (Julien, 2026-09-23 : « dans l'onglet campagne dans détail, pareil, tu ne
   * mets pas le prix comme si c'était un template Meta car c'était un RCS »). Ce panneau multipliait les
   * destinataires par le tarif de la catégorie, donc il affichait un tarif de modèle sur une campagne RCS
   * et sur une campagne à scénario qui n'a envoyé aucun modèle facturable.
   */
  cout: number | null;
  devise: string | null;
  tenantId: string;
  onClose: () => void;
  onRetried: () => void;
}) {
  const t = useT();
  const { locale } = useLocale();
  // Date d'envoi d'un destinataire, même format que l'historique de la fiche contact (fuseau imposé par day.ts).
  const stamp = (iso: string) => `${formatDate(iso, locale, { day: '2-digit', month: '2-digit', year: '2-digit' })} ${hourMin(iso, locale)}`;

  // Champs (source:field) du template : ce que l'admin peut corriger sur le contact avant de renvoyer (F7).
  const fieldKeys = detail.paramMapping.filter((p) => p.source.type === 'field' && p.source.key).map((p) => p.source.key as string);
  const [retryFor, setRetryFor] = useState<string | null>(null);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ rid: string; text: string; ok: boolean } | null>(null);

  function openRetry(rid: string) {
    setRetryFor(rid);
    setVals(Object.fromEntries(fieldKeys.map((k) => [k, ''])));
    setMsg(null);
  }
  async function submitRetry(r: CampaignRecipient) {
    setBusy(true);
    setMsg(null);
    try {
      // Ne PATCH que les champs réellement saisis (MERGE côté serveur, n'écrase pas les autres).
      const fields = Object.fromEntries(Object.entries(vals).filter(([, v]) => v.trim() !== ''));
      if (Object.keys(fields).length > 0) await updateContact(tenantId, r.contactId, { fields });
      await retryRecipient(detail.id, r.id);
      setRetryFor(null);
      setMsg({ rid: r.id, text: t('Renvoi en file. Le statut se met à jour au rafraîchissement.', 'Resend queued. Status updates on refresh.'), ok: true });
      onRetried();
    } catch (err) {
      setMsg({ rid: r.id, text: err instanceof Error ? err.message : t('Renvoi impossible', 'Resend failed'), ok: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-4 overflow-hidden rounded-2xl border border-ink-200 bg-white">
      <div className="flex items-center justify-between border-b border-ink-100 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">{detail.name}</span>
          <Badge status={detail.status} />
          <span className="text-xs text-ink-500">{campaignSendLabel(detail, locale)}</span>
          <span className="text-xs text-ink-400" data-testid="detail-cout-estime">{t('coût estimé', 'estimated cost')} {cout != null ? `≈ ${fmtCost(cout, locale, devise)}${devise ? '' : ` (${t('devise du compte', 'account currency')})`}` : t('indisponible', 'unavailable')}</span>
        </div>
        <div className="flex items-center gap-3">
          {/*
            🔴 LE CHEMIN VERS LES RÉSULTATS, depuis l'écran où on se pose la question (demande de Julien,
            2026-09-15). Sans lui, il fallait retenir le nom de la campagne, changer de menu, trouver le
            Funnel, puis la rechercher dans une liste déroulante : quatre gestes pour une question qu'on se
            pose en regardant le détail.

            ⚠️ C'est un LIEN, pas un bouton à `onClick` : il s'ouvre dans un nouvel onglet au clic du milieu,
            se copie, et se partage. Un `router.push` perdrait les trois.
          */}
          <Link
            href={`/dashboard/funnel?campagne=${encodeURIComponent(detail.id)}`}
            data-testid="campagne-voir-funnel"
            className={classesBouton('secondaire', 'petite')}
          >
            {t('Voir les résultats', 'See results')}
          </Link>
          <button onClick={onClose} className="text-xs text-ink-400 hover:text-ink-900">{t('Fermer', 'Close')}</button>
        </div>
      </div>
      {/* ⚠️ `?? []` N'EST PAS DE LA PRUDENCE DÉCORATIVE : le front part sur Vercel au push et l'API sur le
          VPS plus tard, donc pendant cette fenêtre un écran NEUF interroge une API qui ne rend pas encore
          `chaine`. Sans ce repli, le panneau de détail entier tombait. */}
      <CeQuiAEteLance chaine={detail.chaine ?? []} />
      {detail.recipients.length === 0 ? (
        <p className="px-4 py-4 text-sm text-ink-500">{t('Aucun destinataire.', 'No recipients.')}</p>
      ) : (
        <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-ink-50 text-left text-xs text-ink-500">
            <tr>
              <th className="px-4 py-2 font-medium">{t('Destinataire', 'Recipient')}</th>
              <th className="px-4 py-2 font-medium">{t('Envoi', 'Sending')}</th>
              <th className="px-4 py-2 font-medium">{t('Envoyé le', 'Sent on')}</th>
              <th className="px-4 py-2 font-medium">{t('Livraison', 'Delivery')}</th>
              <th className="px-4 py-2 font-medium">{t('Détail', 'Detail')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {detail.recipients.map((r) => {
              const retryable = r.status === 'failed' && r.errorCode !== null && RETRYABLE_VAR_CODES.has(r.errorCode);
              return [
                <tr key={r.id}>
                  <td className="px-4 py-2 font-mono text-xs">{r.toE164}</td>
                  <td className="px-4 py-2"><Badge status={r.status} /></td>
                  <td className="px-4 py-2 whitespace-nowrap text-xs text-ink-500">{r.sentAt ? stamp(r.sentAt) : <span className="text-ink-400">{t('non envoyé', 'not sent')}</span>}</td>
                  <td className="px-4 py-2">{r.deliveryStatus ? <Badge status={r.deliveryStatus} /> : <span className="text-xs text-ink-400">-</span>}</td>
                  <td className="px-4 py-2 text-xs text-ink-500" title={r.deliveryError ?? r.error ?? undefined}>
                    <div>{explainMetaError(r.deliveryError ?? r.error, locale) ?? r.messageId ?? '-'}</div>
                    {retryable && retryFor !== r.id && (
                      <button
                        type="button"
                        onClick={() => openRetry(r.id)}
                        data-testid={`retry-${r.id}`}
                        className="mt-1 rounded-md border border-brand-200 px-2 py-0.5 text-xs font-medium text-brand-700 transition-colors duration-150 hover:bg-brand-50"
                      >
                        {/* Sans variable de champ à corriger, il n'y a RIEN à corriger : promettre l'inverse
                            envoie chercher une faute de saisie qui n'existe pas (cas d'un template dont
                            l'en-tête média manquait à l'envoi). Le renvoi, lui, reste utile : il repart avec
                            l'envoi corrigé, ou avec un contact mis à jour ailleurs. */}
                        {fieldKeys.length === 0 ? t('Renvoyer', 'Resend') : t('Corriger + renvoyer', 'Fix + resend')}
                      </button>
                    )}
                    {msg?.rid === r.id && (
                      <p className={`mt-1 ${msg.ok ? 'text-succes-700' : 'text-danger-600'}`}>{msg.text}</p>
                    )}
                  </td>
                </tr>,
                retryFor === r.id ? (
                  <tr key={`${r.id}-form`} className="bg-ink-50/60">
                    <td colSpan={5} className="px-4 py-3">
                      <p className="mb-2 text-xs text-ink-500">
                        {t("Corrige la ou les variables de template, puis renvoie ce message. La valeur est enregistrée sur le contact.", 'Fix the template variable(s), then resend this message. The value is saved on the contact.')}
                      </p>
                      {fieldKeys.length === 0 ? (
                        <p className="mb-2 text-xs text-ink-500">{t('Aucune variable de champ à corriger : renvoi tel quel (le contact a peut-être été mis à jour ailleurs).', 'No field variable to fix: resend as-is (the contact may have been updated elsewhere).')}</p>
                      ) : (
                        <div className="mb-2 flex flex-wrap gap-2">
                          {fieldKeys.map((k) => (
                            <label key={k} className="text-xs text-ink-900">
                              <span className="mr-1 font-medium">{k}</span>
                              <input
                                value={vals[k] ?? ''}
                                onChange={(e) => setVals((v) => ({ ...v, [k]: e.target.value }))}
                                data-testid={`retry-field-${k}`}
                                placeholder={t('nouvelle valeur', 'new value')}
                                className="rounded border border-ink-300 px-2 py-1 text-sm outline-none focus:border-brand-500"
                              />
                            </label>
                          ))}
                        </div>
                      )}
                      <div className="flex gap-2">
                        <Bouton taille="petite" enCours={busy}
                          type="button"
                          onClick={() => void submitRetry(r)}
                          disabled={busy}
                          data-testid={`retry-submit-${r.id}`}
                        >
                          {busy ? t('Renvoi...', 'Resending...') : t('Renvoyer', 'Resend')}
                        </Bouton>
                        <Bouton variante="secondaire" taille="petite"
                          type="button"
                          onClick={() => { setRetryFor(null); setMsg(null); }}
                        >
                          {t('Annuler', 'Cancel')}
                        </Bouton>
                      </div>
                    </td>
                  </tr>
                ) : null,
              ];
            })}
          </tbody>
        </table>
        </div>
      )}
    </div>
  );
}

/**
 * CE QUI A ÉTÉ LANCÉ : la chaîne telle qu'elle est partie, étage par étage.
 *
 * 🔴 DEMANDÉ PAR JULIEN LE 2026-09-14 : « un truc en termes d'UX qui me gêne, c'est qu'on ne retrouve pas
 * les détails de comment est foutue une campagne une fois qu'on l'a lancée ; on doit pouvoir savoir quel
 * message on a lancé, ou quel scénario, s'il y a un fallback quel message ou quel scénario ». Le panneau
 * ne montrait que des compteurs et des destinataires : la première question qu'on se pose devant un
 * résultat n'avait aucune réponse à l'écran.
 *
 * ⚠️ IL NOMME, IL NE RÉSOUT PAS. Le nom du template est celui qui a été envoyé (colonne de l'étage), et
 * l'identifiant d'un scénario s'affiche tel quel : aller chercher son libellé demanderait un appel par
 * étage, pour une information que l'écran des scénarios donne déjà. Ce qui compte ici est de pouvoir dire
 * « c'est bien CE message qui est parti, et CE scénario derrière ».
 */
function CeQuiAEteLance({ chaine }: { chaine: CampaignDetail['chaine'] }) {
  const t = useT();
  // ⚠️ Vide = campagne d'avant la migration 0134, ou API pas encore déployée : on n'affiche RIEN plutôt
  // qu'un cadre sans contenu, et surtout on ne tombe pas.
  if (!chaine || chaine.length === 0) return null;

  const canal = (c: string) => (c === 'whatsapp' ? 'WhatsApp' : c === 'rcs' ? 'RCS' : t('E-mail', 'Email'));
  const devenir = (d?: string) => (d === 'inbox'
    ? t('les réponses reviennent à l’équipe', 'replies come back to the team')
    : d === 'mba'
      ? t('l’agent de Meta répond', 'Meta’s agent replies')
      : null);

  return (
    <div className="border-b border-ink-100 px-4 py-3">
      <p className="text-xs font-medium text-ink-500">{t('Ce qui a été lancé', 'What was launched')}</p>
      <ul className="mt-2 space-y-1.5">
        {chaine.map((e) => {
          const suite = devenir(e.devenir);
          return (
            <li key={e.rang} className="text-sm text-ink-900">
              <span className="font-medium">
                {chaine.length > 1 ? `${t('Étage', 'Stage')} ${e.rang} · ` : ''}{canal(e.canal)}
              </span>
              {' : '}
              {/*
                🔴 UN ÉTAGE À SCÉNARIO N'A PAS DE « CONTENU INCONNU », LE SCÉNARIO EST LE CONTENU (constaté
                par Julien le 2026-09-15). Une campagne « modèle + scénario » ne stocke AUCUN nom de modèle
                dans `campaign_etages` : le modèle est le premier bloc du parcours. L'écran annonçait donc
                « contenu inconnu · puis le scénario », c'est-à-dire un aveu d'ignorance juste à côté de la
                réponse.
              */}
              {e.templateName
                ? <span className="font-mono text-xs">{e.templateName}{e.templateLanguage ? ` (${e.templateLanguage})` : ''}</span>
                : e.rcsMessage
                  ? t('message RCS', 'RCS message')
                  : e.emailTemplateId
                    ? t('modèle d’e-mail', 'email template')
                    : e.workflowId
                      ? t('le scénario', 'the scenario')
                      : t('contenu inconnu', 'unknown content')}
              {e.workflowId && (
                <span className="text-ink-500">
                  {' '}{e.templateName || e.rcsMessage || e.emailTemplateId ? `· ${t('puis le scénario', 'then scenario')} ` : ''}
                  {/* 🔴 LE NOM, PAS LE CODE. « 40f4a189 » ne désigne rien pour qui a écrit le parcours. Le nom
                      vient d'une jointure à la LECTURE : il suit les renommages, et il manque seulement si le
                      scénario a été supprimé depuis, auquel cas l'identifiant reste le seul repère vrai. */}
                  <span className={e.workflowName ? 'font-medium' : 'font-mono text-xs'}>
                    {e.workflowName ? `« ${e.workflowName} »` : e.workflowId.slice(0, 8)}
                  </span>
                  {!e.workflowName && <span className="text-ink-400">{' '}({t('supprimé', 'deleted')})</span>}
                </span>
              )}
              {/* ⚠️ Le devenir n'est affiché QUE s'il a été réglé : une campagne d'avant le câblage n'en a
                  pas, et en inventer un dirait ce qui ne s'est pas passé. */}
              {!e.workflowId && suite && <span className="text-ink-500">{' '}· {suite}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
