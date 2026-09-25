'use client';

import { useCallback, useEffect, useState } from 'react';
import { useT } from '@/lib/i18n';
import { cardCls, inputCls } from '@/lib/ui';
import { MbaNotice } from './MbaNotice';
import { isSendableButtonUrl } from '@/lib/button-url';
import { createMbaWebsite, deleteMbaWebsite, listMbaWebsites, type MbaWebsite } from '@/lib/api-mba';
import { Bouton } from '@/components/Bouton';
import { BoutonConfirme } from '@/components/Confirmation';
import { Squelette } from '@/components/Squelette';

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
  if (s === 'COMPLETED') return { texte: t('Exploré', 'Crawled'), classe: 'bg-succes-50 text-succes-700' };
  if (s === 'FAILED') return { texte: t('Échec', 'Failed'), classe: 'bg-danger-50 text-danger-700' };
  if (s === 'PENDING' || s === 'IN_PROGRESS') return { texte: t('En cours', 'In progress'), classe: 'bg-alerte-100 text-ink-900' };
  // Champ absent ou valeur non prévue : ni succès ni échec, on affiche la valeur brute.
  return { texte: brut && brut !== '' ? brut : t('Inconnu', 'Unknown'), classe: 'bg-ink-100 text-ink-500' };
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

  if (chargement) return <Squelette forme="lignes" />;

  return (
    <div className="space-y-5">
      {err !== '' && <MbaNotice kind="error" testid="mba-websites-error">{err}</MbaNotice>}

      <section className={cardCls}>
        <h3 className="text-sm font-semibold text-ink-900">{t('Ajouter une page', 'Add a page')}</h3>
        <p className="mt-1 text-xs leading-relaxed text-ink-500">
          {t(
            'Meta explore l’adresse indiquée. Le périmètre ne se règle pas : on ne peut pas exclure une section, donc choisissez une adresse précise plutôt que la racine du site.',
            'Meta crawls the given address. The scope cannot be tuned: no section can be excluded, so pick a precise address rather than the site root.',
          )}
        </p>
        <div className="mt-3 flex gap-2">
          <input
            className={inputCls}
            data-testid="mba-website-url"
            placeholder={t('https://www.exemple.fr/aide', 'https://www.example.com/help')}
            value={url}
            onChange={(e) => { setUrl(e.target.value); setErr(''); }}
          />
          <Bouton
            className="shrink-0"
            data-testid="mba-website-add"
            disabled={busy || url.trim() === ''}
            onClick={ajouter}
          >
            {t('Ajouter', 'Add')}
          </Bouton>
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
              <BoutonConfirme
                className="shrink-0 text-xs font-medium text-danger-700 hover:text-danger-800"
                question={t('Retirer ce site de la connaissance de l’agent ?', 'Remove this site from the agent’s knowledge?')}
                libelleConfirmer={t('Retirer', 'Remove')}
                onConfirme={() => {
                  if (s.id === undefined) return;
                  void agir(() => deleteMbaWebsite(tenantId, phoneNumberId, s.id as string));
                }}
              >
                {t('Retirer', 'Remove')}
              </BoutonConfirme>
            </li>
          );
        })}
        {sites.length === 0 && <li className="text-sm text-ink-500">{t('Aucune page pour l’instant.', 'No pages yet.')}</li>}
      </ul>
    </div>
  );
}
