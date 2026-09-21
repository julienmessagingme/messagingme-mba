'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { listRequetes } from '@/lib/api-agent-requetes';
import type { TypeOutilMba } from '@/lib/api-mba-outils';
import { TEXTES_PAR_TYPE } from '@/lib/mba-outils';
import { useT } from '@/lib/i18n';

/** Les types proposés, dans l'ordre du croquis de Julien (2026-09-21). Le lot 3 ajoute bloc et scénario. */
export const TYPES_PROPOSES: readonly TypeOutilMba[] = ['tag', 'champ', 'connecteur'];

/**
 * « QUEL OUTIL AJOUTER ? » (spec 2026-09-21-outils-maison-mba, § 9.4).
 *
 * 🔴 « APPELER UN CONNECTEUR API » EST GRISÉ, PAS CACHÉ, quand l'espace n'a déclaré aucun appel : un client qui
 * débute doit apprendre que ça existe, et où le déclarer (arbitrage du 2026-09-21).
 */
export function ChoixTypeOutil({ tenantId, onChoisir, onAnnuler }: {
  tenantId: string; onChoisir: (type: TypeOutilMba) => void; onAnnuler: () => void;
}) {
  const t = useT();
  const [appels, setAppels] = useState<number | null>(null);
  useEffect(() => {
    let vivant = true;
    listRequetes(tenantId)
      .then((r) => { if (vivant) setAppels(Array.isArray(r?.requetes) ? r.requetes.length : 0); })
      .catch(() => { if (vivant) setAppels(0); });
    return () => { vivant = false; };
  }, [tenantId]);
  return (
    <section className="rounded-2xl border border-ink-200 bg-white p-4" data-testid="mba-types">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-semibold text-ink-900">{t('Quel outil ajouter ?', 'Which tool to add?')}</p>
        <button type="button" data-testid="mba-types-annuler" onClick={onAnnuler} className="text-xs text-ink-500 hover:underline">
          {t('Annuler', 'Cancel')}
        </button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {TYPES_PROPOSES.map((type) => {
          const x = TEXTES_PAR_TYPE[type];
          const indisponible = type === 'connecteur' && appels === 0;
          const enAttente = type === 'connecteur' && appels === null;
          return (
            <div key={type}
              className={`rounded-xl border p-4 ${indisponible ? 'border-dashed border-ink-200 opacity-60' : 'border-ink-200 hover:border-brand-300 hover:bg-brand-50'}`}>
              <button type="button" disabled={indisponible || enAttente} data-testid={`mba-type-${type}`}
                onClick={() => onChoisir(type)} className="block w-full text-left disabled:cursor-not-allowed">
                <span className="block text-sm font-semibold text-ink-900">{t(x.titre[0], x.titre[1])}</span>
                <span className="mt-1 block text-xs text-ink-500">{t(x.aide[0], x.aide[1])}</span>
              </button>
              {indisponible && (
                <Link href="/connecteurs" data-testid="mba-type-connecteur-lien" className="mt-2 block text-xs text-brand-600 underline">
                  {t('Aucun appel déclaré : Tools > Connecteurs API', 'No call declared: Tools > API connectors')}
                </Link>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
