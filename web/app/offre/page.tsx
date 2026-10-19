'use client';

import { useState } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/AppShell';
import { IntroPage, TitrePage } from '@/components/TitrePage';
import { Squelette } from '@/components/Squelette';
import { Icone } from '@/components/Icone';
import { Bouton, classesBouton } from '@/components/Bouton';
import { useConfirmation } from '@/components/Confirmation';
import type { Session } from '@/lib/session';
import { useT } from '@/lib/i18n';
import { oublierOffre, useOffre } from '@/lib/use-offre';
import { changerSieges, payerPro, portailPro, rendreNumero } from '@/lib/api/offre';
import { ApiError, erreurDeChargement } from '@/lib/http';
import {
  FONCTIONS_OFFRE, NOMS_OFFRES, libelleFonction, nomDeLOffre, offreQuiOuvre,
  type FonctionOffre, type LimitesOffre, type NomOffre,
} from '@/lib/offre';

/**
 * L'OFFRE DE L'ESPACE (lot 6, tâche 7) : ce que l'espace consomme de ses limites, la grille des trois offres, et
 * « Passer en Pro ». Réservée aux administrateurs, comme le reste de Paramètres : en Pro ou en Entreprise, un agent ou un
 * manager ne déclenche aucun refus d'offre, et une Base n'a qu'un administrateur. La ROUTE, elle, se lit par tout membre :
 * la coquille en grise les menus de chacun.
 *
 * 🔴 LA GRILLE N'EST PAS RECOPIÉE ICI : elle arrive avec la vue de l'offre (`GET /tenants/:tenantId/offre`), lue dans la
 * seule définition du serveur (`src/offres/offres.ts`).
 *
 * Le Pro se paie sur la page de Stripe (livraison B1) : « Mensuel » ou « Annuel », aux prix que porte la vue. Tant qu'il
 * n'est pas en vente (`prixPro` nul : prix Stripe pas posés, ou API plus ancienne), « Passer en Pro » mène au Support,
 * sujet prérempli. Un Pro gère son abonnement au portail de Stripe.
 */
export default function OffrePage() {
  return <AppShell active="offre">{(session) => <OffreInner session={session} />}</AppShell>;
}

/** La fonction qui a mené ici, depuis un menu grisé (`/offre?fonction=inbox`). Lue après le montage de la coquille. */
function fonctionDemandee(): FonctionOffre | null {
  if (typeof window === 'undefined') return null;
  const f = new URLSearchParams(window.location.search).get('fonction');
  return (FONCTIONS_OFFRE as readonly string[]).includes(f ?? '') ? (f as FonctionOffre) : null;
}

/** Les limites montrées dans la grille, dans cet ordre. Les webhooks sortants y entrent avec leur écran (lot 12). */
const LIGNES_LIMITES = [
  'utilisateurs', 'contacts', 'envoisModelesMois', 'automations', 'adressesWebhook', 'journalWebhooksJours',
  'stockageOctets', 'conservationJours', 'commissionPct', 'numeroInclus', 'badge',
] as const satisfies ReadonlyArray<keyof LimitesOffre>;

/**
 * Le retour de la page de Stripe (`/offre?pro=recu` ou `?pro=abandon`). Un paiement reçu oublie l'offre gardée par la
 * console : le webhook la fait passer en Pro, et la page doit la relire au lieu de servir la Base d'il y a une minute.
 */
function retourDeStripe(): 'recu' | 'abandon' | null {
  if (typeof window === 'undefined') return null;
  const r = new URLSearchParams(window.location.search).get('pro');
  if (r === 'recu') oublierOffre();
  return r === 'recu' || r === 'abandon' ? r : null;
}

/** Un prix en euros, sans centimes quand il n'en a pas (« 49 € », « 490 € »). */
const euros = (centimes: number): string => `${(centimes / 100).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} €`;

