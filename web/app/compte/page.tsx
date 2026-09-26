'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import {
  changePassword, lireSecondFacteur, enrolerMoi, activerMoi, regenererCodesSecours, desactiverSecondFacteur, estCodeRefuse,
  type EtatSecondFacteur,
} from '@/lib/api';
import type { Session } from '@/lib/session';
import { useT, useLocale } from '@/lib/i18n';
import { inputCls } from '@/lib/ui';
import { erreurDeChargement } from '@/lib/http';
import { formatDate } from '@/lib/day';
import { MIN_MOT_DE_PASSE, aideMotDePasse } from '@/lib/mot-de-passe';
import { Bouton } from '@/components/Bouton';
import { TitrePage } from '@/components/TitrePage';
import { Squelette } from '@/components/Squelette';
import { Enrolement, CodesSecours } from '@/components/SecondFacteur';

/**
 * MON COMPTE, DANS LA COQUILLE DE LA CONSOLE (passe 2, 2026-09-25). La page vivait seule, avec un lien
 * « ← Retour » : on quittait la console pour changer un mot de passe, et on la retrouvait en rechargeant la
 * page d'arrivée. Elle garde son contenu, et tous les rôles y ont accès (`accesAutorise`).
 */
export default function ComptePage() {
  return <AppShell active="compte">{(session) => <Compte session={session} />}</AppShell>;
}

function Compte({ session }: { session: Session }) {
  const t = useT();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setLoading(true);
    try {
      await changePassword(current, next);
      setMsg({ kind: 'ok', text: t('Mot de passe mis à jour.', 'Password updated.') });
      setCurrent('');
      setNext('');
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : t('Changement impossible', 'Unable to change password') });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-formulaire">
      <TitrePage>{t('Mon compte', 'My account')}</TitrePage>
      <p className="mt-1 text-sm text-ink-500">{session.email}</p>

      <form onSubmit={onSubmit} className="mt-6 max-w-md space-y-4 rounded-carte border border-ink-200 bg-white p-6">
        <h2 className="text-sm font-semibold text-ink-900">{t('Changer le mot de passe', 'Change password')}</h2>
        <div>
          <label className="mb-1 block text-sm font-medium text-ink-900">{t('Mot de passe actuel', 'Current password')}</label>
          <input type="password" required value={current} onChange={(e) => setCurrent(e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-ink-900">{t('Nouveau mot de passe', 'New password')}</label>
          <input type="password" required minLength={MIN_MOT_DE_PASSE} value={next} onChange={(e) => setNext(e.target.value)} className={inputCls} placeholder={t(aideMotDePasse().fr, aideMotDePasse().en)} />
        </div>
        {msg && <p className={`rounded-controle px-3 py-2 text-sm ${msg.kind === 'ok' ? 'bg-succes-50 text-succes-800' : 'bg-danger-50 text-danger-700'}`}>{msg.text}</p>}
        <Bouton enCours={loading} type="submit" disabled={loading} className="w-full">
          {loading ? t('Mise à jour…', 'Updating…') : t('Mettre à jour', 'Update')}
        </Bouton>
      </form>

      <DoubleAuthentification />
    </div>
  );
}

/**
 * LA DOUBLE AUTHENTIFICATION DE LA PERSONNE CONNECTÉE (plan du 2026-09-25) : son état, l'activer, régénérer ses
 * codes de secours, la désactiver. Les deux derniers gestes demandent un code, même avec une session : une
 * session volée ne doit ni se fabriquer des codes ni retirer le facteur.
 *
 * ⚠️ La désactivation n'est pas proposée à un administrateur (le serveur la refuserait) : le facteur est
 * obligatoire pour lui, et une phrase le dit.
 */
