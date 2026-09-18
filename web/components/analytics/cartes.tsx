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

import { Fragment, useEffect, useState } from 'react';
import { DailyChart } from '@/components/DailyChart';
import { BoutonPdf } from '@/components/BoutonPdf';
import { useT, useLocale } from '@/lib/i18n';
import { phrasesNonChiffrables } from '@/lib/cout-non-chiffrable';
import { fmtCost, fmtNum, fmtPct, fmtPourcent } from '@/lib/format';
import { mesureInconnue, ventilationAffichable } from '@/lib/funnel-canal';
import { metaCodeLabel } from '@/lib/meta-errors';
import { formatDate } from '@/lib/day';
import {
  getCampaignFunnel, getCostSeries, getErrorContacts,
  type CampaignFunnel, type CampaignSummary, type CostSeries, type ErrorBreakdownRow,
  type ErrorContactRow, type StatsRange, type TemplateStats,
} from '@/lib/api';

/**
 * Funnel d'UNE campagne : envoyés -> délivrés -> lus -> répondus (+ échecs). Remplace le funnel global.
 * « répondu » = message entrant reçu après l'envoi (peut dépasser « lu » si les accusés sont désactivés).
 */
export interface EtapeFunnel {
  label: string;
  value: number;
  color: string;
  /** Le pourcentage des envois, ou la chaîne vide quand il n'a pas de sens (étape en CLICS, pas en personnes). */
  sub: string;
  /**
   * Cette étape n'a AUCUNE mesure : Meta n'a rendu aucun accusé sur cette campagne. La colonne s'efface et
   * affiche « — », au lieu d'un zéro qu'on lirait comme un fait.
   *
   * 🔴 « 0 délivrés » ET « on ne sait pas » NE SONT PAS LA MÊME CHOSE, et la carte les confondait. Signalé
   * par Julien le 2026-09-11 : « 3 envoyés, 0 délivrés, 0 lus et pourtant 3 répondus, erreur manifeste
   * non ? ». Chaque nombre était juste ; c'est leur mise côte à côte qui mentait.
   */
  inconnue?: boolean;
}

/**
 * UN funnel, en barres VERTICALES.
 *
 * 🔴 VERTICALES ET PAS HORIZONTALES, à la demande de Julien. Ce composant n'existait pas : la carte
 * dessinait ses barres à l'horizontale (label à gauche, piste à droite), et il n'y avait aucun patron de
 * barre verticale à reprendre dans le dépôt. Le graphe journalier est en SVG et ses `rect` répondent à une
 * échelle de dates, pas à un entonnoir ; le seul patron de barre partageable
 * (`ConversationAnalysisCard`) est horizontal, et son commentaire dit qu'il vient d'ici.
 *
 * ⚠️ La hauteur est PLAFONNÉE à 100 % et PLANCHÉE à 2 %, et les deux comptent. Les clics ne sont pas bornés
 * par le nombre d'envois (une même personne clique dix fois), donc sans plafond la colonne déborderait de
 * la carte ; et une étape à 1 sur 10 000 doit rester visible, sinon elle se lit comme un zéro.
 */
function FunnelVertical({ etapes, sent, locale }: { etapes: EtapeFunnel[]; sent: number; locale: ReturnType<typeof useLocale>['locale'] }) {
  const hauteur = (n: number) => (sent > 0 ? Math.min(100, Math.max(2, Math.round((n / sent) * 100))) : 0);
  return (
    <div className="flex h-56 items-end gap-2" data-testid="funnel-colonnes">
      {etapes.map((e) => (
        <div key={e.label} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1">
          {/* 🔴 « — » ET UNE COLONNE HACHURÉE QUAND IL N'Y A PAS DE MESURE. Un zéro dessiné comme les
              autres se lit comme un fait mesuré ; c'est ce qui a fait conclure à une erreur de calcul là où
              il n'y avait qu'une absence d'accusé. La hauteur est fixée bas et la couleur devient neutre :
              la colonne reste à sa place, elle cesse seulement d'affirmer. */}
          <div className={`text-xs font-semibold tabular-nums ${e.inconnue ? 'text-ink-400' : 'text-ink-800'}`}>
            {e.inconnue ? '—' : fmtNum(e.value, locale)}
          </div>
          <div
            className={`w-full rounded-t-md ${e.inconnue ? 'border border-dashed border-ink-300' : ''}`}
            style={e.inconnue
              ? { height: '8%', backgroundColor: 'transparent' }
              : { height: `${hauteur(e.value)}%`, backgroundColor: e.color }}
            data-testid={`funnel-barre-${e.label}`}
            {...(e.inconnue ? { 'data-inconnue': 'oui' } : {})}
          />
          {/* Le libellé SOUS la colonne, sur deux lignes au besoin : les étapes de clic ont des noms longs,
              et les tronquer ferait perdre l'unité, qui est justement ce qui les distingue. */}
          <div className="h-8 w-full text-center text-[10px] leading-tight text-ink-500" title={e.label}>{e.label}</div>
          <div className="h-3 text-[10px] tabular-nums text-ink-400">{e.inconnue ? '' : e.sub}</div>
        </div>
      ))}
    </div>
  );
}

