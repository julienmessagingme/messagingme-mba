'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { OrigineServiceCard } from '@/components/analytics/cartes';
import { DailyChart } from '@/components/DailyChart';
import { RangeBar } from '@/components/RangeBar';
import type { Session } from '@/lib/session';
import { getStats, type DashboardStats, type StatsRange, type DailyPoint } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { presetRange } from '@/lib/range';

export default function DashboardPage() {
  return <AppShell active="quanti-messages">{(session) => <MessagesInner session={session} />}</AppShell>;
}

function MessagesInner({ session }: { session: Session }) {
  const t = useT();
  const [range, setRange] = useState<StatsRange>(() => presetRange(30));
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const s = await getStats(session.tenantId, range);
      // Normalisé AVANT d'entrer dans l'état. Une réponse 200 amputée d'un champ (version d'API en retard,
      // route qui rend `{}`) posait `undefined` dans un état typé, et un `.marketing` du rendu emportait
      // l'ÉCRAN ENTIER, pas la carte concernée. Le `catch` n'y peut rien : il n'y a aucune erreur réseau.
      const serie = (v: unknown): DailyPoint[] => (Array.isArray(v) ? (v as DailyPoint[]) : []);
      setStats({
        contacts: serie(s?.contacts),
        // ⚠️ `undefined` QUAND L'API NE L'ENVOIE PAS, et surtout pas un tableau vide : la bascule se masque
        // alors, au lieu de proposer une courbe plate qu'on lirait « plus aucun contact ».
        ...(Array.isArray(s?.contactsActifs) ? { contactsActifs: s.contactsActifs } : {}),
        templates: { marketing: serie(s?.templates?.marketing), utility: serie(s?.templates?.utility) },
        exchanged: serie(s?.exchanged),
        service: serie(s?.service),
        // Laisse `undefined` si l'API ne l'envoie pas : la carte se masque alors, au lieu d'afficher trois
        // zeros qu'on prendrait pour une mesure (meme raison que le `?? []` des series, un cran plus loin).
        ...(s?.serviceParOrigine ? { serviceParOrigine: s.serviceParOrigine } : {}),
        ...(s?.serviceIaDetail ? { serviceIaDetail: s.serviceIaDetail } : {}),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Chargement impossible', 'Unable to load'));
    } finally {
      setLoading(false);
    }
  }, [session.tenantId, range]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-4">
      <RangeBar title={t('Messages & contacts', 'Messages & contacts')} range={range} onChange={setRange} />

      {error && <p className="rounded-lg bg-danger-50 px-3 py-2 text-sm text-danger-700">{error}</p>}

      {loading ? (
        <p className="text-sm text-ink-500">{t('Chargement des statistiques...', 'Loading statistics...')}</p>
      ) : stats ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <CarteContacts stats={stats} range={range} />
          <DailyChart
            title={t('Messages échangés', 'Messages exchanged')}
            subtitle={t('reçus + réponses (hors template)', 'received + replies (excluding templates)')}
            from={range.from}
            to={range.to}
            zonePdf="quanti-echanges"
            series={[{ label: t('Échangés', 'Exchanged'), color: '#6E5AE0', points: stats.exchanged }]}
          />
          <div className="lg:col-span-2">
            {/* Templates ET messages de service au même endroit : c'est ici qu'on lit ce qui est parti, et les
                séparer obligeait à additionner de tête pour connaître le volume envoyé. Les messages de service
                n'entrent pas dans le coût : Meta ne les facture pas au message. */}
            <DailyChart
              title={t('Messages envoyés', 'Messages sent')}
              subtitle={t('par jour : templates (marketing, utility) et messages de service', 'per day: templates (marketing, utility) and service messages')}
              from={range.from}
              to={range.to}
              zonePdf="quanti-messages-envoyes"
              series={[
                { label: 'Marketing', color: '#0080D6', points: stats.templates.marketing },
                { label: 'Utility', color: '#17C74E', points: stats.templates.utility },
                // `?? []` : mba-web et mba-api sont deux conteneurs, et ils ne redemarrent pas a la meme seconde. Le
                // temps d'un deploiement, le front neuf peut interroger l'API d'avant ; une page d'analytics qui
                // tombe pendant ces quelques secondes se remarque plus qu'une courbe vide.
                { label: t('Service', 'Service'), color: '#F5A623', points: stats.service ?? [] },
              ]}
            />
          </div>
          <div className="lg:col-span-2">
            <OrigineServiceCard repartition={stats.serviceParOrigine} detailIa={stats.serviceIaDetail} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * LA CARTE DES CONTACTS, AVEC SA BASCULE CUMULES / ACTIFS (demande de Julien du 2026-09-23).
 *
 * 🔴 DEUX QUESTIONS DIFFERENTES, PAS DEUX VERSIONS DE LA MEME. « Cumules » dit ce qu'on a COLLECTE depuis le
 * debut, « actifs » ce qu'on a ENCORE dans le mini-CRM. Une base qu'on nettoie voit les deux courbes
 * diverger, et c'est l'ECART qui est l'information : une seule des deux, quelle qu'elle soit, la cache.
 *
 * ⚠️ « CUMULES » RESTE LE DEFAUT, parce que c'est ce que cette carte a toujours montre : changer la courbe
 * par defaut ferait lire une baisse la ou rien n'a bouge, pour tous ceux qui regardent cet ecran chaque
 * semaine.
 *
 * ⚠️ LA BASCULE DISPARAIT SI L'API NE REND PAS LES ACTIFS (le temps d'un deploiement, le front neuf parle a
 * l'API d'avant). Un bouton qui ne montrerait rien est pire que pas de bouton.
 */
function CarteContacts({ stats, range }: { stats: DashboardStats; range: StatsRange }) {
  const t = useT();
  const [actifs, setActifs] = useState(false);
  const dispo = Array.isArray(stats.contactsActifs) && stats.contactsActifs.length > 0;
  const montreActifs = actifs && dispo;
  return (
    <DailyChart
      title={t('Contacts', 'Contacts')}
      subtitle={montreActifs
        ? t('encore dans le mini-CRM', 'still in the mini-CRM')
        : t('total cumulé', 'cumulative total')}
      zonePdf="quanti-contacts"
      from={range.from}
      to={range.to}
      summary="last"
      series={[{
        label: montreActifs ? t('Actifs', 'Active') : t('Contacts', 'Contacts'),
        color: montreActifs ? '#17C74E' : '#009AFE',
        points: montreActifs ? stats.contactsActifs! : stats.contacts,
      }]}
      actions={dispo ? (
        <div className="sans-impression inline-flex rounded-lg border border-ink-200 p-0.5 text-xs" data-testid="contacts-bascule">
          {([false, true] as const).map((v) => (
            <button
              key={String(v)}
              type="button"
              onClick={() => setActifs(v)}
              aria-pressed={actifs === v}
              data-testid={v ? 'contacts-actifs' : 'contacts-cumules'}
              className={`rounded-md px-2 py-0.5 font-medium transition-colors duration-150 ${actifs === v ? 'bg-ink-100 text-ink-900' : 'text-ink-500 hover:text-ink-900'}`}
            >
              {v ? t('Actifs', 'Active') : t('Cumulés', 'Cumulative')}
            </button>
          ))}
        </div>
      ) : undefined}
    />
  );
}

