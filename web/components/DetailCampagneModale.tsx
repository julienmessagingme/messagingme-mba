'use client';

import { useEffect, useState } from 'react';
import { getDetailCoutCampagne, getWorkflow, type DetailCoutCampagne } from '@/lib/api';
import { Modale } from '@/components/Modale';
import { fmtNum, fmtCost } from '@/lib/format';
import { blocsDuScenario } from '@/lib/mesures-scenario';
import { FunnelNodes } from '@/components/FunnelNodes';
import { phrasesNonChiffrables } from '@/lib/cout-non-chiffrable';
import { useT, useLocale } from '@/lib/i18n';
import type { Locale } from '@/lib/locale';

/**
 * LA FICHE D'UNE CAMPAGNE : ce qu'elle a coûté, et ce que les gens en ont fait.
 *
 * Demandée par Julien le 2026-09-09, en cliquant une ligne du tableau du coût. Quatre décisions ont été
 * tranchées avec lui avant d'écrire une ligne, et elles se lisent toutes sur cet écran :
 *
 * 🔴 LE COÛT DE RÉFÉRENCE EST LE LANCEMENT, c'est-à-dire le premier envoi PAR PERSONNE. Les templates
 * qu'un scénario renvoie ensuite sont facturés en plus et affichés à part : les mettre dans la base ferait
 * grossir le dénominateur à chaque relance, donc baisser le coût par interaction sans qu'une seule
 * interaction de plus soit survenue.
 *
 * 🔴 TOUTE LA VIE DE LA CAMPAGNE, et l'écran le DIT. Le tableau d'où l'on vient est sur la période
 * choisie ; cette fiche ne l'est pas. Sans la phrase, l'écart entre les deux se lirait comme un bug.
 *
 * 🔴 LES DEUX UNITÉS, gestes et personnes, parce qu'elles répondent à deux questions différentes (combien
 * d'activité, combien de gens). Le RATIO se calcule sur les gestes, seule unité qui existe partout.
 *
 * 🔴 LA COLONNE DES LIENS A FAILLI NE PAS EXISTER, sur une justification FAUSSE. La première version de
 * cette fiche annonçait qu'un clic « n'identifie personne, donc ne se rattache à aucune campagne », et
 * refusait sur cette base une colonne que Julien avait demandée en toutes lettres. La migration 0106 écrit
 * `tracked_link_clicks.contact_id` : un lien dont l'URL porte le jeton du destinataire SAIT qui a cliqué.
 * L'affirmation n'était vraie que du cas légataire.
 *
 * ⚠️ CE QUI RESTE VRAI, ET QUI EST DIT À PART : les clics venus d'un template approuvé avant le 2026-09-02
 * portent une URL figée chez Meta, sans jeton, et n'auront jamais d'identifiant. Ils sont comptés hors des
 * colonnes, avec leur raison : les taire laisserait croire la colonne complète, les y ajouter affirmerait
 * qu'ils viennent d'ici.
 *
 * ⚠️ La colonne des liens n'a PAS de compte de personnes : l'agrégat se fait par CODE de lien. Un clic
 * attribué sait de qui il vient, mais le compteur ne les distingue pas, et écrire un nombre de personnes
 * égal au nombre de clics mentirait dans la colonne d'à côté.
 */

const TH = 'px-2 py-1.5 text-left text-xs font-medium text-ink-500';
const TD = 'px-2 py-1.5 text-sm text-ink-900';

