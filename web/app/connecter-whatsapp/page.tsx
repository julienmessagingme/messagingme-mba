'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/AppShell';
import { Bouton } from '@/components/Bouton';
import { TitrePage, IntroPage } from '@/components/TitrePage';
import type { Session } from '@/lib/session';
import { useT } from '@/lib/i18n';
import { useConnexionNumero } from '@/lib/connexion-numero';
import {
  getAccountStatus, obtenirNumeroFourni, lireNumeroFourni, remplacerNumeroFourni, abandonnerNumeroFourni,
  type AccountStatusResponse,
} from '@/lib/api';

/**
 * « CONNECTER WHATSAPP » (lot 3b, spec `docs/superpowers/specs/2026-10-05-numero-fourni-design.md`).
 *
 * Deux choix. « Fournissez-moi un numéro » : la page obtient un numéro de notre réserve et l'affiche ; le client le
 * tape dans la fenêtre de Meta et choisit la vérification par appel ; notre Asterisk capte le code que Meta dicte, et
 * la page l'affiche pour qu'il le recopie. « J'ai déjà un numéro » : la fenêtre de Meta, comme depuis l'Accueil.
 *
 * ⚠️ EN v4, RIEN NE FAIT SAUTER L'ÉCRAN DU NUMÉRO DE LA FENÊTRE DE META (mesuré le 2026-10-06) : le client y tape donc
 * le numéro, d'où les consignes. La fenêtre vérifie le code, puis la suite actuelle relie et active le numéro.
 */
export default function ConnecterWhatsappPage() {
  return <AppShell active="accueil">{(session) => <ConnecterWhatsapp session={session} />}</AppShell>;
}

/** Le délai entre deux lectures du code pendant que la fenêtre de Meta est ouverte. */
const INTERVALLE_CODE_MS = 3_000;

