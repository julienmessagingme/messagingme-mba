'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { getSoldeAgent } from '@/lib/api-agent';
import {
  aUneFacture, achatArriveDepuis, estPageDePaiement, getMouvementsCredit, lireDepartPaiement, oublierDepartPaiement,
  ouvrirFacture, ouvrirPaiement, retenirDepartPaiement, seuilDuRetour, type LigneCredit, type OffreRecharge,
} from '@/lib/api-credit';
import { eurosDepuisMicro, SOLDE_BAS_MICRO_EUR } from '@/lib/agent-solde';
import { erreurDeChargement } from '@/lib/http';
import { fmtCost } from '@/lib/format';
import type { Locale } from '@/lib/locale';
import type { Session } from '@/lib/session';
import { useT, useLocale } from '@/lib/i18n';
import { IntroPage, TitrePage } from '@/components/TitrePage';
import { Squelette } from '@/components/Squelette';
import { Bouton } from '@/components/Bouton';
import { MbaNotice } from '@/components/MbaNotice';

/**
 * LE CRÉDIT IA DE L'ESPACE : ce qu'il reste, comment recharger, et ce qui l'a fait bouger.
 *
 * 🔴 LE SOLDE EST CELUI DE L'ESPACE, pas d'un agent : les agents IA ET la traduction de l'Inbox y puisent. C'est
 * pour ça que la page vit dans Paramètres (2026-09-29, décision de Julien) et plus sous « Other AI agent ».
 *
 * 🔴 LE RETOUR DE STRIPE NE CRÉDITE RIEN. Il dit « paiement reçu » et RELIT le solde, quelques secondes, le temps
 * que le webhook signé de Stripe passe. Une adresse de retour se tape à la main, une signature ne se forge pas.
 *
 * ⚠️ LA CONSOLE PART AVANT L'API (Vercel publie au push). Tant que la route de paiement n'est pas déployée, ou que
 * Stripe n'est pas configuré, le serveur rend 404 ou 503 : l'écran dit « recharge pas encore disponible », jamais
 * une erreur brute.
 */
export default function CreditPage() {
  return <AppShell active="parametres-credit">{(session) => <CreditInner session={session} />}</AppShell>;
}

/** Après un retour de paiement : combien de fois, et tous les combien, on relit le solde en attendant le webhook. */
const RELECTURES_APRES_PAIEMENT = 10;
const INTERVALLE_RELECTURE_MS = 3_000;

const OFFRES: ReadonlyArray<{ offre: OffreRecharge; euros: number }> = [
  { offre: 'refill_50', euros: 50 },
  { offre: 'refill_100', euros: 100 },
];

