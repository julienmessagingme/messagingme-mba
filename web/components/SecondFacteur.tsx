'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { toDataURL } from 'qrcode';
import { useT, useLocale } from '@/lib/i18n';
import { inputCls } from '@/lib/ui';
import { ApiError } from '@/lib/http';
import { grouperCle, texteCodesSecours } from '@/lib/second-facteur';
import {
  verifierCodeConnexion, enrolerConnexion, activerConnexion, estCodeRefuse,
  type CleTotp, type EtapeSecondFacteur, type SuiteConnexion,
} from '@/lib/api';
import { Bouton, classesBouton } from '@/components/Bouton';

/**
 * LA DOUBLE AUTHENTIFICATION, CÔTÉ ÉCRAN (plan `docs/superpowers/plans/2026-09-25-mfa-admins.md`, tâche 8).
 *
 * Trois morceaux, partagés par la connexion, l'inscription, l'invitation et la page Compte :
 * - `EtapesSecondFacteur` : ce que rend le mot de passe quand un code est dû (`mfaToken`) ou qu'un administrateur
 *   doit d'abord poser son facteur (`enrolToken`) ;
 * - `Enrolement` : le QR code, la clé à saisir à la main, le premier code, puis les codes de secours ;
 * - `CodesSecours` : les dix codes, montrés UNE fois.
 *
 * 🔴 LES CODES DE SECOURS NE VIVENT QUE DANS L'ÉTAT DE CES COMPOSANTS : ni URL, ni stockage du navigateur, ni
 * journal de la console. Le fichier téléchargé passe par un objet `Blob` révoqué aussitôt, jamais par une URL
 * `data:` qui les porterait en clair.
 */

const ERREUR = 'rounded-controle bg-danger-50 px-3 py-2 text-sm text-danger-700';
const LIEN = 'text-xs text-ink-500 underline hover:text-ink-900';

type T = (fr: string, en?: string) => string;

/**
 * Ce que l'écran fait d'un refus : RESTER sur l'étape (code refusé, trop d'essais) ou REVENIR au début (étape
 * expirée, facteur activé entre-temps dans un autre onglet). Le serveur répond 401 aux deux premiers cas : seul
 * son texte les distingue (`estCodeRefuse`).
 *
 * ⚠️ `avantSession` faux (page Compte) : il n'y a pas d'étape à expirer. Un autre 401 y est une session tombée,
 * déjà traitée par `lib/http.ts` (bannière de reconnexion), et un 409 se lit sur place.
 */
function lireRefus(err: unknown, t: T, avantSession = true): { revenir: boolean; message: string } {
  if (estCodeRefuse(err)) return { revenir: false, message: t('Code invalide ou expiré.', 'Invalid or expired code.') };
  if (avantSession && err instanceof ApiError && err.status === 401) {
    return { revenir: true, message: t('Cette étape a expiré, reconnectez-vous.', 'This step has expired, sign in again.') };
  }
  if (avantSession && err instanceof ApiError && err.status === 409) return { revenir: true, message: err.message };
  return { revenir: false, message: err instanceof Error ? err.message : t('Vérification impossible', 'Unable to verify') };
}

/** Un geste pour quitter l'étape (revenir au formulaire, annuler). Absent : rien ne s'affiche. */
interface Abandon { libelle: string; action: () => void }

/**
 * Les étapes d'une connexion, AVANT toute session. `onSuite` reçoit ce que le login aurait rendu sans second
 * facteur (session ou choix d'espace) ; `onRetour` reçoit le message d'une étape qui ne peut plus aboutir.
 */
export function EtapesSecondFacteur({ etape, onSuite, onRetour, abandon }: {
  etape: EtapeSecondFacteur;
  onSuite: (suite: SuiteConnexion) => void;
  onRetour: (message: string) => void;
  abandon?: Abandon;
}) {
  const t = useT();
  return (
    <div className="space-y-4 rounded-carte border border-ink-200 bg-white p-6" data-testid="second-facteur">
      <h2 className="text-sm font-semibold text-ink-900">{t('Double authentification', 'Two-factor authentication')}</h2>
      {'mfaToken' in etape ? (
        <EtapeCode mfaToken={etape.mfaToken} onSuite={onSuite} onRetour={onRetour} abandon={abandon} />
      ) : (
        <Enrolement
          intro={t('Obligatoire pour les administrateurs : scannez ce code avec votre application d’authentification.', 'Required for administrators: scan this code with your authenticator app.')}
          demarrer={() => enrolerConnexion(etape.enrolToken)}
          activer={(code: string) => activerConnexion(etape.enrolToken, code)}
          onActive={onSuite}
          onRetour={onRetour}
          abandon={abandon}
        />
      )}
    </div>
  );
}

