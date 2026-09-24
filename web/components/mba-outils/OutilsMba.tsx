'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apercuPublicationMba, publierChezMeta, type GestePublication } from '@/lib/api-agent-tools';
import {
  listerOutilsMba, reactiverOutilMba, retirerOutilMba, type OutilMbaVue, type TypeOutilMba,
} from '@/lib/api-mba-outils';
import {
  TEXTES_PAR_TYPE, chezMetaSansLigne, effacementsImprevus, etatsChezMeta, type EtatChezMeta,
} from '@/lib/mba-outils';
import { IconeOutil } from '@/components/IconeOutil';
import { ChoixTypeOutil } from './ChoixTypeOutil';
import { FormulaireOutilMba } from './FormulaireOutilMba';
import { useT } from '@/lib/i18n';

type Mode = { vue: 'liste' } | { vue: 'choix' } | { vue: 'form'; type: TypeOutilMba; outil: OutilMbaVue | null };
type Traduire = (fr: string, en?: string) => string;

/**
 * L'ONGLET « OUTILS » DE L'AGENT DE META (spec 2026-09-21-outils-maison-mba, § 9, d'après le croquis de Julien).
 *
 * Une liste claire (titre, cible, type, état chez Meta), un gros bouton « Ajouter un outil », et enregistrer
 * envoie chez Meta. Ce qui attend s'envoie par le bouton « À envoyer » de la ligne ; un seul bandeau, pour ce que
 * Meta liste encore sans outil ici.
 *
 * 🔴 UN EFFACEMENT QUE L'UTILISATEUR N'A PAS DEMANDÉ SE FAIT CONFIRMER EN LE NOMMANT, TOUJOURS (spec § 9.2). Seuls
 * les outils qu'il a supprimés dans cette session partent sans autre question (`supprimesIci`) : Meta ne rend
 * jamais un outil effacé.
 *
 * 🔴 L'ENVOI EN COURS SE LIT À L'INSTANT (`envoiRef`), PAS AU RENDU DU CLIC (revue finale du 2026-09-21). Et le
 * bouton qui envoie DIT qu'il envoie : un bouton muet sur une opération lente fabrique des doublons chez Meta
 * (Julien, 2026-09-18).
 *
 * ⚠️ RIEN NE S'AFFICHE TANT QUE LA LECTURE N'A PAS ABOUTI : une liste vide pendant le chargement dirait « aucun
 * outil » à un espace qui en a.
 */
