'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  getCoutParCampagne, getCoutMessages, getCoutIa,
  type CoutParCampagne, type CoutMessages, type CoutIa, type StatsRange,
} from '@/lib/api';
import { fmtNum, fmtCost } from '@/lib/format';
import { formatDate } from '@/lib/day';
import { eurosDepuisMicro } from '@/lib/agent-solde';
import { coutMoyenParEngagement } from '@/lib/cout-moyen';
import { DetailCampagneModale } from '@/components/DetailCampagneModale';
import { useT, useLocale } from '@/lib/i18n';
import { Icone } from '@/components/Icone';
import { Nd, useErreurRegroupee } from '@/components/Nd';

/**
 * LA CARTE « COUTS » DE LA SYNTHESE : trois chiffres, et rien d'autre tant qu'on ne déplie pas.
 *
 * 🔴 ELLE REMPLACE `CoutParCampagneCard`, ET LA DIFFERENCE N'EST PAS COSMETIQUE. L'ancienne posait un
 * tableau de sept colonnes et quatre paragraphes de réserves sur un écran qu'on ouvre pour se faire une
 * idée. Julien, le 2026-09-17 : « tu supprimes tout le blabla [...] je veux 1 seul chiffre à ce niveau
 * là ». Les réserves ne sont pas perdues : elles descendent dans la fiche d'une campagne, où elles ont
 * leur place, c'est-à-dire là où quelqu'un regarde UNE campagne et peut en faire quelque chose.
 *
 * 🔴 TROIS LIGNES, ET ELLES NE REPONDENT PAS A LA MEME QUESTION. « Ce qu'une personne engagée m'a coûté »
 * est un ratio ; « ce que la période a coûté » est un total ; « ce que l'IA m'a coûté » est un autre total,
 * sur un autre budget. Les additionner n'aurait aucun sens, et la carte ne propose donc AUCUN grand total.
 *
 * ⚠️ TROIS APPELS SEPARES, ET C'EST VOULU. Les fondre en une route ferait payer à chaque ouverture ce dont
 * l'écran n'a pas encore besoin, et surtout : si l'un des trois tombe, les deux autres s'affichent. Une
 * route unique ferait disparaître la carte entière pour une panne d'un tiers de son contenu.
 */

const CARD = 'rounded-carte border border-ink-200 bg-white p-5';
const TH = 'px-2 py-1.5 text-left text-xs font-medium text-ink-500';
const TD = 'px-2 py-1.5 text-sm text-ink-900';