/**
 * Une étape qui n'a pas abouti APRÈS la création du compte (inscription, invitation acceptée). Revenir au
 * formulaire le rejouerait (un second espace, une invitation déjà consommée) : on renvoie à la connexion, qui
 * reprend là où l'on s'est arrêté.
 */
export function EtapeInterrompue({ message }: { message: string }) {
  const t = useT();
  return (
    <div className="space-y-3 rounded-carte border border-ink-200 bg-white p-6" data-testid="etape-interrompue">
      <p className={ERREUR}>{message}</p>
      <Link href="/login" className={classesBouton('principal', 'normale', 'w-full')}>{t('Se connecter', 'Sign in')}</Link>
    </div>
  );
}

/** Le champ d'un code : six chiffres de l'application, ou un code de secours. */
function ChampCode({ id, valeur, onChange, secours = false }: { id: string; valeur: string; onChange: (v: string) => void; secours?: boolean }) {
  return (
    <input
      id={id}
      data-testid={id}
      required
      autoFocus
      autoComplete="one-time-code"
      inputMode={secours ? 'text' : 'numeric'}
      autoCapitalize="characters"
      spellCheck={false}
      maxLength={24}
      value={valeur}
      onChange={(e) => onChange(e.target.value)}
      className={`${inputCls} font-mono tracking-widest`}
      placeholder={secours ? 'XXXXXXXX-XXXXXXXX' : '123456'}
    />
  );
}

/** L'étape « code » : le TOTP de l'application, ou un code de secours dans le même champ. */
function EtapeCode({ mfaToken, onSuite, onRetour, abandon }: {
  mfaToken: string;
  onSuite: (suite: SuiteConnexion) => void;
  onRetour: (message: string) => void;
  abandon?: Abandon;
}) {
  const t = useT();
  const [code, setCode] = useState('');
  // Ne change QUE l'aide du champ : le serveur accepte l'un ou l'autre dans le même champ.
  const [secours, setSecours] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [envoi, setEnvoi] = useState(false);
  /** Un code de secours a servi : on dit combien il en reste avant d'entrer. */
  const [restants, setRestants] = useState<{ suite: SuiteConnexion; n: number } | null>(null);

  async function valider(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setErreur(null);
    setEnvoi(true);
    try {
      const res = await verifierCodeConnexion(mfaToken, code.trim());
      if (res.codesSecoursRestants !== undefined) {
        setRestants({ suite: res, n: res.codesSecoursRestants });
        return;
      }
      onSuite(res);
    } catch (err) {
      const refus = lireRefus(err, t);
      if (refus.revenir) {
        onRetour(refus.message);
        return;
      }
      setErreur(refus.message);
      setCode('');
    } finally {
      setEnvoi(false);
    }
  }

  if (restants) {
    return (
      <div className="space-y-3" data-testid="code-secours-accepte">
        <p className="text-sm text-ink-900">
          {restants.n === 0
            ? t('Code de secours accepté. Il ne vous en reste aucun : générez-en de nouveaux depuis Mon compte.', 'Backup code accepted. You have none left: generate new ones from My account.')
            : t(`Code de secours accepté. Il vous en reste ${restants.n}, et Mon compte permet d’en générer de nouveaux.`, `Backup code accepted. You have ${restants.n} left, and My account lets you generate new ones.`)}
        </p>
        <Bouton type="button" className="w-full" onClick={() => onSuite(restants.suite)}>{t('Continuer', 'Continue')}</Bouton>
      </div>
    );
  }

  return (
    <form onSubmit={valider} className="space-y-3" data-testid="etape-code">
      <div>
        <label htmlFor="code-connexion" className="mb-1 block text-sm font-medium text-ink-900">
          {secours ? t('Code de secours', 'Backup code') : t('Code de votre application', 'Code from your app')}
        </label>
        <ChampCode id="code-connexion" valeur={code} onChange={setCode} secours={secours} />
        <p className="mt-1 text-xs text-ink-500">
          {secours
            ? t('Un des dix codes conservés à l’activation. Chacun ne sert qu’une fois.', 'One of the ten codes saved at activation. Each works only once.')
            : t('Les six chiffres affichés en ce moment par votre application d’authentification.', 'The six digits your authenticator app shows right now.')}
        </p>
      </div>
      {erreur && <p className={ERREUR} data-testid="etape-code-erreur">{erreur}</p>}
      <Bouton type="submit" enCours={envoi} disabled={envoi || code.trim() === ''} className="w-full">
        {envoi ? t('Vérification…', 'Checking…') : t('Valider', 'Confirm')}
      </Bouton>
      <div className="flex items-center justify-between gap-3">
        <button type="button" className={LIEN} onClick={() => { setSecours((s) => !s); setErreur(null); }}>
          {secours ? t('Utiliser le code de l’application', 'Use the app code') : t('Utiliser un code de secours', 'Use a backup code')}
        </button>
        {abandon && <button type="button" className={LIEN} onClick={abandon.action}>{abandon.libelle}</button>}
      </div>
    </form>
  );
}