export function OutilsMba({ tenantId, isAdmin }: { tenantId: string; isAdmin: boolean }) {
  const t = useT();
  const [outils, setOutils] = useState<OutilMbaVue[] | null>(null);
  // 🔴 Une lecture RATÉE n'est pas une liste VIDE : les confondre disait « Aucun outil » à un espace qui en a.
  const [lectureRatee, setLectureRatee] = useState<string | null>(null);
  const [gestes, setGestes] = useState<GestePublication[] | null>(null);
  const [etatsCharges, setEtatsCharges] = useState(false);
  const [mode, setMode] = useState<Mode>({ vue: 'liste' });
  const [erreur, setErreur] = useState<string | null>(null);
  const [envoiEnCours, setEnvoiEnCours] = useState(false);
  const envoiRef = useRef(false);
  // Une suppression occupe l'écran DÈS LE CLIC (confirmation, DELETE, relecture), pas seulement pendant l'envoi :
  // sinon un second retrait lancé entre-temps devenait un effacement « imprévu » du premier envoi.
  const [suppressionEnCours, setSuppressionEnCours] = useState(false);
  const suppressionRef = useRef(false);
  // Un enregistrement du formulaire occupe aussi l'écran : dans l'autre sens, « Supprimer » pendant un
  // enregistrement faisait perdre l'envoi à l'un des deux, ou confirmer le retrait en cours comme imprévu.
  const [enregistrementEnCours, setEnregistrementEnCours] = useState(false);
  // Les noms supprimés ICI pendant cette visite, et dont le retrait n'est PAS ENCORE PARTI : les seuls que le
  // bandeau laisse partir sans confirmation. Un nom sort de l'ensemble dès que son retrait est parti (la
  // publication réussie, dans `envoyer`), et, en filet, dès que Meta ne le liste plus (`chargerEtats`) : sinon un
  // outil ajouté plus tard à la main sous ce nom partirait sans être nommé.
  const [supprimesIci, setSupprimesIci] = useState<ReadonlySet<string>>(() => new Set());
  const occupe = envoiEnCours || suppressionEnCours || enregistrementEnCours;

  const chargerEtats = useCallback(async (): Promise<void> => {
    try {
      const r = await apercuPublicationMba(tenantId);
      const lus = Array.isArray(r?.gestes) ? r.gestes : [];
      setGestes(lus);
      const encoreChezMeta = new Set(lus.filter((g) => g.type === 'outil_supprimer').map((g) => g.nom));
      setSupprimesIci((avant) => new Set([...avant].filter((n) => encoreChezMeta.has(n))));
    } catch {
      setGestes(null);
    } finally {
      setEtatsCharges(true);
    }
  }, [tenantId]);

  /** La liste seule. Avant un envoi, c'est tout ce qu'il faut : `envoyer` relit déjà le plan chez Meta. */
  const chargerListe = useCallback(async (): Promise<void> => {
    try {
      const r = await listerOutilsMba(tenantId);
      setOutils(Array.isArray(r?.outils) ? r.outils : []);
      setLectureRatee(null);
    } catch (e) {
      setOutils((avant) => avant ?? []);
      setLectureRatee(e instanceof Error ? e.message : 'lecture impossible');
    }
  }, [tenantId]);

  const charger = useCallback(async (): Promise<void> => {
    await chargerListe();
    await chargerEtats();
  }, [chargerListe, chargerEtats]);

  useEffect(() => { void charger(); }, [charger]);

  /**
   * Envoie chez Meta tout ce qui attend. Seuls les effacements d'OUTILS que ce geste n'a pas demandés se
   * confirment (`outilsAttendus`) ; notre connecteur `EngageMe` est toujours attendu (`effacementsImprevus`).
   */
  const envoyer = async (outilsAttendus: ReadonlySet<string>): Promise<boolean> => {
    if (envoiRef.current) return false;
    envoiRef.current = true;
    setEnvoiEnCours(true);
    setErreur(null);
    try {
      const plan = (await apercuPublicationMba(tenantId)).gestes ?? [];
      if (plan.length === 0) return true;
      const imprevus = effacementsImprevus(plan, outilsAttendus);
      if (imprevus.length > 0) {
        const liste = imprevus.map((g) => `- ${g.nom}`).join('\n');
        const ok = window.confirm(t(
          `Cet envoi va aussi SUPPRIMER chez Meta :\n\n${liste}\n\nContinuer ?`,
          `This will also DELETE at Meta:\n\n${liste}\n\nContinue?`,
        ));
        if (!ok) return false;
      }
      await publierChezMeta(tenantId);
      // 🔴 La dispense s'éteint DÈS que le retrait est parti, sans attendre la relecture du plan : si celle-ci
      // échouait, le nom restait dispensé, et un outil ajouté plus tard à la main sous ce nom serait parti sans
      // être nommé (relecture du 2026-09-22).
      const partis = new Set(plan.filter((g) => g.type === 'outil_supprimer').map((g) => g.nom));
      setSupprimesIci((avant) => new Set([...avant].filter((n) => !partis.has(n))));
      return true;
    } catch (e) {
      setErreur(e instanceof Error ? e.message : t('L’envoi chez Meta a échoué.', 'Sending to Meta failed.'));
      return false;
    } finally {
      envoiRef.current = false;
      setEnvoiEnCours(false);
      await chargerEtats();
    }
  };

  /**
   * Un outil enregistré part chez Meta dans le même geste. Un échec d'envoi ne défait pas l'enregistrement.
   * 🔴 Le message le DIT toujours (spec § 9.3), cause comprise : l'erreur brute seule (« Meta a refusé… ») laissait
   * croire que l'outil n'avait pas été créé, et invitait à le recréer, donc à buter sur son propre nom.
   */
  const apresEnregistrement = async (nomsAttendus: Set<string>): Promise<void> => {
    setMode({ vue: 'liste' });
    await chargerListe();
    const ok = await envoyer(nomsAttendus);
    if (!ok) {
      setErreur((e) => t(
        `L’outil est enregistré, mais l’envoi chez Meta n’a pas abouti${e ? ` (${e})` : ''} : cliquez sur « À envoyer » pour réessayer.`,
        `The tool is saved, but sending to Meta did not go through${e ? ` (${e})` : ''}: click “To send” to retry.`,
      ));
    }
  };

  const supprimer = async (o: OutilMbaVue): Promise<void> => {
    if (suppressionRef.current || envoiRef.current || enregistrementEnCours) return;
    suppressionRef.current = true;
    setSuppressionEnCours(true);
    try {
      if (!window.confirm(t(`Supprimer « ${o.title} » ? Il sera retiré chez Meta.`, `Delete “${o.title}”? It will be removed at Meta.`))) return;
      setErreur(null);
      try {
        await retirerOutilMba(tenantId, o.id);
      } catch (e) {
        setErreur(e instanceof Error ? e.message : t('La suppression a échoué.', 'Deletion failed.'));
        return;
      }
      setSupprimesIci((avant) => new Set([...avant, o.name]));
      await chargerListe();
      const ok = await envoyer(new Set([o.name]));
      // 🔴 Un retrait qui n'est pas parti se DIT (spec § 9.3) : l'outil n'a plus de ligne ici, et Meta le liste
      // encore. Le bandeau le laissera partir sans question ; tout AUTRE effacement y sera confirmé en le nommant.
      if (!ok) {
        setErreur((e) => t(
          `L’outil est supprimé ici, mais Meta le liste encore${e ? ` (${e})` : ''} : « Envoyer à Meta », au-dessus de la liste, le retirera. Tout autre effacement vous sera demandé.`,
          `The tool is deleted here, but Meta still lists it${e ? ` (${e})` : ''}: “Send to Meta”, above the list, will remove it. Any other deletion will be asked first.`,
        ));
      }
    } finally {
      suppressionRef.current = false;
      setSuppressionEnCours(false);
    }
  };

  const reactiver = async (o: OutilMbaVue): Promise<void> => {
    setErreur(null);
    try {
      await reactiverOutilMba(tenantId, o.id);
    } catch (e) {
      setErreur(e instanceof Error ? e.message : t('La réactivation a échoué.', 'Reactivation failed.'));
      return;
    }
    await chargerListe();
    await envoyer(new Set());
  };

  if (outils === null) return null;
  // Tant que Meta n'a pas été lu, AUCUN état : afficher « Chez Meta » par défaut serait affirmer ce qu'on ignore.
  const etats = etatsCharges ? etatsChezMeta(outils, gestes) : null;
  // Seulement sur une liste LUE : sans elle, un outil désactivé qui a bien sa ligne passerait pour « sans outil ici ».
  const sansLigne = etatsCharges && lectureRatee === null ? chezMetaSansLigne(outils, gestes) : [];

  return (
    <section data-testid="mba-outils" className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink-900">{t('Outils de l’agent de Meta', 'Meta’s agent tools')}</h1>
          <p className="text-sm text-ink-500">
            {t('Ce que l’agent de Meta peut faire pendant une conversation.', 'What Meta’s agent can do during a conversation.')}
          </p>
        </div>
        {isAdmin && mode.vue === 'liste' && (
          <button type="button" data-testid="mba-outils-ajouter" onClick={() => setMode({ vue: 'choix' })}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">
            {t('+ Ajouter un outil', '+ Add a tool')}
          </button>
        )}
      </div>

      {erreur !== null && <p className="text-xs text-coral" data-testid="mba-outils-erreur">{erreur}</p>}
      {envoiEnCours && (
        <p className="text-xs text-ink-500" data-testid="mba-outils-attente">
          {t('Envoi chez Meta : il répond en quelques secondes. N’appuyez pas une seconde fois.',
            'Sending to Meta: it answers within seconds. Do not press again.')}
        </p>
      )}

      {mode.vue === 'choix' && (
        <ChoixTypeOutil tenantId={tenantId} onAnnuler={() => setMode({ vue: 'liste' })}
          onChoisir={(type) => setMode({ vue: 'form', type, outil: null })} />
      )}
      {mode.vue === 'form' && (
        <FormulaireOutilMba key={mode.outil?.id ?? `nouveau-${mode.type}`} tenantId={tenantId} type={mode.type} outil={mode.outil}
          occupe={occupe} onOccupe={setEnregistrementEnCours} onEnregistre={apresEnregistrement}
          onAnnuler={() => setMode({ vue: 'liste' })} />
      )}

      {sansLigne.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900"
          data-testid="mba-outils-retraits">
          <span>
            {t('Encore chez Meta, sans outil ici : ', 'Still at Meta, with no tool here: ')}{sansLigne.join(', ')}.
          </span>
          {isAdmin && (
            <button type="button" data-testid="mba-outils-retraits-envoyer" disabled={occupe}
              title={t('Ce que vous venez de supprimer ici part sans autre question ; tout autre effacement vous est demandé en le nommant.',
                'What you just deleted here goes without further question; any other deletion is asked first, by name.')}
              onClick={() => { void envoyer(new Set(sansLigne.filter((n) => supprimesIci.has(n)))); }}
              className="rounded-lg border border-amber-300 bg-white px-2 py-0.5 font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50">
              {envoiEnCours ? t('Envoi…', 'Sending…') : t('Envoyer à Meta', 'Send to Meta')}
            </button>
          )}
        </div>
      )}

      {lectureRatee !== null ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-coral" data-testid="mba-outils-lecture-ratee">
          <span>{t('La liste des outils n’a pas pu être lue', 'The tool list could not be read')} ({lectureRatee}).</span>
          <button type="button" data-testid="mba-outils-relire" onClick={() => { void charger(); }}
            className="rounded-lg border border-ink-300 bg-white px-2 py-0.5 text-xs font-medium text-ink-700 hover:bg-ink-50">
            {t('Réessayer', 'Retry')}
          </button>
        </div>
      ) : outils.length === 0 ? (
        <p className="text-sm text-ink-500" data-testid="mba-outils-vide">
          {t('Aucun outil pour l’instant. Ajoutez-en un : l’agent de Meta saura quand s’en servir.',
            'No tool yet. Add one: Meta’s agent will know when to use it.')}
        </p>
      ) : (
        <ul className="divide-y divide-ink-100 rounded-2xl border border-ink-200 bg-white">
          {outils.map((o) => (
            <LigneOutil key={o.id} o={o} t={t} isAdmin={isAdmin} etat={etats === null ? 'chargement' : (etats.get(o.id) ?? 'inconnu')}
              occupe={occupe} envoiEnCours={envoiEnCours}
              onEnvoyer={() => { void envoyer(new Set()); }}
              onRetirer={() => { void envoyer(new Set([o.name])); }}
              onModifier={() => { if (o.type !== 'inconnu') setMode({ vue: 'form', type: o.type, outil: o }); }}
              onSupprimer={() => { void supprimer(o); }}
              onReactiver={() => { void reactiver(o); }} />
          ))}
        </ul>
      )}
    </section>
  );
}

