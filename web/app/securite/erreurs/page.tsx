'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { RangeBar } from '@/components/RangeBar';
import { ErreursLivraison, ErreursSysteme } from '@/components/ErreursLivraison';
import { ErrorBreakdownCard } from '@/components/analytics/cartes';
import { getErrorBreakdown, type ErrorBreakdownRow, type StatsRange } from '@/lib/api';
import type { Session } from '@/lib/session';
import { useT } from '@/lib/i18n';
import { presetRange } from '@/lib/range';

/**
 * LE JOURNAL DES ERREURS, ET IL EN A TROIS MOITIÉS (tranché par Julien le 2026-09-13 : « on a déjà un log
 * d'erreurs [...] donc il faut les 2 », puis le 2026-09-17 pour la troisième).
 *
 * 🔴 TROIS VUES DE NATURE DIFFÉRENTE, DISTINGUÉES ET NON MÉLANGÉES.
 *  - AGRÉGAT : combien d'échecs, par code d'erreur Meta, sur une PÉRIODE. C'est la seule des trois qui
 *    dise s'il faut agir, et sur quoi : un code qui revient cent fois ce mois-ci est un problème, la même
 *    erreur vue une fois n'en est pas un.
 *  - CLIENT : ce que META a répondu quand un message vers un CONTACT n'est pas parti ou pas arrivé. Quelqu'un
 *    attend au bout d'un téléphone.
 *  - SYSTÈME : ce que LES SYSTÈMES DU CLIENT (CRM, ERP, back-office) ont répondu aux appels que nous leur
 *    passons. Personne n'attend, et la correction est chez lui.
 * Les fondre obligerait chaque ligne à porter les colonnes vides de l'autre, et ferait chercher un numéro de
 * téléphone là où il n'y en a jamais eu.
 *
 * 🔴 L'AGRÉGAT VIENT DE `Analytics > Quantitatif > Erreurs`, QUI A DISPARU LE 2026-09-17 (Julien : « l'onglet
 * erreur dans quantitatif n'a plus rien à faire là, on l'a mis dans Console > securité > journal des
 * erreurs »). Il a DÉMÉNAGÉ et n'a pas été supprimé, parce que ce n'était PAS un doublon du journal : le
 * journal rend les 100 dernières lignes, cherchables par numéro ; l'agrégat rend un classement par code sur
 * une fenêtre choisie. Supprimer le second aurait retiré la seule vue qui répond à « qu'est-ce qui cloche
 * en ce moment ».
 *
 * ⚠️ LA PÉRIODE NE SERT QUE L'AGRÉGAT, et c'est pour ça qu'elle est posée en haut, juste au-dessus de lui.
 * Les deux journaux n'en ont pas : ils rendent les dernières lignes, point. Une barre de période qui n'en
 * filtrerait qu'un tiers, sans le dire, ferait croire que les deux autres sont vides sur la fenêtre.
 *
 * ⚠️ LA MOITIÉ CLIENT PORTE LES NUMÉROS, DÉLIBÉRÉMENT (« quel message n'est pas arrivé » sans dire « à
 * qui » ne répond à rien), et les trois sont admin-only côté serveur. Le déplacer dans un centre de
 * conformité ne l'ouvre PAS plus largement : la garde est sur la route, pas sur le menu.
 */
export default function SecuriteErreursPage() {
  return <AppShell active="securite-erreurs">{(session) => <ErreursInner session={session} />}</AppShell>;
}

function ErreursInner({ session }: { session: Session }) {
  const t = useT();
  const [range, setRange] = useState<StatsRange>(() => presetRange(30));
  const [errors, setErrors] = useState<ErrorBreakdownRow[]>([]);
  const [chargement, setChargement] = useState(true);
  const [erreur, setErreur] = useState<string | null>(null);

  /**
   * 🔴 L'AGRÉGAT EST ADMIN-ONLY, LES DEUX JOURNAUX NE LE SONT PAS, ET CET ÉCRAN PORTE LES TROIS.
   *
   * Le centre de Sécurité est ouvert aux MANAGERS (`ECRANS_ENCADREMENT`, décision de Julien du 2026-09-14 :
   * « ouvre la console aux managers sur les écrans de conformité »). Or tout le module `stats` est monté
   * avec la garde `admin` (`src/server.ts`, `registerStats(app, d, g.admin)`), donc `getErrorBreakdown`
   * rend **403** à un manager. Sans cette condition, amener la carte ici aurait collé un bandeau rouge en
   * haut d'une page qui marchait très bien pour lui la veille, et l'aurait fait à CHAQUE ouverture.
   *
   * ⚠️ ON N'APPELLE PAS, ON NE CACHE PAS APRÈS COUP. Masquer la carte en laissant partir la requête
   * produirait un refus par ouverture d'écran, donc du bruit dans les journaux d'accès pour une page que
   * ce rôle a le droit d'ouvrir. « On ne montre qu'une porte qu'on peut ouvrir » vaut aussi pour les
   * requêtes qu'on lance sans le dire.
   *
   * ⚠️ ET LA BARRE DE PÉRIODE PART AVEC, parce qu'elle ne filtre QUE cet agrégat : la laisser donnerait à
   * un manager un réglage qui ne change rien à l'écran, ce qui est le motif « offert-et-inerte » que ce
   * produit s'interdit ailleurs.
   */
  const voitAgregat = session.role === 'admin';

  const charger = useCallback(async () => {
    if (!voitAgregat) { setChargement(false); return; }
    setErreur(null);
    try {
      const eb = await getErrorBreakdown(session.tenantId, range);
      setErrors(Array.isArray(eb?.errors) ? eb.errors : []);
    } catch (err) {
      setErreur(err instanceof Error ? err.message : t('Chargement impossible', 'Unable to load'));
    } finally {
      setChargement(false);
    }
  }, [session.tenantId, range, t, voitAgregat]);

  useEffect(() => { void charger(); }, [charger]);

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 p-6">
      {voitAgregat && (
        <>
          <RangeBar title={t('Erreurs de livraison', 'Delivery errors')} range={range} onChange={setRange} />
          {erreur && <p className="rounded-lg bg-danger-50 px-3 py-2 text-sm text-danger-700">{erreur}</p>}
          {chargement ? (
            <p className="text-sm text-ink-500">{t('Chargement des statistiques...', 'Loading statistics...')}</p>
          ) : (
            <ErrorBreakdownCard errors={errors} tenantId={session.tenantId} range={range} />
          )}
        </>
      )}
      <ErreursLivraison tenantId={session.tenantId} />
      <ErreursSysteme tenantId={session.tenantId} />
    </div>
  );
}
