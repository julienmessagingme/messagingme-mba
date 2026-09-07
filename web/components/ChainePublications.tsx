'use client';

import { useT, useLocale } from '@/lib/i18n';
import { cardCls } from '@/lib/ui';
import { formatDate } from '@/lib/day';
import { classesPastille, etatPublication } from '@/lib/chaine-statut';
import { corpsDuPost } from '@/lib/chaine-apercu';
import type { ConversationsDunLien, EtatDistant, LienChaine, PostChaine } from '@/lib/api-chaine';
import type { WorkflowSummary } from '@/lib/api';
import { TexteMisEnForme } from '@/components/TexteMisEnForme';

/**
 * Les publications déjà parties, et l'état de leur bouton.
 *
 * 🔴 CE QUE CET ÉCRAN AJOUTE DE PLUS QU'UNE LISTE : il est le seul endroit où un bouton MORT devient
 * visible. Quand l'allumage d'un lien échoue après une publication réussie, le post circule avec un bouton
 * qui ne démarre rien, et jusqu'ici cela ne se voyait que dans les journaux du serveur. Ici, la publication
 * porte la marque, et le bouton de réparation est à côté.
 *
 * ⚠️ Le statut est LU EN DIRECT chez le fournisseur : rien n'en est stocké chez nous. Quand il est muet
 * (`distant === 'injoignable'`), les publications restent affichées SANS statut, ce qui est honnête. Les
 * masquer laisserait croire qu'il n'y a rien eu.
 */

export interface ChainePublicationsProps {
  posts: PostChaine[];
  liens: LienChaine[];
  /** Pour nommer le scénario vers lequel chaque publication renvoie. */
  scenarios: WorkflowSummary[];
  /**
   * Ce que chaque BOUTON a démarré. `null` = mesure non chargée (elle a échoué, ou elle arrive) : l'écran
   * n'affiche alors rien du tout, plutôt qu'un zéro qui se lirait comme « ce bouton n'a rien produit ».
   */
  conversations: { parLien: ConversationsDunLien[]; partiel: boolean } | null;
  distant: EtatDistant;
  erreur: string | null;
  /** `null` = aucun rallumage en cours. Sinon, l'id du lien qu'on rallume. */
  rallumage: string | null;
  onRallumer: (linkId: string) => Promise<void>;
}