function LigneOutil({ o, t, isAdmin, etat, occupe, envoiEnCours, onEnvoyer, onRetirer, onModifier, onSupprimer, onReactiver }: {
  o: OutilMbaVue; t: Traduire; isAdmin: boolean; etat: EtatChezMeta | 'chargement';
  /** Un envoi, une suppression ou un enregistrement en cours : les boutons attendent. */
  occupe: boolean;
  /** Un envoi seul : c'est lui, et lui seul, qui fait dire « Envoi… ». */
  envoiEnCours: boolean;
  onEnvoyer: () => void; onRetirer: () => void; onModifier: () => void; onSupprimer: () => void; onReactiver: () => void;
}) {
  const badge = o.type === 'inconnu' ? ['Inconnu', 'Unknown'] as const : TEXTES_PAR_TYPE[o.type].badge;
  return (
    <li data-testid={`mba-outil-${o.name}`}
      className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_11rem_8.5rem] sm:items-center">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-ink-900">{o.title}</p>
        <p className="truncate text-xs text-ink-500" data-testid={`mba-outil-cible-${o.id}`}>{libelleCible(o, t)}</p>
        {o.cibleManquante !== null && (
          <p className="text-xs text-coral" data-testid={`mba-outil-manque-${o.id}`}>{o.cibleManquante}</p>
        )}
        {o.aussiUtilisePar.length > 0 && (
          <p className="text-[11px] text-ink-500" data-testid={`mba-outil-partage-${o.id}`}>
            {t('Aussi utilisé par : ', 'Also used by: ')}{o.aussiUtilisePar.join(', ')}
            {t('. Le modifier le modifie pour eux aussi.', '. Editing it edits it for them too.')}
          </p>
        )}
      </div>
      <span className="flex flex-wrap items-center gap-1 justify-self-start">
        {/* 🔴 LE MÊME DESSIN QUE DANS « QUEL OUTIL AJOUTER ? », ET C'EST TOUT L'INTÉRÊT : on reconnaît ici
            ce qu'on a choisi là-bas. Un outil dont le type est `inconnu` n'en porte AUCUN plutôt qu'un par
            défaut, parce qu'un dessin affirmerait une nature que personne n'a lue. */}
        <span className="flex items-center gap-1.5 rounded-md bg-ink-100 px-2 py-0.5 text-xs text-ink-700" data-testid={`mba-outil-type-${o.id}`}>
          {o.type !== 'inconnu' && <IconeOutil signe={TEXTES_PAR_TYPE[o.type].signe} className="h-3.5 w-3.5 shrink-0 text-ink-500" />}
          {t(badge[0], badge[1])}
        </span>
        {/*
          🔴 « IRRÉVERSIBLE » A ÉTÉ RETIRÉ DES ENVOIS, PAS DES APPELS (Julien, 2026-09-24 : « ça veut rien
          dire, c'est confusant »). Le mot couvrait DEUX choses sous une seule étiquette : un bloc ou un
          scénario, qui envoient un message au client, et un appel de connecteur en DELETE, qui détruit
          quelque chose dans SON système. Pour les deux premiers, « irréversible » est vrai et inutile (tout
          message envoyé l'est) ; ce que le client a besoin de lire, c'est que ça PART chez son contact. Pour
          le troisième, le mot est exactement juste, donc il reste.
          ⚠️ LE RISQUE EN BASE NE BOUGE PAS (`RISQUE_MAISON`, `src/mba/outils-maison.ts`) : c'est lui que le
          journal et la garde d'autonomie d'un agent IA lisent. Seul le MOT affiché change.
        */}
        {o.risque === 'irreversible' && (
          <span className="rounded-md bg-amber-50 px-2 py-0.5 text-xs text-amber-800" data-testid={`mba-outil-irreversible-${o.id}`}
            title={t('L’agent de Meta l’appelle sans validation humaine.', 'Meta’s agent calls it without human approval.')}>
            {o.type === 'bloc' || o.type === 'scenario'
              ? t('part chez le client', 'reaches the customer')
              : t('irréversible', 'irreversible')}
          </span>
        )}
      </span>
      <span data-testid={`mba-outil-etat-${o.id}`}>
        {etat === 'chargement' && <span className="text-xs text-ink-400">…</span>}
        {etat === 'chez_meta' && <span className="text-xs text-mint-700">{t('✓ Chez Meta', '✓ At Meta')}</span>}
        {etat === 'inconnu' && (
          <span className="text-xs text-ink-400" title={t('Meta n’a pas pu être lu.', 'Meta could not be read.')}>?</span>
        )}
        {etat === 'hors_meta' && (
          <span className="text-xs text-ink-400"
            title={t('Cet outil ne peut pas partir chez Meta : la ligne rouge dit pourquoi.',
              'This tool cannot be sent to Meta: the red line says why.')}>
            {t('Pas chez Meta', 'Not at Meta')}
          </span>
        )}
        {(etat === 'desactive' || etat === 'desactive_a_retirer') && (
          <span className="flex flex-wrap items-center gap-2 text-xs text-amber-800"
            title={t('La personne qui l’avait ajouté a quitté l’espace : l’agent de Meta ne peut plus s’en servir.',
              'The person who added it left the workspace: Meta’s agent can no longer use it.')}>
            {t('Désactivé', 'Disabled')}
            {isAdmin && (
              <button type="button" data-testid={`mba-outil-reactiver-${o.id}`} disabled={occupe} onClick={onReactiver}
                className="rounded-lg border border-ink-300 bg-white px-2 py-0.5 font-medium text-ink-700 hover:bg-ink-50 disabled:opacity-50">
                {t('Réactiver', 'Reactivate')}
              </button>
            )}
            {/* Rien ne republie au départ d'un collaborateur : Meta le liste encore, et l'agent l'appellerait pour
                rien. L'envoi l'en retire ; cet effacement-là est demandé, il ne se fait donc pas confirmer. */}
            {etat === 'desactive_a_retirer' && (
              <button type="button" data-testid={`mba-outil-retirer-${o.id}`} disabled={occupe || !isAdmin} onClick={onRetirer}
                title={t('Meta le liste encore : l’envoi l’en retire, avec tout ce qui attend.',
                  'Meta still lists it: sending removes it, along with everything pending.')}
                className="rounded-lg border border-amber-300 bg-amber-50 px-2 py-0.5 font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50">
                {envoiEnCours ? t('Envoi…', 'Sending…') : t('À envoyer', 'To send')}
              </button>
            )}
          </span>
        )}
        {etat === 'a_envoyer' && (
          <button type="button" data-testid={`mba-outil-envoyer-${o.id}`} disabled={occupe || !isAdmin}
            title={t('Envoie chez Meta tout ce qui attend, pas seulement cet outil.', 'Sends everything pending to Meta, not only this tool.')}
            onClick={onEnvoyer}
            className="rounded-lg border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50">
            {envoiEnCours ? t('Envoi…', 'Sending…') : t('À envoyer', 'To send')}
          </button>
        )}
      </span>
      {isAdmin && (
        <span className="flex gap-3 text-xs">
          {/* Désactivé pendant un envoi, une suppression ou un enregistrement. Pendant un enregistrement, ouvrir un autre
              outil démontait le formulaire en cours, dont l'erreur se perdait avec la saisie, ou que la fin de
              l'enregistrement refermait (relecture du 2026-09-22). */}
          <button type="button" data-testid={`mba-outil-modifier-${o.id}`} disabled={o.type === 'inconnu' || occupe} onClick={onModifier}
            className="text-ink-600 hover:underline disabled:opacity-40">{t('Modifier', 'Edit')}</button>
          {/* Désactivé pendant un envoi, une suppression ou un enregistrement, comme « Enregistrer » et « Réactiver »
              (spec § 9.2) : sinon le retrait partait pendant qu'un autre envoi lisait encore l'ancien plan, et restait
              en attente sans le dire. */}
          <button type="button" data-testid={`mba-outil-supprimer-${o.id}`} disabled={occupe} onClick={onSupprimer}
            className="text-coral hover:underline disabled:opacity-40">{t('Supprimer', 'Delete')}</button>
        </span>
      )}
    </li>
  );
}

function libelleCible(o: OutilMbaVue, t: Traduire): string {
  const c = o.cible;
  switch (c.type) {
    case 'tag': return t(`Tag : ${c.tag}`, `Tag: ${c.tag}`);
    case 'champ': return t(`Champ : ${c.champ}`, `Field: ${c.champ}`);
    case 'bloc': {
      const bloc = c.bloc ?? t('bloc supprimé', 'deleted block');
      const scenario = c.scenario ?? t('scénario supprimé', 'deleted scenario');
      return t(`Bloc « ${bloc} » du scénario ${scenario}`, `Block “${bloc}” of scenario ${scenario}`);
    }
    case 'scenario': return c.scenario ? t(`Scénario : ${c.scenario}`, `Scenario: ${c.scenario}`) : t('Scénario supprimé', 'Deleted scenario');
    case 'connecteur': return c.libelle ? t(`Appel : ${c.libelle}`, `Call: ${c.libelle}`) : t('Appel supprimé', 'Deleted call');
    case 'inconnu': return t('Format inconnu', 'Unknown format');
  }
}
