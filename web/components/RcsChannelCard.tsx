'use client';

import { useCallback, useEffect, useState } from 'react';
import { getRcsChannel, activateRcsChannel, deactivateRcsChannel, type RcsChannelInfo, type RcsChannelState } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { inputCls } from '@/lib/ui';

/**
 * Carte d'activation du canal RCS, sur l'accueil, sous le numéro WhatsApp.
 *
 * Le RCS n'a pas de numéro : ce qui signe les messages est un AGENT de marque, déposé chez un fournisseur et
 * approuvé par Google et les opérateurs. Activer revient donc à donner la clé du canal RCS de ce fournisseur.
 *
 * La clé n'est jamais relue ni réaffichée. Ce que la carte montre, c'est ce que la clé OUVRE : le nom de
 * l'agent tel que le destinataire le verra, le type de trafic, et les quotas restants. C'est l'information
 * dont un opérateur a besoin ; le secret, lui, ne lui sert à rien une fois posé.
 */
export function RcsChannelCard({ tenantId, isAdmin }: { tenantId: string; isAdmin: boolean }) {
  const t = useT();
  const [etat, setEtat] = useState<RcsChannelState | null>(null);
  const [ouvert, setOuvert] = useState(false);
  const [cle, setCle] = useState('');
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [droits, setDroits] = useState<RcsChannelInfo | null>(null);

  const recharger = useCallback(async () => {
    try {
      setEtat(await getRcsChannel(tenantId));
    } catch {
      setEtat({ active: false });
    }
  }, [tenantId]);

  useEffect(() => { void recharger(); }, [recharger]);

  async function activer() {
    if (cle.trim() === '') return;
    setBusy(true);
    setErreur(null);
    try {
      const r = await activateRcsChannel(tenantId, cle.trim());
      setDroits(r.channel);
      setCle('');
      setOuvert(false);
      await recharger();
    } catch (e) {
      // Le message vient du serveur et NOMME la cause (clé refusée, clé d'un canal SMS, fournisseur
      // injoignable). On l'affiche tel quel : c'est lui qui dit quoi demander au fournisseur.
      setErreur(e instanceof Error ? e.message : t('Activation impossible', 'Activation failed'));
    } finally {
      setBusy(false);
    }
  }

  async function couper() {
    if (!window.confirm(t('Couper le canal RCS ? Les blocs et campagnes RCS redeviendront inactifs.', 'Turn off the RCS channel? RCS blocks and campaigns will become inactive again.'))) return;
    setBusy(true);
    setErreur(null);
    try {
      await deactivateRcsChannel(tenantId);
      setDroits(null);
      await recharger();
    } catch (e) {
      setErreur(e instanceof Error ? e.message : t('Coupure impossible', 'Turn off failed'));
    } finally {
      setBusy(false);
    }
  }

  const actif = etat?.active === true;

  return (
    <div data-testid="rcs-channel-card" className="flex flex-col rounded-2xl border border-ink-200 bg-gradient-to-br from-white to-mint-50 p-5 shadow-sm">
      <div className="mb-3 flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-mint-100 text-lg">📱</div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold tracking-tight text-ink-900">{t('Canal RCS', 'RCS channel')}</div>
          <p className="mt-0.5 text-xs text-ink-500">
            {t('Vos messages partent sous votre agent de marque, avec votre nom et votre logo. Pas de numéro, pas de template à faire valider.', 'Your messages go out under your brand agent, with your name and logo. No number, no template to get approved.')}
          </p>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${actif ? 'bg-mint-100 text-mint-700' : 'bg-ink-100 text-ink-500'}`}>
          {actif ? t('actif', 'active') : t('inactif', 'inactive')}
        </span>
      </div>

      {actif && etat?.channel && (
        <div className="rounded-xl border border-ink-200 bg-white px-3 py-2 text-xs text-ink-700">
          <div className="font-medium text-ink-900">{etat.channel.displayName || etat.channel.brandName}</div>
          <div className="mt-0.5 text-ink-500">
            {t('Agent', 'Agent')} · {etat.channel.status === 'launched' ? t('lancé', 'launched') : t('en test', 'in test')}
          </div>
        </div>
      )}

      {/* Droits lus À L'ACTIVATION. On ne les rafraîchit pas en boucle : ce sont des quotas de fournisseur,
          pas une donnée temps réel, et un appel externe à chaque affichage de l'accueil serait du gâchis. */}
      {droits && (
        <dl className="mt-2 grid grid-cols-2 gap-2 text-xs">
          <div className="rounded-lg bg-white px-2 py-1.5">
            <dt className="text-ink-400">{t('Trafic', 'Traffic')}</dt>
            <dd className="font-medium text-ink-800">{droits.flow}</dd>
          </div>
          <div className="rounded-lg bg-white px-2 py-1.5">
            <dt className="text-ink-400">{t('Quota mensuel', 'Monthly quota')}</dt>
            <dd className="font-medium text-ink-800">{droits.monthlyUsed ?? 0} / {droits.monthlyLimit ?? '—'}</dd>
          </div>
        </dl>
      )}

      {erreur && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700" data-testid="rcs-channel-error">{erreur}</p>}

      {isAdmin && (
        <div className="mt-3">
          {!actif && !ouvert && (
            <button
              onClick={() => { setOuvert(true); setErreur(null); }}
              data-testid="rcs-channel-activate"
              className="rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-brand-600"
            >
              {t('Activer le RCS', 'Enable RCS')}
            </button>
          )}

          {!actif && ouvert && (
            <div className="space-y-2">
              <label className="block text-xs font-medium text-ink-600">{t('Clé d’API du canal RCS', 'RCS channel API key')}</label>
              <input
                value={cle}
                onChange={(e) => setCle(e.target.value)}
                type="password"
                autoComplete="off"
                data-testid="rcs-channel-key"
                className={inputCls}
                placeholder={t('Collez la clé fournie par votre fournisseur', 'Paste the key from your provider')}
              />
              <p className="text-[11px] text-ink-400">
                {t('Chez smsmode, une clé est rattachée à UN canal : demandez celle du canal RCS, pas celle du compte ni celle d’un canal SMS.', 'At smsmode, a key belongs to ONE channel: ask for the RCS channel key, not the account key nor an SMS channel key.')}
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => void activer()}
                  disabled={busy || cle.trim() === ''}
                  data-testid="rcs-channel-submit"
                  className="rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-40"
                >
                  {busy ? t('Vérification…', 'Checking…') : t('Vérifier et activer', 'Check and enable')}
                </button>
                <button onClick={() => { setOuvert(false); setCle(''); setErreur(null); }} className="text-sm text-ink-500 hover:underline">
                  {t('Annuler', 'Cancel')}
                </button>
              </div>
            </div>
          )}

          {actif && (
            <button onClick={() => void couper()} disabled={busy} className="text-sm text-ink-500 hover:text-coral hover:underline disabled:opacity-40">
              {t('Couper le canal RCS', 'Turn off the RCS channel')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