function CreditInner({ session }: { session: Session }) {
  const t = useT();
  const { locale } = useLocale();
  const retour = useSearchParams().get('paiement');
  const [solde, setSolde] = useState<number | null>(null);
  const [charge, setCharge] = useState(false);
  const [mouvements, setMouvements] = useState<LigneCredit[] | null>(null);
  const [enCours, setEnCours] = useState<OffreRecharge | null>(null);
  const [indisponible, setIndisponible] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  // Le crédit est-il arrivé depuis le retour de paiement ? Tant que non, l'écran le dit et relit.
  const [arrive, setArrive] = useState(false);
  // Une facture qui n'a pas pu s'ouvrir : dit dans la page, sous l'historique.
  const [erreurFacture, setErreurFacture] = useState<string | null>(null);

  /** Relit le solde et l'historique. L'historique ne fait jamais échouer la lecture : une liste vide le remplace. */
  const relire = useCallback(async (): Promise<{ solde: number | null; mouvements: LigneCredit[] }> => {
    const [s, m] = await Promise.all([
      getSoldeAgent(session.tenantId),
      getMouvementsCredit(session.tenantId).catch((): LigneCredit[] => []),
    ]);
    setSolde(s);
    setCharge(true);
    setMouvements(m);
    return { solde: s, mouvements: m };
  }, [session.tenantId]);

  useEffect(() => {
    let vivant = true;
    let minuteur: ReturnType<typeof setTimeout> | undefined;
    // 🔴 L'ARRIVÉE SE LIT SUR LA LIGNE `achat` DE CE PAIEMENT (`achatArriveDepuis`), dès la PREMIÈRE lecture : le
    // webhook passe souvent avant elle, et un solde comparé à lui-même ne « montait » alors jamais (relecture du
    // 2026-09-29). Le solde qui monte pendant les relectures reste un second signal.
    const seuil = seuilDuRetour(lireDepartPaiement(), Date.now());
    const constater = (): void => {
      setArrive(true);
      oublierDepartPaiement();
    };
    const demarrer = async (): Promise<void> => {
      let initial: number | null = null;
      try {
        const r = await relire();
        initial = r.solde;
        if (vivant && retour === 'recu' && achatArriveDepuis(r.mouvements, seuil)) {
          constater();
          return;
        }
      } catch {
        if (vivant) setCharge(true);
      }
      if (retour !== 'recu') return;
      // Le webhook arrive en quelques secondes : on relit jusqu'à voir l'achat, sans insister au-delà.
      let restantes = RELECTURES_APRES_PAIEMENT;
      const suivante = (): void => {
        if (!vivant || restantes <= 0) return;
        restantes -= 1;
        minuteur = setTimeout(() => {
          relire()
            .then((r) => {
              if (!vivant) return;
              if (achatArriveDepuis(r.mouvements, seuil) || (initial !== null && r.solde !== null && r.solde > initial)) constater();
              else suivante();
            })
            .catch(() => suivante());
        }, INTERVALLE_RELECTURE_MS);
      };
      suivante();
    };
    void demarrer();
    return () => { vivant = false; if (minuteur) clearTimeout(minuteur); };
  }, [relire, retour]);

  async function payer(offre: OffreRecharge): Promise<void> {
    setEnCours(offre);
    setErreur(null);
    try {
      const r = await ouvrirPaiement(session.tenantId, offre);
      if ('indisponible' in r) {
        setIndisponible(true);
        setEnCours(null);
        return;
      }
      if (!estPageDePaiement(r.url)) throw new Error(t('Adresse de paiement invalide.', 'Invalid payment address.'));
      // Le moment du départ, pour reconnaître au retour la ligne `achat` de CE paiement.
      retenirDepartPaiement(Date.now());
      // La page de paiement est hébergée par Stripe : on la quitte, le bouton reste en cours jusqu'au départ.
      window.location.assign(r.url);
    } catch (err) {
      setErreur(erreurDeChargement(err, t));
      setEnCours(null);
    }
  }

  /**
   * LA FACTURE D'UN ACHAT, dans un nouvel onglet (décision de Julien du 2026-09-29).
   *
   * 🔴 L'ONGLET S'OUVRE DANS LE CLIC, DE FAÇON SYNCHRONE, et reçoit son adresse ensuite. L'adresse vient du serveur,
   * qui la lit chez Stripe : l'ouvrir APRÈS l'attente ferait bloquer l'onglet comme fenêtre surgissante, le navigateur
   * ne le rattachant plus à un geste de l'utilisateur. Un échec se dit dans la page, et l'onglet vide se referme.
   * ⚠️ `opener` est coupé avant de naviguer : la page de Stripe n'a pas à pouvoir piloter la console.
   */
  async function voirFacture(paiementId: string): Promise<void> {
    setErreurFacture(null);
    const onglet = window.open('', '_blank');
    try {
      const url = await ouvrirFacture(session.tenantId, paiementId);
      if (onglet) {
        onglet.opener = null;
        onglet.location.href = url;
      } else {
        // Le navigateur a refusé l'onglet malgré le clic : la facture s'ouvre ici plutôt que pas du tout.
        window.location.assign(url);
      }
    } catch (err) {
      onglet?.close();
      setErreurFacture(erreurDeChargement(err, t));
    }
  }

  const admin = session.role === 'admin';

  return (
    <div className="mx-auto max-w-formulaire space-y-4">
      <header>
        <TitrePage>{t('Crédit IA', 'AI credit')}</TitrePage>
        <IntroPage>
          {t(
            'Le crédit prépayé de l’espace. Il paie vos agents IA et la traduction des conversations de l’Inbox.',
            'The workspace’s prepaid credit. It pays for your AI agents and for translating Inbox conversations.',
          )}
        </IntroPage>
      </header>

      {retour === 'recu' && (
        <MbaNotice kind="success" testid="credit-retour-recu">
          {arrive
            ? t('Paiement reçu, votre crédit est à jour. La facture vous est envoyée par e-mail.', 'Payment received, your credit is up to date. The invoice is sent to you by email.')
            : t('Paiement reçu : le crédit arrive dans quelques secondes.', 'Payment received: the credit arrives in a few seconds.')}
        </MbaNotice>
      )}
      {retour === 'abandon' && (
        <MbaNotice kind="warning" testid="credit-retour-abandon">
          {t('Paiement abandonné : rien n’a été débité.', 'Payment cancelled: nothing was charged.')}
        </MbaNotice>
      )}

      <section className="rounded-carte border border-ink-200 bg-white p-5" data-testid="credit-solde">
        <div className="text-xs font-medium text-ink-500">{t('Crédit restant', 'Credit left')}</div>
        {!charge && <Squelette forme="carte" className="mt-1" />}
        {charge && solde === null && (
          <p className="mt-1 text-sm text-ink-500">
            {t('Aucun crédit n’est suivi sur cet espace.', 'No credit is tracked on this workspace.')}
          </p>
        )}
        {charge && solde !== null && (
          <>
            <div className="mt-1 text-3xl font-semibold tracking-tight tabular-nums text-ink-900">{eurosDepuisMicro(solde)} €</div>
            {solde <= 0 && (
              <p className="mt-2 text-sm text-danger" data-testid="credit-epuise">
                {t(
                  'Épuisé : vos agents ne répondent plus (ils sortent par « Plafond atteint ») et l’Inbox ne traduit plus.',
                  'Used up: your agents no longer answer (they leave through “Cap reached”) and the Inbox no longer translates.',
                )}
              </p>
            )}
            {solde > 0 && solde < SOLDE_BAS_MICRO_EUR && (
              <p className="mt-2 text-sm text-alerte" data-testid="credit-bas">
                {t('C’est bas : au bout, vos agents cesseront de répondre et l’Inbox de traduire.', 'That is low: once it runs out, your agents stop answering and the Inbox stops translating.')}
              </p>
            )}
          </>
        )}
      </section>

      <section className="rounded-carte border border-ink-200 bg-white p-5" data-testid="credit-recharger">
        <h2 className="text-sm font-semibold text-ink-900">{t('Recharger', 'Top up')}</h2>
        {!admin && (
          <p className="mt-1 text-sm text-ink-500" data-testid="credit-non-admin">
            {t('Demandez à un administrateur de votre espace de recharger le crédit.', 'Ask an administrator of your workspace to top up the credit.')}
          </p>
        )}
        {admin && indisponible && (
          <p className="mt-1 text-sm text-ink-500" data-testid="credit-indisponible">
            {t(
              'La recharge en ligne n’est pas encore disponible. Contactez-nous : le crédit est ajouté à votre espace dans la foulée.',
              'Online top-up isn’t available yet. Contact us: the credit is added to your workspace right away.',
            )}
          </p>
        )}
        {admin && !indisponible && (
          <>
            <p className="mt-1 text-sm text-ink-500">
              {t(
                'Montants hors taxe, TVA en sus. Le paiement se fait sur la page sécurisée de Stripe, qui vous envoie la facture par e-mail. Le crédit n’expire pas.',
                'Amounts exclude VAT, which is added at checkout. Payment happens on Stripe’s secure page, which emails you the invoice. The credit does not expire.',
              )}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {OFFRES.map(({ offre, euros }) => (
                <Bouton
                  key={offre}
                  data-testid={`credit-offre-${offre}`}
                  onClick={() => { void payer(offre); }}
                  disabled={enCours !== null}
                  enCours={enCours === offre}
                >
                  {t(`Recharger ${euros} € HT`, `Top up €${euros} excl. VAT`)}
                </Bouton>
              ))}
            </div>
          </>
        )}
        {erreur && <p className="mt-2 text-sm text-danger" data-testid="credit-erreur">{erreur}</p>}
        <p className="mt-3 text-xs text-ink-500">
          {t(
            'Ce que le crédit paie : chaque échange d’un agent IA avec son modèle et chaque recherche dans sa base de connaissance (en production comme au bac à sable), la préparation des fiches de connaissance, et chaque traduction ou transcription de l’Inbox, au tarif de votre offre (celui de l’onglet Modèle). 1 € est offert au premier numéro WhatsApp de l’espace, dès que Meta l’a vérifié.',
            'What the credit pays for: every exchange between an AI agent and its model and every search in its knowledge base (in production as in the sandbox), the preparation of knowledge entries, and every Inbox translation or transcription, at your plan’s rate (the one in the Model tab). €1 is offered for the workspace’s first WhatsApp number, as soon as Meta has verified it.',
          )}
        </p>
      </section>

      <section className="rounded-carte border border-ink-200 bg-white p-5" data-testid="credit-historique">
        <h2 className="text-sm font-semibold text-ink-900">{t('Historique', 'History')}</h2>
        {mouvements === null && <Squelette forme="carte" className="mt-2" />}
        {mouvements !== null && mouvements.length === 0 && (
          <p className="mt-1 text-sm text-ink-500">{t('Aucun mouvement pour l’instant.', 'No movement yet.')}</p>
        )}
        {mouvements !== null && mouvements.length > 0 && (
          <ul className="mt-2 divide-y divide-ink-100">
            {mouvements.map((m) => (
              <li key={m.id} className="flex items-baseline justify-between gap-3 py-2 text-sm" data-testid="credit-ligne" data-raison={m.raison}>
                <span className="text-ink-900">
                  {libelle(m, t)}
                  <span className="ml-2 text-xs text-ink-500">{dateCourte(m.at, locale)}</span>
                  {aUneFacture(m) && (
                    <button
                      type="button"
                      onClick={() => { void voirFacture(m.paiementId); }}
                      data-testid="credit-facture"
                      className="ml-2 text-xs font-medium text-brand-600 hover:underline"
                    >
                      {t('Facture', 'Invoice')}
                    </button>
                  )}
                </span>
                <span className={`tabular-nums ${m.deltaMicroEur >= 0 ? 'text-ink-900' : 'text-ink-500'}`}>
                  {m.deltaMicroEur >= 0 ? '+' : ''}{fmtCost(m.deltaMicroEur / 1_000_000, locale, 'EUR')}
                </span>
              </li>
            ))}
          </ul>
        )}
        {erreurFacture && <p className="mt-2 text-sm text-danger" data-testid="credit-facture-erreur">{erreurFacture}</p>}
      </section>
    </div>
  );
}

