'use client';

import { useEffect, useRef, useState } from 'react';
import { Bouton } from '@/components/Bouton';
import { useT } from '@/lib/i18n';
import { useConnexionNumero } from '@/lib/connexion-numero';
import type { ApiConnexionNumero } from '@/lib/api/connexion-numero';
import { COEXISTENCE_BOUTON, COEXISTENCE_PHRASES } from '@/lib/fenetre-meta';
import { repriseDuNumeroFourni } from '@/lib/lien-numero';
import { ETAPES_NUMERO_FOURNI } from '@/lib/partage/etapes-numero-fourni';
import { PREREQUIS_META } from '@/lib/partage/etapes-meta';
import { ETAPES_COMPTE_FOURNI } from '@/lib/partage/etapes-application';
import { QrApplication } from '@/components/QrApplication';

/**
 * LE PARCOURS DE CONNEXION DU NUMÉRO (lot 3b, sorti de `/connecter-whatsapp` au lot 3c pour servir aussi `/brancher`).
 *
 * Trois choix. « Fournissez-moi un numéro » : un numéro de notre réserve s'affiche ; le client le tape dans la fenêtre de
 * Meta, par SMS de préférence (la ligne fixe le lit à voix haute), sinon par la voix ; notre Asterisk capte le code
 * dans les deux cas, et le parcours l'affiche pour qu'il le recopie. Les étapes affichées sont celles que Claude redit
 * (`ETAPES_NUMERO_FOURNI`, essai réel 99). « J'ai déjà un numéro » : la fenêtre de Meta, comme depuis l'Accueil.
 * « Garder mon application WhatsApp Business » : la même fenêtre en coexistence (plan 2026-10-24), le numéro reste dans
 * l'application.
 *
 * Il ne connaît pas son autorité : `api` est celle de la session de la console ou celle du lien de Claude Code
 * (`@/lib/api/connexion-numero`). La page décide de ce qu'on voit une fois le numéro connecté.
 *
 * ⚠️ EN v4, RIEN NE FAIT SAUTER L'ÉCRAN DU NUMÉRO DE LA FENÊTRE DE META (mesuré le 2026-10-06) : le client y tape donc
 * le numéro, d'où les consignes. La fenêtre vérifie le code, puis la suite actuelle relie et active le numéro.
 */