function ConnecterWhatsapp({ session }: { session: Session }) {
  const t = useT();
  const tenantId = session.tenantId;
  const isAdmin = session.role === 'admin';
  const [compte, setCompte] = useState<AccountStatusResponse | null>(null);
  const [choix, setChoix] = useState<'fourni' | 'apporte' | null>(null);
  const [numero, setNumero] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [copie, setCopie] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [enCours, setEnCours] = useState(false);
  const [avertissements, setAvertissements] = useState<string[]>([]);

  const chargerCompte = useCallback(() => {
    getAccountStatus(tenantId).then(setCompte).catch(() => { /* l'écran reste utilisable sans le statut */ });
  }, [tenantId]);
  const connexion = useConnexionNumero(tenantId, (av) => { setAvertissements(av); chargerCompte(); });

  // Au retour sur la page (rechargement, onglet rouvert), un numéro déjà attribué reprend où il en était. Une API qui
  // n'a pas encore la route rend une erreur : la page reste au choix, sans message.
  useEffect(() => {
    chargerCompte();
    lireNumeroFourni(tenantId).then((r) => {
      if (r.numero) { setNumero(r.numero); setCode(r.code); setChoix('fourni'); }
    }).catch(() => {});
  }, [tenantId, chargerCompte]);

  const connecte = compte?.hasNumber === true;
  // Le code se lit en boucle tant qu'un numéro fourni attend sa connexion.
  useEffect(() => {
    if (choix !== 'fourni' || numero === null || connecte) return undefined;
    const minuterie = setInterval(() => {
      lireNumeroFourni(tenantId).then((r) => setCode(r.code)).catch(() => {});
    }, INTERVALLE_CODE_MS);
    return () => clearInterval(minuterie);
  }, [choix, numero, connecte, tenantId]);

  const geste = async (f: () => Promise<void>) => {
    setEnCours(true);
    setErreur(null);
    try { await f(); } catch (err) { setErreur(err instanceof Error ? err.message : t('Une erreur est survenue', 'Something went wrong')); }
    finally { setEnCours(false); }
  };
  const obtenir = () => geste(async () => { setNumero((await obtenirNumeroFourni(tenantId)).numero); setCode(null); });
  const remplacer = () => geste(async () => { setNumero(null); setCode(null); setNumero((await remplacerNumeroFourni(tenantId)).numero); });
  const abandonner = () => geste(async () => { await abandonnerNumeroFourni(tenantId); setNumero(null); setCode(null); setChoix(null); });
  const copier = async () => {
    if (!numero) return;
    try { await navigator.clipboard.writeText(numero); setCopie(true); } catch { setCopie(false); }
  };

  const pret = connexion.cfg?.enabled === true && isAdmin;
  const boutonFenetre = (
    <Bouton type="button" enCours={connexion.busy} disabled={!pret || connexion.busy} onClick={() => { void connexion.connect(); }} data-testid="ouvrir-fenetre-meta">
      {connexion.busy ? t('Fenêtre de Meta ouverte…', 'Meta window open…') : t('Ouvrir la fenêtre de Meta', 'Open the Meta window')}
    </Bouton>
  );

  return (
    <div className="mx-auto max-w-formulaire">
      <TitrePage>{t('Connecter WhatsApp', 'Connect WhatsApp')}</TitrePage>
      <IntroPage>{t('Un numéro WhatsApp pour votre espace : le vôtre, ou un numéro que nous vous fournissons.', 'A WhatsApp number for your workspace: yours, or one we provide.')}</IntroPage>

      {connecte ? (
        <div data-testid="numero-connecte" className="mt-6 rounded-carte border border-ink-200 bg-white p-5">
          <div className="text-lg font-semibold text-ink-900">{t('Votre numéro WhatsApp est connecté', 'Your WhatsApp number is connected')}</div>
          <p className="mt-1 text-sm text-ink-500">{compte?.number ?? ''}</p>
          <Link href="/accueil" className="mt-4 inline-block text-sm font-semibold text-ink-900 underline">{t('Retour à l’accueil', 'Back to home')}</Link>
        </div>
      ) : !isAdmin ? (
        <p className="mt-6 text-sm text-ink-500">{t('Réservé aux admins de l’espace.', 'Workspace admins only.')}</p>
      ) : choix === null ? (
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <button type="button" data-testid="choix-fourni" onClick={() => setChoix('fourni')} className="rounded-carte border border-ink-200 bg-white p-5 text-left hover:border-ink-400">
            <div className="text-base font-semibold text-ink-900">{t('Fournissez-moi un numéro', 'Provide me a number')}</div>
            <p className="mt-1 text-xs text-ink-500">{t('Un numéro dédié, prêt pour WhatsApp. Rien à acheter de votre côté.', 'A dedicated number, ready for WhatsApp. Nothing to buy on your side.')}</p>
          </button>
          <button type="button" data-testid="choix-apporte" onClick={() => setChoix('apporte')} className="rounded-carte border border-ink-200 bg-white p-5 text-left hover:border-ink-400">
            <div className="text-base font-semibold text-ink-900">{t('J’ai déjà un numéro', 'I already have a number')}</div>
            <p className="mt-1 text-xs text-ink-500">{t('Vous le saisissez dans la fenêtre de Meta et recevez son code.', 'You enter it in the Meta window and receive its code.')}</p>
          </button>
        </div>
      ) : choix === 'apporte' ? (
        <div className="mt-6 rounded-carte border border-ink-200 bg-white p-5">
          <p className="text-sm text-ink-700">{t('Dans la fenêtre de Meta, choisissez votre entreprise, saisissez votre numéro et le code reçu.', 'In the Meta window, pick your business, enter your number and the code you receive.')}</p>
          <div className="mt-4 flex items-center gap-3">
            {boutonFenetre}
            <Bouton type="button" variante="discret" onClick={() => setChoix(null)}>{t('Retour', 'Back')}</Bouton>
          </div>
        </div>
      ) : numero === null ? (
        <div className="mt-6 rounded-carte border border-ink-200 bg-white p-5">
          <p className="text-sm text-ink-700">{t('Nous vous attribuons un numéro britannique dédié, que vous connecterez dans la fenêtre de Meta.', 'We assign you a dedicated UK number, which you then connect in the Meta window.')}</p>
          <div className="mt-4 flex items-center gap-3">
            <Bouton type="button" enCours={enCours} disabled={enCours} onClick={() => { void obtenir(); }} data-testid="obtenir-numero">
              {t('Obtenir mon numéro', 'Get my number')}
            </Bouton>
            <Bouton type="button" variante="discret" onClick={() => setChoix(null)}>{t('Retour', 'Back')}</Bouton>
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
            <Bouton type="button" variante="discret" taille="petite" disabled={enCours} onClick={() => { void abandonner(); }}>
              {t('Abandonner', 'Give up')}
            </Bouton>
          </div>
        </div>
      )}

      {(erreur ?? connexion.error) && <p data-testid="erreur-connexion" className="mt-4 rounded-controle bg-danger-50 px-3 py-2 text-xs text-danger-700">{erreur ?? connexion.error}</p>}
      {avertissements.length > 0 && (
        <p data-testid="avertissements-connexion" className="mt-4 rounded-controle bg-alerte-50 px-3 py-2 text-xs text-alerte-700">
          {t('À savoir', 'Note')} : {avertissements.join(' · ')}
        </p>
      )}
    </div>
  );
}