export function ChainePublications(props: ChainePublicationsProps) {
  const t = useT();
  const { locale } = useLocale();
  const { posts, liens, scenarios, conversations, distant, erreur, rallumage } = props;

  if (erreur !== null) {
    return (
      <div className={cardCls} data-testid="chaine-publications-erreur">
        <p className="text-sm text-coral">{erreur}</p>
      </div>
    );
  }

  /**
   * Ce que le chiffre DIT, et il ne dit que ce qu'on mesure.
   *
   * 🔴 « CONVERSATIONS DÉMARRÉES » ÉTAIT DÉJÀ UNE INFÉRENCE DE TROP. On compte les personnes dont un message
   * contient la phrase du bouton. Le moteur, lui, applique trois filtres de plus avant de démarrer un
   * scénario (automation allumée, anti-rebond, plafond horaire) : un message reçu pendant que le bouton
   * était éteint entrait donc dans le compte « conversations démarrées », juste au-dessus du bandeau qui
   * annonce que ce bouton ne démarre rien. On nomme donc l'action qu'on OBSERVE, pas celle qu'on suppose.
   *
   * ⚠️ `partiel` PASSE AVANT LE ZÉRO. Le plafond de lecture atteint est le seul cas où la mesure est
   * officiellement incomplète, et c'était aussi celui où l'écran faisait l'affirmation la plus forte
   * (« personne n'a envoyé ce message »), c'est-à-dire exactement l'inverse de ce qu'il sait.
   */
  const compte = (n: number, partiel: boolean): string => {
    if (partiel) {
      return n === 0
        ? t('aucun envoi dans les messages les plus récents', 'no send among the most recent messages')
        : t(`au moins ${n} personne${n > 1 ? 's ont' : ' a'} envoyé ce message`, `at least ${n} ${n > 1 ? 'people have' : 'person has'} sent this message`);
    }
    return n === 0
      ? t('personne n’a encore envoyé ce message', 'nobody has sent this message yet')
      : t(`${n} personne${n > 1 ? 's ont' : ' a'} envoyé ce message`, `${n} ${n > 1 ? 'people have' : 'person has'} sent this message`);
  };

  const parLien = new Map(liens.map((l) => [l.id, l]));
  const parScenario = new Map(scenarios.map((w) => [w.id, w]));
  const parConversations = new Map((conversations?.parLien ?? []).map((c) => [c.linkId, c]));

  return (
    <div className={cardCls} data-testid="chaine-publications">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-base font-semibold text-ink-800">{t('Publications', 'Posts')}</h2>
        {distant === 'injoignable' ? (
          <span className="text-xs text-gold" data-testid="chaine-publications-injoignable">
            {t('Statuts indisponibles : Channels Me ne répond pas', 'Statuses unavailable: Channels Me is not answering')}
          </span>
        ) : null}
      </div>

      {/* 🔴 LA LIMITE EST ÉCRITE, PAS RANGÉE DANS UNE INFOBULLE. Elle vivait dans un attribut `title`,
          c'est-à-dire au survol de la souris et nulle part au doigt : exactement le défaut que le lot
          voisin corrige sur le formulaire de template. Une mesure dont les limites ne sont pas lisibles
          est une mesure qu'on lira de travers. */}
      {conversations !== null && posts.length > 0 && (
        <p className="mt-2 text-xs text-ink-400" data-testid="chaine-publications-note-mesure">
          {t(
            'Un appui sur le bouton ne nous est pas visible : on compte les personnes qui ont ENVOYÉ le message du bouton, pour ce bouton et tous ses posts. Un message reçu pendant que le bouton était éteint est compté sans avoir démarré de scénario.',
            'A tap on the button is invisible to us: we count the people who SENT the button message, for this button across all its posts. A message received while the button was off is counted without having started any scenario.',
          )}
        </p>
      )}

      {posts.length === 0 ? (
        <p className="mt-4 text-sm text-ink-400" data-testid="chaine-publications-vide">
          {t('Aucune publication pour le moment.', 'No posts yet.')}
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-ink-100">
          {posts.map((p) => {
            const etat = etatPublication(p.message?.status, locale);
            const lien = p.linkId === null ? null : parLien.get(p.linkId) ?? null;
            // 🔴 Le bouton est MORT quand le lien existe mais que son automation est éteinte. `null` veut
            // dire « plus d'automation compagnon », ce qui est un autre cas, tout aussi mort mais non
            // réparable : le serveur refuse alors `/enable` en 409.
            const boutonMort = lien !== null && lien.enabled !== true;
            const reparable = lien !== null && lien.enabled === false;
            const conv = lien === null ? null : parConversations.get(lien.id) ?? null;
            const corps = corpsDuPost(p.message?.text ?? '', lien?.waMeUrl ?? null);

            return (
              <li key={p.id} className="py-3" data-testid={`chaine-publication-${p.id}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    {/* 🔴 LE MÊME RENDU QUE L'APERÇU, juste au-dessus, ET SUR LA MÊME ENTRÉE. Cette liste
                        montrait `*promo*` avec ses étoiles pendant que l'aperçu affichait « promo » en
                        gras. ⚠️ Mais le texte STOCKÉ d'un post vaut corps + adresse wa.me, alors que
                        l'aperçu ne met en forme que le corps : sans `corpsDuPost`, on donnerait l'adresse
                        au formateur et sa longueur compterait dans le plafond d'analyse. */}
                    <p className="truncate text-sm text-ink-800">
                      {corps === ''
                        ? t('(sans texte)', '(no text)')
                        : <TexteMisEnForme texte={corps} />}
                    </p>
                    <p className="mt-0.5 text-xs text-ink-400">
                      {formatDate(p.createdAt, locale)}
                      {lien !== null ? ` · ${lien.phrase}` : ` · ${t('sans bouton', 'no button')}`}
                    </p>
                    {/* 🔴 VERS QUEL SCÉNARIO, ET CE QUE LE BOUTON A PRODUIT. Julien demandait « combien de
                        clics sur le bouton » : ce nombre n'existe pas et ne peut pas exister, un appui sur
                        un lien wa.me ouvre WhatsApp sur le téléphone de l'abonné sans jamais nous
                        traverser. On affiche donc ce qu'on VOIT, le message qui arrive ensuite, et on le
                        NOMME pour ce que c'est. */}
                    {lien !== null && (
                      <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                        <span className="text-ink-500" data-testid={`chaine-publication-scenario-${p.id}`}>
                          {'→ '}
                          {parScenario.get(lien.workflowId)?.name
                            ?? t('scénario introuvable', 'scenario not found')}
                        </span>
                        {conv !== null && (
                          <span className="text-ink-500 tabular-nums" data-testid={`chaine-publication-conversations-${p.id}`}>
                            {compte(conv.contacts, conversations?.partiel === true)}
                          </span>
                        )}
                      </p>
                    )}
                  </div>
                  <span
                    className={`inline-flex shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${classesPastille(etat.ton)}`}
                    data-testid={`chaine-publication-etat-${p.id}`}
                  >
                    {etat.libelle}
                  </span>
                </div>

                {boutonMort ? (
                  <div
                    className="mt-2 flex flex-wrap items-center gap-3 rounded-lg bg-coral/10 px-3 py-2"
                    data-testid={`chaine-publication-bouton-mort-${p.id}`}
                  >
                    <span className="text-xs text-ink-700">
                      {t(
                        'Le bouton de cette publication ne démarre rien : son lien est éteint.',
                        'This post’s button starts nothing: its link is switched off.',
                      )}
                    </span>
                    {reparable ? (
                      <button
                        type="button"
                        onClick={() => void props.onRallumer(lien.id)}
                        disabled={rallumage === lien.id}
                        className="rounded-md border border-coral px-2.5 py-1 text-xs font-medium text-coral hover:bg-coral/10 disabled:opacity-50"
                        data-testid={`chaine-publication-rallumer-${p.id}`}
                      >
                        {rallumage === lien.id ? t('Allumage…', 'Turning on…') : t('Rallumer le lien', 'Turn link back on')}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
