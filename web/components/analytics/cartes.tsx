'use client';

/**
 * Les cartes de l'onglet Analytics > Quantitatif, sorties de la page qui les portait toutes.
 *
 * 🔴 POURQUOI CE MODULE EXISTE. L'onglet est passé de UNE page à QUATRE sous-onglets (Messages & contacts,
 * Coûts, Funnel, Erreurs). Laisser les cartes dans l'une des quatre aurait obligé les trois autres à
 * l'importer, c'est-à-dire à importer une PAGE : un cycle en puissance, et un import qui ne dit pas ce
 * qu'il fait. Elles vivent donc ici, et chaque page ne prend que les siennes.
 *
 * ⚠️ Chaque carte porte son `id="quanti-..."`, qui est sa ZONE d'export PDF. Une carte déplacée garde son
 * id : les zones sont énumérées ailleurs (`web/e2e/exports.spec.ts`) et les renommer casserait l'export
 * sans rien dire.
 */

import { useEffect, useState } from 'react';
import { DailyChart } from '@/components/DailyChart';
import { BoutonPdf } from '@/components/BoutonPdf';
import { useT, useLocale } from '@/lib/i18n';
import { fmtCost, fmtNum, fmtPct } from '@/lib/format';
import { metaCodeLabel } from '@/lib/meta-errors';
import {
  getCampaignFunnel, getCostSeries,
  type CampaignFunnel, type CampaignSummary, type CostSeries, type ErrorBreakdownRow,
  type StatsRange, type TemplateStats,
} from '@/lib/api';

/**
 * Funnel d'UNE campagne : envoyés -> délivrés -> lus -> répondus (+ échecs). Remplace le funnel global.
 * « répondu » = message entrant reçu après l'envoi (peut dépasser « lu » si les accusés sont désactivés).
 */
