'use client';

import { useEffect, useState } from 'react';
import {
  getBibliothequeOutils, supprimerDefinitionOutil, exposerOutilAuMba, creerOutilPourMba,
  apercuPublicationMba, publierChezMeta,
  type OutilBibliotheque, type GestePublication,
} from '@/lib/api-agent-tools';
import { listRequetes, type RequeteApi } from '@/lib/api-agent-requetes';
import { inputCls } from '@/lib/ui';
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

  const recharger = async (): Promise<void> => {
    try { setOutils((await getBibliothequeOutils(tenantId)).outils); } catch { setOutils([]); }
  };

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
   * Le nom LISIBLE d'un consommateur.
   *
   * ⚠️ LE MBA N'A PAS DE FICHE D'AGENT, DONC PAS DE LIBELLÉ, et c'est voulu : c'est un numéro chez Meta, pas
   * une ligne de notre base. Sans cette traduction, la ligne « utilisé par » affichait la clé technique
   * telle quelle (`mba:1234840649713976`), c'est-à-dire un identifiant interne montré au client sur l'écran
   * même qui sert à décider quoi exposer.
   */
  const nomConsommateur = (c: { cle: string; agentLabel: string | null }): string =>
    c.agentLabel ?? (c.cle.startsWith('mba:') ? t('Agent de Meta', 'Meta’s agent') : c.cle);

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

      {/* 🔴 CREER UN OUTIL POUR META SANS PASSER PAR UN AGENT IA (2026-09-15). Un outil naissait en le
          donnant a un agent : exposer un appel a Meta obligeait a creer un agent dont on n a pas besoin, et
          a repondre pour lui a des questions que Meta ignore. Julien : « je ne sais pas ou l affecter pour
          le MBA ». */}
      {isAdmin && <OutilPourMba tenantId={tenantId} onCree={() => { void recharger(); }} />}

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
                {/* 🔴 UN OUTIL MORT NE DOIT PAS RESSEMBLER À UN OUTIL VIVANT. Sans ces deux pastilles, cet
                    écran affichait un outil disparu du serveur distant, ou dont le schéma n'est pas
                    représentable, EXACTEMENT comme les autres : le client ne l'apprenait qu'en cliquant
                    « activer » et en recevant un refus. */}
                {o.mcpIndisponibleLe && (
                  <span data-testid={`outil-disparu-${o.id}`}
                    className="rounded-full bg-coral/10 px-2 py-0.5 text-[11px] font-medium text-coral">
                    {t('a disparu du serveur', 'gone from the server')}
                  </span>
                )}
                {!o.mcpIndisponibleLe && o.mcpNonActivable && (
                  <span data-testid={`outil-non-activable-${o.id}`}
                    className="rounded-full bg-ink-100 px-2 py-0.5 text-[11px] font-medium text-ink-700">
                    {t('non activable', 'not activatable')}
                  </span>
                )}
              </div>
              <p className="mt-1 text-sm text-ink-600">{o.description}</p>
              {/* La RAISON, telle que le serveur l'a écrite : le client ne peut pas la corriger lui-même,
                  mais il doit pouvoir la montrer à son fournisseur. */}
              {o.mcpNonActivable && !o.mcpIndisponibleLe && (
                <p className="mt-1 text-xs text-ink-500" data-testid={`outil-raison-${o.id}`}>{o.mcpNonActivable}</p>
              )}

              {/* 🔴 CE QUE CET ÉCRAN EXISTE POUR MONTRER. Sans cette ligne, la bibliothèque ne serait qu'une
                  liste de plus : c'est elle qui dit qu'un outil est PARTAGÉ, et donc qu'y toucher touche
                  plusieurs agents à la fois. */}
              <p className="mt-2 text-xs text-ink-500" data-testid={`outil-${o.name}-consommateurs`}>
                {o.consommateurs.length === 0
                  ? t('Utilisé par aucun agent.', 'Used by no agent.')
                  : `${t('Utilisé par', 'Used by')} : ${o.consommateurs
                    .map((c) => `${nomConsommateur(c)}${c.actif ? '' : t(' (inactif)', ' (inactive)')}`)
                    .join(', ')}`}
              </p>

              {/* La case « exposé au MBA ». Elle n'est PAS un réglage d'agent : elle rattache l'outil au
                  consommateur `mba:<numero>`, qui est un consommateur comme un autre depuis 0127. */}
              {isAdmin && (
                <label className={`mt-3 flex items-center gap-2 text-xs ${o.origin === 'http' ? 'text-ink-700' : 'text-ink-400'}`}>
                  <input
                    type="checkbox"
                    data-testid={`outil-${o.name}-mba`}
                    checked={exposeAuMba(o)}
                    /* 🔴 GRISÉE POUR UN OUTIL QUI N'EST PAS PUBLIABLE, et la raison est DITE. Un connecteur
                       Meta est une API REST : son schéma exige `base_url` et `auth_type`, et n'a AUCUN champ
                       de protocole (vérifié sur le corpus OpenAPI officiel le 2026-09-10). Un outil MAISON
                       n'a pas d'adresse à appeler, un outil MCP ne parle pas HTTP. Laisser la case cochable
                       produirait une case cochée que la publication ignore en silence, ce qui est pire que
                       de l'interdire. */
                    disabled={o.origin !== 'http'}
                    onChange={(e) => { void basculerMba(o, e.target.checked); }}
                    className="h-3.5 w-3.5 rounded border-ink-300 disabled:opacity-40"
                  />
                  {t('Exposé à l’agent de Meta', 'Exposed to Meta’s agent')}
                  {o.origin !== 'http' && (
                    <span>
                      {o.origin === 'mba'
                        ? t('(outil maison : rien à appeler chez Meta)', '(built-in tool: nothing for Meta to call)')
                        : t('(MCP : Meta ne sait appeler que du HTTP)', '(MCP: Meta only calls HTTP)')}
                    </span>
                  )}
                  {o.risk === 'irreversible' && o.origin === 'http' && (
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

/**
 * CRÉER UN OUTIL POUR L'AGENT DE META, sans agent IA.
 *
 * 🔴 AUCUNE QUESTION « POUSSE OU INTÈGRE » ICI, ET C'EST DÉLIBÉRÉ. Meta appelle le système du client EN
 * DIRECT et lit toute la réponse : ni la nature, ni les champs cochés ne s'y appliquent. Poser la question
 * donnerait un réglage sans effet, c'est-à-dire le motif « offert-et-inerte » que ce produit s'interdit.
 *
 * ⚠️ Les appels sont chargés À L'OUVERTURE du formulaire, pas au montage de l'écran : cette page sert
 * d'abord à voir qui utilise quoi, et la plupart des visites n'ouvrent jamais ce bloc.
 */
function OutilPourMba({ tenantId, onCree }: { tenantId: string; onCree: () => void }) {
  const t = useT();
  const [ouvert, setOuvert] = useState(false);
  const [requetes, setRequetes] = useState<RequeteApi[] | null>(null);
  const [requeteId, setRequeteId] = useState('');
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [nePasUtiliser, setNePasUtiliser] = useState('');
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  const ouvrir = async (): Promise<void> => {
    setOuvert(true);
    if (requetes !== null) return;
    try {
      const r = await listRequetes(tenantId);
      setRequetes(r.requetes);
      setRequeteId(r.requetes[0]?.id ?? '');
    } catch { setRequetes([]); }
  };

  const manque: string | null =
    requeteId === '' ? t('Choisissez un appel.', 'Pick a call.')
      : !/^[a-z0-9_]{1,64}$/.test(name) ? t('Un nom technique en minuscules, chiffres et tirets bas.', 'A technical name in lowercase, digits and underscores.')
        : title.trim() === '' ? t('Donnez un titre lisible.', 'Give it a readable title.')
          : description.trim() === '' ? t('Dites à quoi ça sert.', 'Say what it does.')
            : nePasUtiliser.trim() === '' ? t('Dites quand NE PAS l’appeler.', 'Say when NOT to call it.')
              : busy ? t('Enregistrement en cours…', 'Saving…')
                : null;

  if (!ouvert) {
    return (
      <button type="button" data-testid="outil-mba-ouvrir" onClick={() => { void ouvrir(); }}
        className="self-start text-sm text-brand-600 hover:underline">
        {t('+ un outil pour l’agent de Meta', '+ a tool for Meta’s agent')}
      </button>
    );
  }

  return (
    <section className="flex flex-col gap-2 rounded-2xl border border-ink-200 p-4" data-testid="outil-mba-form">
      <p className="text-sm font-medium text-ink-800">
        {t('Un outil pour l’agent de Meta', 'A tool for Meta’s agent')}
      </p>
      <p className="text-xs text-ink-500">
        {t('Meta appelle votre système en direct : il n’y a rien à choisir sur ce qu’il lit en retour, il lit toute la réponse.',
          'Meta calls your system directly: there is nothing to pick about what it reads back, it reads the whole response.')}
      </p>
      {erreur !== null && <p className="text-xs text-coral" data-testid="outil-mba-erreur">{erreur}</p>}
      <label className="text-xs text-ink-600">
        {t('Quel appel ?', 'Which call?')}
        <select className={`${inputCls} mt-1`} data-testid="outil-mba-requete" value={requeteId} onChange={(e) => setRequeteId(e.target.value)}>
          {(requetes ?? []).map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
        </select>
      </label>
      {requetes !== null && requetes.length === 0 && (
        <p className="text-xs text-ink-500" data-testid="outil-mba-sans-appel">
          {t('Aucun appel déclaré : mettez-en un au point dans Tools > Connecteurs API.',
            'No call declared yet: set one up in Tools > API connectors.')}
        </p>
      )}
      <label className="text-xs text-ink-600">
        {t('Nom technique (vu par l’agent de Meta)', 'Technical name (seen by Meta’s agent)')}
        <input className={`${inputCls} mt-1`} data-testid="outil-mba-nom" value={name} onChange={(e) => setName(e.target.value)} placeholder="poser_etiquette" />
      </label>
      <label className="text-xs text-ink-600">
        {t('Titre lisible', 'Readable title')}
        <input className={`${inputCls} mt-1`} data-testid="outil-mba-titre" value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="text-xs text-ink-600">
        {t('À quoi ça sert', 'What it does')}
        <textarea className={`${inputCls} mt-1`} rows={2} data-testid="outil-mba-description" value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label className="text-xs text-ink-600">
        {t('Quand NE PAS l’appeler', 'When NOT to call it')}
        <textarea className={`${inputCls} mt-1`} rows={2} data-testid="outil-mba-nepasutiliser" value={nePasUtiliser} onChange={(e) => setNePasUtiliser(e.target.value)} />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button" data-testid="outil-mba-creer" disabled={manque !== null} title={manque ?? ''}
          className="rounded-lg bg-brand-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
          onClick={() => {
            setBusy(true);
            setErreur(null);
            creerOutilPourMba(tenantId, { requeteId, name, title: title.trim(), description: description.trim(), nePasUtiliser: nePasUtiliser.trim() })
              .then(() => { setOuvert(false); setName(''); setTitle(''); setDescription(''); setNePasUtiliser(''); onCree(); })
              // 🔴 LE FORMULAIRE NE SE FERME QUE SUR UN SUCCÈS : le refermer sur un refus perdrait la saisie,
              // défaut payé deux fois le 2026-09-15 sur les deux autres écrans de ce chantier.
              .catch((err: unknown) => { setErreur(err instanceof Error ? err.message : t('Création impossible', 'Creation failed')); })
              .finally(() => { setBusy(false); });
          }}
        >
          {t('Créer et exposer à Meta', 'Create and expose to Meta')}
        </button>
        {manque !== null && <span className="text-[11px] text-ink-500" data-testid="outil-mba-manque">{manque}</span>}
        <button type="button" onClick={() => setOuvert(false)} className="text-xs text-ink-500 hover:underline">
          {t('Annuler', 'Cancel')}
        </button>
      </div>
    </section>
  );
}
