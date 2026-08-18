'use client';

import { useCallback, useEffect, useState } from 'react';
import { useT } from '@/lib/i18n';
import { cardCls, inputCls } from '@/lib/ui';
import { MbaNotice } from './MbaNotice';
import { addMbaAllowlistEntry, listMbaAllowlist, removeMbaAllowlistEntry, type MbaAllowlistEntry } from '@/lib/api-mba';

/**
 * Les numéros que l'agent a le droit de gérer quand l'audience est restreinte.
 *
 * Le rappel sur l'audience n'est pas décoratif : une liste bien remplie ne protège de RIEN si l'audience est
 * restée « tout le monde », et l'inverse (audience restreinte, liste vide) éteint l'agent en pratique.
 */
export function MbaAllowlistPanel({ tenantId, phoneNumberId, audience }: {
  tenantId: string;
  phoneNumberId: string;
  audience: 'EVERYONE' | 'ALLOWLISTED_ONLY';
}) {
  const t = useT();
  const [entrees, setEntrees] = useState<MbaAllowlistEntry[]>([]);
  const [phone, setPhone] = useState('');
  const [chargement, setChargement] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const recharger = useCallback(async (): Promise<void> => {
    const { allowlist } = await listMbaAllowlist(tenantId, phoneNumberId);
    setEntrees(Array.isArray(allowlist) ? allowlist : []);
  }, [tenantId, phoneNumberId]);

  useEffect(() => {
    let vivant = true;
    recharger()
      .catch((e: unknown) => { if (vivant) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (vivant) setChargement(false); });
    return () => { vivant = false; };
  }, [recharger]);

  async function agir(action: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setErr('');
    try {
      await action();
      await recharger();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (chargement) return <p className="text-sm text-ink-500">{t('Chargement…', 'Loading…')}</p>;

  return (
    <div className="space-y-5">
      {err !== '' && <MbaNotice kind="error" testid="mba-allowlist-error">{err}</MbaNotice>}

      {audience === 'EVERYONE' && (
        <MbaNotice kind="warning" testid="mba-allowlist-inactive">
          {t(
            'L’audience est réglée sur « tout le monde » : cette liste n’a aucun effet pour l’instant. Passez l’audience sur « liste d’autorisation uniquement » dans Vue d’ensemble pour la rendre active.',
            'The audience is set to “everyone”: this list has no effect right now. Switch the audience to “allowlisted only” in Overview to make it active.',
          )}
        </MbaNotice>
      )}
      {audience === 'ALLOWLISTED_ONLY' && entrees.length === 0 && (
        <MbaNotice kind="warning" testid="mba-allowlist-empty">
          {t(
            'L’audience est restreinte et la liste est vide : l’agent ne répondra à personne.',
            'The audience is restricted and the list is empty: the agent will answer nobody.',
          )}
        </MbaNotice>
      )}

      <section className={cardCls}>
        <h3 className="text-sm font-semibold text-ink-900">{t('Ajouter un numéro', 'Add a number')}</h3>
        <div className="mt-3 flex gap-2">
          <input
            className={inputCls}
            data-testid="mba-allowlist-phone"
            placeholder="+33 6 12 34 56 78"
            value={phone}
            onChange={(e) => { setPhone(e.target.value); setErr(''); }}
          />
          <button
            className="shrink-0 rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            data-testid="mba-allowlist-add"
            disabled={busy || phone.trim() === ''}
            onClick={() => {
              const numero = phone.trim();
              setPhone('');
              void agir(() => addMbaAllowlistEntry(tenantId, phoneNumberId, numero));
            }}
          >
            {t('Ajouter', 'Add')}
          </button>
        </div>
      </section>

      <ul className="space-y-2" data-testid="mba-allowlist-list">
        {entrees.map((e) => (
          <li key={e.id ?? e.consumer_phone_number} className={`${cardCls} flex items-center justify-between gap-4 p-4`}>
            <span className="text-sm text-ink-900">{e.consumer_phone_number}</span>
            <button
              className="text-xs font-medium text-rose-600 hover:text-rose-700"
              onClick={() => {
                if (e.id === undefined) return;
                void agir(() => removeMbaAllowlistEntry(tenantId, phoneNumberId, e.id as string));
              }}
            >
              {t('Retirer', 'Remove')}
            </button>
          </li>
        ))}
        {entrees.length === 0 && <li className="text-sm text-ink-500">{t('Aucun numéro pour l’instant.', 'No numbers yet.')}</li>}
      </ul>
    </div>
  );
}
