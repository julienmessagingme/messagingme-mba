'use client';

import { useState } from 'react';
import { useT } from '@/lib/i18n';
import { basculerPub, lirePub, publierPub, type Entonnoir, type EtapeEntonnoir, type Publicite } from '@/lib/api-pubs';

/**
 * LA LISTE DES PUBLICITÉS, ET LA PAGE D'UNE PUBLICITÉ (lot 3, spec § 3.7).
 *
 * 🔴 « NON DISPONIBLE » N'EST JAMAIS « 0 », ET C'EST LA RÈGLE QUI GOUVERNE TOUT CET ÉCRAN. Il sert à
 * répondre à une seule question : « est-ce que j'arrête cette campagne, ou est-ce que je remets du
 * budget ? ». Un coût affiché « 0 € » alors qu'il est INCONNU ressemble au meilleur résultat imaginable,
 * et c'est le chiffre le plus trompeur que cette page puisse produire. Le calcul vit côté serveur
 * (`src/pubs/entonnoir.ts`) et rend `null` : ici, on l'écrit.
 *
 * ⚠️ LES CHIFFRES DATENT, ET LA PAGE LE DIT. Ils viennent du balayage qui relit Meta toutes les quinze
 * minutes, pas d'un appel à l'ouverture : afficher une heure de lecture évite qu'on cherche une panne là
 * où il n'y a qu'un délai.
 */

type T = (fr: string, en?: string) => string;

/** Le libellé d'un statut Meta, en clair. Une valeur inconnue s'affiche TELLE QUELLE plutôt que traduite. */
function libelleStatut(statut: string | null, t: T): string {
  const connus: Record<string, string> = {
    ACTIVE: t('Diffuse', 'Delivering'),
    PAUSED: t('En pause', 'Paused'),
    CAMPAIGN_PAUSED: t('En pause', 'Paused'),
    ADSET_PAUSED: t('En pause', 'Paused'),
    PENDING_REVIEW: t('En revue chez Meta', 'In review at Meta'),
    DISAPPROVED: t('Refusée par Meta', 'Rejected by Meta'),
    WITH_ISSUES: t('Problème signalé par Meta', 'Issue reported by Meta'),
    IN_PROCESS: t('En cours de traitement', 'Processing'),
    COMPLETED: t('Terminée', 'Finished'),
  };
  // 🔴 `null` NE DEVIENT PAS « en pause » NI « inconnue » : c'est « pas encore lu », et le distinguer
  // évite de faire chercher un problème chez Meta quand le balayage n'est simplement pas encore passé.
  if (statut === null) return t('Pas encore relue chez Meta', 'Not read from Meta yet');
  return connus[statut] ?? statut;
}

/** Un nombre, ou « non disponible ». JAMAIS zéro par défaut. */
function ouRien(v: number | null, t: T, suffixe = ''): string {
  return v === null ? t('non disponible', 'not available') : `${arrondi(v)}${suffixe}`;
}

