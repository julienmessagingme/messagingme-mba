'use client';

import { useCallback, useEffect, useState } from 'react';
import { TemplateForm, type CreatedTemplate } from '@/components/TemplateForm';
import type { TemplateSummary } from '@/lib/api';
import { Icone } from '@/components/Icone';

/**
 * CRÉER UN MODÈLE SANS QUITTER LA CAMPAGNE EN COURS, et suivre sa revue chez Meta jusqu'au bout.
 *
 * 🔴 CE N'EST PAS UN BOUTON, C'EST UN PARCOURS, et c'est pour ça qu'il est partagé plutôt que recopié.
 * Un modèle neuf revient `PENDING` : il n'est pas envoyable, et le sélecteur de campagne ne liste que les
 * approuvés. Le refaire ailleurs aurait donné deux façons de soumettre un modèle à Meta, donc deux
 * endroits où corriger le jour où Meta change une règle.
 *
 * 🔴 IL N'INJECTE PAS LE MODÈLE NEUF DANS LA LISTE, et c'est la décision qui compte ici. L'y mettre le
 * rendrait sélectionnable et INENVOYABLE : l'échec arriverait bien plus tard, chez Meta, sous une forme
 * illisible. On affiche donc ce qui vient de se passer, on NOMME l'attente, et on choisit le modèle tout
 * seul dès qu'il est approuvé.
 *
 * ⚠️ L'ÉTAT DU MODÈLE SOUMIS EST CONTRÔLÉ PAR L'HÔTE (`soumis` / `onSoumis`), et ce n'est pas de la
 * cérémonie : c'est sa DURÉE DE VIE qui diffère d'un écran à l'autre. Dans l'écran en service, changer de
 * mode (modèle, scénario, RCS) doit l'oublier, parce que le panneau appartient à la branche « modèle ».
 * Dans l'assistant, replier le cadre d'un étage ou passer à l'étape suivante ne doit PAS l'oublier :
 * l'écran promet de sélectionner le modèle dès son approbation, et une promesse qui disparaît en repliant
 * un cadre serait pire que pas de promesse du tout.
 */