function DoubleAuthentification() {
  const t = useT();
  const { locale } = useLocale();
  const [etat, setEtat] = useState<EtatSecondFacteur | null>(null);
  const [erreurChargement, setErreurChargement] = useState<string | null>(null);
  const [geste, setGeste] = useState<'activer' | 'regenerer' | 'desactiver' | null>(null);
  /** Les codes régénérés, montrés une fois puis oubliés. */
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState('');
  const [envoi, setEnvoi] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const charger = useCallback(async () => {
    try {
      setEtat(await lireSecondFacteur());
      setErreurChargement(null);
    } catch (err) {
      setErreurChargement(erreurDeChargement(err, t));
    }
  }, [t]);

  useEffect(() => { void charger(); }, [charger]);

  function ouvrir(g: 'activer' | 'regenerer' | 'desactiver'): void {
    setGeste(g);
    setCode('');
    setMsg(null);
  }

  function terminer(texte: string | null): void {
    setGeste(null);
    setCode('');
    setMsg(texte ? { kind: 'ok', text: texte } : null);
    void charger();
  }

  async function confirmerAvecCode(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setMsg(null);
    setEnvoi(true);
    try {
      if (geste === 'regenerer') {
        const res = await regenererCodesSecours(code.trim());
        setGeste(null);
        setCode('');
        setCodes(res.codesSecours);
      } else {
        await desactiverSecondFacteur(code.trim());
        terminer(t('Double authentification désactivée.', 'Two-factor authentication disabled.'));
      }
    } catch (err) {
      setCode('');
      setMsg({
        kind: 'err',
        text: estCodeRefuse(err) ? t('Code invalide ou expiré.', 'Invalid or expired code.') : err instanceof Error ? err.message : t('Action impossible', 'Action failed'),
      });
    } finally {
      setEnvoi(false);
    }
  }

  function contenu(): React.ReactNode {
    if (erreurChargement) return <p className="rounded-controle bg-danger-50 px-3 py-2 text-sm text-danger-700">{erreurChargement}</p>;
    if (etat === null) return <Squelette lignes={2} />;
    if (codes) return <CodesSecours codes={codes} onContinuer={() => { setCodes(null); terminer(t('Nouveaux codes de secours enregistrés.', 'New backup codes saved.')); }} />;
    if (geste === 'activer') {
      return (
        <Enrolement
          intro={t('Scannez ce code avec votre application d’authentification.', 'Scan this code with your authenticator app.')}
          demarrer={enrolerMoi}
          activer={activerMoi}
          onActive={() => terminer(t('Double authentification activée.', 'Two-factor authentication enabled.'))}
          abandon={{ libelle: t('Annuler', 'Cancel'), action: () => setGeste(null) }}
        />
      );
    }
    if (geste === 'regenerer' || geste === 'desactiver') {
      return (
        <form onSubmit={confirmerAvecCode} className="space-y-3" data-testid="mfa-demande-code">
          <p className="text-sm text-ink-900">
            {geste === 'regenerer'
              ? t('Les codes de secours actuels cesseront de fonctionner.', 'Your current backup codes will stop working.')
              : t('Vous vous connecterez ensuite avec votre seul mot de passe.', 'You will then sign in with your password only.')}
          </p>
          <div>
            <label htmlFor="mfa-code" className="mb-1 block text-sm font-medium text-ink-900">{t('Code de votre application, ou code de secours', 'Code from your app, or a backup code')}</label>
            <input
              id="mfa-code"
              data-testid="mfa-code"
              required
              autoFocus
              autoComplete="one-time-code"
              spellCheck={false}
              maxLength={24}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className={`${inputCls} font-mono tracking-widest`}
            />
          </div>
          {msg && <p className="rounded-controle bg-danger-50 px-3 py-2 text-sm text-danger-700" data-testid="mfa-message">{msg.text}</p>}
          <div className="flex flex-wrap gap-2">
            <Bouton type="submit" enCours={envoi} disabled={envoi || code.trim() === ''}>
              {geste === 'regenerer' ? t('Régénérer', 'Regenerate') : t('Désactiver', 'Disable')}
            </Bouton>
            <Bouton type="button" variante="secondaire" onClick={() => { setGeste(null); setMsg(null); }}>{t('Annuler', 'Cancel')}</Bouton>
          </div>
        </form>
      );
    }
    return (
      <div className="space-y-3">
        <p className="text-sm text-ink-900" data-testid="mfa-etat">
          {etat.actif
            ? `${etat.activeLe ? t(`Activée le ${formatDate(etat.activeLe, locale)}.`, `Enabled on ${formatDate(etat.activeLe, locale)}.`) : t('Activée.', 'Enabled.')} ${t(`Codes de secours restants : ${etat.codesSecoursRestants}.`, `Backup codes left: ${etat.codesSecoursRestants}.`)}`
            : t('Désactivée.', 'Disabled.')}
        </p>
        {msg && (
          <p className={`rounded-controle px-3 py-2 text-sm ${msg.kind === 'ok' ? 'bg-succes-50 text-succes-800' : 'bg-danger-50 text-danger-700'}`} data-testid="mfa-message">{msg.text}</p>
        )}
        {etat.actif ? (
          <>
            <div className="flex flex-wrap gap-2">
              <Bouton type="button" variante="secondaire" onClick={() => ouvrir('regenerer')} data-testid="mfa-regenerer">{t('Régénérer les codes de secours', 'Regenerate backup codes')}</Bouton>
              {!etat.obligatoire && (
                <Bouton type="button" variante="secondaire" onClick={() => ouvrir('desactiver')} data-testid="mfa-desactiver">{t('Désactiver', 'Disable')}</Bouton>
              )}
            </div>
            {etat.obligatoire && (
              <p className="text-xs text-ink-500" data-testid="mfa-obligatoire">{t('Obligatoire pour les administrateurs : elle ne peut pas être désactivée.', 'Required for administrators: it cannot be disabled.')}</p>
            )}
          </>
        ) : (
          <Bouton type="button" onClick={() => ouvrir('activer')} data-testid="mfa-activer">{t('Activer', 'Enable')}</Bouton>
        )}
      </div>
    );
  }

  return (
    <section className="mt-6 max-w-md space-y-4 rounded-carte border border-ink-200 bg-white p-6" data-testid="mfa-bloc">
      <h2 className="text-sm font-semibold text-ink-900">{t('Double authentification', 'Two-factor authentication')}</h2>
      {contenu()}
    </section>
  );
}
