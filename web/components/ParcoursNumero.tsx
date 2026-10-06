'use client';

import { useEffect, useRef, useState } from 'react';
import { Bouton } from '@/components/Bouton';
import { useT } from '@/lib/i18n';
import { useConnexionNumero } from '@/lib/connexion-numero';
import type { ApiConnexionNumero } from '@/lib/api/connexion-numero';

/**
 * LE PARCOURS DE CONNEXION DU NUMÉRO (lot 3b, sorti de `/connecter-whatsapp` au lot 3c pour servir aussi `/brancher`).
 *
 * Deux choix. « Fournissez-moi un numéro » : un numéro de notre réserve s'affiche ; le client le tape dans la fenêtre de
 * Meta et choisit la vérification par appel ; notre Asterisk capte le code que Meta dicte, et le parcours l'affiche
 * pour qu'il le recopie. « J'ai déjà un numéro » : la fenêtre de Meta, comme depuis l'Accueil.
 *
 * Il ne connaît pas son autorité : `api` est celle de la session de la console ou celle du lien de Claude Code
 * (`@/lib/api/connexion-numero`). La page décide de ce qu'on voit une fois le numéro connecté.
 *
 * ⚠️ EN v4, RIEN NE FAIT SAUTER L'ÉCRAN DU NUMÉRO DE LA FENÊTRE DE META (mesuré le 2026-10-06) : le client y tape donc
 * le numéro, d'où les consignes. La fenêtre vérifie le code, puis la suite actuelle relie et active le numéro.
 */