/** « 29/09 », depuis `AAAA-MM-JJ` : le jour d'une ligne qui agrège une journée. */
function jourCourt(jour: string): string {
  const [, mois, j] = jour.split('-');
  return `${j}/${mois}`;
}

function dateCourte(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(iso));
}

/**
 * La raison EN CLAIR. Le serveur rend la raison telle qu'écrite ; une raison inconnue (écrite par une version plus
 * récente) s'affiche telle quelle plutôt que de se déguiser en une autre.
 */
function libelle(m: LigneCredit, t: (fr: string, en?: string) => string): string {
  switch (m.raison) {
    case 'achat': return t('Achat de crédit', 'Credit purchase');
    case 'offert': return t('Crédit offert', 'Credit offered');
    case 'recharge': return t('Recharge manuelle', 'Manual top-up');
    // Les tours d'agent, et depuis le lot 6 (C) la recherche, la préparation des fiches et la transcription : la même ligne du jour.
    case 'conso': return m.jour ? t(`Consommation IA du ${jourCourt(m.jour)}`, `AI usage on ${jourCourt(m.jour)}`) : t('Consommation IA', 'AI usage');
    case 'traduction': return m.jour ? t(`Traductions du ${jourCourt(m.jour)}`, `Translations on ${jourCourt(m.jour)}`) : t('Traductions', 'Translations');
    default: return m.raison;
  }
}