export function CampaignFunnelCard({ tenantId, campaigns }: { tenantId: string; campaigns: CampaignSummary[] }) {
  const t = useT();
  const { locale } = useLocale();
  const [selected, setSelected] = useState<string | null>(null);
  const [funnel, setFunnel] = useState<CampaignFunnel | null>(null);
  const [loading, setLoading] = useState(false);
  const current = campaigns.find((c) => c.id === selected) ?? campaigns[0] ?? null;
  const currentId = current?.id ?? null;

  // Dépend de l'ID (pas de l'objet `current`) : un rechargement de `campaigns` au changement de plage
  // recrée le tableau mais le funnel d'une campagne ne dépend pas de la plage -> pas de refetch inutile.
  useEffect(() => {
    if (!currentId) { setFunnel(null); return; }
    let alive = true;
    setLoading(true);
    getCampaignFunnel(tenantId, currentId)
      .then((f) => { if (alive) setFunnel(f); })
      .catch(() => { if (alive) setFunnel(null); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [tenantId, currentId]);

  const sent = funnel?.sent ?? 0;
  // Bornée à 100 : les clics ne sont PAS bornés par le nombre d'envois (une même personne peut cliquer dix
  // fois). Sans ce plafond, la barre déborderait de sa piste et le dessin deviendrait illisible.
  const pct = (n: number) => (sent > 0 ? Math.min(100, Math.max(2, Math.round((n / sent) * 100))) : 0);
  const bars = funnel
    ? [
        { label: t('Envoyés', 'Sent'), value: funnel.sent, color: '#009AFE', sub: '' },
        { label: t('Délivrés', 'Delivered'), value: funnel.delivered, color: '#17C74E', sub: fmtPct(funnel.delivered, sent, locale) },
        { label: t('Lus', 'Read'), value: funnel.read, color: '#6E5AE0', sub: fmtPct(funnel.read, sent, locale) },
        { label: t('Répondus', 'Replied'), value: funnel.replied, color: '#F5A623', sub: fmtPct(funnel.replied, sent, locale) },
        // Les deux étapes de CLIC n'apparaissent que si la donnée existe pour cette campagne. Une barre à zéro
        // sur un template sans bouton se lirait « personne n'a cliqué » au lieu de « il n'y a rien à cliquer ».
        //
        // ⚠️ Elles n'ont PAS la même unité, et les libellés le disent. « Destinataires ayant tapé » compte des
        // PERSONNES, comme les étapes au-dessus, donc un pourcentage des envois a un sens. « Clics sur le
        // lien » compte des CLICS : la même personne peut cliquer dix fois, le total n'est pas borné par le
        // nombre d'envois, et l'afficher en pourcentage laisserait lire « 300 % ont cliqué ».
        ...(funnel.buttonReplies > 0
          ? [{ label: t('Destinataires ayant tapé un bouton', 'Recipients who tapped a button'), value: funnel.buttonReplies, color: '#EC4899', sub: fmtPct(funnel.buttonReplies, sent, locale) }]
          : []),
        ...(funnel.urlClicks !== null
          ? [{ label: t('Clics sur le lien (total)', 'Link clicks (total)'), value: funnel.urlClicks, color: '#C026D3', sub: '' }]
          : []),
      ]
    : [];

  return (
    <div id="quanti-funnel" className="rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold tracking-tight text-ink-900">{t('Funnel par campagne', 'Funnel by campaign')}</h3>
            <BoutonPdf zone="quanti-funnel" />
          </div>
          <p className="text-xs text-ink-400">{t('envoyés → délivrés → lus → répondus', 'sent → delivered → read → replied')}</p>
        </div>
        {campaigns.length > 0 && (
          <select
            value={current?.id ?? ''}
            onChange={(e) => setSelected(e.target.value)}
            className="max-w-[60%] rounded-lg border border-ink-300 bg-white px-3 py-1.5 text-sm text-ink-800 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          >
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        )}
      </div>
      {campaigns.length === 0 ? (
        <p className="text-sm text-ink-500">{t('Aucune campagne pour le moment.', 'No campaigns yet.')}</p>
      ) : loading ? (
        <p className="text-sm text-ink-500">{t('Chargement…', 'Loading…')}</p>
      ) : !funnel || sent === 0 ? (
        <p className="text-sm text-ink-500">{t('Aucun envoi sur cette campagne.', 'No sends on this campaign.')}</p>
      ) : (
        <div className="space-y-2.5">
          {bars.map((b) => (
            <div key={b.label} className="flex items-center gap-3">
              <div className="w-24 shrink-0 text-xs text-ink-600">{b.label}</div>
              <div className="h-6 flex-1 overflow-hidden rounded-md bg-ink-50">
                <div className="flex h-full items-center rounded-md px-2 text-[11px] font-medium text-white" style={{ width: `${pct(b.value)}%`, backgroundColor: b.color }}>
                  {fmtNum(b.value, locale)}
                </div>
              </div>
              <div className="w-12 shrink-0 text-right text-xs tabular-nums text-ink-500">{b.sub}</div>
            </div>
          ))}
          {funnel.failed > 0 && (
            <p className="pt-1 text-xs text-ink-400">{t('Échecs :', 'Failures:')} <span className="font-medium text-coral">{fmtNum(funnel.failed, locale)}</span></p>
          )}
          {funnel.urlClicks !== null && (
            // Dit la limite au lieu de la taire : un lien ne sait pas quel envoi l'a porté, donc deux
            // campagnes sur le même template lisent le même compteur. Le taire ferait prendre un chiffre de
            // template pour un chiffre de campagne.
            <p className="pt-1 text-[11px] leading-relaxed text-ink-400">
              {t(
                'Les clics sur le lien sont comptés sur le lien du template, à partir du premier envoi de cette campagne. Si le même template sert ailleurs, ses clics apparaissent ici aussi.',
                'Link clicks are counted on the template link, from this campaign’s first send. If the same template is used elsewhere, its clicks show up here too.',
              )}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Sélecteur MULTIPLE compact : la liste déroulante sert à AJOUTER, la sélection s'affiche en pastilles
 * retirables. Un `<select multiple>` natif aurait demandé Ctrl+clic et occupé quatre lignes dans un en-tête de
 * carte ; ici, choisir plusieurs valeurs se fait au clic, et ce qui est retenu se lit d'un coup d'œil.
 *
 * Rien de sélectionné = « tout », comme avant.
 */
export function SelecteurMultiple({ libelleTous, options, selection, onChange, testId }: {
  libelleTous: string;
  options: Array<{ value: string; label: string }>;
  selection: string[];
  onChange: (suivant: string[]) => void;
  testId: string;
}) {
  const t = useT();
  const dispo = options.filter((o) => !selection.includes(o.value));
  const selectCls = 'rounded-lg border border-ink-300 bg-white px-2.5 py-1 text-xs text-ink-800 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';
  const libelleDe = (v: string): string => options.find((o) => o.value === v)?.label ?? v;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <select
        value=""
        onChange={(e) => { if (e.target.value !== '') onChange([...selection, e.target.value]); }}
        data-testid={testId}
        className={selectCls}
        disabled={dispo.length === 0}
      >
        <option value="">{selection.length === 0 ? libelleTous : t('Ajouter…', 'Add…')}</option>
        {dispo.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {selection.map((v) => (
        <span key={v} data-testid={`${testId}-retenu`} className="inline-flex items-center gap-1 rounded-md bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700">
          {libelleDe(v)}
          <button
            type="button"
            onClick={() => onChange(selection.filter((x) => x !== v))}
            aria-label={t('Retirer', 'Remove')}
            className="text-brand-400 transition hover:text-coral"
          >
            ×
          </button>
        </span>
      ))}
    </div>
  );
}

/**
 * D'OU viennent les messages de service : l'IA, un scénario, un humain.
 *
 * Demandé par Julien le 2026-09-01. Le chiffre répond à une question d'exploitation qu'aucun autre écran ne
 * couvrait : sur ce que le client a envoyé hors template, quelle part est tenue par les machines et quelle
 * part mobilise encore quelqu'un. C'est la mesure du travail économisé, donc de ce que la console apporte.
 *
 * ⚠️ La ligne « origine non enregistrée » n'est pas un état normal : elle veut dire qu'un chemin d'écriture
 * a envoyé sans dire qui il était. Elle est affichée, et seulement quand elle n'est pas nulle, précisément
 * pour que ça se voie au lieu d'être versé en silence dans un des trois thèmes.
 */
export function OrigineServiceCard({ repartition }: { repartition?: { ia: number; scenario: number; humain: number; indeterminee: number } }) {
  const t = useT();
  const { locale } = useLocale();
  // Absente = l'API ne connaît pas encore ce champ (déploiement en cours). Rien plutôt qu'une fausse mesure.
  if (!repartition) return null;
  const lignes = [
    { cle: 'ia', label: t('IA', 'AI'), aide: t('agent IA de la console, et agent de Meta', 'console AI agent, and Meta agent'), valeur: repartition.ia, couleur: 'bg-violet' },
    { cle: 'scenario', label: t('Scripté', 'Scripted'), aide: t('envoyé par un bloc de scénario', 'sent by a scenario block'), valeur: repartition.scenario, couleur: 'bg-brand-500' },
    { cle: 'humain', label: t('Humain', 'Human'), aide: t('écrit par un opérateur depuis l’inbox', 'written by an operator from the inbox'), valeur: repartition.humain, couleur: 'bg-mint-400' },
    ...(repartition.indeterminee > 0
      ? [{ cle: 'indeterminee', label: t('Origine non enregistrée', 'Origin not recorded'), aide: t('un envoi n’a pas déclaré son origine : à corriger', 'a send did not declare its origin: to be fixed'), valeur: repartition.indeterminee, couleur: 'bg-ink-300' }]
      : []),
  ];
  const total = lignes.reduce((a, l) => a + l.valeur, 0);
  return (
    <div id="quanti-origine-service" className="rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
      <div className="mb-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold tracking-tight text-ink-900">{t('Messages de service : qui les a écrits', 'Service messages: who wrote them')}</h3>
          <BoutonPdf zone="quanti-origine-service" />
        </div>
        <p className="text-xs text-ink-400">{t('sur la période, hors template', 'over the period, excluding templates')}</p>
      </div>
      {total === 0 ? (
        <p className="text-sm text-ink-500">{t('Aucun message de service sur la période.', 'No service message over the period.')}</p>
      ) : (
        <table className="w-full text-left text-xs" data-testid="origine-service">
          <thead>
            <tr className="border-b border-ink-100 text-ink-400">
              <th className="px-2 py-2 font-medium">{t('Origine', 'Origin')}</th>
              <th className="px-2 py-2 font-medium">{t('Messages', 'Messages')}</th>
              <th className="px-2 py-2 font-medium">{t('Part', 'Share')}</th>
              <th className="w-1/2 px-2 py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {lignes.map((l) => (
              <tr key={l.cle} data-testid={`origine-${l.cle}`} className="border-b border-ink-50">
                <td className="px-2 py-2">
                  <div className="font-medium text-ink-800">{l.label}</div>
                  <div className="text-[11px] text-ink-400">{l.aide}</div>
                </td>
                <td className="px-2 py-2 tabular-nums text-ink-700">{fmtNum(l.valeur, locale)}</td>
                <td className="px-2 py-2 tabular-nums text-ink-500">{fmtPct(l.valeur, total, locale)}</td>
                <td className="px-2 py-2">
                  <div className="h-1.5 overflow-hidden rounded-full bg-ink-50">
                    <div className={`h-full rounded-full ${l.couleur}`} style={{ width: `${total > 0 ? Math.round((l.valeur / total) * 100) : 0}%` }} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Breakdown des codes d'erreur Meta sur la période (avec libellé FR). */
export function ErrorBreakdownCard({ errors }: { errors: ErrorBreakdownRow[] }) {
  const t = useT();
  const { locale } = useLocale();
  const [tpls, setTpls] = useState<string[]>([]);
  // Templates ayant généré des erreurs (pour le filtre). Les erreurs des envois Inbox/Workflow ne sont pas
  // trackées (colonne d'erreur seulement sur campaign_recipients) : ce breakdown couvre les CAMPAGNES.
  const templates = [...new Set(errors.map((e) => e.templateName).filter((x): x is string => !!x))].sort();
  // Plusieurs templates -> breakdown COMPILÉ sur l'ensemble. L'agrégation par code juste en dessous s'en
  // charge déjà : elle sommait le cas « tous les templates », donc rien de neuf à écrire pour un sous-ensemble.
  const filtered = tpls.length > 0 ? errors.filter((e) => e.templateName !== null && tpls.includes(e.templateName)) : errors;
  // Agrège par code (somme sur les templates de la sélection : plusieurs lignes par code sinon).
  const byCode = new Map<number, number>();
  for (const e of filtered) byCode.set(e.code, (byCode.get(e.code) ?? 0) + e.count);
  const rows = [...byCode.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || a.code - b.code);
  const total = rows.reduce((a, e) => a + e.count, 0);
  const max = rows.reduce((m, e) => Math.max(m, e.count), 0);
  return (
    <div id="quanti-erreurs" className="rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold tracking-tight text-ink-900">{t('Erreurs Meta', 'Meta errors')}</h3>
            <BoutonPdf zone="quanti-erreurs" />
          </div>
          <p className="text-xs text-ink-400">{t('par code, sur la période', 'by code, over the period')}</p>
        </div>
        {templates.length > 0 && (
          <SelecteurMultiple
            libelleTous={t('Tous les templates', 'All templates')}
            options={templates.map((n) => ({ value: n, label: n }))}
            selection={tpls}
            onChange={setTpls}
            testId="erreurs-templates"
          />
        )}
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-ink-500">{t('Aucune erreur sur la période.', 'No errors over the period.')}</p>
      ) : (
        <div className="space-y-2.5">
          {rows.map((e) => (
            <div key={e.code}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-mono text-xs font-medium text-ink-700">{e.code}</span>
                <span className="text-xs tabular-nums text-ink-500">{fmtNum(e.count, locale)}</span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-ink-50">
                <div className="h-full rounded-full bg-coral" style={{ width: `${max > 0 ? Math.max(4, Math.round((e.count / max) * 100)) : 0}%` }} />
              </div>
              <p className="mt-0.5 text-[11px] text-ink-400">{metaCodeLabel(e.code, locale)}</p>
            </div>
          ))}
          <p className="pt-1 text-xs text-ink-400">{t('Total :', 'Total:')} <span className="font-medium text-ink-700">{fmtNum(total, locale)}</span></p>
        </div>
      )}
    </div>
  );
}

/** Graphe de coût estimé/jour (marketing + utility), filtrable par campagne OU template. */
export function CostChartCard({
  tenantId, range, campaigns, templates,
}: { tenantId: string; range: StatsRange; campaigns: CampaignSummary[]; templates: TemplateStats['breakdown'] }) {
  const t = useT();
  const { locale } = useLocale();
  const [campaignIds, setCampaignIds] = useState<string[]>([]);
  const [templateNames, setTemplateNames] = useState<string[]>([]);
  const [cost, setCost] = useState<CostSeries | null>(null);
  const [loading, setLoading] = useState(true);

  // Les clés de dépendance sont les listes SÉRIALISÉES : un tableau recréé à chaque rendu relancerait la
  // requête en boucle, alors que son contenu n'a pas changé.
  const cleCampagnes = campaignIds.join(',');
  const cleTemplates = templateNames.join(',');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const filter: { campaignIds?: string[]; templateNames?: string[] } = {
      ...(cleCampagnes ? { campaignIds: cleCampagnes.split(',') } : {}),
      ...(cleTemplates ? { templateNames: cleTemplates.split(',') } : {}),
    };
    getCostSeries(tenantId, range, filter)
      .then((c) => { if (alive) setCost(c); })
      .catch(() => { if (alive) setCost(null); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [tenantId, range, cleCampagnes, cleTemplates]);

  return (
    <div id="quanti-cout" className="rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold tracking-tight text-ink-900">{t('Coût estimé', 'Estimated cost')}</h3>
            <BoutonPdf zone="quanti-cout" />
          </div>
          <p className="text-xs text-ink-400">
            {t('par jour, tarif Meta × volume', 'per day, Meta rate × volume')}{cost ? <> · {t('total ≈', 'total ≈')} <span className="font-medium text-ink-700">{fmtCost(cost.total, locale, cost.currency)}</span></> : null}
            {/* 🔴 CE QUE LE COÛT NE COMPTE PAS, DIT PLUTÔT QUE TU. Un envoi sans catégorie connue ne produit
                aucun coût et disparaissait du calcul en silence : le client lisait zéro là où il avait bien
                envoyé. Vécu sur 22 envois de scénario, dont la catégorie n'était pas écrite avant le
                2026-09-07. Un volume non chiffrable est une information, l'escamoter est un mensonge par
                omission. Ces envois-là ne deviendront pas chiffrables rétroactivement : on ne devine pas
                une catégorie, elle se facturerait au mauvais tarif. */}
            {cost && cost.nonChiffrables > 0 ? (
              <span className="mt-1 block text-gold" data-testid="cout-non-chiffrables">
                {t(
                  `${fmtNum(cost.nonChiffrables, locale)} envoi(s) ne sont pas chiffrables : leur catégorie n’a pas été enregistrée. Ils comptent dans les volumes, pas dans ce coût.`,
                  `${fmtNum(cost.nonChiffrables, locale)} send(s) cannot be priced: their category was not recorded. They count in volumes, not in this cost.`,
                )}
              </span>
            ) : null}
          </p>
        </div>
        {/* Les deux axes restent MUTUELLEMENT EXCLUSIFS : choisir des campagnes vide les templates et
            inversement. Les croiser ne donnerait pas une union mais leur intersection, qui ne décrit rien. */}
        <div className="flex flex-wrap items-center gap-2">
          <SelecteurMultiple
            libelleTous={t('Toutes campagnes', 'All campaigns')}
            options={campaigns.map((c) => ({ value: c.id, label: c.name }))}
            selection={campaignIds}
            onChange={(suivant) => { setCampaignIds(suivant); if (suivant.length > 0) setTemplateNames([]); }}
            testId="cout-campagnes"
          />
          <SelecteurMultiple
            libelleTous={t('Tous templates', 'All templates')}
            options={templates.map((tp) => ({ value: tp.name, label: tp.name }))}
            selection={templateNames}
            onChange={(suivant) => { setTemplateNames(suivant); if (suivant.length > 0) setCampaignIds([]); }}
            testId="cout-templates"
          />
        </div>
      </div>
      {loading ? (
        <p className="text-sm text-ink-500">{t('Chargement…', 'Loading…')}</p>
      ) : !cost || !cost.hasRates ? (
        <p className="text-sm text-ink-500">{t("Tarif Meta indisponible : coût non estimable pour l'instant.", 'Meta rate unavailable: cost cannot be estimated right now.')}</p>
      ) : (
        <DailyChart
          title=""
          from={range.from}
          to={range.to}
          series={[
            { label: 'Marketing', color: '#0080D6', points: cost.marketing },
            { label: 'Utility', color: '#17C74E', points: cost.utility },
          ]}
        />
      )}
    </div>
  );
}

/**
 * Ce que Meta a REELLEMENT facture sur la periode, et pourquoi ce n est pas le meme nombre que l estimation.
 *
 * 🔴 CETTE CARTE EXISTE PARCE QUE LE CHIFFRE ETAIT MAL PLACE, pas mal calcule. `pricing.totalCost` vient de
 * l API de facturation de Meta (`src/meta/pricing.ts`, « somme des couts factures sur la periode ») : il
 * est juste, il couvre TOUS les templates, et il vivait sous un selecteur par template ou il se lisait
 * comme le cout du template choisi.
 *
 * 🔴 ET IL NE PEUT PAS EGALER L ESTIMATION, meme apres correction. L un est une facture rendue par Meta,
 * l autre notre volume multiplie par un tarif moyen par categorie. Les rapprocher serait un faux objectif ;
 * ne pas dire pourquoi ils different fait reposer la question a chaque lecture.
 */
export function FactureCard({ data }: { data: TemplateStats | null }) {
  const t = useT();
  const { locale } = useLocale();
  const pricing = data?.pricing ?? null;
  if (!pricing) return null;

  return (
    <div id="quanti-facture" className="rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
      <div className="mb-3 flex items-center gap-2">
        <h3 className="text-sm font-semibold tracking-tight text-ink-900">
          {t('Facturé par Meta sur la période', 'Billed by Meta over the period')}
        </h3>
        <BoutonPdf zone="quanti-facture" />
      </div>
      <div className="text-3xl font-bold tracking-tight text-ink-900">
        {fmtCost(pricing.totalCost, locale, pricing.currency)}
      </div>
      <p className="mt-2 text-xs text-ink-500">
        {t(
          'Tous templates confondus, toutes catégories. C’est le montant que Meta a réellement compté, pas une estimation de notre part.',
          'All templates and categories combined. This is what Meta actually charged, not an estimate of ours.',
        )}
      </p>
      <p className="mt-2 border-t border-ink-100 pt-2 text-xs text-ink-400">
        {t(
          'Le « coût estimé » plus haut ne donnera jamais exactement ce chiffre : c’est notre volume multiplié par un tarif moyen par catégorie, pas une facture.',
          'The "estimated cost" above will never match this exactly: it is our volume times an average per-category rate, not an invoice.',
        )}
      </p>
    </div>
  );
}

/** Section « Templates envoyés » détaillée : dropdown par template + volume + prix estimé (Meta). */
export function TemplateBreakdownCard({ data }: { data: TemplateStats | null }) {
  const t = useT();
  const { locale } = useLocale();
  const rows = data?.breakdown ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  const current = rows.find((r) => r.name === selected) ?? rows[0] ?? null;
  const pricing = data?.pricing ?? null;

  const rate = current && current.category ? pricing?.byCategory[current.category]?.ratePerMessage ?? null : null;
  const estimated = current && rate != null ? current.count * rate : null;

  return (
    <div id="quanti-templates" className="rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold tracking-tight text-ink-900">{t('Détail par template', 'Breakdown by template')}</h3>
            <BoutonPdf zone="quanti-templates" />
          </div>
          <p className="text-xs text-ink-400">{t('volume + prix estimé sur la période', 'volume + estimated price over the period')}</p>
        </div>
        {rows.length > 0 && (
          <select
            value={current?.name ?? ''}
            onChange={(e) => setSelected(e.target.value)}
            className="rounded-lg border border-ink-300 bg-white px-3 py-1.5 text-sm text-ink-800 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          >
            {rows.map((r) => (
              <option key={r.name} value={r.name}>
                {r.name} ({r.count})
              </option>
            ))}
          </select>
        )}
      </div>

      {!current ? (
        <p className="text-sm text-ink-500">{t('Aucun template envoyé sur la période.', 'No templates sent over the period.')}</p>
      ) : (
        <div className="flex flex-wrap gap-6">
          <Metric label={t('Catégorie', 'Category')} value={current.category ?? '-'} />
          <Metric label={t('Envois', 'Sends')} value={String(current.count)} />
          <Metric
            label={t('Prix estimé', 'Estimated price')}
            value={estimated != null ? `≈ ${fmtCost(estimated, locale, pricing?.currency)}` : t('indisponible', 'unavailable')}
            hint={estimated != null ? t('volume × tarif catégorie (Meta)', 'volume × category rate (Meta)') : t('tarif Meta indisponible', 'Meta rate unavailable')}
          />
        </div>
      )}

      {/* 🔴 LE TOTAL FACTURE N EST PLUS ICI. Il y etait, sous le selecteur de template et sous une metrique
          « Prix estime » qui, elle, est bien celle du template choisi : n importe qui le lisait comme le
          cout de CE template. Le chiffre n a jamais ete faux (il vient de l API de facturation de Meta,
          `src/meta/pricing.ts`), c est son PLACEMENT qui mentait. Il vit desormais dans `FactureCard`,
          seul, avec ce qu il faut pour le lire. Vecu le 2026-09-07 : 2,42 EUR pris pour le cout d un
          template qui en avait genere 7 envois. */}
      {data && !pricing && (
        <p className="mt-4 border-t border-ink-100 pt-3 text-xs text-ink-400">{t("Prix Meta indisponible pour l'instant : volumes affichés seuls.", 'Meta price unavailable right now: volumes shown only.')}</p>
      )}
    </div>
  );
}

export function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wide text-ink-400">{label}</div>
      <div className="text-xl font-bold tracking-tight text-ink-900">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-ink-400">{hint}</div>}
    </div>
  );
}