function OffreInner({ session }: { session: Session }) {
  const t = useT();
  // Avant `useOffre` : le retour d'un paiement oublie l'offre gardée, que la lecture qui suit refait donc.
  const [retour] = useState(retourDeStripe);
  const vue = useOffre(session.tenantId);
  const [demandee] = useState(fonctionDemandee);
  const [paiement, setPaiement] = useState<'mois' | 'an' | 'portail' | null>(null);
  const [erreurPaiement, setErreurPaiement] = useState<string | null>(null);
  const [proIndisponible, setProIndisponible] = useState(false);
  /** Le choix « rendre le numéro » fait sur cette page (lot 6, B2b) : `null` = celui de la vue. */
  const [rendreChoisi, setRendreChoisi] = useState<boolean | null>(null);
  const [rendreEnCours, setRendreEnCours] = useState(false);
  const [erreurRendre, setErreurRendre] = useState<string | null>(null);
  /** Les sièges après un retrait fait sur cette page (spec offres v2, livraison 7) : `null` = ceux de la vue. */
  const [achetesChoisis, setAchetesChoisis] = useState<number | null>(null);
  const confirmer = useConfirmation();
  const [retraitEnCours, setRetraitEnCours] = useState(false);
  const [erreurSieges, setErreurSieges] = useState<string | null>(null);

  /**
   * Retirer un utilisateur payé : confirmé d'abord (aucun remboursement, et le reprendre refacture un prorata) ; refusé tant
   * que les membres actifs ne tiennent pas dans le reste.
   */
  async function retirerUnSiege(achetes: number): Promise<void> {
    const ok = await confirmer({
      titre: t('Retirer un utilisateur payé', 'Remove a paid user'),
      message: t('La période en cours n’est pas remboursée, et reprendre cet utilisateur plus tard facturera de nouveau un prorata.',
        'The current period is not refunded, and taking this user back later charges a prorated amount again.'),
      confirmer: t('Retirer', 'Remove'),
    });
    if (!ok) return;
    setRetraitEnCours(true);
    setErreurSieges(null);
    try {
      setAchetesChoisis((await changerSieges(session.tenantId, achetes, achetes - 1)).sieges);
      oublierOffre();
    } catch (err) {
      setErreurSieges(erreurDeChargement(err, t));
    } finally {
      setRetraitEnCours(false);
    }
  }

  /** Rendre le numéro fourni à la fin du Pro, ou le garder. */
  async function choisirRendre(rendre: boolean): Promise<void> {
    setRendreEnCours(true);
    setErreurRendre(null);
    try {
      setRendreChoisi((await rendreNumero(session.tenantId, rendre)).rendreNumero);
    } catch (err) {
      setErreurRendre(erreurDeChargement(err, t));
    } finally {
      setRendreEnCours(false);
    }
  }

  /** Le paiement ou le portail : la console redirige vers l'adresse de Stripe que l'API rend. */
  async function ouvrirStripe(geste: 'mois' | 'an' | 'portail'): Promise<void> {
    setPaiement(geste);
    setErreurPaiement(null);
    try {
      const r = geste === 'portail' ? await portailPro(session.tenantId) : await payerPro(session.tenantId, geste);
      window.location.assign(r.url);
    } catch (err) {
      setPaiement(null);
      // Une API qui n'a pas encore la route (404), ou un Pro pas encore en vente (503) : le Support, comme avant. Le portail
      // n'a pas de repli, son refus se dit.
      if (geste !== 'portail' && err instanceof ApiError && (err.status === 404 || err.status === 503)) {
        setProIndisponible(true);
        return;
      }
      setErreurPaiement(erreurDeChargement(err, t));
    }
  }

  const libelleLimite = (k: (typeof LIGNES_LIMITES)[number]): string => ({
    utilisateurs: t('Utilisateurs', 'Users'),
    contacts: t('Contacts créés', 'Contacts created'),
    envoisModelesMois: t('Modèles envoyés par mois', 'Templates sent per month'),
    automations: t('Automations allumées', 'Active automations'),
    adressesWebhook: t('Adresses de webhook sortant actives', 'Active outgoing webhook addresses'),
    journalWebhooksJours: t('Journal des webhooks sortants', 'Outgoing webhook log'),
    stockageOctets: t('Fichiers de la médiathèque', 'Media library files'),
    conservationJours: t('Conservation des conversations', 'Conversation retention'),
    commissionPct: t('Commission sur le crédit IA', 'Commission on AI credit'),
    numeroInclus: t('Numéro WhatsApp inclus', 'WhatsApp number included'),
    badge: t('Mention « Messaging Me » sur le widget', '“Messaging Me” mention on the widget'),
  })[k];

  const valeurLimite = (l: LimitesOffre, k: (typeof LIGNES_LIMITES)[number]): string => {
    const v = l[k];
    if (typeof v === 'boolean') return v ? t('Oui', 'Yes') : t('Non', 'No');
    if (v === undefined) return '';
    if (v === null) return t('Sans limite', 'Unlimited');
    if (k === 'stockageOctets') return v === 0 ? t('Aucun', 'None') : `${Math.round(v / (1024 * 1024))} Mo`;
    if (k === 'conservationJours') return v === 0 ? t('Sans limite', 'Unlimited') : t(`${v} jours`, `${v} days`);
    if (k === 'journalWebhooksJours') return t(`${v} jours`, `${v} days`);
    if (k === 'commissionPct') return `${v} %`;
    return v.toLocaleString('fr-FR');
  };

  if (vue === undefined) {
    return <div className="mx-auto max-w-liste space-y-4"><Squelette forme="carte" /></div>;
  }
  if (vue === null) {
    return (
      <div className="mx-auto max-w-liste space-y-4">
        <TitrePage>{t('Offre', 'Plan')}</TitrePage>
        <p className="text-sm text-ink-500" data-testid="offre-inconnue">
          {t('L’offre de cet espace n’est pas encore disponible. Réessayez dans quelques minutes.', 'This workspace’s plan is not available yet. Try again in a few minutes.')}
        </p>
      </div>
    );
  }

  const suivante: NomOffre | null = vue.offre === 'free' ? 'pro' : vue.offre === 'pro' ? 'entreprise' : null;
  const offreDemandee = demandee ? offreQuiOuvre(vue, demandee) : null;
  const jauges: Array<{ cle: string; libelle: string; utilise: number | null; max: number | null; note?: string }> = [
    { cle: 'contacts', libelle: t('Contacts créés', 'Contacts created'), utilise: vue.usage.contacts, max: vue.limites.contacts,
      note: t('Un contact qui vous écrit le premier n’est jamais compté.', 'A contact who writes to you first is never counted.') },
    { cle: 'modeles', libelle: t('Modèles envoyés ce mois-ci', 'Templates sent this month'), utilise: vue.usage.envoisModelesMois, max: vue.limites.envoisModelesMois,
      note: t('Les réponses dans les 24 h qui suivent un message du client ne sont jamais comptées.', 'Replies within 24 hours of a customer message are never counted.') },
    { cle: 'automations', libelle: t('Automations allumées', 'Active automations'), utilise: vue.usage.automations, max: vue.limites.automations },
    { cle: 'membres', libelle: t('Utilisateurs', 'Users'), utilise: vue.usage.membres, max: vue.limites.utilisateurs },
  ];

  return (
    <div className="mx-auto max-w-liste space-y-6">
      <div>
        <TitrePage>{t('Offre', 'Plan')}</TitrePage>
        <IntroPage>
          {t('Votre espace est en offre', 'Your workspace is on the')}{' '}
          <strong className="font-semibold text-ink-900" data-testid="offre-actuelle">{nomDeLOffre(vue.offre, t)}</strong>
          {t('.', ' plan.')}
        </IntroPage>
        {retour === 'recu' && (
          <p className="mt-3 rounded-carte border border-succes-200 bg-succes-50 px-4 py-3 text-sm text-succes-700" data-testid="offre-paiement-recu">
            {t('Paiement reçu : votre espace passe en Pro dans quelques instants. Rechargez la page si la grille ne l’indique pas encore.',
              'Payment received: your workspace moves to Pro in a few moments. Reload the page if the grid does not show it yet.')}
          </p>
        )}
        {retour === 'abandon' && (
          <p className="mt-3 text-sm text-ink-500" data-testid="offre-paiement-abandon">
            {t('Paiement abandonné : rien n’a été débité.', 'Payment cancelled: nothing was charged.')}
          </p>
        )}
      </div>

      {demandee && offreDemandee && offreDemandee !== vue.offre && (
        <p className="rounded-carte border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-700" data-testid="offre-raison">
          {t(`« ${libelleFonction(demandee, t)} » fait partie de l’offre ${nomDeLOffre(offreDemandee, t)}.`,
            `“${libelleFonction(demandee, t)}” is part of the ${nomDeLOffre(offreDemandee, t)} plan.`)}
        </p>
      )}

      <section className="rounded-carte border border-ink-200 bg-white p-5" data-testid="offre-usage">
        <h2 className="text-sm font-semibold text-ink-900">{t('Ce que votre espace consomme', 'What your workspace uses')}</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {jauges.map((j) => {
            const plein = j.max !== null && j.utilise !== null && j.utilise >= j.max;
            return (
              <div key={j.cle} data-testid={`offre-usage-${j.cle}`}>
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="text-ink-500">{j.libelle}</span>
                  <span className={`tabular-nums font-medium ${plein ? 'text-danger' : 'text-ink-900'}`}>
                    {j.max === null
                      ? t('Sans limite', 'Unlimited')
                      : `${(j.utilise ?? 0).toLocaleString('fr-FR')} / ${j.max.toLocaleString('fr-FR')}`}
                  </span>
                </div>
                {j.max !== null && (
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-ink-100">
                    <div className={`h-full rounded-full ${plein ? 'bg-danger' : 'bg-brand-500'}`} style={{ width: `${Math.min(100, Math.round(((j.utilise ?? 0) / Math.max(1, j.max)) * 100))}%` }} />
                  </div>
                )}
                {j.note && j.max !== null && <p className="mt-1 text-xs text-ink-400">{j.note}</p>}
              </div>
            );
          })}
        </div>
      </section>

      {suivante && (
        <section className="flex flex-wrap items-center gap-3 rounded-carte border border-ink-200 bg-white p-5" data-testid="offre-passer">
          <p className="min-w-0 flex-1 text-sm text-ink-500">
            {/* Les arguments du Pro resserré (spec offres v2, livraison 5) : ses contacts se lisent dans la grille du serveur, qui
                peut encore les dire sans limite (une API plus ancienne que la console). */}
            {suivante === 'pro'
              ? (vue.grille.pro.limites.contacts != null
                ? t(`Le Pro ouvre la console complète (l’Inbox, les scénarios, les statistiques, l’agent de Meta), crée jusqu’à ${valeurLimite(vue.grille.pro.limites, 'contacts')} contacts et lève les limites d’envois et d’automations.`,
                  `Pro unlocks the full console (the Inbox, scenarios, statistics, the Meta agent), creates up to ${valeurLimite(vue.grille.pro.limites, 'contacts')} contacts and lifts the sending and automation limits.`)
                : t('Le Pro ouvre la console complète (l’Inbox, les scénarios, les statistiques, l’agent de Meta) et lève les limites de contacts, d’envois et d’automations.',
                  'Pro unlocks the full console (the Inbox, scenarios, statistics, the Meta agent) and lifts the contact, sending and automation limits.'))
              : t('L’Entreprise ajoute l’analyse des conversations, les publicités et les chaînes WhatsApp, le RCS, les connecteurs CRM, le Performance Lab et une équipe à votre mesure, sur devis.',
                'Enterprise adds conversation analysis, WhatsApp ads and channels, RCS, CRM connectors, the Performance Lab and a team sized for you, on quote.')}
          </p>
          {suivante === 'pro' && retour === 'recu' ? null : suivante === 'pro' && vue.prixPro && !proIndisponible ? (
            // Le Pro se paie sur la page de Stripe (lot 6, B1) ; le webhook signé, et lui seul, ouvre les fonctions.
            <>
            <div className="flex flex-wrap items-center gap-2">
              <Bouton onClick={() => void ouvrirStripe('mois')} enCours={paiement === 'mois'} disabled={paiement !== null} data-testid="offre-payer-mois">
                {t(`Mensuel, ${euros(vue.prixPro.moisCentimes)} HT`, `Monthly, ${euros(vue.prixPro.moisCentimes)} excl. VAT`)}
              </Bouton>
              <Bouton variante="secondaire" onClick={() => void ouvrirStripe('an')} enCours={paiement === 'an'} disabled={paiement !== null} data-testid="offre-payer-an">
                {t(`Annuel, ${euros(vue.prixPro.anCentimes)} HT`, `Yearly, ${euros(vue.prixPro.anCentimes)} excl. VAT`)}
              </Bouton>
            </div>
            {/* L'essai de 14 jours (spec offres v2), une fois par espace : la carte est demandée, rien n'est prélevé avant sa fin. */}
            {vue.essai?.possible && (
              <p className="w-full text-sm text-ink-700" data-testid="offre-essai">
                {t(`Essai gratuit de ${vue.essai.jours} jours : la carte est demandée sur la page de Stripe, et rien n’est prélevé avant la fin de l’essai.`,
                  `${vue.essai.jours}-day free trial: the card is entered on the Stripe page, and nothing is charged before the trial ends.`)}
              </p>
            )}
            {/* Depuis la livraison B2b, le numéro fourni est inclus : son abonnement à part s'arrête, avec un avoir, au premier
                paiement du Pro (après l'essai, s'il y en a un). */}
            {/* Les sièges (livraison 7) : 3 utilisateurs inclus, puis un prix par utilisateur, dans la formule du Pro. */}
            {vue.prixSiege && vue.grille.pro.limites.utilisateurs !== null && (
              <p className="w-full text-xs text-ink-500" data-testid="offre-sieges-prix">
                {t(`Le Pro comprend ${vue.grille.pro.limites.utilisateurs} utilisateurs ; chaque utilisateur en plus coûte ${euros(vue.prixSiege.moisCentimes)} HT par mois (${euros(vue.prixSiege.anCentimes)} HT par an avec le Pro annuel).`,
                  `Pro includes ${vue.grille.pro.limites.utilisateurs} users; each extra user costs ${euros(vue.prixSiege.moisCentimes)} excl. VAT a month (${euros(vue.prixSiege.anCentimes)} excl. VAT a year with yearly Pro).`)}
              </p>
            )}
            <p className="w-full text-xs text-ink-500" data-testid="offre-numero-inclus">
              {t('Le numéro WhatsApp que nous vous fournissons est inclus dans le Pro : s’il est déjà payé à part, cet abonnement s’arrête au premier paiement du Pro, avec un avoir.',
                'The WhatsApp number we provide is included in Pro: if it is already paid separately, that subscription stops at the first Pro payment, with a credit.')}
            </p>
            </>
          ) : (
            // Pas encore en vente (API plus ancienne, prix pas posés), ou l'Entreprise : le Support, sujet prérempli.
            <Link href={`/support?sujet=${suivante}`} className={classesBouton('principal')} data-testid={`offre-passer-${suivante}`}>
              {suivante === 'pro' ? t('Passer en Pro', 'Upgrade to Pro') : t('Nous contacter', 'Contact us')}
            </Link>
          )}
          {erreurPaiement && vue.offre !== 'pro' && <p className="w-full text-sm text-danger" data-testid="offre-paiement-erreur">{erreurPaiement}</p>}
        </section>
      )}

      {vue.offre === 'pro' && vue.suiteDuNumero && (() => {
        // La suite du numéro fourni (lot 6, B2b) : inclus tant que le Pro court ; à sa fin prévue, 3,50 € HT par mois sur
        // la même carte, ou rendu si l'administrateur l'a choisi (réversible tant que le Pro court).
        const fin = vue.suiteDuNumero.finPrevueLe;
        const rendre = rendreChoisi ?? vue.suiteDuNumero.rendreNumero;
        const date = fin === null ? '' : new Date(fin).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
        return (
          <section className="flex flex-wrap items-center gap-3 rounded-carte border border-ink-200 bg-white p-5" data-testid="offre-suite-numero">
            <p className="min-w-0 flex-1 text-sm text-ink-500">
              {fin === null
                ? t('Votre numéro WhatsApp fourni est inclus dans votre Pro.', 'Your provided WhatsApp number is included in your Pro plan.')
                : rendre
                  ? t(`Votre Pro se termine le ${date}, et votre numéro WhatsApp fourni sera alors rendu : ses envois seront coupés, puis il sera libéré 7 jours après.`,
                    `Your Pro plan ends on ${date}, and your provided WhatsApp number will then be given back: its sending stops, and it is released 7 days later.`)
                  : t(`Votre Pro se termine le ${date}. Votre numéro WhatsApp fourni passera alors à 3,50 € HT par mois, sur la même carte.`,
                    `Your Pro plan ends on ${date}. Your provided WhatsApp number will then cost €3.50 excl. VAT a month, on the same card.`)}
            </p>
            {fin !== null && (rendre ? (
              <Bouton variante="secondaire" onClick={() => void choisirRendre(false)} enCours={rendreEnCours} disabled={rendreEnCours} data-testid="offre-garder-numero">
                {t('Garder mon numéro', 'Keep my number')}
              </Bouton>
            ) : (
              <Bouton variante="secondaire" onClick={() => void choisirRendre(true)} enCours={rendreEnCours} disabled={rendreEnCours} data-testid="offre-rendre-numero">
                {t('Rendre mon numéro à la fin du Pro', 'Give back my number when Pro ends')}
              </Bouton>
            ))}
            {erreurRendre && <p className="w-full text-sm text-danger" data-testid="offre-rendre-erreur">{erreurRendre}</p>}
          </section>
        );
      })()}

      {vue.offre === 'pro' && vue.sieges && (() => {
        // Les utilisateurs du Pro (livraison 7) : les 3 inclus, ceux achetés en plus, le prix du suivant. Un utilisateur
        // s'ajoute en invitant un membre (le prix est dit à ce moment) ; un utilisateur payé se retire ici, sans remboursement.
        const achetes = achetesChoisis ?? vue.sieges.achetes;
        const prix = vue.prixSiege ? (vue.sieges.periodicite === 'an' ? vue.prixSiege.anCentimes : vue.prixSiege.moisCentimes) : null;
        return (
          <section className="flex flex-wrap items-center gap-3 rounded-carte border border-ink-200 bg-white p-5" data-testid="offre-sieges">
            <p className="min-w-0 flex-1 text-sm text-ink-500">
              {achetes === 0
                ? t(`Votre Pro comprend ${vue.sieges.inclus} utilisateurs.`, `Your Pro plan includes ${vue.sieges.inclus} users.`)
                : t(`Votre Pro comprend ${vue.sieges.inclus} utilisateurs, et ${achetes} utilisateur${achetes > 1 ? 's' : ''} payé${achetes > 1 ? 's' : ''} en plus.`,
                  `Your Pro plan includes ${vue.sieges.inclus} users, and ${achetes} paid extra user${achetes > 1 ? 's' : ''}.`)}
              {prix !== null && (vue.sieges.periodicite === 'an'
                ? t(` Un utilisateur de plus : ${euros(prix)} HT par an, proposé quand vous invitez un membre au-delà.`, ` One more user: ${euros(prix)} excl. VAT a year, offered when you invite a member beyond that.`)
                : t(` Un utilisateur de plus : ${euros(prix)} HT par mois, proposé quand vous invitez un membre au-delà.`, ` One more user: ${euros(prix)} excl. VAT a month, offered when you invite a member beyond that.`))}
            </p>
            {achetes > 0 && (
              <Bouton variante="secondaire" onClick={() => void retirerUnSiege(achetes)} enCours={retraitEnCours} disabled={retraitEnCours} data-testid="offre-retirer-siege">
                {t('Retirer un utilisateur payé', 'Remove a paid user')}
              </Bouton>
            )}
            {achetes > 0 && (
              <p className="w-full text-xs text-ink-400">
                {t('Un retrait ne rembourse pas la période en cours. Désactivez d’abord le membre en trop dans « Compte & équipe ».',
                  'A removal does not refund the current period. First deactivate the extra member in “Account & team”.')}
              </p>
            )}
            {erreurSieges && <p className="w-full text-sm text-danger" data-testid="offre-sieges-erreur">{erreurSieges}</p>}
          </section>
        );
      })()}

      {vue.offre === 'pro' && (
        <section className="flex flex-wrap items-center gap-3 rounded-carte border border-ink-200 bg-white p-5" data-testid="offre-abonnement">
          {vue.essai?.finLe && (
            <p className="w-full text-sm text-ink-700" data-testid="offre-essai-fin">
              {t(`Votre essai du Pro se termine le ${new Date(vue.essai.finLe).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })} : sans résiliation, le premier paiement a lieu ce jour-là.`,
                `Your Pro trial ends on ${new Date(vue.essai.finLe).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}: unless you cancel, the first payment happens that day.`)}
            </p>
          )}
          <p className="min-w-0 flex-1 text-sm text-ink-500">
            {t('Changer de carte, retrouver vos factures ou résilier : tout se fait sur la page de Stripe.',
              'Change your card, find your invoices or cancel: it all happens on the Stripe page.')}
          </p>
          <Bouton variante="secondaire" onClick={() => void ouvrirStripe('portail')} enCours={paiement === 'portail'} disabled={paiement !== null} data-testid="offre-portail">
            {t('Gérer mon abonnement', 'Manage my subscription')}
          </Bouton>
          {erreurPaiement && <p className="w-full text-sm text-danger" data-testid="offre-paiement-erreur">{erreurPaiement}</p>}
        </section>
      )}

      <section className="overflow-x-auto rounded-carte border border-ink-200 bg-white" data-testid="offre-grille">
        <table className="w-full min-w-[34rem] text-sm">
          <thead>
            <tr className="border-b border-ink-100 text-left">
              <th className="px-4 py-3 font-medium text-ink-500" />
              {NOMS_OFFRES.map((o) => (
                <th key={o} className={`px-4 py-3 text-center font-semibold ${o === vue.offre ? 'bg-brand-50 text-brand-700' : 'text-ink-900'}`} data-testid={`offre-colonne-${o}`}>
                  {nomDeLOffre(o, t)}
                  {o === vue.offre && <span className="ml-1.5 text-xs font-medium">{t('(la vôtre)', '(yours)')}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {FONCTIONS_OFFRE.map((f) => (
              <tr key={f} className="border-b border-ink-100 last:border-0">
                <td className="px-4 py-2 text-ink-900">{libelleFonction(f, t)}</td>
                {NOMS_OFFRES.map((o) => (
                  <td key={o} className={`px-4 py-2 text-center ${o === vue.offre ? 'bg-brand-50' : ''}`}>
                    {vue.grille[o].fonctions.has(f)
                      ? <Icone nom="valide" taille="ligne" className="inline text-succes" titre={t('Inclus', 'Included')} />
                      : <Icone nom="cadenas" taille="ligne" className="inline text-ink-300" titre={t('Non inclus', 'Not included')} />}
                  </td>
                ))}
              </tr>
            ))}
            {LIGNES_LIMITES.filter((k) => vue.grille.free.limites[k] !== undefined).map((k) => (
              <tr key={k} className="border-b border-ink-100 last:border-0">
                <td className="px-4 py-2 text-ink-900">{libelleLimite(k)}</td>
                {NOMS_OFFRES.map((o) => (
                  <td key={o} className={`px-4 py-2 text-center tabular-nums text-ink-700 ${o === vue.offre ? 'bg-brand-50' : ''}`}>
                    {valeurLimite(vue.grille[o].limites, k)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