/**
 * Le funnel d'UNE campagne : son chargement, ses étapes, son dessin.
 *
 * ⚠️ Ce composant ne porte NI identifiant de zone PDF NI sélecteur. Le comparateur en affiche plusieurs, et
 * N éléments partageant un même `id` casseraient à la fois l'export PDF (qui marque une zone par son id) et
 * l'inventaire qui lit les zones dans le DOM. Un seul `quanti-funnel`, posé par le comparateur, autour de
 * tous.
 */
function FunnelCampagne({ tenantId, campagne }: { tenantId: string; campagne: CampaignSummary }) {
  const t = useT();
  const { locale } = useLocale();
  const [funnel, setFunnel] = useState<CampaignFunnel | null>(null);
  const [loading, setLoading] = useState(true);

  // Dépend de l'ID (pas de l'objet) : un rechargement de `campaigns` recrée le tableau, mais le funnel
  // d'une campagne ne dépend pas de la plage -> pas de rechargement inutile.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    getCampaignFunnel(tenantId, campagne.id)
      .then((f) => { if (alive) setFunnel(f); })
      .catch(() => { if (alive) setFunnel(null); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [tenantId, campagne.id]);

  const sent = funnel?.sent ?? 0;
  /**
   * AUCUN accusé sur AUCUN envoi : les deux étapes du milieu n'ont pas de mesure, elles ne valent pas zéro.
   *
   * ⚠️ LE SEUIL EST « TOUS », PAS « CERTAINS », et c'est volontaire. Un accusé manquant sur trois envois sur
   * dix laisse les sept autres parfaitement mesurés : effacer la colonne entière perdrait une vraie
   * information. C'est quand il n'y en a AUCUN que le zéro devient un mensonge, et ce cas-là n'est pas rare,
   * il est SYSTÉMATIQUE sur une campagne à scénario.
   */
  const sansMesure = funnel !== null && sent > 0 && (funnel.sansAccuse ?? 0) === sent;
  const etapes: EtapeFunnel[] = funnel
    ? [
        { label: t('Envoyés', 'Sent'), value: funnel.sent, color: '#009AFE', sub: '' },
        { label: t('Délivrés', 'Delivered'), value: funnel.delivered, color: '#17C74E', sub: fmtPct(funnel.delivered, sent, locale), inconnue: sansMesure },
        { label: t('Lus', 'Read'), value: funnel.read, color: '#6E5AE0', sub: fmtPct(funnel.read, sent, locale), inconnue: sansMesure },
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
    <div className="rounded-xl border border-ink-100 p-3" data-testid={`funnel-campagne-${campagne.id}`}>
      <h4 className="mb-2 truncate text-sm font-medium text-ink-800" title={campagne.name}>{campagne.name}</h4>
      {loading ? (
        <p className="text-sm text-ink-500">{t('Chargement…', 'Loading…')}</p>
      ) : !funnel || sent === 0 ? (
        <p className="text-sm text-ink-500">{t('Aucun envoi sur cette campagne.', 'No sends on this campaign.')}</p>
      ) : (
        <>
          <FunnelVertical etapes={etapes} sent={sent} locale={locale} />
          {sansMesure && (
            <p className="pt-2 text-xs text-amber-800" data-testid="funnel-sans-accuse">
              {t(
                'Meta n’a rendu aucun accusé de livraison sur cette campagne : « délivrés » et « lus » sont inconnus, pas nuls. C’est le cas de toutes les campagnes qui envoient un scénario.',
                'Meta returned no delivery receipt for this campaign: “delivered” and “read” are unknown, not zero. This is the case for every campaign that sends a scenario.',
              )}
            </p>
          )}
          {funnel.failed > 0 && (
            <p className="pt-2 text-xs text-ink-400">{t('Échecs :', 'Failures:')} <span className="font-medium text-coral">{fmtNum(funnel.failed, locale)}</span></p>
          )}
          <VentilationParCanal funnel={funnel} />
        </>
      )}
    </div>
  );
}

/** Le nom lisible d'un canal. Le libellé du produit, jamais l'identifiant technique de la base. */
const NOM_CANAL: Record<string, string> = { whatsapp: 'WhatsApp', rcs: 'RCS', email: 'E-mail' };

/**
 * LA VENTILATION PAR CANAL d'une campagne (journal des tentatives, migration 0134).
 *
 * 🔴 ELLE NE S'AFFICHE QU'À PARTIR DE DEUX CANAUX, et c'est le point. Sur une campagne mono-canal, elle
 * répéterait ligne pour ligne les barres juste au-dessus : deux fois les mêmes chiffres sur un écran, c'est
 * une invitation à chercher pourquoi ils diffèrent. Or toutes les campagnes sont mono-canal aujourd'hui,
 * donc cet ajout ne change RIEN de visible tant que la chaîne de repli n'existe pas, exactement comme le
 * reste du lot.
 *
 * ⚠️ UNE VENTILATION ABSENTE N'EST PAS UNE VENTILATION À ZÉRO. Le journal ne contient que les tentatives
 * postérieures à sa mise en service : une campagne plus ancienne n'a aucune ligne, alors que ses compteurs
 * du dessus sont complets. On se tait dans ce cas, on n'annonce pas « 0 envoi » sur une campagne qui a
 * réellement envoyé.
 *
 * ⚠️ LARGEUR : le tableau défile dans SON conteneur (`overflow-x-auto`). La carte vit dans un comparateur
 * qui en met deux ou trois côte à côte sur environ 1000 px utiles : un tableau qui pousserait la page
 * ferait déborder tout l'écran, pas seulement lui.
 */
function VentilationParCanal({ funnel }: { funnel: CampaignFunnel }) {
  const t = useT();
  const { locale } = useLocale();
  const lignes = funnel.parCanal ?? [];
  if (!ventilationAffichable(funnel.parCanal)) return null;

  return (
    <div className="mt-3 border-t border-ink-100 pt-3">
      <p className="mb-1 text-xs font-medium text-ink-700">{t('Par canal', 'By channel')}</p>
      {/* ⚠️ La ligne de tête est au grain CONTACT : la somme des « tentatives » ci-dessous la dépasse dès
          qu'une personne a été jointe au second étage, et sans cette phrase l'écart se lit comme une erreur. */}
      {funnel.contactsVises !== undefined && (
        <p className="mb-2 text-xs text-ink-500">
          {t(
            `${fmtNum(funnel.contactsVises, locale)} personne(s) visée(s), jointe(s) en ${fmtNum(lignes.reduce((n, l) => n + l.envois, 0), locale)} tentative(s).`,
            `${fmtNum(funnel.contactsVises, locale)} person(s) targeted, reached in ${fmtNum(lignes.reduce((n, l) => n + l.envois, 0), locale)} attempt(s).`,
          )}
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[22rem] text-left text-xs">
          <thead>
            <tr className="text-ink-500">
              <th className="py-1 pr-2 font-medium">{t('Canal', 'Channel')}</th>
              <th className="py-1 pr-2 text-right font-medium">{t('Tentatives', 'Attempts')}</th>
              <th className="py-1 pr-2 text-right font-medium">{t('Partis', 'Sent')}</th>
              <th className="py-1 pr-2 text-right font-medium">{t('Délivrés', 'Delivered')}</th>
              <th className="py-1 pr-2 text-right font-medium">{t('Lus', 'Read')}</th>
              <th className="py-1 text-right font-medium">{t('Répondus', 'Replied')}</th>
            </tr>
          </thead>
          <tbody>
            {lignes.map((l) => {
              // « On ne sait pas » plutôt que « zéro », canal par canal. La règle et ses deux pièges
              // vivent dans `lib/funnel-canal.ts`, où ils sont tenus par un test : écrite ici, elle ne
              // serait exerçable que par un rendu complet, donc en pratique jamais.
              const sansMesure = mesureInconnue(l);
              return (
                <tr key={l.canal} className="border-t border-ink-100">
                  <td className="py-1 pr-2">
                    <span className="rounded bg-violet/10 px-1.5 py-0.5 font-medium text-ink-800">
                      {NOM_CANAL[l.canal] ?? l.canal}
                    </span>
                  </td>
                  <td className="py-1 pr-2 text-right tabular-nums text-ink-700">{fmtNum(l.envois, locale)}</td>
                  <td className="py-1 pr-2 text-right tabular-nums text-ink-700">{fmtNum(l.reussis, locale)}</td>
                  {/* Un tiret, jamais un zéro : la valeur n'est pas nulle, elle est inconnue. */}
                  <td className="py-1 pr-2 text-right tabular-nums text-ink-700" title={sansMesure ? t('Aucun accusé de Meta sur ce canal : inconnu, pas nul.', 'No Meta receipt on this channel: unknown, not zero.') : undefined}>
                    {sansMesure ? '—' : fmtNum(l.delivres, locale)}
                  </td>
                  <td className="py-1 pr-2 text-right tabular-nums text-ink-700">
                    {sansMesure ? '—' : fmtNum(l.lus, locale)}
                  </td>
                  <td className="py-1 text-right tabular-nums text-ink-700">{fmtNum(l.repondus, locale)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Le comparateur : plusieurs campagnes côte à côte, pour les lire d'un coup d'œil.
 *
 * 🔴 DEUX CAMPAGNES PROPOSÉES D'EMBLÉE quand elles existent. Un comparateur qui s'ouvre sur une seule
 * colonne ne se lit pas comme un comparateur : personne ne pense à en ajouter une seconde. C'est la demande
 * de Julien (« au moins 2 tableaux »), et c'est un DÉFAUT d'affichage, pas une contrainte : la sélection
 * reste libre, y compris à une seule campagne.
 */
export function CampaignFunnelCard({ tenantId, campaigns, initiale }: {
  tenantId: string;
  campaigns: CampaignSummary[];
  /**
   * La campagne à montrer d'emblée, quand on arrive depuis son écran de détail (2026-09-15).
   *
   * ⚠️ C'EST UN DÉFAUT, PAS UN VERROU : dès que l'utilisateur touche aux cases, son choix gagne, comme
   * avec le défaut ordinaire. Un filtre qu'on ne pourrait pas défaire serait pire que pas de filtre.
   */
  initiale?: string[];
}) {
  const t = useT();
  const [choisies, setChoisies] = useState<string[]>([]);
  // `campaigns` arrive APRÈS le premier rendu : un `useState` initialisé sur lui resterait vide pour
  // toujours. Le défaut se calcule donc au rendu, et disparaît dès que l'utilisateur choisit lui-même.
  // ⚠️ La campagne demandée par l'adresse n'est retenue que si elle EXISTE dans la liste : un identifiant
  // périmé dans un lien doit rendre l'écran normal, jamais un entonnoir vide qui se lirait « zéro envoi ».
  const demandees = (initiale ?? []).filter((id) => campaigns.some((c) => c.id === id));
  const parDefaut = demandees.length > 0 ? demandees : campaigns.slice(0, 2).map((c) => c.id);
  const selection = choisies.length > 0 ? choisies : parDefaut;
  const affichees = selection
    .map((id) => campaigns.find((c) => c.id === id))
    .filter((c): c is CampaignSummary => c !== undefined);

  return (
    <div id="quanti-funnel" className="rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold tracking-tight text-ink-900">{t('Funnel par campagne', 'Funnel by campaign')}</h3>
            <BoutonPdf zone="quanti-funnel" />
          </div>
          <p className="text-xs text-ink-400">{t('envoyés, délivrés, lus, répondus', 'sent, delivered, read, replied')}</p>
        </div>
        {campaigns.length > 0 && (
          <SelecteurMultiple
            libelleTous={t('Choisir des campagnes', 'Pick campaigns')}
            options={campaigns.map((c) => ({ value: c.id, label: c.name }))}
            selection={selection}
            onChange={setChoisies}
            testId="funnel-campagnes"
          />
        )}
      </div>
      {campaigns.length === 0 ? (
        <p className="text-sm text-ink-500">{t('Aucune campagne pour le moment.', 'No campaigns yet.')}</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {affichees.map((c) => <FunnelCampagne key={c.id} tenantId={tenantId} campagne={c} />)}
        </div>
      )}
      {/* Dit la limite au lieu de la taire : un lien ne sait pas quel envoi l'a porté, donc deux campagnes
          sur le même template lisent le même compteur. Le taire ferait prendre un chiffre de template pour
          un chiffre de campagne. */}
      <p className="pt-3 text-[11px] leading-relaxed text-ink-400">
        {t(
          'Les clics sur le lien sont comptés sur le lien du template, à partir du premier envoi de la campagne. Si le même template sert ailleurs, ses clics apparaissent ici aussi.',
          'Link clicks are counted on the template link, from the campaign’s first send. If the same template is used elsewhere, its clicks show up here too.',
        )}
      </p>
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
export function OrigineServiceCard({ repartition, detailIa }: {
  repartition?: { ia: number; scenario: number; humain: number; indeterminee: number };
  /**
   * LE DÉTAIL SOUS « IA » : laquelle des trois (demande de Julien, 2026-09-15).
   *
   * ⚠️ OPTIONNEL, comme `repartition` et pour la même raison : pendant le déploiement, l'API d'avant ne le
   * connaît pas. Absent, la ligne « IA » reste seule, ce qui était le comportement d'hier. Inventer un
   * détail à zéro ferait croire qu'aucune IA n'a écrit, ce qui est une mesure FAUSSE et non une mesure
   * manquante.
   */
  detailIa?: { agent: number; mba: number; mcp: number };
}) {
  const t = useT();
  const { locale } = useLocale();
  // Absente = l'API ne connaît pas encore ce champ (déploiement en cours). Rien plutôt qu'une fausse mesure.
  if (!repartition) return null;
  /**
   * Les sous-lignes de « IA », dans l'ordre où elles comptent pour l'exploitation, et SEULEMENT celles qui
   * ont écrit quelque chose.
   *
   * ⚠️ ON MASQUE LES ZÉROS, et ce n'est pas de la cosmétique : un client qui n'a pas branché l'agent de Meta
   * n'a aucune raison de lire « Agent de Meta : 0 » sous chaque tableau. Le thème « IA », lui, reste affiché
   * même à zéro, parce que son absence dirait quelque chose de différent de sa valeur nulle.
   */
  const sousIa = detailIa
    ? ([
      { cle: 'agent', label: t('Agent IA de la console', 'Console AI agent'), valeur: detailIa.agent },
      { cle: 'mba', label: t('Agent de Meta', 'Meta agent'), valeur: detailIa.mba },
      { cle: 'mcp', label: t('Agent tiers (MCP)', 'Third-party agent (MCP)'), valeur: detailIa.mcp },
    ]).filter((l) => l.valeur > 0)
    : [];
  const lignes = [
    { cle: 'ia', label: t('IA', 'AI'), aide: t('agent IA de la console, agent de Meta, agent tiers', 'console AI agent, Meta agent, third-party agent'), valeur: repartition.ia, couleur: 'bg-violet' },
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
              <Fragment key={l.cle}>
              <tr data-testid={`origine-${l.cle}`} className="border-b border-ink-50">
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
              {/**
                * LE DÉTAIL, EN RETRAIT SOUS LA SEULE LIGNE « IA ». Julien : « je veux avoir le détail sous IA
                * des messages écrits par le MBA ou par l'agent IA ».
                *
                * ⚠️ La part est calculée sur le MÊME total que les lignes principales, pas sur le total des
                * IA : autrement deux pourcentages voisins se liraient sur deux bases différentes, et la somme
                * de la colonne cesserait de faire cent.
                */}
              {l.cle === 'ia' && sousIa.map((d) => (
                <tr key={d.cle} data-testid={`origine-ia-${d.cle}`} className="border-b border-ink-50">
                  <td className="py-1.5 pl-6 pr-2">
                    <div className="flex items-center gap-2 text-[11px] text-ink-500">
                      <span className="h-1 w-1 rounded-full bg-violet" aria-hidden="true" />
                      {d.label}
                    </div>
                  </td>
                  <td className="px-2 py-1.5 tabular-nums text-[11px] text-ink-500">{fmtNum(d.valeur, locale)}</td>
                  <td className="px-2 py-1.5 tabular-nums text-[11px] text-ink-400">{fmtPct(d.valeur, total, locale)}</td>
                  <td className="px-2 py-1.5" />
                </tr>
              ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Breakdown des codes d'erreur Meta sur la période (avec libellé FR). */
export function ErrorBreakdownCard({ errors, tenantId, range }: {
  errors: ErrorBreakdownRow[];
  tenantId: string;
  range: StatsRange;
}) {
  const t = useT();
  const { locale } = useLocale();
  const [tpls, setTpls] = useState<string[]>([]);
  const [camps, setCamps] = useState<string[]>([]);
  const [ouvert, setOuvert] = useState<number | null>(null);

  // Les deux axes se DÉDUISENT des erreurs elles-mêmes, pas d'une liste de campagnes chargée à côté :
  // proposer une campagne sans erreur ferait choisir un filtre qui vide l'écran sans rien expliquer.
  const templates = [...new Set(errors.map((e) => e.templateName).filter((x): x is string => !!x))].sort();
  const campagnes = [...new Map(errors.map((e) => [e.campaignId, e.campaignName])).entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));

  // Plusieurs valeurs -> breakdown COMPILÉ sur l'ensemble. L'agrégation par code juste en dessous s'en
  // charge déjà : elle sommait le cas « tous les templates », donc rien de neuf à écrire pour un sous-ensemble.
  // Les deux axes sont MUTUELLEMENT EXCLUSIFS (voir les sélecteurs) : au plus un des deux filtre ici.
  const filtered = tpls.length > 0
    ? errors.filter((e) => e.templateName !== null && tpls.includes(e.templateName))
    : camps.length > 0
      ? errors.filter((e) => camps.includes(e.campaignId))
      : errors;
  // Agrège par code (somme sur les lignes de la sélection : plusieurs lignes par code sinon).
  const byCode = new Map<number, number>();
  for (const e of filtered) byCode.set(e.code, (byCode.get(e.code) ?? 0) + e.count);
  const rows = [...byCode.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || a.code - b.code);
  const total = rows.reduce((a, e) => a + e.count, 0);
  const max = rows.reduce((m, e) => Math.max(m, e.count), 0);

  /**
   * Un filtre qui change pendant qu'une ligne est ouverte laisserait une liste qui ne correspond plus au
   * chiffre affiché au-dessus. On referme.
   *
   * ⚠️ DANS LES `onChange`, PAS DANS UN EFFET. Un effet se joue APRÈS le rendu : la liste serait d'abord
   * remontée avec les nouveaux filtres, sa requête partirait, et le composant serait démonté juste après.
   * Le drapeau `alive` empêche l'écriture d'état, pas l'appel réseau.
   */
  const refermer = (suivant: string[]): boolean => { setOuvert(null); return suivant.length > 0; };

  return (
    <div id="quanti-erreurs" className="rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold tracking-tight text-ink-900">{t('Erreurs Meta', 'Meta errors')}</h3>
            <BoutonPdf zone="quanti-erreurs" />
          </div>
          <p className="text-xs text-ink-400">{t('par code, sur la période', 'by code, over the period')}</p>
        </div>
        {/* Mêmes axes exclusifs qu'au coût : les croiser décrirait leur intersection, pas leur union. */}
        <div className="flex flex-wrap items-center gap-2">
          {campagnes.length > 0 && (
            <SelecteurMultiple
              libelleTous={t('Toutes campagnes', 'All campaigns')}
              options={campagnes}
              selection={camps}
              onChange={(suivant) => { setCamps(suivant); if (refermer(suivant)) setTpls([]); }}
              testId="erreurs-campagnes"
            />
          )}
          {templates.length > 0 && (
            <SelecteurMultiple
              libelleTous={t('Tous les templates', 'All templates')}
              options={templates.map((n) => ({ value: n, label: n }))}
              selection={tpls}
              onChange={(suivant) => { setTpls(suivant); if (refermer(suivant)) setCamps([]); }}
              testId="erreurs-templates"
            />
          )}
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-ink-500">{t('Aucune erreur sur la période.', 'No errors over the period.')}</p>
      ) : (
        <div className="space-y-2.5">
          {rows.map((e) => (
            <div key={e.code}>
              {/* La ligne ENTIÈRE est le bouton : cliquer sur un code de quatre chiffres demanderait de viser. */}
              <button
                type="button"
                onClick={() => setOuvert((c) => (c === e.code ? null : e.code))}
                aria-expanded={ouvert === e.code}
                data-testid={`erreur-ligne-${e.code}`}
                className="w-full rounded-lg px-1 py-0.5 text-left transition hover:bg-ink-50"
              >
                {/* Des `span` en `block` et non des `div`/`p` : un bouton ne peut contenir que du contenu de
                    phrase. Le rendu est identique, le HTML cesse d'etre invalide. */}
                <span className="flex items-baseline justify-between gap-2">
                  <span className="font-mono text-xs font-medium text-ink-700">{e.code}</span>
                  <span className="text-xs tabular-nums text-ink-500">{fmtNum(e.count, locale)}</span>
                </span>
                <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-ink-50">
                  <span className="block h-full rounded-full bg-coral" style={{ width: `${max > 0 ? Math.max(4, Math.round((e.count / max) * 100)) : 0}%` }} />
                </span>
                <span className="mt-0.5 block text-[11px] text-ink-400">{metaCodeLabel(e.code, locale)}</span>
              </button>
              {ouvert === e.code && (
                <ContactsTouches
                  tenantId={tenantId}
                  range={range}
                  code={e.code}
                  campaignIds={camps}
                  templateNames={tpls}
                />
              )}
            </div>
          ))}
          <p className="pt-1 text-xs text-ink-400">{t('Total :', 'Total:')} <span className="font-medium text-ink-700">{fmtNum(total, locale)}</span></p>
        </div>
      )}
      {/* 🔴 DIT LES DEUX CHOSES QUE CE DÉCOMPTE NE VOIT PAS, toutes deux mesurées le 2026-09-07 :
          1. `error_code` n'existe que sur les destinataires de campagne, un envoi de scénario ou d'inbox ne
             journalise que son succès, son échec n'est écrit nulle part ;
          2. ce tableau est PAR CODE, donc un échec sans code Meta n'y a pas de ligne (2 sur 25 en
             production : un template inenvoyable, une panne réseau). Ceux-là sont dans le journal des
             erreurs de livraison, et l'écran doit y renvoyer plutôt que de laisser croire à un inventaire.
          Sans ces deux phrases, un écran vide se lirait « aucune erreur ». */}
      <p className="pt-3 text-[11px] leading-relaxed text-ink-400">
        {t(
          'Ce décompte porte sur les envois de CAMPAGNE, et il est classé par code Meta. Un échec sur un envoi de scénario ou depuis l’inbox n’est pas enregistré, et un échec sans code Meta (template inenvoyable, panne réseau) n’a pas de ligne ici : le journal complet est dans Paramètres, « Erreurs de livraison ».',
          'This count covers CAMPAIGN sends, grouped by Meta code. A failure on a scenario or inbox send is not recorded, and a failure without a Meta code (unsendable template, network outage) has no row here: the full log lives in Settings, "Delivery errors".',
        )}
      </p>
    </div>
  );
}

/**
 * QUI a été touché par un code d'erreur : la liste qui s'ouvre sous une ligne du breakdown.
 *
 * Elle reprend les filtres de la carte, sinon elle répondrait à une autre question que celle affichée
 * au-dessus (« les contacts de ce code », toutes campagnes confondues, sous un chiffre filtré).
 *
 * ⚠️ La liste est PLAFONNÉE côté serveur, et elle le dit quand elle est coupée : une liste tronquée en
 * silence se lit comme une liste complète, donc comme un décompte plus petit que le chiffre juste au-dessus.
 */
function ContactsTouches({ tenantId, range, code, campaignIds, templateNames }: {
  tenantId: string;
  range: StatsRange;
  code: number;
  campaignIds: string[];
  templateNames: string[];
}) {
  const t = useT();
  const { locale } = useLocale();
  const [etat, setEtat] = useState<{ contacts: ErrorContactRow[]; tronque: boolean; plafond: number } | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  // Clés SÉRIALISÉES : un tableau recréé à chaque rendu relancerait la requête en boucle.
  const cleCampagnes = campaignIds.join(',');
  const cleTemplates = templateNames.join(',');
  useEffect(() => {
    let alive = true;
    setEtat(null);
    setErreur(null);
    const filter = {
      ...(cleCampagnes ? { campaignIds: cleCampagnes.split(',') } : {}),
      ...(cleTemplates ? { templateNames: cleTemplates.split(',') } : {}),
    };
    getErrorContacts(tenantId, code, range, filter)
      .then((r) => { if (alive) setEtat(r); })
      .catch((e: unknown) => { if (alive) setErreur(e instanceof Error ? e.message : 'erreur'); });
    return () => { alive = false; };
  }, [tenantId, code, range, cleCampagnes, cleTemplates]);

  return (
    <div className="mt-2 rounded-lg border border-ink-100 bg-ink-50/50 p-2" data-testid={`erreur-contacts-${code}`}>
      {erreur !== null ? (
        // Un échec de chargement se DIT : sans ça, il se lirait « personne n'a été touché ».
        <p className="text-xs text-coral">{t('Liste indisponible :', 'List unavailable:')} {erreur}</p>
      ) : etat === null ? (
        <p className="text-xs text-ink-500">{t('Chargement…', 'Loading…')}</p>
      ) : etat.contacts.length === 0 ? (
        <p className="text-xs text-ink-500">{t('Aucun contact à afficher.', 'No contact to show.')}</p>
      ) : (
        <>
          <ul className="divide-y divide-ink-100">
            {etat.contacts.map((c) => (
              // La clé est l'identifiant de LIGNE du journal : un même contact peut échouer dans deux
              // campagnes, et sur la même campagne après un renvoi.
              <li key={c.recipientId} className="py-1">
                <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                  <span className="truncate text-xs font-medium text-ink-800">{c.contactNom ?? c.telephone}</span>
                  <span className="text-[11px] text-ink-400">
                    {c.campaignName ?? ''}
                    {c.at !== null ? ` · ${formatDate(c.at, locale, { day: '2-digit', month: '2-digit' })}` : ''}
                  </span>
                </div>
                {/* Ce que Meta a répondu. C'est le champ le plus utile de la liste : sans lui, on sait QUI a
                    échoué mais pas ce qu'on peut y faire. */}
                {c.message !== null && <p className="truncate text-[11px] text-ink-500" title={c.message}>{c.message}</p>}
              </li>
            ))}
          </ul>
          {etat.tronque && (
            <p className="pt-1 text-[11px] text-gold" data-testid={`erreur-contacts-tronque-${code}`}>
              {t(
                `Liste limitée aux ${etat.plafond} plus récents.`,
                `List limited to the ${etat.plafond} most recent.`,
              )}
            </p>
          )}
        </>
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
            {t('par jour, votre prix × volume', 'per day, your price × volume')}{cost ? <> · {t('total ≈', 'total ≈')} <span className="font-medium text-ink-700">{fmtCost(cost.total, locale, cost.currency)}</span></> : null}
            {/* 🔴 CE QUE LE COÛT NE COMPTE PAS, DIT PLUTÔT QUE TU. Un envoi sans catégorie connue ne produit
                aucun coût et disparaissait du calcul en silence : le client lisait zéro là où il avait bien
                envoyé. Vécu sur 22 envois de scénario, dont la catégorie n'était pas écrite avant le
                2026-09-07. Un volume non chiffrable est une information, l'escamoter est un mensonge par
                omission.
                ⚠️ LE TEXTE VIT DANS UN MODULE PARTAGÉ avec le tableau de la synthèse, et il DISTINGUE
                désormais les deux causes : la catégorie absente est un héritage clos, le tarif manquant est
                une panne du jour. Une seule phrase pour les deux laissait le lecteur sans savoir s'il devait
                attendre ou aller réparer. */}
            {cost ? phrasesNonChiffrables(cost, 'periode', (n) => fmtNum(n, locale)).map((ph) => (
              <span key={ph.fr} className="mt-1 block text-gold" data-testid="cout-non-chiffrables">{t(ph.fr, ph.en)}</span>
            )) : null}
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
  const marge = data?.margeTemplate;
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
      {/*
        🔴 CETTE PHRASE RECONCILIE DEUX CHIFFRES DE LA MEME PAGE, ET ELLE DESIGNAIT LA MAUVAISE CAUSE. Elle
        attribuait tout l'ecart au tarif moyen par categorie, ce qui etait vrai tant que personne ne posait
        de marge. Depuis que la marge se regle (2026-09-18), le « cout estime » est un prix de VENTE et ce
        total est ce que Meta a FACTURE : avec une marge de 150, l'ecart est de 50 % et sa cause dominante
        n'etait nommee nulle part. Le client lisait deux nombres et la seule explication a l'ecran lui
        designait un arrondi. Releve a la quatrieme revue.

        ⚠️ LA MARGE N'EST NOMMEE QUE QUAND ELLE EXISTE : a 100, elle n'explique rien et l'ecart redevient
        celui du tarif moyen. Une phrase qui parlerait de marge a un client qui n'en a pas pose ferait
        chercher une cause absente.
      */}
      <p className="mt-2 border-t border-ink-100 pt-2 text-xs text-ink-400">
        {t(
          'Le « coût estimé » plus haut ne donnera jamais exactement ce chiffre : c’est notre volume multiplié par un tarif moyen par catégorie, pas une facture.',
          'The "estimated cost" above will never match this exactly: it is our volume times an average per-category rate, not an invoice.',
        )}
        {/* ⚠️ LA MARGE S AJOUTE A L EXPLICATION, ELLE NE LA REMPLACE PAS. La premiere version BRANCHAIT
            entre les deux phrases : a marge 105, la cause dominante restait le tarif moyen et l ecran ne la
            nommait plus du tout, il designait 5 %. Un correctif qui deplace le defaut au lieu de le
            supprimer, exactement le motif de ce chantier. Les deux causes existent, on les dit toutes deux. */}
        {marge !== undefined && marge !== 100 && (
          <> {t(
            `Il applique en plus votre marge de ${fmtPourcent(marge, locale)}, alors que ce total-ci est ce que Meta vous a compté.`,
            `It also applies your ${fmtPourcent(marge, locale)} margin, whereas this total is what Meta charged you.`,
          )}</>
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
            hint={estimated != null ? t('volume × votre prix (tarif Meta et votre marge)', 'volume × your price (Meta rate and your margin)') : t('tarif Meta indisponible', 'Meta rate unavailable')}
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