/**
 * L'ENRÔLEMENT : un secret neuf (QR code et clé), le premier code qui prouve que l'application le lit, puis les
 * dix codes de secours. `activer` rend les codes, et ce que l'appelant doit recevoir à la fin (la suite de la
 * connexion, ou rien de plus sur la page Compte).
 *
 * ⚠️ `demarrer` n'est appelé QU'UNE fois par montage : chaque appel tire un secret neuf côté serveur, et le mode
 * strict de React rejoue les effets en développement. Deux secrets tirés en parallèle laisseraient à l'écran
 * celui que le serveur n'a peut-être pas gardé, et le premier code serait refusé.
 */
export function Enrolement<R extends { codesSecours: string[] }>({ intro, demarrer, activer, onActive, onRetour, abandon }: {
  intro?: string;
  demarrer: () => Promise<CleTotp>;
  activer: (code: string) => Promise<R>;
  onActive: (resultat: R) => void;
  /** Absent : une étape expirée s'affiche sur place, comme les autres erreurs. */
  onRetour?: (message: string) => void;
  abandon?: Abandon;
}) {
  const t = useT();
  const [cle, setCle] = useState<CleTotp | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [envoi, setEnvoi] = useState(false);
  const [cleCopiee, setCleCopiee] = useState(false);
  const [resultat, setResultat] = useState<R | null>(null);
  const lance = useRef(false);

  async function charger(): Promise<void> {
    setErreur(null);
    try {
      const c = await demarrer();
      setCle(c);
      // Dessiné ICI, dans le navigateur : le secret ne part vers aucun service de QR code.
      setQr(await toDataURL(c.uri, { margin: 1, width: 200 }));
    } catch (err) {
      const refus = lireRefus(err, t, onRetour !== undefined);
      if (refus.revenir && onRetour) onRetour(refus.message);
      else setErreur(refus.message);
    }
  }

  useEffect(() => {
    if (lance.current) return;
    lance.current = true;
    void charger();
    // Une seule fois par montage, cf. l'en-tête.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function valider(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setErreur(null);
    setEnvoi(true);
    try {
      setResultat(await activer(code.trim()));
    } catch (err) {
      const refus = lireRefus(err, t, onRetour !== undefined);
      if (refus.revenir && onRetour) {
        onRetour(refus.message);
        return;
      }
      setErreur(refus.message);
      setCode('');
    } finally {
      setEnvoi(false);
    }
  }

  async function copierCle(): Promise<void> {
    if (!cle) return;
    try {
      await navigator.clipboard.writeText(cle.secret);
      setCleCopiee(true);
    } catch {
      // Presse-papiers refusé : la clé reste affichée, on la recopie à la main.
    }
  }

  if (resultat) {
    return <CodesSecours codes={resultat.codesSecours} onContinuer={() => onActive(resultat)} />;
  }

  return (
    <div className="space-y-4" data-testid="enrolement">
      {intro && <p className="text-sm text-ink-900">{intro}</p>}
      {cle === null ? (
        erreur ? (
          <div className="space-y-2">
            <p className={ERREUR}>{erreur}</p>
            <Bouton type="button" variante="secondaire" taille="petite" onClick={() => { void charger(); }}>{t('Réessayer', 'Try again')}</Bouton>
          </div>
        ) : (
          <p className="text-sm text-ink-500">{t('Préparation…', 'Preparing…')}</p>
        )
      ) : (
        <>
          {qr && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={qr} width={200} height={200} alt={t('QR code à scanner avec votre application', 'QR code to scan with your app')} className="mx-auto" data-testid="enrolement-qr" />
          )}
          <div>
            <p className="text-xs text-ink-500">{t('Ou saisissez cette clé dans l’application :', 'Or enter this key in the app:')}</p>
            <div className="mt-1 flex items-center justify-between gap-2 rounded-controle bg-ink-50 px-3 py-2">
              <code className="break-all font-mono text-sm text-ink-900" data-testid="enrolement-cle">{grouperCle(cle.secret)}</code>
              <Bouton type="button" variante="discret" taille="petite" onClick={() => { void copierCle(); }}>
                {cleCopiee ? t('Copiée', 'Copied') : t('Copier', 'Copy')}
              </Bouton>
            </div>
          </div>
          <form onSubmit={valider} className="space-y-3">
            <div>
              <label htmlFor="code-enrolement" className="mb-1 block text-sm font-medium text-ink-900">{t('Code affiché par l’application', 'Code shown by the app')}</label>
              <ChampCode id="code-enrolement" valeur={code} onChange={setCode} />
            </div>
            {erreur && <p className={ERREUR} data-testid="enrolement-erreur">{erreur}</p>}
            <Bouton type="submit" enCours={envoi} disabled={envoi || code.trim() === ''} className="w-full">
              {envoi ? t('Activation…', 'Activating…') : t('Activer', 'Activate')}
            </Bouton>
          </form>
        </>
      )}
      {abandon && <button type="button" className={LIEN} onClick={abandon.action}>{abandon.libelle}</button>}
    </div>
  );
}