export function DetailCampagneModale({ tenantId, campaignId, nom, onClose }: {
  tenantId: string;
  campaignId: string;
  /** Le nom déjà affiché dans le tableau : la modale s'ouvre avec son titre, sans attendre le réseau. */
  nom: string;
  onClose: () => void;
}) {
  const t = useT();
  const { locale } = useLocale();
  const [fiche, setFiche] = useState<DetailCoutCampagne | null>(null);
  const [titres, setTitres] = useState<Map<string, string>>(new Map());
  const [erreur, setErreur] = useState(false);

  useEffect(() => {
    let vivant = true;
    setFiche(null);
    setErreur(false);
    setTitres(new Map());
    getDetailCoutCampagne(tenantId, campaignId)
      .then(async (d) => {
        if (!vivant) return;
        // Même garde que les deux cartes : le type est une promesse, pas une preuve, et un corps sans
        // `lancement` ferait jeter le rendu au milieu de la modale.
        if (!d || typeof d.lancement !== 'object' || d.lancement === null) { setErreur(true); return; }
        setFiche(d);
        // Les noms des blocs viennent du GRAPHE, pas du serveur de stats : c'est `mesures-scenario.ts` qui
        // sait les nommer, et il est déjà la seule source de ces libellés pour « Mes tableaux ». En écrire
        // une seconde ici, côté serveur, aurait donné deux noms au même bloc sur deux écrans.
        // Best-effort : un graphe illisible laisse les identifiants bruts, il ne vide pas le tableau.
        if (!d.workflowId || d.etapes.length === 0) return;
        try {
          const w = await getWorkflow(tenantId, d.workflowId);
          if (!vivant) return;
          const blocs = blocsDuScenario(w.workflow.graph as never, locale, {}, {});
          setTitres(new Map(blocs.map((b) => [b.id, b.titre])));
        } catch { /* les identifiants bruts feront l'affaire */ }
      })
      .catch(() => { if (vivant) setErreur(true); });
    return () => { vivant = false; };
  }, [tenantId, campaignId, locale]);

  return (
    <Modale
      titre={nom}
      // Le nom mène aux résultats de CETTE campagne (Quantitatif > Funnel), même adresse que le bouton
      // « Voir les résultats » de l'onglet Campagnes : on lit un coût, on veut voir ce qu'il a produit.
      titreHref={`/dashboard/funnel?campagne=${encodeURIComponent(campaignId)}`}
      taille="large"
      sousTitre={t(
        'Toute la vie de la campagne, pas la période choisie en haut : un scénario reçoit des réponses pendant des jours.',
        'The campaign’s whole life, not the period selected above: a scenario keeps receiving replies for days.',
      )}
      onClose={onClose}
    >
      {erreur && (
        <p className="rounded-lg bg-danger-50 px-3 py-2 text-xs text-danger" data-testid="detail-erreur">
          {t('Le détail de cette campagne n’a pas pu être chargé.', 'This campaign’s detail could not be loaded.')}
        </p>
      )}
      {!erreur && fiche === null && <p className="text-xs text-ink-400">{t('Chargement…', 'Loading…')}</p>}
      {!erreur && fiche !== null && <Contenu fiche={fiche} titres={titres} locale={locale} t={t} />}
    </Modale>
  );
}

