'use client';

import { useCallback, useEffect, useState } from 'react';
import { useT, useLocale } from '@/lib/i18n';
import { cardCls } from '@/lib/ui';
import { formatDate } from '@/lib/day';
import { listBlockedContacts, setContactBlocked, type BlockedContact } from '@/lib/api';

/**
 * Contacts bloqués : la SEULE porte de sortie d'un blocage.
 *
 * Un contact bloqué n'apparaît plus dans l'inbox et n'est plus joignable par campagne. Sans cet écran, il
 * serait donc introuvable, donc perdu. C'est pour cette raison qu'il fait partie du même lot que le blocage
 * et non d'un lot suivant.
 */
export function BlockedContacts({ tenantId }: { tenantId: string }) {
  const t = useT();
  const { locale } = useLocale();
  const [contacts, setContacts] = useState<BlockedContact[]>([]);
  const [chargement, setChargement] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [erreur, setErreur] = useState('');

  const recharger = useCallback(async () => {
    try {
      const r = await listBlockedContacts(tenantId);
      // `Array.isArray` et pas seulement le try/catch : une réponse 200 sans `contacts` (backend antérieur)
      // poserait `undefined` dans un état typé tableau, et le rendu suivant casserait toute la page.
      setContacts(Array.isArray(r?.contacts) ? r.contacts : []);
      setErreur('');
    } catch (e) {
      setErreur(e instanceof Error ? e.message : String(e));
      setContacts([]);
    } finally {
      setChargement(false);
    }
  }, [tenantId]);
  useEffect(() => { void recharger(); }, [recharger]);

  async function debloquer(c: BlockedContact): Promise<void> {
    setBusy(c.id);
    try {
      await setContactBlocked(tenantId, c.id, false);
      await recharger();
    } catch (e) {
      setErreur(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  // Section masquée quand il n'y a rien à montrer ET rien à dire : un encadré vide en permanence dans les
  // réglages est du bruit. L'erreur, elle, s'affiche : « je n'ai pas pu lire » n'est pas « il n'y en a pas ».
  if (chargement || (contacts.length === 0 && erreur === '')) return null;

  return (
    <section className={cardCls} data-testid="blocked-contacts">
      <h3 className="text-sm font-semibold text-ink-900">{t('Contacts bloqués', 'Blocked contacts')}</h3>
      <p className="mt-1 text-xs text-ink-500">
        {t(
          'Ces contacts ne reçoivent plus aucun message, et leurs conversations n’apparaissent plus dans l’inbox. Leurs messages continuent d’être enregistrés.',
          'These contacts no longer receive any message, and their conversations no longer appear in the inbox. Their messages are still recorded.',
        )}
      </p>
      {erreur !== '' && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{erreur}</p>}
      <ul className="mt-3 space-y-2">
        {contacts.map((c) => (
          <li key={c.id} className="flex items-center justify-between gap-3 rounded-lg border border-ink-200 px-3 py-2">
            <span className="min-w-0">
              <span className="block truncate text-sm text-ink-800">{c.profileName ?? c.phoneE164 ?? c.id}</span>
              <span className="block text-xs text-ink-400">
                {t('bloqué le ', 'blocked on ')}{formatDate(c.blockedAt, locale)}
              </span>
            </span>
            <button
              onClick={() => { void debloquer(c); }}
              disabled={busy === c.id}
              data-testid={`unblock-${c.id}`}
              className="shrink-0 rounded-lg border border-ink-300 px-2.5 py-1 text-xs font-medium text-ink-700 transition hover:bg-ink-50 disabled:opacity-50"
            >
              {busy === c.id ? t('…', '…') : t('Débloquer', 'Unblock')}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
