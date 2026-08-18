'use client';

import { useCallback, useEffect, useState } from 'react';
import { useT } from '@/lib/i18n';
import { cardCls, inputCls } from '@/lib/ui';
import { MbaNotice } from './MbaNotice';
import { addMbaAllowlistEntry, listMbaAllowlist, removeMbaAllowlistEntry, type MbaAllowlistEntry } from '@/lib/api-mba';

/**
 * Les numéros de TEST : ceux que l'agent a le droit de gérer quand l'audience est restreinte.
 *
 * ⚠️ Ce n'est PAS un mode d'exploitation. Personne n'autorise ses clients un par un. Meta n'offre que deux
 * audiences, « tout le monde » (le mode normal) et « liste d'autorisation uniquement », et la seconde n'existe
 * que pour essayer l'agent sur un vrai numéro avec son propre téléphone avant de l'ouvrir. C'est pour cela que
 * cette liste vit DANS la vue d'ensemble, sous le choix d'audience, et non dans un onglet à elle : sa place
 * disait « étape normale de configuration » alors qu'elle est un banc d'essai.
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
    <section className={`${cardCls} space-y-4`}>
      <div>
        <h3 className="text-sm font-semibold text-ink-900">{t('Numéros de test', 'Test numbers')}</h3>
        <p className="mt-1 text-xs leading-relaxed text-ink-600">
          {t(
            'Quand l’audience est restreinte, l’agent ne répond QU’À ces numéros. Sert à l’essayer sur votre vrai numéro avant de l’ouvrir à vos clients, pas à autoriser les clients un par un.',
            'When the audience is restricted, the agent answers ONLY these numbers. Use it to try the agent on your own number before opening it to your customers, not to allow customers one by one.',
          )}
        </p>
      </div>
      {err !== '' && <MbaNotice kind="error" testid="mba-allowlist-error">{err}</MbaNotice>}

      {audience === 'EVERYONE' && (
        <MbaNotice kind="warning" testid="mba-allowlist-inactive">
          {t(
            'L’audience est réglée sur « tout le monde » : cette liste n’a aucun effet. Elle ne sert que si vous passez l’audience juste au-dessus sur « liste d’autorisation uniquement », le temps d’un essai.',
            'The audience is set to “everyone”: this list has no effect. It only matters if you switch the audience just above to “allowlisted only”, for the duration of a trial.',
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

      <div>
        <div className="flex gap-2">
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
      </div>

      <ul className="space-y-2" data-testid="mba-allowlist-list">
        {entrees.map((e) => (
          <li key={e.id ?? e.consumer_phone_number} className="flex items-center justify-between gap-4 rounded-lg border border-ink-100 px-3 py-2">
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
    </section>
  );
}
