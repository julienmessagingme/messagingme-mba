'use client';

import { useEffect, useState } from 'react';
import {
  getBibliothequeOutils, supprimerDefinitionOutil, exposerOutilAuMba,
  apercuPublicationMba, publierChezMeta,
  type OutilBibliotheque, type GestePublication,
} from '@/lib/api-agent-tools';
import { useT } from '@/lib/i18n';

/**
 * Les outils de l'ESPACE, et qui s'en sert.
 *
 * 🔴 LA COLONNE « UTILISÉ PAR » EST TOUTE LA RAISON DE CET ÉCRAN, et elle n'existait nulle part. Un outil
 * déclaré une fois et branché sur trois agents était trois outils qui se ressemblaient : corriger ses mots
 * dans un agent ne les corrigeait pas dans les deux autres, et personne ne pouvait le voir. Depuis la
 * migration 0127, la définition est unique et le consentement est par consommateur.
 *
 * ⚠️ RIEN NE S'AFFICHE TANT QUE LA LECTURE N'A PAS ABOUTI. Une liste vide pendant le chargement dirait
 * « vous n'avez aucun outil » sur un espace qui en a douze, et c'est le premier écran qu'on voit en arrivant.
 */
export function BibliothequeOutils({ tenantId, isAdmin }: { tenantId: string; isAdmin: boolean }) {
  const t = useT();
  const [outils, setOutils] = useState<OutilBibliotheque[] | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [plan, setPlan] = useState<GestePublication[] | null>(null);
  const [publie, setPublie] = useState(false);

  useEffect(() => {
    let vivant = true;
    getBibliothequeOutils(tenantId)
      .then((r) => { if (vivant) setOutils(r.outils); })
      .catch(() => { if (vivant) setOutils([]); });
    return () => { vivant = false; };
  }, [tenantId]);

  /** Un outil est « exposé au MBA » quand un consommateur `mba:` le porte ET qu'il est actif. */
  const exposeAuMba = (o: OutilBibliotheque): boolean =>
    o.consommateurs.some((c) => c.cle.startsWith('mba:') && c.actif);

  /**
   * Coche ou décoche « exposé au Meta Business Agent ».
   *
   * 🔴 L'AVERTISSEMENT SUR UN OUTIL IRRÉVERSIBLE VIT ICI, AU MOMENT DU CLIC, et pas dans une documentation.
   * `risk` et `autonome` n'existent pas chez Meta : un outil marqué irréversible exposé au MBA sera appelé
   * SANS la garde d'autonomie que le client a réglée de notre côté, parce que le modèle de Meta n'a aucun
   * champ pour la porter. C'est le seul endroit de ce programme où l'on abaisse une protection existante, et
   * une protection qu'on abaisse doit se voir.
   *
   * ⚠️ On ne bloque PAS : c'est une décision du client, comme `autonome` l'est déjà depuis le 2026-08-26. On
   * la lui fait confirmer en nommant la conséquence.
   */
  async function basculerMba(o: OutilBibliotheque, valeur: boolean): Promise<void> {
    setErreur(null);
    if (valeur && o.risk === 'irreversible') {
      const ok = window.confirm(t(
        `« ${o.title} » peut faire une action IRRÉVERSIBLE.\n\nExposé à l’agent de Meta, il sera appelé sans la validation humaine que vous avez réglée ici : Meta n’a aucun réglage équivalent.\n\nL’exposer quand même ?`,
        `“${o.title}” can perform an IRREVERSIBLE action.\n\nExposed to Meta's agent, it will be called without the human approval you set here: Meta has no equivalent setting.\n\nExpose it anyway?`,
      ));
      if (!ok) return;
    }
    try {
      await exposerOutilAuMba(tenantId, o.id, valeur);
      // Relecture complète plutôt qu'une bascule optimiste : c'est le serveur qui sait ce qu'il a fait, et
      // afficher un état qu'il n'a pas confirmé est exactement ce qui a coûté trois pannes au toggle MBA.
      const r = await getBibliothequeOutils(tenantId);
      setOutils(r.outils);
    } catch (e) {
      setErreur(e instanceof Error ? e.message : t('Le changement n’a pas pu être appliqué.', 'The change could not be applied.'));
    }
  }

  async function supprimer(outilId: string): Promise<void> {
    setErreur(null);
    try {
      await supprimerDefinitionOutil(tenantId, outilId);
      setOutils((v) => (v ? v.filter((o) => o.id !== outilId) : v));
    } catch (e) {
      /**
       * 🔴 LE MESSAGE DU SERVEUR, PAS UN MESSAGE MAISON. Le 409 dit précisément pourquoi il refuse (l'outil
       * est encore utilisé) ; le remplacer par « échec » renverrait le client chercher lui-même ce que le
       * serveur savait déjà.
       */
      setErreur(e instanceof Error ? e.message : t('La suppression a échoué.', 'Deletion failed.'));
    }
  }

  /**
   * L'APERÇU avant la publication.
   *
   * 🔴 « ENGAGE ME FAIT FOI, LA PUBLICATION ÉCRASE » (décision de Julien du 2026-09-10). Écraser n'est
   * acceptable que si l'on montre QUOI avant de le faire : ce bouton n'écrit rien, il demande le plan et
   * l'affiche en toutes lettres, y compris les suppressions.
   */
  async function voirLePlan(): Promise<void> {
    setErreur(null);
    setPublie(false);
    try {
      setPlan((await apercuPublicationMba(tenantId)).gestes);
    } catch (e) {
      setErreur(e instanceof Error ? e.message : t('L’aperçu a échoué.', 'Preview failed.'));
    }
  }

  async function publier(): Promise<void> {
    setErreur(null);
    try {
      await publierChezMeta(tenantId);
      setPublie(true);
      setPlan([]);
      setOutils((await getBibliothequeOutils(tenantId)).outils);
    } catch (e) {
      // Le message du serveur dit combien de gestes ont abouti et qu'on peut relancer sans risque de doublon.
      setErreur(e instanceof Error ? e.message : t('La publication a échoué.', 'Publishing failed.'));
      void voirLePlan();
    }
  }

  const LIBELLE_GESTE: Record<GestePublication['type'], string> = {
    connecteur_creer: t('créer le connecteur', 'create connector'),
    connecteur_modifier: t('modifier le connecteur', 'update connector'),
    connecteur_supprimer: t('SUPPRIMER le connecteur', 'DELETE connector'),
    secret_poser: t('poser le secret', 'set the secret'),
    outil_creer: t('créer l’outil', 'create tool'),
    outil_modifier: t('modifier l’outil', 'update tool'),
    outil_supprimer: t('SUPPRIMER l’outil', 'DELETE tool'),
  };

  if (outils === null) return null;

  return (
    <section data-testid="bibliotheque-outils" className="space-y-4">
      <header>
        <h1 className="text-lg font-semibold text-ink-900">{t('Outils de l’espace', 'Workspace tools')}</h1>
        <p className="mt-1 text-sm text-ink-500">
          {t('Un outil se déclare une fois ici, puis chaque agent choisit de s’en servir. Le même outil peut servir à plusieurs agents.',
            'A tool is declared once here, then each agent chooses whether to use it. The same tool can serve several agents.')}
        </p>
      </header>

      {erreur && <p className="text-xs text-coral" data-testid="bibliotheque-erreur">{erreur}</p>}

      {/* La publication chez Meta. Elle vit ICI et pas dans les paramètres MBA : ce qu'on publie, c'est
          cette bibliothèque-là, et le geste doit être à côté de ce qu'il emporte. */}
      {isAdmin && (
        <section className="rounded-2xl border border-ink-200 bg-ink-50/50 p-4" data-testid="publication-mba">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm font-medium text-ink-800">{t('Publier chez Meta', 'Publish to Meta')}</span>
            <button type="button" className="rounded-lg border border-ink-300 bg-white px-2 py-0.5 text-xs"
              data-testid="publication-apercu" onClick={() => { void voirLePlan(); }}>
              {t('Voir ce qui va changer', 'Preview changes')}
            </button>
            {plan !== null && plan.length > 0 && (
              <button type="button" className="rounded-lg bg-brand-600 px-2 py-0.5 text-xs font-medium text-white"
                data-testid="publication-publier" onClick={() => { void publier(); }}>
                {t(`Publier ces ${plan.length} changement(s)`, `Publish these ${plan.length} change(s)`)}
              </button>
            )}
          </div>

          {/* ⚠️ CE QUE PERSONNE NE DEVINE, ET QUI DOIT ÊTRE ÉCRIT : une modification faite dans WhatsApp
              Manager sera PERDUE. C'est la conséquence directe de « Engage Me fait foi ». */}
          <p className="mt-1 text-xs text-ink-500">
            {t('Ce que vous avez ici remplace ce qui est chez Meta. Un connecteur ou un outil ajouté à la main dans WhatsApp Manager sera supprimé.',
              'What you have here replaces what is at Meta. A connector or tool added by hand in WhatsApp Manager will be deleted.')}
          </p>

          {publie && <p className="mt-2 text-xs text-mint-700" data-testid="publication-faite">{t('Publié. Meta est à jour.', 'Published. Meta is up to date.')}</p>}
          {plan !== null && plan.length === 0 && !publie && (
            <p className="mt-2 text-xs text-mint-700" data-testid="publication-rien">{t('Rien à changer : Meta est déjà à jour.', 'Nothing to change: Meta is already up to date.')}</p>
          )}
          {plan !== null && plan.length > 0 && (
            <ul className="mt-2 space-y-0.5" data-testid="publication-plan">
              {plan.map((g, i) => (
                <li key={`${g.type}-${g.nom}-${i}`} className={`text-xs ${g.type.endsWith('supprimer') ? 'text-coral' : 'text-ink-600'}`}>
                  {LIBELLE_GESTE[g.type]} : <code>{g.nom}</code>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {outils.length === 0 ? (
        <p className="text-sm text-ink-500" data-testid="bibliotheque-vide">
          {t('Aucun outil déclaré. Ajoutez-en un depuis l’onglet Outils d’un agent.',
            'No tools declared yet. Add one from an agent’s Tools tab.')}
        </p>
      ) : (
        <ul className="space-y-2">
          {outils.map((o) => (
            <li key={o.id} className="rounded-2xl border border-ink-200 bg-white p-4 shadow-sm" data-testid={`outil-${o.name}`}>
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="font-medium text-ink-900">{o.title}</span>
                <code className="text-xs text-ink-500">{o.name}</code>
                {o.risk === 'irreversible' && (
                  <span className="rounded-full bg-coral/10 px-2 py-0.5 text-[11px] font-medium text-coral">
                    {t('action irréversible', 'irreversible action')}
                  </span>
                )}
                <span className="rounded-full bg-ink-100 px-2 py-0.5 text-[11px] text-ink-600">
                  {o.origin === 'mba' ? t('maison', 'built-in') : o.origin === 'http' ? t('connecteur', 'connector') : 'MCP'}
                </span>
              </div>
              <p className="mt-1 text-sm text-ink-600">{o.description}</p>

              {/* 🔴 CE QUE CET ÉCRAN EXISTE POUR MONTRER. Sans cette ligne, la bibliothèque ne serait qu'une
                  liste de plus : c'est elle qui dit qu'un outil est PARTAGÉ, et donc qu'y toucher touche
                  plusieurs agents à la fois. */}
              <p className="mt-2 text-xs text-ink-500" data-testid={`outil-${o.name}-consommateurs`}>
                {o.consommateurs.length === 0
                  ? t('Utilisé par aucun agent.', 'Used by no agent.')
                  : `${t('Utilisé par', 'Used by')} : ${o.consommateurs
                    .map((c) => `${c.agentLabel ?? c.cle}${c.actif ? '' : t(' (inactif)', ' (inactive)')}`)
                    .join(', ')}`}
              </p>

              {/* La case « exposé au MBA ». Elle n'est PAS un réglage d'agent : elle rattache l'outil au
                  consommateur `mba:<numero>`, qui est un consommateur comme un autre depuis 0127. */}
              {isAdmin && (
                <label className="mt-3 flex items-center gap-2 text-xs text-ink-700">
                  <input
                    type="checkbox"
                    data-testid={`outil-${o.name}-mba`}
                    checked={exposeAuMba(o)}
                    onChange={(e) => { void basculerMba(o, e.target.checked); }}
                    className="h-3.5 w-3.5 rounded border-ink-300"
                  />
                  {t('Exposé à l’agent de Meta', 'Exposed to Meta’s agent')}
                  {o.risk === 'irreversible' && (
                    <span className="text-coral">
                      {t('(sans la validation humaine : Meta n’a pas ce réglage)', '(without human approval: Meta has no such setting)')}
                    </span>
                  )}
                </label>
              )}

              {/* ⚠️ LE BOUTON N'APPARAÎT QUE SUR UN OUTIL RATTACHÉ À PERSONNE. Le serveur refuse de toute
                  façon en 409, mais montrer un bouton dont on sait qu'il échouera est une invitation à
                  l'échec, pas une garde. */}
              {isAdmin && o.consommateurs.length === 0 && (
                <button
                  type="button"
                  className="mt-2 text-xs text-coral underline"
                  data-testid={`outil-${o.name}-supprimer`}
                  onClick={() => { void supprimer(o.id); }}
                >
                  {t('Supprimer de l’espace', 'Delete from workspace')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