/**
 * LES DIX CODES DE SECOURS, montrés une fois : le serveur n'en garde que l'empreinte. « Continuer » n'est
 * accessible qu'une fois la case cochée, pour qu'on ne quitte pas l'écran sans les avoir mis de côté.
 */
export function CodesSecours({ codes, onContinuer }: { codes: readonly string[]; onContinuer: () => void }) {
  const t = useT();
  const { locale } = useLocale();
  const [conserves, setConserves] = useState(false);
  const [copies, setCopies] = useState(false);

  async function copier(): Promise<void> {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      setCopies(true);
    } catch {
      // Presse-papiers refusé : les codes restent affichés, et le téléchargement reste possible.
    }
  }

  function telecharger(): void {
    const url = URL.createObjectURL(new Blob([texteCodesSecours(codes, locale !== 'en')], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'engage-me-codes-de-secours.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4" data-testid="codes-secours">
      <p className="text-sm text-ink-900">
        {t('Vos codes de secours, si vous perdez votre téléphone. Chacun ne sert qu’une fois, et ils ne seront plus affichés.', 'Your backup codes, in case you lose your phone. Each works only once, and they will not be shown again.')}
      </p>
      <ol className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-controle bg-ink-50 px-3 py-2 font-mono text-sm text-ink-900" data-testid="codes-secours-liste">
        {codes.map((c) => <li key={c} className="whitespace-nowrap">{c}</li>)}
      </ol>
      <div className="flex flex-wrap gap-2">
        <Bouton type="button" variante="secondaire" taille="petite" onClick={() => { void copier(); }} data-testid="codes-secours-copier">
          {copies ? t('Copiés', 'Copied') : t('Copier', 'Copy')}
        </Bouton>
        <Bouton type="button" variante="secondaire" taille="petite" onClick={telecharger} data-testid="codes-secours-telecharger">
          {t('Télécharger', 'Download')}
        </Bouton>
      </div>
      <label className="flex items-center gap-2 text-sm text-ink-900">
        <input type="checkbox" checked={conserves} onChange={(e) => setConserves(e.target.checked)} data-testid="codes-secours-conserves" />
        {t('J’ai conservé ces codes', 'I have saved these codes')}
      </label>
      <Bouton type="button" className="w-full" disabled={!conserves} onClick={onContinuer} data-testid="codes-secours-continuer">
        {t('Continuer', 'Continue')}
      </Bouton>
    </div>
  );
}
