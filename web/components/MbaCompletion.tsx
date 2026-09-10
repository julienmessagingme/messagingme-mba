'use client';

import { useEffect, useState } from 'react';
import { getMbaCompletion, type CompletionMba, type TacheMba } from '@/lib/api-mba';
import { useT } from '@/lib/i18n';

/**
 * « Où en est la configuration de l'agent », au-dessus des onglets.
 *
 * Demandé par Julien le 2026-09-10, et pas pour imiter Meta : parce que nos onglets ne DISENT pas ce qui
 * manque. Il faut les ouvrir un par un pour découvrir qu'un réglage obligatoire est vide, et c'est
 * exactement comme ça que les compétences sont restées vides pendant que l'agent répondait à tout le monde.
 *
 * 🔴 CE QU'ON MONTRE ET QUE META NE MONTRE PAS : la RAISON. Son écran affiche une coche ou un cercle vide ;
 * le nôtre dit « 4 compétences en relecture chez Meta, elles n'agissent pas encore » ou « 1 site déclaré,
 * mais AUCUNE page aspirée ». C'est la différence entre savoir qu'il manque quelque chose et savoir quoi
 * faire. Les deux exemples ci-dessus sont réels, mesurés sur notre propre numéro le même jour, et le second
 * portait une coche VERTE chez Meta.
 *
 * ⚠️ RIEN NE S'AFFICHE TANT QUE LA LECTURE N'A PAS ABOUTI. Une barre à « 0 sur 4 » pendant le chargement
 * annoncerait une configuration vide sur un agent parfaitement réglé, et c'est le premier écran que le
 * client voit en arrivant.
 */

const LIBELLES: Record<TacheMba['cle'], { fr: string; en: string; onglet?: string }> = {
  business_info: { fr: 'Informations', en: 'Business info', onglet: 'business' },
  faq: { fr: 'FAQ', en: 'FAQs', onglet: 'faq' },
  competences: { fr: 'Compétences', en: 'Skills', onglet: 'competences' },
  activation: { fr: 'Activation', en: 'Activation', onglet: 'activation' },
  paiement: { fr: 'Moyen de paiement', en: 'Payment method' },
  fichiers: { fr: 'Fichiers', en: 'Files', onglet: 'fichiers' },
  sites: { fr: 'Sites web', en: 'Websites', onglet: 'sites' },
  connecteurs: { fr: 'Connecteurs', en: 'Connectors' },
  outils: { fr: 'Outils', en: 'Tools' },
};

export function MbaCompletion({ tenantId, phoneNumberId, onOnglet }: {
  tenantId: string;
  phoneNumberId: string;
  /** Ouvre l'onglet concerné : une liste de ce qui manque doit mener à l'endroit où on le règle. */
  onOnglet?: (cle: string) => void;
}) {
  const t = useT();
  const [c, setC] = useState<CompletionMba | null>(null);

  useEffect(() => {
    let vivant = true;
    setC(null);
    getMbaCompletion(tenantId, phoneNumberId)
      .then((r) => { if (vivant && Array.isArray(r?.taches)) setC(r); })
      .catch(() => { if (vivant) setC(null); });
    return () => { vivant = false; };
  }, [tenantId, phoneNumberId]);

  if (c === null) return null;

  const manquantes = c.taches.filter((x) => x.etat === 'a_faire');
  const aSignaler = c.taches.filter((x) => x.etat === 'inconnue' && x.requise);
  const pct = c.total > 0 ? Math.round((c.faites / c.total) * 100) : 0;
  const complet = c.faites === c.total && manquantes.length === 0;

  return (
    <section className="mb-4 rounded-2xl border border-ink-200 bg-white p-4 shadow-sm" data-testid="mba-completion">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-semibold text-ink-900" data-testid="mba-completion-ratio">
          {t(`${c.faites} sur ${c.total} réglages obligatoires`, `${c.faites} of ${c.total} required settings`)}
        </span>
        <div className="h-1.5 min-w-[8rem] flex-1 overflow-hidden rounded-full bg-ink-100">
          <div className={`h-full rounded-full ${complet ? 'bg-mint-500' : 'bg-brand-500'}`} style={{ width: `${pct}%` }} />
        </div>
      </div>

      {/* Ce qui manque, avec la RAISON et le chemin pour y aller. Une liste de manques sans le geste
          correspondant se lit comme un reproche. */}
      {manquantes.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {manquantes.map((x) => (
            <li key={x.cle} className="flex flex-wrap items-baseline gap-x-2 text-xs" data-testid={`mba-manque-${x.cle}`}>
              <span className="font-medium text-ink-800">{t(LIBELLES[x.cle].fr, LIBELLES[x.cle].en)}</span>
              <span className="text-ink-500">{x.raison}</span>
              {LIBELLES[x.cle].onglet && onOnglet && (
                <button type="button" className="text-brand-700 underline" onClick={() => onOnglet(LIBELLES[x.cle].onglet!)}>
                  {t('y aller', 'go there')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* 🔴 CE QU'ON NE SAIT PAS SE DIT, et hors du compte. Le moyen de paiement se lit derrière le statut
          BSP, que nous n'avons pas (mesuré : `primary_funding_id` répond code 10). Le taire ferait croire
          la liste complète ; le compter comme « à faire » serait un reproche pour une porte fermée. */}
      {aSignaler.length > 0 && (
        <ul className="mt-2 space-y-1 border-t border-ink-100 pt-2">
          {aSignaler.map((x) => (
            <li key={x.cle} className="text-xs text-ink-400" data-testid={`mba-inconnu-${x.cle}`}>
              <span className="font-medium">{t(LIBELLES[x.cle].fr, LIBELLES[x.cle].en)}</span> : {x.raison}
            </li>
          ))}
        </ul>
      )}

      {complet && manquantes.length === 0 && (
        <p className="mt-2 text-xs text-mint-700" data-testid="mba-completion-ok">
          {t('Tout ce que nous savons vérifier est en place.', 'Everything we can verify is in place.')}
        </p>
      )}
    </section>
  );
}