export function ParcoursNumero({ tenantId, api, choixInitial, connecte, retour, surConnexion, filiere = 'api' }: {
  tenantId: string;
  api: ApiConnexionNumero;
  /**
   * `application` : la filière de l'application WhatsApp Business (2026-10-22), ouverte par le lien de Claude Code. Le
   * numéro se relie par un QR code scanné depuis le téléphone, à la place de la fenêtre de Meta. Absente : l'API.
   */
  filiere?: 'api' | 'application';
  /** Où Stripe renvoie après le paiement : cette page-ci (`/brancher` ou `/connecter-whatsapp`). */
  retour: 'brancher' | 'console';
  /** Le choix déjà fait (le mode du lien de Claude Code), ou `null` pour proposer les trois. */
  choixInitial: 'fourni' | 'apporte' | 'coexistence' | null;
  /** Le numéro est connecté : la lecture du code s'arrête. */
  connecte: boolean;
  /** La fenêtre de Meta a relié le compte : ses avertissements, à afficher par la page. */
  surConnexion(avertissements: string[]): void;
}) {
  const t = useT();
  const [choix, setChoix] = useState<'fourni' | 'apporte' | 'coexistence' | null>(choixInitial);
  const [numero, setNumero] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [copie, setCopie] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [enCours, setEnCours] = useState(false);
  /** L'abonnement du numéro (lot 3c) : `undefined` tant qu'il n'est pas lu (ou sur une API sans la route). */
  const [abonnement, setAbonnement] = useState<{ statut: string } | null | undefined>(undefined);
  /** Retour de la page de Stripe (`?abonnement=recu`) : la confirmation arrive par le webhook, on ne repaie pas. */
  const [paiementRecu, setPaiementRecu] = useState(false);
  /** Le numéro vient d'être rendu (« Abandonner ») alors que l'abonnement court : il ne se « prépare » pas. */
  const [rendu, setRendu] = useState(false);
  /** La fin de l'abonnement est programmée à la fin de la période payée (lot 4, livraison B). */
  const [finProgrammee, setFinProgrammee] = useState(false);
  /** Un Pro vivant inclut le numéro (lot 6, B2b) : il s'obtient sans payer. Faux tant qu'il n'est pas lu. */
  const [inclus, setInclus] = useState(false);
  /** Filière application, numéro fourni : le QR code s'affiche une fois le compte créé dans l'application. */
  const [qrDemande, setQrDemande] = useState(false);
  const application = filiere === 'application';
  const connexion = useConnexionNumero(tenantId, api, surConnexion);
  /**
   * La course d'un geste et d'une lecture (jaune 5 de la relecture de la livraison B) : une lecture partie AVANT
   * « Remplacer » revient avec l'ancien numéro ou son code. Chaque geste change de génération à son début et à sa fin,
   * et une lecture n'est appliquée que si la génération n'a pas bougé depuis son départ ni un geste n'est en cours.
   */
  const generation = useRef(0);
  const enGeste = useRef(false);
  const fraiche = (depart: number) => depart === generation.current && !enGeste.current;

  useEffect(() => {
    const recu = new URLSearchParams(window.location.search).get('abonnement') === 'recu';
    setPaiementRecu(recu);
    // Retour de Stripe : le client vient de payer le numéro fourni, il ne le rechoisit pas.
    if (recu) setChoix((c) => c ?? 'fourni');
  }, []);

  // Tant qu'un numéro fourni n'est pas là, l'abonnement et le numéro se relisent : le webhook les écrit ensemble.
  useEffect(() => {
    if (choix !== 'fourni' || numero !== null || connecte) return undefined;
    let vivant = true;
    const lire = () => {
      const depart = generation.current;
      api.etat().then((r) => {
        if (!vivant || !fraiche(depart)) return;
        setAbonnement(r.etat.abonnement);
        setInclus(r.etat.inclusDansLePro === true);
        if (r.etat.fourni) { setNumero(r.etat.fourni); setCode(r.etat.code?.code ?? null); }
      }).catch(() => {});
    };
    lire();
    const minuterie = setInterval(lire, INTERVALLE_CODE_MS);
    return () => { vivant = false; clearInterval(minuterie); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [choix, numero, connecte, tenantId]);

  // Au retour sur la page (rechargement, onglet rouvert), un numéro déjà attribué reprend où il en était, sauf sur un lien
  // de coexistence (`repriseDuNumeroFourni`). Une API qui n'a pas encore la route rend une erreur : le parcours reste au
  // choix, sans message.
  useEffect(() => {
    const depart = generation.current;
    api.lire().then((r) => {
      const reprise = repriseDuNumeroFourni(choixInitial, r);
      if (reprise && fraiche(depart)) { setNumero(reprise.numero); setCode(reprise.code); setChoix('fourni'); }
    }).catch(() => {});
    // L'abonnement, même quand un numéro est déjà là : le portail et le texte après « Abandonner » en dépendent.
    api.etat().then((r) => { if (fraiche(depart)) { setAbonnement(r.etat.abonnement); setInclus(r.etat.inclusDansLePro === true); } }).catch(() => {});
    // `api` change d'identité à chaque rendu de la page : l'espace suffit à dire qu'il faut relire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  // Le code se lit en boucle tant qu'un numéro fourni attend sa connexion.
  useEffect(() => {
    if (choix !== 'fourni' || numero === null || connecte) return undefined;
    const minuterie = setInterval(() => {
      const depart = generation.current;
      api.lire().then((r) => { if (fraiche(depart)) setCode(r.code); }).catch(() => {});
    }, INTERVALLE_CODE_MS);
    return () => clearInterval(minuterie);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [choix, numero, connecte, tenantId]);

  const geste = async (f: () => Promise<void>) => {
    generation.current += 1;
    enGeste.current = true;
    setEnCours(true);
    setErreur(null);
    try { await f(); } catch (err) { setErreur(err instanceof Error ? err.message : t('Une erreur est survenue', 'Something went wrong')); }
    finally { generation.current += 1; enGeste.current = false; setEnCours(false); }
  };
  const abonne = abonnement !== undefined && abonnement !== null && abonnement.statut !== 'resilie';
  const obtenir = () => geste(async () => { setNumero((await api.obtenir()).numero); setCode(null); setRendu(false); });
  const remplacer = () => geste(async () => { setNumero(null); setCode(null); setNumero((await api.remplacer()).numero); });
  const abandonner = () => geste(async () => {
    const r = await api.abandonner();
    setNumero(null); setCode(null); setChoix(choixInitial); setRendu(true); setFinProgrammee(r.finProgrammee === true);
  });
  const payer = () => geste(async () => { window.location.assign((await api.payer(retour)).url); });
  // Le portail se gère depuis la console ; sur la page du lien, c'est Claude qui résilie.
  const portail = api.portail !== undefined && abonnement !== undefined && abonnement !== null
    ? <BoutonPortail api={api} />
    : null;
  const copier = async () => {
    if (!numero) return;
    try { await navigator.clipboard.writeText(numero); setCopie(true); } catch { setCopie(false); }
  };

  const pret = connexion.cfg?.enabled === true;
  const boutonFenetre = (
    <Bouton type="button" enCours={connexion.busy} disabled={!pret || connexion.busy} onClick={() => { void connexion.connect(); }} data-testid="ouvrir-fenetre-meta">
      {connexion.busy ? t('Fenêtre de Meta ouverte…', 'Meta window open…') : t('Ouvrir la fenêtre de Meta', 'Open the Meta window')}
    </Bouton>
  );
  // Le lien de Claude Code arrive avec son choix : pas de retour vers un choix qu'il n'a pas proposé.
  const boutonRetour = choixInitial === null
    ? <Bouton type="button" variante="discret" onClick={() => setChoix(null)}>{t('Retour', 'Back')}</Bouton>
    : null;
  // En coexistence, le numéro RESTE dans l'application : le prérequis d'un numéro hors de l'application la contredirait,
  // et le compte Meta Business, sa carte le dit elle-même, la fenêtre de Meta le crée en chemin. Reste ce qu'il est.
  const prerequis = choix === 'coexistence' ? PREREQUIS_META.slice(0, 1) : PREREQUIS_META;

  return (
    <>
      {/* Ce qu'il faut chez Meta, avant toute fenêtre de Meta : la même source que Claude (guide « compte Meta »). La filière
          application n'a pas de fenêtre de Meta. */}
      {!application && (
        <div data-testid="prerequis-meta" className="mt-6 rounded-carte border border-ink-200 bg-ink-50 p-5">
          <div className="text-sm font-semibold text-ink-900">{t('Avant de commencer, chez Meta', 'Before you start, at Meta')}</div>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-ink-700">
            {prerequis.map((e) => <li key={e.fr}>{t(e.fr, e.en)}</li>)}
          </ol>
        </div>
      )}
      {choix === null ? (
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <button type="button" data-testid="choix-fourni" onClick={() => setChoix('fourni')} className="rounded-carte border border-ink-200 bg-white p-5 text-left hover:border-ink-400">
            <div className="text-base font-semibold text-ink-900">{t('Fournissez-moi un numéro', 'Provide me a number')}</div>
            <p className="mt-1 text-xs text-ink-500">
              {inclus
                ? t('Un numéro dédié, prêt pour WhatsApp. Inclus dans votre offre.', 'A dedicated number, ready for WhatsApp. Included in your plan.')
                : t('Un numéro dédié, prêt pour WhatsApp : 3,50 € HT par mois.', 'A dedicated number, ready for WhatsApp: €3.50 excl. VAT per month.')}
            </p>
          </button>
          <button type="button" data-testid="choix-apporte" onClick={() => setChoix('apporte')} className="rounded-carte border border-ink-200 bg-white p-5 text-left hover:border-ink-400">
            <div className="text-base font-semibold text-ink-900">{t('J’ai déjà un numéro', 'I already have a number')}</div>
            <p className="mt-1 text-xs text-ink-500">{t('Vous le saisissez dans la fenêtre de Meta et recevez son code.', 'You enter it in the Meta window and receive its code.')}</p>
          </button>
          {/* La coexistence passe par l'API officielle : la filière application, qui relie par QR code, ne la propose pas. */}
          {!application && (
            <button type="button" data-testid="choix-coexistence" onClick={() => setChoix('coexistence')} className="rounded-carte border border-ink-200 bg-white p-5 text-left hover:border-ink-400 sm:col-span-2">
              <div className="text-base font-semibold text-ink-900">{t(COEXISTENCE_BOUTON.fr, COEXISTENCE_BOUTON.en)}</div>
              <p className="mt-1 text-xs text-ink-500">{t('Le numéro de votre application WhatsApp Business, qui reste sur votre téléphone.', 'Your WhatsApp Business app number, which stays on your phone.')}</p>
            </button>
          )}
        </div>
      ) : choix === 'coexistence' ? (
        <div data-testid="choix-coexistence-ouvert" className="mt-6 rounded-carte border border-ink-200 bg-white p-5">
          <div className="flex items-center gap-3">
            <Bouton type="button" enCours={connexion.busy} disabled={!pret || connexion.busy} onClick={() => { void connexion.connect({ coexistence: true }); }} data-testid="ouvrir-fenetre-coexistence">
              {connexion.busy ? t('Fenêtre de Meta ouverte…', 'Meta window open…') : t(COEXISTENCE_BOUTON.fr, COEXISTENCE_BOUTON.en)}
            </Bouton>
            {boutonRetour}
          </div>
          {COEXISTENCE_PHRASES.map((p) => <p key={p.fr} className="mt-3 text-sm text-ink-700">{t(p.fr, p.en)}</p>)}
        </div>
      ) : choix === 'apporte' && application ? (
        <QrApplication api={api} />
      ) : choix === 'apporte' ? (
        <div data-testid="choix-apporte-ouvert" className="mt-6 rounded-carte border border-ink-200 bg-white p-5">
          <p className="text-sm text-ink-700">{t('Dans la fenêtre de Meta, choisissez votre entreprise, saisissez votre numéro et le code reçu.', 'In the Meta window, pick your business, enter your number and the code you receive.')}</p>
          <div className="mt-4 flex items-center gap-3">
            {boutonFenetre}
            {boutonRetour}
          </div>
        </div>
      ) : numero === null ? (
        <div data-testid="choix-fourni-ouvert" className="mt-6 rounded-carte border border-ink-200 bg-white p-5">
          <p className="text-sm text-ink-700">
            {application
              ? t('Nous vous attribuons un numéro britannique dédié, que vous ajouterez dans l’application WhatsApp Business.', 'We assign you a dedicated UK number, which you then add in the WhatsApp Business app.')
              : t('Nous vous attribuons un numéro britannique dédié, que vous connecterez dans la fenêtre de Meta.', 'We assign you a dedicated UK number, which you then connect in the Meta window.')}
          </p>
          {abonne && rendu ? (
            // Rendu par « Abandonner », mais l'abonnement court toujours : on le dit, avec ce qu'on peut en faire.
            <p data-testid="numero-rendu" className="mt-3 text-sm text-ink-700">
              {finProgrammee
                ? t('Numéro rendu. Votre abonnement prend fin à la fin de la période payée : rien ne vous sera plus prélevé.', 'Number given back. Your subscription ends at the end of the paid period: nothing more will be charged.')
                : api.portail
                ? t('Numéro rendu. Votre abonnement continue : obtenez un autre numéro ci-dessous, ou résiliez-le avec « Gérer mon abonnement ».', 'Number given back. Your subscription continues: get another number below, or cancel it with “Manage my subscription”.')
                : t('Numéro rendu. Votre abonnement continue : obtenez un autre numéro ci-dessous, ou demandez à Claude de le résilier.', 'Number given back. Your subscription continues: get another number below, or ask Claude to cancel it.')}
            </p>
          ) : abonne ? (
            // Payé, mais sans numéro : la réserve était vide au moment du paiement. Le bouton réessaie l'attribution.
            <p data-testid="numero-en-preparation" className="mt-3 text-sm text-ink-700">
              {t('Paiement reçu : votre numéro est en préparation, il s’affichera ici dès qu’il sera prêt.', 'Payment received: your number is being prepared and will show here as soon as it is ready.')}
            </p>
          ) : inclus ? (
            // Un Pro vivant inclut le numéro (lot 6, B2b) : rien à payer.
            <p data-testid="numero-inclus" className="mt-3 text-sm text-ink-700">
              {t('Inclus dans votre offre : rien à payer.', 'Included in your plan: nothing to pay.')}
            </p>
          ) : paiementRecu && abonnement === null ? (
            <p data-testid="paiement-en-confirmation" className="mt-3 text-sm text-ink-700">
              {t('Paiement en cours de confirmation… votre numéro s’affichera ici dans quelques secondes.', 'Payment being confirmed… your number will show here in a few seconds.')}
            </p>
          ) : null}
          <div className="mt-4 flex items-center gap-3">
            {abonnement === undefined || abonne || inclus ? (
              <Bouton type="button" enCours={enCours} disabled={enCours} onClick={() => { void obtenir(); }} data-testid="obtenir-numero">
                {t('Obtenir mon numéro', 'Get my number')}
              </Bouton>
            ) : paiementRecu && abonnement === null ? null : (
              // Sans abonnement, ou résilié : même revenu de Stripe, un abonnement résilié se repaie.
              <Bouton type="button" enCours={enCours} disabled={enCours} onClick={() => { void payer(); }} data-testid="payer-numero">
                {t('Payer 3,50 € HT par mois', 'Pay €3.50 excl. VAT per month')}
              </Bouton>
            )}
            {portail}
            {boutonRetour}
          </div>
        </div>
      ) : (
        <div className="mt-6 space-y-4">
          <div className="rounded-carte border border-ink-200 bg-white p-5">
            <div className="text-xs font-medium text-ink-500">{t('Votre numéro', 'Your number')}</div>
            <div className="mt-1 flex items-center gap-3">
              <span data-testid="numero-fourni" className="font-mono text-2xl font-semibold text-ink-900">{numero}</span>
              <Bouton type="button" variante="secondaire" taille="petite" onClick={() => { void copier(); }}>{copie ? t('Copié', 'Copied') : t('Copier', 'Copy')}</Bouton>
            </div>
            {/* Les mêmes étapes que celles que Claude redit (`src/mcp/outils-numero.ts`) : une seule source. */}
            <ol data-testid="etapes-numero-fourni" className="mt-4 list-decimal space-y-1 pl-5 text-sm text-ink-700">
              {(application ? ETAPES_COMPTE_FOURNI : ETAPES_NUMERO_FOURNI).map((e) => <li key={e.fr}>{t(e.fr, e.en)}</li>)}
            </ol>
            <div className="mt-4">
              {!application ? boutonFenetre : !qrDemande ? (
                <Bouton type="button" onClick={() => setQrDemande(true)} data-testid="afficher-qr-application">
                  {t('J’ai créé le compte : afficher le QR code', 'I created the account: show the QR code')}
                </Bouton>
              ) : null}
            </div>
          </div>
          <div data-testid="code-capte" className="rounded-carte border border-ink-200 bg-ink-50 p-5">
            <div className="text-xs font-medium text-ink-500">{t('Code de vérification', 'Verification code')}</div>
            {code ? (
              <div className="mt-1 font-mono text-3xl font-semibold tracking-widest text-ink-900">{code}</div>
            ) : (
              <p className="mt-1 text-sm text-ink-500">
                {application ? t('En attente du code de WhatsApp…', 'Waiting for WhatsApp’s code…') : t('En attente du code de Meta…', 'Waiting for Meta’s code…')}
              </p>
            )}
          </div>
          {application && qrDemande && <QrApplication api={api} />}
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <Bouton type="button" variante="discret" taille="petite" disabled={enCours} onClick={() => { void remplacer(); }} data-testid="remplacer-numero">
              {application
                ? t('Ce numéro ne passe pas ? En obtenir un autre', 'This number does not go through? Get another one')
                : t('Meta refuse ce numéro ? En obtenir un autre', 'Meta refuses this number? Get another one')}
            </Bouton>
            <Bouton type="button" variante="discret" taille="petite" disabled={enCours} onClick={() => { void abandonner(); }} data-testid="abandonner-numero">
              {t('Abandonner', 'Give up')}
            </Bouton>
            {portail}
          </div>
        </div>
      )}
      {(erreur ?? connexion.error) && <p data-testid="erreur-connexion" className="mt-4 rounded-controle bg-danger-50 px-3 py-2 text-xs text-danger-700">{erreur ?? connexion.error}</p>}
    </>
  );
}

/**
 * Le portail client de Stripe (jaune 1 de la relecture de la livraison B) : changer de carte, lire les factures,
 * résilier. Rien sans `api.portail`, c'est-à-dire sur la page du lien de Claude Code.
 */
export function BoutonPortail({ api }: { api: ApiConnexionNumero }) {
  const t = useT();
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const ouvrir = api.portail;
  if (!ouvrir) return null;
  const aller = async () => {
    setEnCours(true);
    setErreur(null);
    try { window.location.assign((await ouvrir()).url); } catch (err) {
      setErreur(err instanceof Error ? err.message : t('Une erreur est survenue', 'Something went wrong'));
      setEnCours(false);
    }
  };
  return (
    <>
      <Bouton type="button" variante="discret" taille="petite" enCours={enCours} disabled={enCours} onClick={() => { void aller(); }} data-testid="gerer-abonnement">
        {t('Gérer mon abonnement', 'Manage my subscription')}
      </Bouton>
      {erreur && <span className="text-xs text-danger-700">{erreur}</span>}
    </>
  );
}

/** Le délai entre deux lectures du code pendant que la fenêtre de Meta est ouverte. */
const INTERVALLE_CODE_MS = 3_000;