function Contenu({ fiche, titres, locale, t }: {
  fiche: DetailCoutCampagne;
  titres: Map<string, string>;
  locale: Locale;
  t: (fr: string, en?: string) => string;
}) {
  const d = fiche.devise;
  const l = fiche.lancement;
  return (
    <div className="space-y-5">
      <section data-testid="detail-lancement">
        <h4 className="text-xs font-medium text-ink-500">
          {t('Le lancement', 'The launch')}
        </h4>
        <p className="mt-0.5 text-xs text-ink-400">
          {t(
            'Le premier message envoyé à chaque destinataire. C’est la base de tous les rapports de cette fiche.',
            'The first message sent to each recipient. It is the base of every ratio on this card.',
          )}
        </p>
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
          <Chiffre libelle={t('Envoyés', 'Sent')} valeur={fmtNum(l.envoyes, locale)} />
          {/* 🔴 AFFICHÉ MÊME À ZÉRO : « aucun échec » est une information que le client vient chercher, et
              une ligne qui disparaît quand tout va bien laisse croire qu'on ne la compte pas. */}
          <Chiffre
            libelle={t('Échecs', 'Failed')}
            valeur={fmtNum(l.echecs, locale)}
            aide={t('Non partis ou refusés par Meta. Jamais comptés dans le coût.', 'Not sent or rejected by Meta. Never counted in the cost.')}
            testid="detail-echecs"
          />
          <Chiffre
            libelle={t('Coût du lancement', 'Launch cost')}
            valeur={l.cout === null ? '—' : fmtCost(l.cout, locale, d)}
            aide={l.cout === null ? t('Aucun de ces envois n’a pu être chiffré.', 'None of these sends could be priced.') : undefined}
            testid="detail-cout"
          />
          <Chiffre
            libelle={t('Coût par clic', 'Cost per click')}
            valeur={l.coutParClic === null ? '—' : fmtCost(l.coutParClic, locale, d)}
            aide={t('Coût du lancement rapporté aux clics sur les liens tracés de son template.', 'Launch cost against clicks on its template’s tracked links.')}
            testid="detail-cout-clic"
          />
          <Chiffre
            libelle={t('Clics', 'Clicks')}
            valeur={l.clics === null ? t('sans lien tracé', 'no tracked link') : fmtNum(l.clics, locale)}
            testid="detail-clics"
          />
          <Chiffre libelle={t('Réponses', 'Replies')} valeur={fmtNum(l.reponses, locale)} testid="detail-reponses" />
          <Chiffre libelle={t('Boutons tapés', 'Buttons tapped')} valeur={fmtNum(l.boutons, locale)} />
          {fiche.relances.envoyes > 0 && (
            <Chiffre
              libelle={t('Relances du scénario', 'Scenario follow-ups')}
              valeur={`${fmtNum(fiche.relances.envoyes, locale)}${fiche.relances.cout === null ? '' : ` · ${fmtCost(fiche.relances.cout, locale, d)}`}`}
              aide={t(
                'Templates renvoyés plus tard par le scénario. Facturés en plus, et volontairement HORS des rapports ci-dessus.',
                'Templates re-sent later by the scenario. Billed on top, and deliberately OUTSIDE the ratios above.',
              )}
              testid="detail-relances"
            />
          )}
        </dl>
        {phrasesNonChiffrables(l, 'campagne', (n) => fmtNum(n, locale)).map((ph) => (
          <p key={ph.fr} className="mt-2 text-xs text-ink-400" data-testid="detail-non-chiffrables">{t(ph.fr, ph.en)}</p>
        ))}
      </section>

      {fiche.workflowId !== null && (
        <section data-testid="detail-etapes">
          <h4 className="text-xs font-medium text-ink-500">
            {t('Étape par étape', 'Step by step')}
          </h4>
          <p className="mt-0.5 text-xs text-ink-400">
            {t(
              'Ce que les gens ont fait à chaque bloc du scénario, lu comme un entonnoir. Le coût par interaction rapporte le coût du LANCEMENT aux gestes de l’étape.',
              'What people did at each block of the scenario, read as a funnel. Cost per interaction is the LAUNCH cost against the step’s gestures.',
            )}
          </p>
          {fiche.etapes.length === 0 ? (
            <p className="mt-2 text-xs text-ink-500" data-testid="detail-etapes-vide">
              {t(
                'Aucune mesure rattachée à cette campagne pour l’instant.',
                'No measure attached to this campaign yet.',
              )}
            </p>
          ) : (
            <>
              {/**
                * 🔴 LES BARRES D ABORD, LE TABLEAU ENSUITE, ET LES DEUX RESTENT. Julien, le 2026-09-17 :
                * « je veux voir un autre truc que ton tableau pourri [...] un tableau avec des barres
                * verticales ». Les barres repondent a la question qu on se pose en ouvrant la fiche (ce
                * qui se perd d un bloc au suivant), le tableau garde les chiffres exacts et les deux
                * unites. Supprimer le tableau retirerait des colonnes que des tests exercent et qu on ne
                * peut pas lire sur un graphe, notamment le partage gestes / personnes.
                */}
              <FunnelNodes etapes={fiche.etapes} titres={titres} devise={d} />
              <details className="mt-3" data-testid="detail-etapes-table">
                <summary className="cursor-pointer text-xs text-ink-500 hover:text-ink-900">
                  {t('Voir les chiffres exacts', 'Show the exact figures')}
                </summary>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[32rem] border-collapse">
                <thead>
                  <tr className="border-b border-ink-100">
                    <th className={TH}>{t('Étape', 'Step')}</th>
                    <th className={`${TH} text-right`}>{t('Envoyés', 'Sent')}</th>
                    <th className={`${TH} text-right`}>{t('Liens', 'Links')}</th>
                    <th className={`${TH} text-right`}>{t('Boutons', 'Buttons')}</th>
                    <th className={`${TH} text-right`}>{t('Réponses', 'Replies')}</th>
                    <th className={`${TH} text-right`}>{t('Coût/interaction', 'Cost/interaction')}</th>
                  </tr>
                </thead>
                <tbody>
                  {fiche.etapes.map((e) => (
                    <tr key={e.nodeId} className="border-b border-ink-50" data-testid={`detail-etape-${e.nodeId}`}>
                      <td className={`${TD} max-w-[14rem] truncate font-medium text-ink-900`} title={titres.get(e.nodeId) ?? e.nodeId}>
                        {titres.get(e.nodeId) ?? e.nodeId}
                      </td>
                      <td className={`${TD} text-right tabular-nums`}>{deuxUnites(e.envoyes, locale, t)}</td>
                      {/* 🔴 `e.liens?` ET PAS `e.liens` : la console part sur Vercel a chaque push, l'API se
                          deploie a la main sur le VPS. Pendant cette fenetre, l'ancienne API rend des etapes
                          SANS cette colonne, et `e.liens.gestes` jetterait EN PLEIN RENDU, ce qui n'emporte
                          pas la colonne mais la page. Meme piege que le detail des non-chiffrables, corrige
                          au meme endroit du meme lot : le type est une promesse, pas une preuve. */}
                      <td className={`${TD} text-right tabular-nums`} data-testid={`detail-liens-${e.nodeId}`}>
                        {fmtNum(e.liens?.gestes ?? 0, locale)}
                      </td>
                      <td className={`${TD} text-right tabular-nums`}>{deuxUnites(e.boutons, locale, t)}</td>
                      <td className={`${TD} text-right tabular-nums`}>{deuxUnites(e.reponses, locale, t)}</td>
                      <td className={`${TD} text-right tabular-nums`} data-testid={`detail-ratio-${e.nodeId}`}>
                        {e.coutParInteraction === null
                          ? <span className="text-ink-400" title={t('Aucune interaction à cette étape, ou coût du lancement inconnu.', 'No interaction at this step, or unknown launch cost.')}>—</span>
                          : fmtCost(e.coutParInteraction, locale, d)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
              </details>
            </>
          )}
          <p className="mt-2 text-xs text-ink-400" data-testid="detail-liens-reserve">
            {t(
              'La colonne « Liens » ne compte pas les personnes : le comptage se fait par lien, pas par contact.',
              'The "Links" column does not count people: clicks are counted per link, not per contact.',
            )}
            {fiche.clicsAnonymes > 0 && ` ${t(
              `Et ${fmtNum(fiche.clicsAnonymes, locale)} clic(s) survenus depuis le lancement ne portent aucun identifiant : ils viennent de templates approuvés avant le 2 septembre 2026, dont l’adresse figée chez Meta ne permet pas de savoir qui a cliqué, ni pour quelle campagne. Ils ne sont donc dans aucune colonne.`,
              `And ${fmtNum(fiche.clicsAnonymes, locale)} click(s) since the launch carry no identifier: they come from templates approved before 2 September 2026, whose address frozen at Meta cannot tell who clicked, nor for which campaign. They are in no column.`,
            )}`}
          </p>
        </section>
      )}
    </div>
  );
}

/**
 * « 12 (8 pers.) », la réponse de Julien à la question des unités.
 *
 * ⚠️ La mention des personnes DISPARAÎT quand elle est égale au nombre de gestes : « 8 (8 pers.) » n'ajoute
 * rien et alourdit une colonne de chiffres. Elle est là pour signaler l'ÉCART, c'est-à-dire les gens qui
 * ont agi plusieurs fois.
 */
function deuxUnites(v: { gestes: number; personnes: number } | undefined, locale: Locale, t: (fr: string, en?: string) => string): string {
  // Meme raison que la colonne des liens : une API plus ancienne que ce champ rend `undefined`, et le
  // rendu entier tomberait sur un `.gestes` de trop.
  if (!v || !Number.isFinite(v.gestes) || v.gestes === 0) return '0';
  if (v.personnes === v.gestes || v.personnes === 0) return fmtNum(v.gestes, locale);
  return `${fmtNum(v.gestes, locale)} (${fmtNum(v.personnes, locale)} ${t('pers.', 'ppl')})`;
}

function Chiffre({ libelle, valeur, aide, testid }: { libelle: string; valeur: string; aide?: string; testid?: string }) {
  return (
    <div title={aide} data-testid={testid}>
      <dt className="text-xs text-ink-500 font-medium">{libelle}</dt>
      <dd className="text-sm font-medium tabular-nums text-ink-900">{valeur}</dd>
    </div>
  );
}
