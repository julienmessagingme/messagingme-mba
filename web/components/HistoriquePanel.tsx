'use client';

import { useCallback, useEffect, useState } from 'react';
import { useT, useLocale } from '@/lib/i18n';
import { cardCls } from '@/lib/ui';
import { formatDate, hourMin } from '@/lib/day';
import { request } from '@/lib/http';
import { Squelette } from '@/components/Squelette';

/**
 * L'HISTORIQUE DES RÉGLAGES : ce qui a changé, et ce qui a été effacé.
 *
 * 🔴 IL EXISTE PARCE QUE META N'A PAS DE CORBEILLE. Une FAQ ou une compétence supprimée est perdue chez lui :
 * la ligne d'historique en est le seul exemplaire, et c'est pourquoi elle porte le CONTENU effacé.
 *
 * 🔴 IL MONTRE AUSSI LES GESTES D'ÉCRAN, pas seulement ceux de l'assistant. Un historique qui les ignorerait
 * mentirait par omission, et on y chercherait une cause qui ne s'y trouve pas.
 *
 * ⚠️ RESTAURER RECRÉE, IL NE RESSUSCITE PAS : l'identifiant Meta de l'élément supprimé est perdu pour
 * toujours. L'écran le dit, sans quoi quelqu'un croirait avoir annulé une suppression.
 */

export interface LigneHistoriqueVue {
  id: string;
  surface: 'mba' | 'agent';
  element: string;
  operation: 'ajout' | 'modification' | 'suppression';
  libelle: string;
  avant: unknown;
  apres: unknown;
  origine: 'assistant' | 'formulaire';
  acteurEmail: string | null;
  acteurId: string | null;
  at: string;
}

export function HistoriquePanel({ tenantId, surface, agentId }: {
  tenantId: string;
  surface: 'mba' | 'agent';
  agentId?: string;
}) {
  const t = useT();
  const { locale } = useLocale();
  const [lignes, setLignes] = useState<LigneHistoriqueVue[]>([]);
  const [tronquee, setTronquee] = useState(false);
  const [chargement, setChargement] = useState(true);
  const [erreur, setErreur] = useState<string | null>(null);
  const [ouvert, setOuvert] = useState<string | null>(null);

  const charger = useCallback(async () => {
    setChargement(true);
    try {
      const q = new URLSearchParams({ surface, ...(agentId ? { agentId } : {}) });
      const r = await request<{ lignes: LigneHistoriqueVue[]; tronquee: boolean }>(`/tenants/${tenantId}/historique?${q}`);
      setLignes(r.lignes);
      setTronquee(r.tronquee);
    } catch (e) {
      setErreur(e instanceof Error ? e.message : t('Historique indisponible', 'History unavailable'));
    } finally {
      setChargement(false);
    }
  }, [tenantId, surface, agentId, t]);

  useEffect(() => { void charger(); }, [charger]);

  const stamp = (iso: string) =>
    `${formatDate(iso, locale, { day: '2-digit', month: '2-digit', year: '2-digit' })} ${hourMin(iso, locale)}`;

  const signe = (o: LigneHistoriqueVue['operation']) => (o === 'suppression' ? '−' : o === 'ajout' ? '+' : '~');

  if (chargement) return <Squelette forme="carte" />;

  return (
    <div className={cardCls}>
      <h3 className="text-sm font-semibold text-ink-900">{t('Historique', 'History')}</h3>
      {/* 🔴 CE TEXTE DIT CE QUE LA PAGE CONTIENT VRAIMENT, et il a été corrigé le 2026-09-15. Il annonçait
          « tout ce qui a été changé » ; depuis les ONGLETS, seules les SUPPRESSIONS sont journalisées (choix
          délibéré : chez Meta une suppression est définitive, une création ratée se refait). Une page qui
          promet plus qu'elle ne montre fait conclure « ça n'a pas eu lieu » là où il faudrait lire « ce
          n'est pas encore journalisé », et c'est le pire malentendu possible sur un journal. */}
      <p className="mt-1 text-sm text-ink-500">
        {t('Ce que l’assistant a appliqué, et ce qui a été SUPPRIMÉ depuis les onglets, avec son contenu. Rien n’est purgé.',
          'What the assistant applied, and what was DELETED from the tabs, with its content. Nothing is purged.')}
      </p>
      <p className="mt-1 text-xs text-ink-500">
        {t('Les créations et les modifications faites à la main dans les onglets n’y figurent pas encore.',
          'Creations and edits made by hand in the tabs are not listed yet.')}
      </p>

      {erreur && <p className="mt-3 rounded-controle bg-danger-50 px-3 py-2 text-sm text-danger-700">{erreur}</p>}

      {/* 🔴 On le DIT quand la liste est coupée : sans cette ligne, chercher une modification ancienne et ne
          pas la voir se lirait comme « elle n'a pas eu lieu ». */}
      {tronquee && (
        <p className="mt-3 text-xs text-ink-500">
          {t(`Les ${lignes.length} modifications les plus récentes sont affichées. Les précédentes sont conservées, elles ne sont pas purgées.`,
            `Showing the ${lignes.length} most recent changes. Earlier ones are kept, they are not purged.`)}
        </p>
      )}

      {lignes.length === 0 ? (
        <p className="mt-4 text-sm text-ink-500">{t('Rien n’a encore été modifié.', 'Nothing has been changed yet.')}</p>
      ) : (
        <ul className="mt-4 divide-y divide-ink-100" data-testid="historique-lignes">
          {lignes.map((l) => (
            <li key={l.id} className="py-2.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className={`text-sm ${l.operation === 'suppression' ? 'text-danger' : 'text-ink-900'}`}>
                  {signe(l.operation)} {l.libelle}
                </span>
                <span className="shrink-0 text-xs text-ink-500">{stamp(l.at)}</span>
              </div>
              <div className="mt-0.5 text-xs text-ink-500">
                {/* ⚠️ « auteur inconnu » plutôt qu'un nom inventé : un compte supprimé laisse une ligne sans
                    acteur, et lui en attribuer un serait faux. */}
                {l.acteurEmail ?? t('auteur inconnu', 'unknown author')}
                {' · '}
                {l.origine === 'assistant' ? t('par l’assistant', 'by the assistant') : t('depuis les onglets', 'from the tabs')}
                {l.operation === 'suppression' && l.avant != null && (
                  <>
                    {' · '}
                    <button
                      onClick={() => setOuvert(ouvert === l.id ? null : l.id)}
                      className="underline hover:text-ink-900"
                      data-testid={`historique-voir-${l.id}`}
                    >
                      {ouvert === l.id ? t('masquer le contenu', 'hide content') : t('voir le contenu effacé', 'show deleted content')}
                    </button>
                  </>
                )}
              </div>
              {ouvert === l.id && l.avant != null && (
                <div className="mt-2 rounded-carte bg-ink-50 p-3">
                  <pre className="overflow-x-auto whitespace-pre-wrap text-xs text-ink-900">
                    {JSON.stringify(l.avant, null, 2)}
                  </pre>
                  {/* 🔴 LA PHRASE QUI ÉVITE UN MALENTENDU COÛTEUX : recopier ce contenu dans l'onglet crée un
                      élément NEUF. L'identifiant Meta de l'original est perdu pour toujours. */}
                  <p className="mt-2 text-xs text-ink-500">
                    {t('Pour le remettre, recopiez-le dans l’onglet concerné : cela créera un nouvel élément, l’original n’est pas récupérable chez Meta.',
                      'To restore it, copy it back in the matching tab: this creates a new item, the original cannot be recovered from Meta.')}
                  </p>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