export function CarteCouts({ tenantId, range }: { tenantId: string; range: StatsRange }) {
  const t = useT();
  const { locale } = useLocale();
  const [campagnes, setCampagnes] = useState<CoutParCampagne | null | 'erreur'>(null);
  const [messages, setMessages] = useState<CoutMessages | null | 'erreur'>(null);
  const [ia, setIa] = useState<CoutIa | null | 'erreur'>(null);
  const [ouverte, setOuverte] = useState<string | null>(null);
  const [fiche, setFiche] = useState<{ id: string; nom: string } | null>(null);
  // Les campagnes archivées, exclues par défaut : elles entraient dans le tableau sans le dire (lot 4).
  const [archivees, setArchivees] = useState(false);

  /**
   * L'adresse du détail, période comprise. Les postes de messages y mènent (cf. `Poste`).
   *
   * ⚠️ `du` ET `au`, LES MÊMES NOMS QUE LA PAGE D'ARRIVÉE LIT. Écrits deux fois, à deux endroits : un seul
   * qui change et le lien retombe sur la période par défaut, en silence, ce qui est exactement le défaut
   * que ces paramètres existent pour éviter. `web/e2e/performance-cout.spec.ts` recolle les deux.
   */
  const lienCouts = `/dashboard/couts?du=${encodeURIComponent(range.from)}&au=${encodeURIComponent(range.to)}`;

  useEffect(() => {
    let vivant = true;
    setCampagnes(null); setMessages(null); setIa(null);
    /**
     * 🔴 LE TYPE MENT SUR UNE DONNEE DE RESEAU, et cette carte l'a déjà payé une fois. `request()` rend ce
     * que le serveur a envoyé ; une API plus ancienne que ces routes, ou un proxy qui répond `{}`, et un
     * `.map` jette EN PLEIN RENDU. Ce n'est pas la carte qui tombe alors, c'est la PAGE, donc aussi la
     * colonne de droite qui n'a rien demandé. Chaque réponse est donc vérifiée avant d'entrer dans l'état.
     */
    getCoutMessages(tenantId, range)
      .then((d) => { if (vivant) setMessages(d && typeof d.total === 'number' && d.service ? d : 'erreur'); })
      .catch(() => { if (vivant) setMessages('erreur'); });
    getCoutIa(tenantId, range)
      .then((d) => { if (vivant) setIa(d && typeof d.coutMicroEur === 'number' ? d : 'erreur'); })
      .catch(() => { if (vivant) setIa('erreur'); });
    return () => { vivant = false; };
  }, [tenantId, range.from, range.to]);

  // ⚠️ UN EFFET À PART : basculer les archivées ne relit que les campagnes, pas les deux autres lignes.
  useEffect(() => {
    let vivant = true;
    setCampagnes(null);
    getCoutParCampagne(tenantId, range, archivees)
      .then((d) => { if (vivant) setCampagnes(d && Array.isArray(d.lignes) ? d : 'erreur'); })
      .catch(() => { if (vivant) setCampagnes('erreur'); });
    return () => { vivant = false; };
  }, [tenantId, range.from, range.to, archivees]);

  /**
   * 🔴 CHAQUE LIGNE PORTE SA PROPRE DEVISE, ET LA PREMIERE VERSION NE LE FAISAIT PAS. Elle prenait celle de
   * la route des campagnes pour TOUTE la carte : une panne de cette route, ou une période sans campagne,
   * et les montants de la ligne « messages » s'affichaient sans leur symbole. C'est exactement ce que les
   * trois appels séparés existent pour éviter, défait au moment de l'affichage. Trouvé en revue le
   * 2026-09-17, et le test « une panne d'une ligne ne tue pas les deux autres » passait quand même, parce
   * que le nombre s'affichait.
   *
   * ⚠️ LE REPLI SUR L'AUTRE DEVISE NE SERT QU'A LA FENETRE DE DEPLOIEMENT, où l'API du VPS ne rend pas
   * encore `currency` sur cette route. Les deux viennent du MEME appel Meta (`pricing_analytics`), donc
   * elles ne peuvent pas se contredire : le repli ne peut jamais afficher une devise fausse.
   */
  const deviseCampagnes = campagnes !== null && campagnes !== 'erreur' ? campagnes.currency : null;
  const deviseMessages = messages !== null && messages !== 'erreur'
    ? (messages.currency ?? deviseCampagnes)
    : deviseCampagnes;
  const moyen = campagnes !== null && campagnes !== 'erreur'
    ? coutMoyenParEngagement(campagnes.lignes)
    : null;

  return (
    <section className={CARD} data-testid="carte-couts">
      <header className="mb-4">
        <h2 className="text-sm font-semibold text-ink-900">{t('Coûts', 'Costs')}</h2>
        {/* La seule phrase de la carte, et elle porte la seule réserve qui vaut pour les TROIS lignes.
            Tout le reste du texte de l'ancienne carte est descendu dans la fiche d'une campagne. */}
        <p className="mt-0.5 text-xs text-ink-500">
          {t('Estimé, ce n’est pas une facture.', 'Estimated, this is not an invoice.')}
        </p>
      </header>

      <div className="divide-y divide-ink-100">
        {/* ---------------------------------------------------------------- 1. coût moyen par engagement */}
        <Ligne
          cle="engagement"
          ouverte={ouverte === 'engagement'}
          onBascule={() => setOuverte((v) => (v === 'engagement' ? null : 'engagement'))}
          titre={t('Coût par engagement', 'Cost per engagement')}
          etat={campagnes === 'erreur' ? 'erreur' : campagnes === null ? 'charge' : 'pret'}
          /* Dépliable dès que la liste est lue, même vide : sinon la bascule des archivées serait inatteignable
             sur une période dont toutes les campagnes sont archivées. */
          depliable={campagnes !== null && campagnes !== 'erreur'}
          valeur={moyen && moyen.valeur !== null ? fmtCost(moyen.valeur, locale, deviseCampagnes) : null}
          /* `null` et pas « 0 € » : un zéro se lirait « c'est gratuit », alors que la vérité est qu'aucune
             campagne de la période n'a à la fois un coût chiffrable et une personne engagée. */
          vide={t('Aucune campagne mesurable sur cette période.', 'No measurable campaign over this period.')}
        >
          {moyen && campagnes !== null && campagnes !== 'erreur' && (
            <>
              <label className="mb-2 flex w-fit cursor-pointer items-center gap-2 text-xs text-ink-500">
                <input
                  type="checkbox" data-testid="cout-archivees" checked={archivees}
                  onChange={(e) => setArchivees(e.target.checked)}
                />
                {t('Inclure les campagnes archivées', 'Include archived campaigns')}
              </label>
              {campagnes.lignes.length === 0 && (
                <p className="text-xs text-ink-500" data-testid="cout-aucune-campagne">
                  {t('Aucune campagne n’a envoyé sur cette période.', 'No campaign sent over this period.')}
                </p>
              )}
              {campagnes.lignes.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[24rem] border-collapse">
                  <thead>
                    <tr className="border-b border-ink-100">
                      <th className={TH}>{t('Campagne', 'Campaign')}</th>
                      <th className={`${TH} text-right`}>{t('Envoyés', 'Sent')}</th>
                      <th className={`${TH} text-right`}>{t('Engagés', 'Engaged')}</th>
                      <th className={`${TH} text-right`}>{t('Coût/engagé', 'Cost/engaged')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {campagnes.lignes.map((l) => (
                      <tr
                        key={l.campaignId}
                        className="cursor-pointer border-b border-ink-50 transition-colors duration-150 hover:bg-ink-50"
                        data-testid={`cout-ligne-${l.campaignId}`}
                        onClick={() => setFiche({ id: l.campaignId, nom: l.nom })}
                      >
                        <td className={`${TD} max-w-[12rem] font-medium text-ink-900`}>
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); setFiche({ id: l.campaignId, nom: l.nom }); }}
                            title={l.nom}
                            data-testid={`cout-ouvrir-${l.campaignId}`}
                            className="block w-full truncate text-left hover:text-brand-700"
                          >
                            {l.nom}
                          </button>
                        </td>
                        <td className={`${TD} text-right tabular-nums`} data-testid={`cout-envoyes-${l.campaignId}`}>{fmtNum(l.envois ?? l.envoyes, locale)}</td>
                        <td className={`${TD} text-right tabular-nums`} data-testid={`cout-engages-${l.campaignId}`}>
                          {l.engagements === undefined || l.engagements === null
                            ? <Vide titre={t('Engagement non mesuré sur cette version.', 'Engagement not measured on this version.')} />
                            : fmtNum(l.engagements, locale)}
                        </td>
                        <td className={`${TD} text-right tabular-nums`} data-testid={`cout-ratio-engage-${l.campaignId}`}>
                          {l.coutParEngagement === undefined || l.coutParEngagement === null
                            ? <Vide titre={t('Il manque un des deux termes, ou personne ne s’est engagé.', 'One of the two terms is missing, or nobody engaged.')} />
                            : fmtCost(l.coutParEngagement, locale, deviseCampagnes)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              )}
              <p className="mt-2 text-xs text-ink-500" data-testid="cout-denominateur">
                {/* 🔴 LE DENOMINATEUR REEL, DIT A L'ECRAN. Le chiffre du dessus n'est pas « la moyenne des
                    campagnes de la période » : les campagnes sans coût chiffrable ou sans personne engagée
                    en sortent, des DEUX termes. Sans cette phrase, un lecteur qui compte les lignes du
                    tableau et refait la division trouverait autre chose et croirait le chiffre faux. */}
                {t(
                  `Calculé sur ${moyen.campagnes} campagne(s)${moyen.ecartees > 0 ? `, ${moyen.ecartees} écartée(s) faute de coût chiffrable ou de personne engagée` : ''}.`,
                  `Computed over ${moyen.campagnes} campaign(s)${moyen.ecartees > 0 ? `, ${moyen.ecartees} left out for lack of a priceable cost or an engaged person` : ''}.`,
                )}
              </p>
              {campagnes.tronque && (
                <p className="mt-1 text-xs text-ink-500" data-testid="cout-tronque">
                  {t(
                    `Seules les ${campagnes.lignes.length} campagnes qui ont le plus envoyé sont affichées : la période en compte davantage.`,
                    `Only the ${campagnes.lignes.length} campaigns that sent the most are shown: the period holds more.`,
                  )}
                </p>
              )}
            </>
          )}
        </Ligne>

        {/* ------------------------------------------------------------------ 2. coût total des messages */}
        <Ligne
          cle="messages"
          ouverte={ouverte === 'messages'}
          onBascule={() => setOuverte((v) => (v === 'messages' ? null : 'messages'))}
          titre={t('Coût des messages envoyés', 'Cost of messages sent')}
          etat={messages === 'erreur' ? 'erreur' : messages === null ? 'charge' : 'pret'}
          valeur={messages !== null && messages !== 'erreur' ? fmtCost(messages.total, locale, deviseMessages) : null}
          vide={t('Aucun envoi sur cette période.', 'Nothing sent over this period.')}
        >
          {messages !== null && messages !== 'erreur' && (
            <>
              {/* 🔴 LA PÉRIODE VOYAGE DANS L'ADRESSE, ET CE N'EST PAS UN CONFORT. La page Coûts s'ouvre sur
                  30 jours par défaut : sans ces deux paramètres, quitter une synthèse réglée sur 90 jours
                  rendrait des chiffres qui ne se recoupent pas, et le lecteur conclurait que l'un des deux
                  écrans ment. Un lien qui change la période en silence est pire que pas de lien. */}
              <dl className="space-y-1 text-sm">
                <Poste libelle={t('Templates marketing', 'Marketing templates')} valeur={fmtCost(messages.templates.marketing, locale, deviseMessages)} href={lienCouts} />
                <Poste libelle={t('Templates utility', 'Utility templates')} valeur={fmtCost(messages.templates.utility, locale, deviseMessages)} href={lienCouts} />
                <Poste
                  href={lienCouts}
                  libelle={t('Messages de service', 'Service messages')}
                  valeur={fmtCost(messages.service.cout, locale, deviseMessages)}
                  detail={t(
                    `${fmtNum(messages.service.envoyes, locale)} envoyé(s), ${fmtNum(messages.service.factures, locale)} facturé(s)`,
                    `${fmtNum(messages.service.envoyes, locale)} sent, ${fmtNum(messages.service.factures, locale)} billed`,
                  )}
                />
                <Poste
                  href={lienCouts}
                  libelle={t('RCS', 'RCS')}
                  valeur={fmtCost(messages.rcs.cout, locale, deviseMessages)}
                  detail={t(
                    `${fmtNum(messages.rcs.simple, locale)} simple(s), ${fmtNum(messages.rcs.conversationnel, locale)} conversationnel(s)`,
                    `${fmtNum(messages.rcs.simple, locale)} plain, ${fmtNum(messages.rcs.conversationnel, locale)} conversational`,
                  )}
                />
              </dl>

              {/* 🔴 LA FRANCHISE EST CELLE DU MOIS, SUR UNE LIGNE A PART DE LA PERIODE, et c'est la
                  décision de Julien du 2026-09-17. Meta la compte par mois calendaire ; la proratiser sur
                  la fenêtre affichée aurait produit un nombre inventé, et un client construit un budget
                  dessus. Une ligne par mois traversé, parce qu'une période à cheval en a DEUX. */}
              {messages.service.parMois.length > 0 && (
                <div className="mt-3 rounded-controle bg-ink-50 px-3 py-2" data-testid="cout-franchise">
                  <p className="text-xs font-medium text-ink-500">
                    {t('Franchise mensuelle', 'Monthly allowance')}
                  </p>
                  {messages.service.parMois.map((m) => (
                    <p key={m.mois} className="text-xs text-ink-500 tabular-nums">
                      {m.mois} : {fmtNum(m.consommes, locale)} / {fmtNum(m.plafond, locale)}
                    </p>
                  ))}
                </div>
              )}

              {messages.nonChiffrables > 0 && (
                <p className="mt-2 text-xs text-ink-500" data-testid="cout-non-chiffrables">
                  {/* Les deux causes se disent SEPAREMENT : une catégorie absente est un héritage clos
                      (rien ne la retrouvera), un tarif manquant est une panne du jour (Meta le rendra
                      demain). Un seul nombre les confondrait, et l'écran ne pourrait dire ni l'un ni
                      l'autre sans risquer de mentir. */}
                  {t(
                    `${fmtNum(messages.nonChiffrables, locale)} envoi(s) ne sont pas chiffrables : ${fmtNum(messages.sansCategorie, locale)} sans catégorie enregistrée, ${fmtNum(messages.sansTarif, locale)} sans tarif rendu par Meta.`,
                    `${fmtNum(messages.nonChiffrables, locale)} send(s) cannot be priced: ${fmtNum(messages.sansCategorie, locale)} with no recorded category, ${fmtNum(messages.sansTarif, locale)} with no rate returned by Meta.`,
                  )}
                </p>
              )}

              {/* 🔴 LE LIEN VERS LA FACTURE REELLE, parce que cette carte n'en porte pas. L'écart entre
                  notre estimation et ce que Meta facture est une question qui revient à chaque lecture, et
                  le seul écran qui y répond est le sous-onglet Coûts. */}
              <p className="mt-2 text-xs">
                <Link href="/dashboard/couts" className="text-brand-600 underline decoration-dotted underline-offset-2 hover:text-brand-700" data-testid="cout-vers-facture">
                  {t('Voir la facture réelle de Meta et le détail par template', 'See Meta’s actual invoice and the per-template detail')}
                </Link>
              </p>
            </>
          )}
        </Ligne>

        {/* ----------------------------------------------------------------------------- 3. coût de l'IA */}
        <Ligne
          cle="ia"
          ouverte={ouverte === 'ia'}
          onBascule={() => setOuverte((v) => (v === 'ia' ? null : 'ia'))}
          titre={t('Coût de l’IA', 'AI cost')}
          etat={ia === 'erreur' ? 'erreur' : ia === null ? 'charge' : 'pret'}
          valeur={ia !== null && ia !== 'erreur' ? fmtCost(eurosDepuisMicro(ia.coutMicroEur), locale, 'EUR') : null}
          vide={t('Aucune consommation sur cette période.', 'No usage over this period.')}
        >
          {ia !== null && ia !== 'erreur' && (
            <>
              {/* 🔴 CE QUE CETTE LIGNE NE COMPTE PAS, DIT PLUTOT QUE LAISSE DEVINER. Le Meta Business Agent
                  tourne CHEZ Meta : nous ne payons aucun token pour lui, et Meta le facture au message de
                  service. Son coût est donc dans la ligne du dessus. Sans cette phrase, un lecteur qui voit
                  son agent Meta répondre toute la journée conclura que la mesure est fausse.

                  🔴 ET « LA TRADUCTION » A ÉTÉ RETIRÉE DE CETTE PHRASE, parce qu'elle était FAUSSE. La
                  traduction tombe bien sur le crédit du client, mais elle n'enregistre AUCUN coût :
                  `consommationIa` ne lit que `agent_sessions`, et `src/traduction/traduire.pg.ts` n'écrit
                  ni débit ni compteur. Un client dont l'Inbox traduit toute la journée lisait donc « 0 € »
                  sous un libellé qui lui promettait que la traduction était dedans. Relevé en revue finale
                  le 2026-09-17. Le dire au lieu de le promettre coûte une phrase ; compter la traduction
                  pour de vrai est un lot à part, il est dans `todo.md`. */}
              <p className="text-xs text-ink-500" data-testid="cout-ia-perimetre">
                {t(
                  'Votre crédit prépayé : les tours d’agent IA. La traduction des conversations tombe sur le même crédit mais n’est pas encore chiffrée ici. Le Meta Business Agent n’y est pas non plus, il tourne chez Meta, qui le facture au message de service (ligne ci-dessus).',
                  'Your prepaid credit: AI agent turns. Conversation translation draws on the same credit but is not costed here yet. The Meta Business Agent is not here either, it runs at Meta, which bills it per service message (line above).',
                )}
              </p>
              {ia.tours.length === 0 ? (
                <p className="mt-2 text-xs text-ink-500" data-testid="cout-ia-vide">
                  {t('Aucun tour d’agent sur cette période.', 'No agent turn over this period.')}
                </p>
              ) : (
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full min-w-[24rem] border-collapse">
                    <thead>
                      <tr className="border-b border-ink-100">
                        <th className={TH}>{t('Date', 'Date')}</th>
                        <th className={`${TH} text-right`}>{t('Tours', 'Turns')}</th>
                        <th className={`${TH} text-right`}>{t('Tokens', 'Tokens')}</th>
                        <th className={`${TH} text-right`}>{t('Coût', 'Cost')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ia.tours.map((s) => (
                        <tr key={s.id} className="border-b border-ink-50" data-testid="cout-ia-ligne">
                          <td className={TD}>{formatDate(s.at, locale)}</td>
                          <td className={`${TD} text-right tabular-nums`}>{fmtNum(s.tours, locale)}</td>
                          <td className={`${TD} text-right tabular-nums`}>
                            {fmtNum(s.tokensEntree + s.tokensSortie, locale)}
                          </td>
                          <td className={`${TD} text-right tabular-nums`}>
                            {fmtCost(eurosDepuisMicro(s.coutMicroEur), locale, 'EUR')}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {ia.tronque && (
                <p className="mt-1 text-xs text-ink-500" data-testid="cout-ia-tronque">
                  {t(
                    `Seuls les ${ia.tours.length} tours les plus récents sont affichés : la période en compte davantage.`,
                    `Only the ${ia.tours.length} most recent turns are shown: the period holds more.`,
                  )}
                </p>
              )}
            </>
          )}
        </Ligne>
      </div>

      {fiche !== null && (
        <DetailCampagneModale
          tenantId={tenantId}
          campaignId={fiche.id}
          nom={fiche.nom}
          onClose={() => setFiche(null)}
        />
      )}
    </section>
  );
}

/**
 * UNE LIGNE DE LA CARTE : son titre, son chiffre, et ce qu'elle cache.
 *
 * ⚠️ UN VRAI `<button>` AVEC `aria-expanded`, et pas un `<div onClick>` : la ligne est le seul moyen
 * d'atteindre le détail, donc elle doit être atteignable au clavier et annoncée comme dépliable. Un
 * accordéon invisible d'un lecteur d'écran est une fonctionnalité qui n'existe pas pour ceux qui en ont
 * le plus besoin.
 */
function Ligne({ cle, titre, valeur, vide, etat, depliable = true, ouverte, onBascule, children }: {
  cle: string;
  titre: string;
  /** `null` = rien à montrer. Un « 0 € » se lirait « c'est gratuit », ce qui est une autre affirmation. */
  valeur: string | null;
  vide: string;
  etat: 'charge' | 'erreur' | 'pret';
  /**
   * Y a-t-il quelque chose DERRIERE ? Par defaut oui.
   *
   * ⚠️ CE N EST PAS `valeur !== null`, ET LA NUANCE COMPTE. Une periode peut porter des campagnes dont
   * aucune n est mesurable : le chiffre du haut est alors vide, mais le tableau du dessous a toute sa
   * valeur, il montre lesquelles et pourquoi leur case est vide. Fermer l accordeon sur ce critere
   * cacherait l explication au moment precis ou on la cherche.
   */
  depliable?: boolean;
  ouverte: boolean;
  onBascule: () => void;
  children: React.ReactNode;
}) {
  // Sur un écran qui regroupe ses erreurs, la ligne ne porte plus que « n/d » : la phrase est en haut, une fois.
  const regroupee = useErreurRegroupee(`cout-${cle}`, etat === 'erreur');
  return (
    <div className="py-3 first:pt-0 last:pb-0" data-testid={`cout-bloc-${cle}`}>
      <button
        type="button"
        onClick={onBascule}
        aria-expanded={ouverte}
        disabled={etat !== 'pret' || !depliable}
        data-testid={`cout-bascule-${cle}`}
        className="flex w-full items-baseline justify-between gap-3 text-left disabled:cursor-default"
      >
        <span className="flex items-center gap-1.5 text-sm text-ink-500">
          {titre}
          {etat === 'pret' && depliable && (
            <Icone nom="deplier" taille="petite" className={`text-ink-400 transition-transform duration-150 ${ouverte ? 'rotate-180' : ''}`} />
          )}
        </span>
        <span className="text-xl font-semibold tracking-tight tabular-nums text-ink-900" data-testid={`cout-valeur-${cle}`}>
          {etat === 'charge' && <span className="text-sm font-normal text-ink-400">…</span>}
          {etat === 'erreur' && <Nd className="text-sm" {...(regroupee ? { testId: `cout-erreur-${cle}` } : {})} />}
          {etat === 'pret' && (valeur ?? <Nd className="text-sm" />)}
        </span>
      </button>
      {etat === 'erreur' && !regroupee && (
        <p className="mt-1 text-xs text-danger" data-testid={`cout-erreur-${cle}`}>
          {/* Une panne d'UNE ligne ne doit pas faire disparaître les deux autres : c'est la raison d'être
              des trois appels séparés, et cette phrase est ce qui le rend lisible. */}
          Ce chiffre n’a pas pu être chargé.
        </p>
      )}
      {etat === 'pret' && valeur === null && <p className="mt-1 text-xs text-ink-500">{vide}</p>}
      {ouverte && etat === 'pret' && <div className="mt-3">{children}</div>}
    </div>
  );
}

/**
 * Une ligne de poste, et son libellé peut être une PORTE vers le détail.
 *
 * 🔴 `href` EXISTE PARCE QUE CES LIGNES ONT ÉTÉ CLIQUÉES SANS RIEN DONNER (Julien, 2026-09-24). Un intitulé
 * de poste au-dessus d'un chiffre se lit comme un lien, donc il en devient un : la synthèse dit COMBIEN,
 * Quantitatif > Coûts dit DE QUOI (l'estimation, la facture de Meta, le détail par modèle).
 *
 * ⚠️ LE TITRE DU BLOC, LUI, CONTINUE DE DÉPLIER, et c'est l'arbitrage de Julien : l'accordéon porte la
 * franchise mensuelle, le RCS et les messages de service, que la page Coûts ne montre nulle part. En faire
 * une porte aurait fait disparaître ces quatre détails de la console entière.
 */
function Poste({ libelle, valeur, detail, href }: { libelle: string; valeur: string; detail?: string; href?: string }) {
  const intitule = (
    <>
      {libelle}
      {detail && <span className="ml-1.5 text-xs text-ink-500">{detail}</span>}
    </>
  );
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink-500">
        {href === undefined
          ? intitule
          : <Link href={href} className="text-brand-700 underline decoration-dotted underline-offset-2 hover:decoration-solid">{intitule}</Link>}
      </dt>
      <dd className="shrink-0 tabular-nums text-ink-900">{valeur}</dd>
    </div>
  );
}

/** Une case sans réponse. Le titre porte la raison : un tiret nu se lisait « zéro » à la deuxième lecture. */
function Vide({ titre }: { titre: string }) {
  return <Nd titre={titre} />;
}