function arrondi(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

function pourcent(v: number | null, t: T): string {
  return v === null ? t('non disponible', 'not available') : `${(v * 100).toFixed(1)} %`;
}

export function PubsListe({ tenantId, publicites, recharger }: {
  tenantId: string; publicites: Publicite[]; recharger: () => Promise<void>;
}) {
  const t = useT();
  const [ouverte, setOuverte] = useState<string | null>(null);

  if (publicites.length === 0) {
    return (
      <p className="text-sm text-ink-500" data-testid="pubs-liste-vide">
        {t('Aucune publicité pour l’instant.', 'No ads yet.')}
      </p>
    );
  }

  return (
    <ul className="divide-y divide-ink-100" data-testid="pubs-liste">
      {publicites.map((p) => (
        <li key={p.id} className="py-3">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-ink-900">{p.nom}</p>
              <p className="mt-0.5 text-xs text-ink-500">
                {p.etat === 'publiee' ? libelleStatut(p.statutMeta, t)
                  : p.etat === 'prete' ? t('Prête, pas encore publiée', 'Ready, not published yet')
                  : p.etat === 'creation' ? t('Création en cours', 'Being created')
                  : t('Création échouée', 'Creation failed')}
                {' · '}
                {p.destination === 'scenario' ? t('Scénario', 'Scenario') : t('Agent de Meta', 'Meta agent')}
                {p.budgetTotal !== null ? ` · ${t('budget')} ${arrondi(p.budgetTotal)}` : ''}
              </p>
              {p.motifRefus !== null && (
                <p className="mt-1 text-xs text-red-700" data-testid="pub-motif">{p.motifRefus}</p>
              )}
              {p.etat === 'echec_creation' && (
                /* ⚠️ ON LE DIT, PARCE QUE QUELQUE CHOSE PEUT SUBSISTER CHEZ META. En pause, donc sans
                   dépense, mais le taire ferait découvrir la campagne au client dans le Gestionnaire
                   sans qu'il sache d'où elle vient. */
                <p className="mt-1 text-xs text-amber-700" data-testid="pub-echec">
                  {t('Cette création a échoué. Une campagne en pause peut subsister chez Meta : elle ne dépense rien.',
                     'This creation failed. A paused campaign may remain at Meta: it does not spend anything.')}
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Actions tenantId={tenantId} pub={p} recharger={recharger} t={t} />
              <button
                type="button"
                onClick={() => setOuverte(ouverte === p.id ? null : p.id)}
                className="rounded-lg border border-ink-200 px-2 py-1 text-xs text-ink-700"
                data-testid={`pub-detail-${p.id}`}
              >
                {ouverte === p.id ? t('Fermer', 'Close') : t('Chiffres', 'Numbers')}
              </button>
            </div>
          </div>
          {ouverte === p.id && <Detail tenantId={tenantId} id={p.id} t={t} />}
        </li>
      ))}
    </ul>
  );
}

/**
 * PUBLIER, METTRE EN PAUSE, RELANCER.
 *
 * 🔴 « PUBLIER » EST LE SEUL BOUTON DE CET ÉCRAN QUI ENGAGE DE L'ARGENT, et il le dit avant d'agir : la
 * dépense maximale et les dates sont rappelées dans la confirmation. Le reste ne fait que créer des objets
 * en pause, ou les arrêter.
 */
function Actions({ tenantId, pub, recharger, t }: {
  tenantId: string; pub: Publicite; recharger: () => Promise<void>; t: T;
}) {
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  async function agir(quoi: () => Promise<unknown>): Promise<void> {
    setErreur(null);
    setBusy(true);
    try {
      await quoi();
      await recharger();
    } catch (err) {
      setErreur(err instanceof Error ? err.message : t('Action impossible', 'Action failed'));
    } finally {
      setBusy(false);
    }
  }

  const enPause = pub.statutMeta !== 'ACTIVE';

  return (
    <div className="text-right">
      {pub.etat === 'prete' && (
        <button
          type="button" disabled={busy}
          onClick={() => {
            const jusqua = pub.budgetTotal !== null ? arrondi(pub.budgetTotal) : '?';
            const bornes = pub.debut !== null && pub.fin !== null
              ? ` ${t('entre le', 'between')} ${pub.debut.slice(0, 10)} ${t('et le', 'and')} ${pub.fin.slice(0, 10)}`
              : '';
            // 🔴 LA CONFIRMATION DIT LA DÉPENSE MAXIMALE (spec § 3.2). Publier est irréversible au sens qui
            // compte : une impression payée ne se rembourse pas.
            if (!window.confirm(t(
              `Cette publicité peut dépenser jusqu’à ${jusqua}${bornes}. Publier ?`,
              `This ad can spend up to ${jusqua}${bornes}. Publish?`,
            ))) return;
            void agir(() => publierPub(tenantId, pub.id));
          }}
          className="rounded-lg bg-ink-900 px-2 py-1 text-xs font-medium text-white disabled:opacity-40"
          data-testid={`pub-publier-${pub.id}`}
        >
          {t('Publier', 'Publish')}
        </button>
      )}
      {pub.etat === 'publiee' && (
        <button
          type="button" disabled={busy}
          onClick={() => void agir(() => basculerPub(tenantId, pub.id, enPause))}
          className="rounded-lg border border-ink-200 px-2 py-1 text-xs text-ink-700 disabled:opacity-40"
          data-testid={`pub-bascule-${pub.id}`}
        >
          {enPause ? t('Relancer', 'Resume') : t('Mettre en pause', 'Pause')}
        </button>
      )}
      {erreur !== null && <p role="alert" className="mt-1 text-xs text-red-700">{erreur}</p>}
    </div>
  );
}

function Detail({ tenantId, id, t }: { tenantId: string; id: string; t: T }) {
  const [vue, setVue] = useState<{ publicite: Publicite; entonnoir: Entonnoir } | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  if (vue === null && erreur === null) {
    void lirePub(tenantId, id)
      .then(setVue)
      .catch((err: unknown) => setErreur(err instanceof Error ? err.message : t('Lecture impossible', 'Could not load')));
  }

  if (erreur !== null) return <p role="alert" className="mt-2 text-xs text-red-700">{erreur}</p>;
  if (vue === null) return <p className="mt-2 text-xs text-ink-500">{t('Chargement…', 'Loading…')}</p>;

  const e = vue.entonnoir;
  return (
    <div className="mt-3 rounded-xl bg-ink-50 p-3" data-testid={`pub-entonnoir-${id}`}>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
        <Chiffre t={t} libelle={t('Dépense', 'Spend')} valeur={ouRien(e.depense, t)} />
        <Etape t={t} libelle={t('Clics', 'Clicks')} etape={e.clics} />
        <Etape t={t} libelle={t('Prospects', 'Leads')} etape={e.leads} />
        <Etape t={t} libelle={t('Qualifiés', 'Qualified')} etape={e.qualifies} />
      </dl>
      {/* 🔴 À PART, ET NOMMÉS : ce sont des clics PAYÉS qui n'ont produit aucune conversation. Les noyer
          dans le total des prospects les rendrait invisibles, et les en soustraire flatterait le taux. */}
      <p className="mt-2 text-xs text-ink-500" data-testid={`pub-non-pris-${id}`}>
        {t('Prospects non pris en charge', 'Leads not handled')} : {e.nonPrisEnCharge}
        {' '}
        <span className="text-ink-400">
          ({t('reprise refusée, désabonnés, bloqués', 'handover refused, unsubscribed, blocked')})
        </span>
      </p>
      <p className="mt-1 text-xs text-ink-400">
        {vue.publicite.luLe === null
          ? t('Chiffres jamais relus chez Meta.', 'Numbers never read from Meta.')
          : `${t('Relus chez Meta le', 'Read from Meta on')} ${new Date(vue.publicite.luLe).toLocaleString()}`}
      </p>
    </div>
  );
}

function Chiffre({ libelle, valeur }: { t: T; libelle: string; valeur: string }) {
  return (
    <div>
      <dt className="text-ink-500">{libelle}</dt>
      <dd className="font-medium text-ink-900">{valeur}</dd>
    </div>
  );
}

function Etape({ t, libelle, etape }: { t: T; libelle: string; etape: EtapeEntonnoir }) {
  return (
    <div>
      <dt className="text-ink-500">{libelle}</dt>
      <dd className="font-medium text-ink-900">{ouRien(etape.nombre, t)}</dd>
      <dd className="text-ink-400">
        {t('coût', 'cost')} {ouRien(etape.cout, t)}
        {etape.passage !== null && ` · ${pourcent(etape.passage, t)}`}
      </dd>
    </div>
  );
}
