'use client';

import { useCallback, useEffect, useState } from 'react';
import { useT } from '@/lib/i18n';
import { cardCls, inputCls } from '@/lib/ui';
import { MbaNotice } from './MbaNotice';
import { isSendableButtonUrl } from '@/lib/button-url';
import { createMbaWebsite, deleteMbaWebsite, listMbaWebsites, type MbaWebsite } from '@/lib/api-mba';

/**
 * Les pages du site que Meta explore pour nourrir l'agent.
 *
 * ⚠️ Aucun réglage de périmètre n'existe dans l'API : ni profondeur, ni fréquence, ni exclusion. Le seul levier
 * réel est de choisir l'adresse soumise. C'est dit à l'écran, sinon le client croit pouvoir exclure son blog.
 *
 * ⚠️ Le statut d'exploration n'a pas de casse garantie chez Meta (« completed » dans la description,
 * « COMPLETED » dans l'exemple) et peut être absent. Une valeur inconnue n'est JAMAIS traitée comme un succès.
 */

function libelleStatut(brut: string | undefined, t: (fr: string, en?: string) => string): { texte: string; classe: string } {
  const s = (brut ?? '').toUpperCase();
  if (s === 'COMPLETED') return { texte: t('Exploré', 'Crawled'), classe: 'bg-emerald-50 text-emerald-700' };
  if (s === 'FAILED') return { texte: t('Échec', 'Failed'), classe: 'bg-rose-50 text-rose-700' };
  if (s === 'PENDING' || s === 'IN_PROGRESS') return { texte: t('En cours', 'In progress'), classe: 'bg-gold/20 text-ink-700' };
  // Champ absent ou valeur non prévue : ni succès ni échec, on affiche la valeur brute.
  return { texte: brut && brut !== '' ? brut : t('Inconnu', 'Unknown'), classe: 'bg-ink-100 text-ink-600' };
}

export function MbaWebsitesPanel({ tenantId, phoneNumberId }: { tenantId: string; phoneNumberId: string }) {
  const t = useT();
  const [sites, setSites] = useState<MbaWebsite[]>([]);
  const [url, setUrl] = useState('');
  const [chargement, setChargement] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const recharger = useCallback(async (): Promise<void> => {
    const { websites } = await listMbaWebsites(tenantId, phoneNumberId);
    setSites(Array.isArray(websites) ? websites : []);
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

  function ajouter(): void {
    const adresse = url.trim();
    // Refusé ICI : le schéma Meta est un simple `string`, une adresse sans `https://` revient en 400 illisible.
    if (!isSendableButtonUrl(adresse)) {
      setErr(t('Adresse invalide : indiquez l’adresse complète, par exemple https://www.exemple.fr', 'Invalid address: give the full address, for example https://www.example.com'));
      return;
    }
    setUrl('');
    void agir(() => createMbaWebsite(tenantId, phoneNumberId, adresse));
  }

  if (chargement) return <p className="text-sm text-ink-500">{t('Chargement…', 'Loading…')}</p>;

  return (
    <div className="space-y-5">
      {err !== '' && <MbaNotice kind="error" testid="mba-websites-error">{err}</MbaNotice>}

      <section className={cardCls}>
        <h3 className="text-sm font-semibold text-ink-900">{t('Ajouter une page', 'Add a page')}</h3>
        <p className="mt-1 text-xs leading-relaxed text-ink-600">
          {t(
            'Meta explore l’adresse indiquée. Le périmètre ne se règle pas : on ne peut pas exclure une section, donc choisissez une adresse précise plutôt que la racine du site.',
            'Meta crawls the given address. The scope cannot be tuned: no section can be excluded, so pick a precise address rather than the site root.',
          )}
        </p>
        <div className="mt-3 flex gap-2">
          <input
            className={inputCls}
            data-testid="mba-website-url"
            placeholder="https://www.exemple.fr/aide"
            value={url}
            onChange={(e) => { setUrl(e.target.value); setErr(''); }}
          />
          <button
            className="shrink-0 rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            data-testid="mba-website-add"
            disabled={busy || url.trim() === ''}
            onClick={ajouter}
          >
            {t('Ajouter', 'Add')}
          </button>
        </div>
      </section>

      <ul className="space-y-2" data-testid="mba-websites-list">
        {sites.map((s) => {
          const statut = libelleStatut(s.crawl_status, t);
          return (
            <li key={s.id ?? s.url} className={`${cardCls} flex items-center justify-between gap-4 p-4`}>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-ink-900">{s.url}</p>
                <p className="mt-1 flex items-center gap-2 text-xs text-ink-500">
                  <span className={`rounded-full px-2 py-0.5 ${statut.classe}`}>{statut.texte}</span>
                  {s.pages_crawled !== undefined && <span>{t(`${s.pages_crawled} page(s)`, `${s.pages_crawled} page(s)`)}</span>}
                </p>
              </div>
              <button
                className="shrink-0 text-xs font-medium text-rose-600 hover:text-rose-700"
                onClick={() => {
                  if (s.id === undefined) return;
                  if (!window.confirm(t(`Retirer ${s.url} de la connaissance de l’agent ?`, `Remove ${s.url} from the agent’s knowledge?`))) return;
                  void agir(() => deleteMbaWebsite(tenantId, phoneNumberId, s.id as string));
                }}
              >
                {t('Retirer', 'Remove')}
              </button>
            </li>
          );
        })}
        {sites.length === 0 && <li className="text-sm text-ink-500">{t('Aucune page pour l’instant.', 'No pages yet.')}</li>}
      </ul>
    </div>
  );
}
