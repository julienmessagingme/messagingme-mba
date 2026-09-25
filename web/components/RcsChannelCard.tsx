'use client';

import { useCallback, useEffect, useState } from 'react';
import { getRcsChannel, activateRcsChannel, deactivateRcsChannel, type RcsChannelInfo, type RcsChannelState } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { inputCls } from '@/lib/ui';

/**
 * L'état du canal RCS et ses deux gestes, partagés par la carte ci-dessous et par l'interrupteur « Canal RCS »
 * du bloc « Canaux et services » de l'Accueil.
 *
 * 🔴 UNE SEULE INSTANCE PAR PAGE, créée par l'Accueil et passée aux deux. Deux instances liraient deux états :
 * couper le canal depuis l'interrupteur laisserait la carte annoncer « actif » jusqu'au prochain chargement.
 *
 * ⚠️ `couper` NE DEMANDE PLUS DE CONFIRMATION ici : c'est l'interrupteur qui la pose, avec le texte de ce que
 * l'extinction arrête. L'ancien lien « Couper le canal RCS » de la carte est devenu cet interrupteur (plan du
 * 2026-09-25) : deux portes pour le même geste auraient eu deux confirmations à tenir alignées.
 */
export interface CanalRcs {
  /**
   * `null` = pas encore lu ; `'echec'` = la lecture a échoué, donc on ne SAIT PAS.
   *
   * 🔴 L'ÉCHEC N'EST PLUS `{ active: false }` (relecture du 2026-09-25) : l'interrupteur de l'Accueil le lisait
   * « éteint », sa pastille passait au gris et sa phrase disait « Inactif », alors que rien de tel n'avait été lu.
   * L'Accueil en fait désormais une carte sans interrupteur ni pastille, qui dit « État inconnu ».
   */
  etat: RcsChannelState | 'echec' | null;
  /** Le formulaire de la clé est-il ouvert ? */
  ouvert: boolean;
  /** Ouvre l'activation actuelle (la clé du canal) et amène la carte à l'écran. */
  ouvrirActivation(): void;
  fermerActivation(): void;
  cle: string;
  setCle(v: string): void;
  busy: boolean;
  erreur: string | null;
  /** Quotas lus à l'activation. */
  droits: RcsChannelInfo | null;
  activer(): Promise<void>;
  /** Coupe le canal, SANS confirmation : l'appelant l'a déjà demandée. Lève en cas d'échec. */
  couper(): Promise<void>;
}

/** Identifiant de la carte : l'interrupteur y amène l'écran quand il ouvre l'activation. */
export const ANCRE_CANAL_RCS = 'canal-rcs';

export function useCanalRcs(tenantId: string): CanalRcs {
  const t = useT();
  const [etat, setEtat] = useState<RcsChannelState | 'echec' | null>(null);
  const [ouvert, setOuvert] = useState(false);
  const [cle, setCle] = useState('');
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [droits, setDroits] = useState<RcsChannelInfo | null>(null);

  const recharger = useCallback(async () => {
    try {
      setEtat(await getRcsChannel(tenantId));
    } catch {
      setEtat('echec');
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
    setBusy(true);
    setErreur(null);
    try {
      await deactivateRcsChannel(tenantId);
      setDroits(null);
      await recharger();
    } finally {
      setBusy(false);
    }
  }

  return {
    etat, ouvert, cle, setCle, busy, erreur, droits, activer, couper,
    ouvrirActivation: () => {
      setOuvert(true);
      setErreur(null);
      if (typeof document !== 'undefined') document.getElementById(ANCRE_CANAL_RCS)?.scrollIntoView({ block: 'center' });
    },
    fermerActivation: () => { setOuvert(false); setCle(''); setErreur(null); },
  };
}

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
export function RcsChannelCard({ rcs, isAdmin }: { rcs: CanalRcs; isAdmin: boolean }) {
  const t = useT();
  const { ouvert, cle, busy, erreur, droits } = rcs;
  // Lecture en échec : la carte le DIT, et ne propose pas d'activer un canal peut-être déjà actif.
  const inconnu = rcs.etat === 'echec';
  const etat = rcs.etat === 'echec' ? null : rcs.etat;
  const actif = etat?.active === true;

  return (
    <div id={ANCRE_CANAL_RCS} data-testid="rcs-channel-card" className="flex flex-col rounded-2xl border border-ink-200 bg-gradient-to-br from-white to-mint-50 p-5 shadow-sm">
      <div className="mb-3 flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-mint-100 text-lg">📱</div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold tracking-tight text-ink-900">{t('Canal RCS', 'RCS channel')}</div>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${actif ? 'bg-mint-100 text-mint-700' : 'bg-ink-100 text-ink-500'}`}>
          {inconnu ? t('état inconnu', 'state unknown') : actif ? t('actif', 'active') : t('inactif', 'inactive')}
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

      {isAdmin && !inconnu && (
        <div className="mt-3">
          {!actif && !ouvert && (
            <button
              onClick={() => rcs.ouvrirActivation()}
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
                onChange={(e) => rcs.setCle(e.target.value)}
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
                  onClick={() => void rcs.activer()}
                  disabled={busy || cle.trim() === ''}
                  data-testid="rcs-channel-submit"
                  className="rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-40"
                >
                  {busy ? t('Vérification…', 'Checking…') : t('Vérifier et activer', 'Check and enable')}
                </button>
                <button onClick={() => rcs.fermerActivation()} className="text-sm text-ink-500 hover:underline">
                  {t('Annuler', 'Cancel')}
                </button>
              </div>
            </div>
          )}

          {/* Le lien « Couper le canal RCS » est devenu l'interrupteur « Canal RCS » du bloc « Canaux et
              services », juste au-dessus (plan du 2026-09-25) : une seule porte, une seule confirmation. */}
        </div>
      )}
    </div>
  );
}