export function CreationModeleEnLigne({
  tenantId,
  templates,
  rechargerTemplates,
  nomChoisi,
  onChoisir,
  soumis,
  onSoumis,
  colonneEtroite = false,
}: {
  tenantId: string;
  /** Les modèles APPROUVÉS, c'est-à-dire ce que le sélecteur de l'écran propose. */
  templates: TemplateSummary[];
  /**
   * Relit la liste et rend la liste COMPLÈTE, statuts non approuvés compris.
   *
   * 🔴 COMPLÈTE, ET C'EST LA SEULE INFORMATION QU'ON VIENT CHERCHER. Filtrée sur les approuvés, la
   * relecture effaçait précisément ce qu'on sonde : « toujours en revue » et « approuvé » se
   * ressemblaient trait pour trait, et le bouton avait l'air cassé.
   *
   * `silencieux` : l'échec d'un SONDAGE de fond ne doit afficher aucune erreur. L'utilisateur n'a rien
   * demandé, il remplit sa campagne, et un message rouge qui apparaît tout seul toutes les 15 s ferait
   * croire à un problème de SA saisie. Seul le clic explicite parle.
   */
  rechargerTemplates: (silencieux?: boolean) => Promise<TemplateSummary[]>;
  /** Le modèle actuellement choisi pour cet envoi. Sert à ne JAMAIS écraser un choix fait pendant l'attente. */
  nomChoisi: string;
  onChoisir: (name: string) => void;
  /** Le modèle qu'on vient de soumettre, ou `null`. Sa durée de vie appartient à l'hôte (cf. docblock). */
  soumis: CreatedTemplate | null;
  onSoumis: (t: CreatedTemplate | null) => void;
  /** Le formulaire est rendu dans une COLONNE : son aperçu passe sous les champs au lieu de se mettre à côté. */
  colonneEtroite?: boolean;
}) {
  const [ouvert, setOuvert] = useState(false);
  /** Une vérification est en vol. Sert à ce qu'un clic produise TOUJOURS quelque chose à l'écran. */
  const [verifEnCours, setVerifEnCours] = useState(false);

  /**
   * Redemande à Meta où en est le modèle soumis, et REPORTE son statut à l'écran.
   *
   * ⚠️ C'est le geste qui manquait à l'origine : le statut affiché était celui figé à la création, et le
   * bouton ne rafraîchissait que le sélecteur fermé au-dessus. On rechargeait bien, mais dans une zone
   * que l'écran n'affichait pas.
   */
  const verifier = useCallback(async (silencieux = false): Promise<void> => {
    if (!soumis) return;
    setVerifEnCours(true);
    try {
      const tous = await rechargerTemplates(silencieux);
      const ligne = tous.find((x) => x.name === soumis.name && x.language === soumis.language);
      if (ligne && ligne.status !== soumis.status) onSoumis({ ...soumis, status: ligne.status });
    } finally {
      setVerifEnCours(false);
    }
  }, [soumis, rechargerTemplates, onSoumis]);

  /**
   * Sondage tant que la revue est en cours : on ne fait pas attendre le client devant un bouton qu'il
   * faut penser à cliquer.
   *
   * 15 s, l'intervalle déjà retenu pour la liste de l'Inbox, et le même garde-fou de visibilité : un
   * onglet en arrière-plan n'appelle rien. Trois conditions d'arrêt, toutes portées par l'état existant :
   * statut terminal atteint, panneau fermé, écran quitté (nettoyage de l'effet).
   *
   * ⚠️ CHAQUE TOUR EST UN VRAI APPEL À META. C'est acceptable parce que le panneau ne vit que le temps de
   * la revue et se referme d'un clic, mais ce n'est pas un patron à recopier ailleurs sans y repenser.
   */
  useEffect(() => {
    const statut = soumis?.status;
    if (!statut) return;
    // Statut DÉJÀ terminal : rien à sonder, mais la liste n'a peut-être jamais été relue (Meta approuve
    // parfois un utilitaire sur-le-champ). Une seule relecture, silencieuse, sinon le modèle approuvé
    // n'apparaît pas dans le sélecteur et la sélection automatique ne trouve rien.
    if (statut === 'APPROVED' || statut === 'REJECTED') { void rechargerTemplates(true); return; }
    const tour = (): void => { if (document.visibilityState === 'visible') void verifier(true); };
    const id = setInterval(tour, 15000);
    document.addEventListener('visibilitychange', tour);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', tour); };
  }, [soumis?.status, verifier, rechargerTemplates]);

  /**
   * Le modèle soumis vient d'être approuvé : on le choisit, ce que l'opérateur allait faire à la main.
   *
   * ⚠️ PASSER PAR UN EFFET N'EST PAS COSMÉTIQUE : le choix doit être fait APRÈS que la liste rechargée
   * soit arrivée dans l'état. L'appeler dans la foulée du rechargement lirait l'ANCIENNE liste, n'y
   * trouverait pas le modèle, et viderait les variables sans la moindre erreur visible.
   */
  useEffect(() => {
    if (soumis?.status !== 'APPROVED') return;
    if (nomChoisi !== '') return; // ne JAMAIS écraser un choix fait pendant l'attente
    if (!templates.some((x) => x.name === soumis.name)) return;
    onChoisir(soumis.name);
    // `onChoisir` est redéfinie à chaque rendu de l'hôte : la mettre en dépendance relancerait l'effet en
    // boucle. Les vraies entrées sont le statut, la liste et le choix courant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [soumis, templates, nomChoisi]);

  if (soumis) {
    return (
      <div className="mt-2 w-full rounded-carte border border-brand-200 bg-brand-50/40 p-4" data-testid="template-soumis">
        {soumis.status === 'APPROVED' ? (
          <>
            <p className="flex items-center gap-1.5 text-sm font-medium text-ink-900">
              <Icone nom="valide" className="text-succes-700" />Modèle « {soumis.name} » approuvé par Meta.
            </p>
            {/* ⚠️ LA PHRASE SUIT L'ÉTAT RÉEL, PAS LE STATUT. La sélection automatique s'abstient quand un
                autre modèle a été choisi pendant l'attente : dire « il est sélectionné » dans ce cas
                précis, c'est mentir exactement là où la garde a été écrite pour protéger le choix. */}
            <p className="mt-1 text-xs text-ink-500">
              {nomChoisi === soumis.name
                ? 'Il est sélectionné pour cet envoi, vous pouvez continuer.'
                : 'Choisissez-le dans la liste ci-dessus pour l’utiliser.'}
            </p>
          </>
        ) : soumis.status === 'REJECTED' ? (
          <>
            <p className="flex items-center gap-1.5 text-sm font-medium text-ink-900">
              <Icone nom="refuse" className="text-danger-700" />Modèle « {soumis.name} » refusé par Meta.
            </p>
            {/* Le motif du refus n'est pas récupéré par la liste : ne pas prétendre l'expliquer ici. */}
            <p className="mt-1 text-xs text-ink-500">
              Le motif est indiqué par Meta dans l’écran Modèles. Corrigez-le là-bas, ou créez-en un autre.
            </p>
          </>
        ) : (
          <>
            <p className="text-sm font-medium text-ink-900">
              Modèle « {soumis.name} » soumis (statut : {soumis.status}).
            </p>
            <p className="mt-1 text-xs text-ink-500">
              Il passe en revue chez Meta. On vérifie automatiquement et il sera sélectionné dès qu’il est
              approuvé : rien à faire, vous pouvez préparer le reste de la campagne.
            </p>
          </>
        )}
        <div className="mt-2 flex items-center gap-3">
          {soumis.status !== 'APPROVED' && soumis.status !== 'REJECTED' && (
            <button
              type="button"
              onClick={() => { void verifier(); }}
              disabled={verifEnCours}
              data-testid="verifier-statut"
              className="text-xs text-brand-600 hover:underline disabled:text-ink-400 disabled:no-underline"
            >
              {verifEnCours ? 'Vérification…' : 'Vérifier maintenant'}
            </button>
          )}
          <button type="button" onClick={() => onSoumis(null)} className="text-xs text-ink-500 hover:underline">
            Fermer
          </button>
        </div>
      </div>
    );
  }

  if (ouvert) {
    return (
      <div className="mt-2 w-full rounded-carte border border-brand-200 bg-brand-50/40 p-4">
        <TemplateForm
          tenantId={tenantId}
          onCreated={(cree) => { setOuvert(false); if (cree) onSoumis(cree); }}
          colonneEtroite={colonneEtroite}
        />
        <button type="button" onClick={() => setOuvert(false)} className="mt-2 text-xs text-ink-500 hover:underline">
          Annuler
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setOuvert(true)}
      data-testid="creer-modele"
      className="mt-2 text-xs text-brand-600 hover:underline"
    >
      ＋ Créer un nouveau modèle
    </button>
  );
}