export function ParcoursNumero({ tenantId, api, choixInitial, connecte, retour, surConnexion }: {
  tenantId: string;
  api: ApiConnexionNumero;
  /** Où Stripe renvoie après le paiement : cette page-ci (`/brancher` ou `/connecter-whatsapp`). */
  retour: 'brancher' | 'console';
  /** Le choix déjà fait (le mode du lien de Claude Code), ou `null` pour proposer les deux. */
  choixInitial: 'fourni' | 'apporte' | null;
  /** Le numéro est connecté : la lecture du code s'arrête. */
  connecte: boolean;
  /** La fenêtre de Meta a relié le compte : ses avertissements, à afficher par la page. */
  surConnexion(avertissements: string[]): void;
}) {
  const t = useT();
  const [choix, setChoix] = useState<'fourni' | 'apporte' | null>(choixInitial);
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
        if (r.etat.fourni) { setNumero(r.etat.fourni); setCode(r.etat.code?.code ?? null); }
      }).catch(() => {});
    };
    lire();
    const minuterie = setInterval(lire, INTERVALLE_CODE_MS);
    return () => { vivant = false; clearInterval(minuterie); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [choix, numero, connecte, tenantId]);

  // Au retour sur la page (rechargement, onglet rouvert), un numéro déjà attribué reprend où il en était. Une API qui
  // n'a pas encore la route rend une erreur : le parcours reste au choix, sans message.
  useEffect(() => {
    const depart = generation.current;
    api.lire().then((r) => {
      if (r.numero && fraiche(depart)) { setNumero(r.numero); setCode(r.code); setChoix('fourni'); }
    }).catch(() => {});
    // L'abonnement, même quand un numéro est déjà là : le portail et le texte après « Abandonner » en dépendent.
    api.etat().then((r) => { if (fraiche(depart)) setAbonnement(r.etat.abonnement); }).catch(() => {});
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
    await api.abandonner();
    setNumero(null); setCode(null); setChoix(choixInitial); setRendu(true);
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

  return (
    <>
      {choix === null ? (
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <button type="button" data-testid="choix-fourni" onClick={() => setChoix('fourni')} className="rounded-carte border border-ink-200 bg-white p-5 text-left hover:border-ink-400">
            <div className="text-base font-semibold text-ink-900">{t('Fournissez-moi un numéro', 'Provide me a number')}</div>
            <p className="mt-1 text-xs text-ink-500">{t('Un numéro dédié, prêt pour WhatsApp : 3,50 € HT par mois.', 'A dedicated number, ready for WhatsApp: €3.50 excl. VAT per month.')}</p>
          </button>
          <button type="button" data-testid="choix-apporte" onClick={() => setChoix('apporte')} className="rounded-carte border border-ink-200 bg-white p-5 text-left hover:border-ink-400">
            <div className="text-base font-semibold text-ink-900">{t('J’ai déjà un numéro', 'I already have a number')}</div>
            <p className="mt-1 text-xs text-ink-500">{t('Vous le saisissez dans la fenêtre de Meta et recevez son code.', 'You enter it in the Meta window and receive its code.')}</p>
          </button>
        </div>
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
          <p className="text-sm text-ink-700">{t('Nous vous attribuons un numéro britannique dédié, que vous connecterez dans la fenêtre de Meta.', 'We assign you a dedicated UK number, which you then connect in the Meta window.')}</p>
          {abonne && rendu ? (
            // Rendu par « Abandonner », mais l'abonnement court toujours : on le dit, avec ce qu'on peut en faire.
            <p data-testid="numero-rendu" className="mt-3 text-sm text-ink-700">
              {api.portail
                ? t('Numéro rendu. Votre abonnement continue : obtenez un autre numéro ci-dessous, ou résiliez-le avec « Gérer mon abonnement ».', 'Number given back. Your subscription continues: get another number below, or cancel it with “Manage my subscription”.')
                : t('Numéro rendu. Votre abonnement continue : obtenez un autre numéro ci-dessous, ou demandez à Claude de le résilier.', 'Number given back. Your subscription continues: get another number below, or ask Claude to cancel it.')}
            </p>
          ) : abonne ? (
            // Payé, mais sans numéro : la réserve était vide au moment du paiement. Le bouton réessaie l'attribution.
            <p data-testid="numero-en-preparation" className="mt-3 text-sm text-ink-700">
              {t('Paiement reçu : votre numéro est en préparation, il s’affichera ici dès qu’il sera prêt.', 'Payment received: your number is being prepared and will show here as soon as it is ready.')}
            </p>
          ) : paiementRecu && abonnement === null ? (
            <p data-testid="paiement-en-confirmation" className="mt-3 text-sm text-ink-700">
              {t('Paiement en cours de confirmation… votre numéro s’affichera ici dans quelques secondes.', 'Payment being confirmed… your number will show here in a few seconds.')}
            </p>
          ) : null}
          <div className="mt-4 flex items-center gap-3">
            {abonnement === undefined || abonne ? (
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
            <ol className="mt-4 list-decimal space-y-1 pl-5 text-sm text-ink-700">
              <li>{t('Ouvrez la fenêtre de Meta.', 'Open the Meta window.')}</li>
              <li>{t('À l’écran du numéro, choisissez « Enter a new phone number », tapez ce numéro, et choisissez la vérification par appel (« Phone call »).', 'On the phone number screen, choose “Enter a new phone number”, type this number, and pick verification by phone call.')}</li>
              <li>{t('Le code s’affiche ci-dessous dès que Meta appelle : recopiez-le dans la fenêtre.', 'The code shows below as soon as Meta calls: copy it into the window.')}</li>
            </ol>
            <div className="mt-4">{boutonFenetre}</div>
          </div>
          <div data-testid="code-capte" className="rounded-carte border border-ink-200 bg-ink-50 p-5">
            <div className="text-xs font-medium text-ink-500">{t('Code de vérification', 'Verification code')}</div>
            {code ? (
              <div className="mt-1 font-mono text-3xl font-semibold tracking-widest text-ink-900">{code}</div>
            ) : (
              <p className="mt-1 text-sm text-ink-500">{t('En attente de l’appel de Meta…', 'Waiting for Meta’s call…')}</p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <Bouton type="button" variante="discret" taille="petite" disabled={enCours} onClick={() => { void remplacer(); }} data-testid="remplacer-numero">
              {t('Meta refuse ce numéro ? En obtenir un autre', 'Meta refuses this number? Get another one')}
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
