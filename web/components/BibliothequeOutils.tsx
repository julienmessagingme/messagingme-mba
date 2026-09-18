'use client';

import { useEffect, useState } from 'react';
import {
  getBibliothequeOutils, supprimerDefinitionOutil, exposerOutilAuMba, creerOutilPourMba,
  apercuPublicationMba, publierChezMeta,
  type OutilBibliotheque, type GestePublication,
} from '@/lib/api-agent-tools';
import { listRequetes, type RequeteApi } from '@/lib/api-agent-requetes';
import { normaliserCodeSortie } from '@/lib/agent-sorties';
import { inputCls } from '@/lib/ui';
import { useT } from '@/lib/i18n';

/**
 * LES OUTILS DE L'AGENT DE META : ce qu'on lui expose, et qui d'autre s'en sert.
 *
 * 🔴 IL N'EST PLUS L'ÉCRAN « OUTILS DE L'ESPACE », ET LA NOTION A DISPARU DU PRODUIT (2026-09-18). Depuis
 * 0157 une ACTION appartient à son agent, et 0159 INTERDIT en base qu'une action vive au niveau de
 * l'espace : il ne reste ici que des outils bâtis sur un connecteur. L'entrée `Tools > Outils` a été
 * retirée à la demande de Julien, cet onglet du MBA est le seul chemin, et l'adresse `/outils` reste
 * servie pour les liens déjà partagés.
 *
 * 🔴 LA COLONNE « UTILISÉ PAR » RESTE TOUTE LA RAISON DE LA LISTE, et elle n'existait nulle part. Un outil
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
   * ENVOYER CHEZ META, EN UN SEUL GESTE (demande de Julien, 2026-09-18).
   *
   * 🔴 IL Y AVAIT DEUX BOUTONS, « Voir ce qui va changer » PUIS « Publier ces N changement(s) », et ce
   * vocabulaire ne disait rien à qui veut simplement soumettre son outil. Un écran qui oblige à comprendre
   * le mot « plan » avant d'agir est un écran qui ne sert pas.
   *
   * ⚠️ LA SEULE CHOSE QU'ON GARDE DE L'APERÇU, C'EST LE REFUS DE SUPPRIMER EN SILENCE. Publier ÉCRASE ce
   * qui est chez Meta (« Engage Me fait foi », arbitrage du 2026-09-10) : une création n'a besoin d'aucune
   * cérémonie, une SUPPRESSION oui. On demande donc le plan sans le montrer, et on n'arrête la main que
   * s'il contient un effacement, en le nommant.
   */
  async function envoyerChezMeta(): Promise<void> {
    setErreur(null);
    setPublie(false);
    let gestes: GestePublication[];
    try {
      gestes = (await apercuPublicationMba(tenantId)).gestes;
    } catch (e) {
      setErreur(e instanceof Error ? e.message : t('L’envoi a échoué.', 'Sending failed.'));
      return;
    }
    if (gestes.length === 0) { setPlan([]); return; }
    const effacements = gestes.filter((g) => g.type.endsWith('supprimer'));
    if (effacements.length > 0) {
      const liste = effacements.map((g) => `- ${LIBELLE_GESTE[g.type]} : ${g.nom}`).join('\n');
      const ok = window.confirm(t(
        `Cet envoi va SUPPRIMER chez Meta :

${liste}

Continuer ?`,
        `This will DELETE at Meta:

${liste}

Continue?`,
      ));
      if (!ok) return;
    }
    await publier();
  }

  async function publier(): Promise<void> {
    try {
      await publierChezMeta(tenantId);
      setPublie(true);
      setPlan([]);
      setOutils((await getBibliothequeOutils(tenantId)).outils);
    } catch (e) {
      // Le message du serveur dit combien de gestes ont abouti et qu'on peut relancer sans risque de doublon.
      setErreur(e instanceof Error ? e.message : t('L’envoi chez Meta a échoué.', 'Sending to Meta failed.'));
    }
  }

  /**
   * Ce que fait « Soumettre » du formulaire : l'outil vient d'être créé, il part chez Meta dans la foulée.
   *
   * ⚠️ UN ÉCHEC D'ENVOI NE DOIT PAS FAIRE CROIRE QUE LA CRÉATION A RATÉ : l'outil est enregistré chez nous,
   * et c'est le voyage vers Meta qui a échoué. Le message le dit, et le bouton d'envoi reste là pour
   * réessayer.
   */
  async function apresCreation(): Promise<void> {
    setOutils((await getBibliothequeOutils(tenantId)).outils);
    await publier();
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
        {/* 🔴 « DE L'ESPACE » A DISPARU DU TITRE, PARCE QUE LA NOTION A DISPARU DU PRODUIT (2026-09-18).
            Depuis 0157 une ACTION appartient à son agent, et 0159 INTERDIT en base qu'une action vive au
            niveau de l'espace : il ne reste ici que des outils bâtis sur un connecteur. Le titre promettait
            donc un inventaire que cet écran ne peut plus contenir, et le sous-titre annonçait un partage
            entre agents qui n'est vrai que de cette moitié-là. */}
        <h1 className="text-lg font-semibold text-ink-900">{t('Outils de l’agent de Meta', 'Meta’s agent tools')}</h1>
        <p className="mt-1 text-sm text-ink-500">
          {t('Un appel réglé dans Tools > Connecteurs API devient un outil ici, avec les mots que l’agent de Meta lira pour décider quand l’appeler. Il faut ensuite le publier chez Meta.',
            'A call set up in Tools > API connectors becomes a tool here, with the words Meta’s agent reads to decide when to call it. You then publish it to Meta.')}
        </p>
      </header>

      {erreur && <p className="text-xs text-coral" data-testid="bibliotheque-erreur">{erreur}</p>}

      {/* 🔴 CREER UN OUTIL POUR META SANS PASSER PAR UN AGENT IA (2026-09-15). Un outil naissait en le
          donnant a un agent : exposer un appel a Meta obligeait a creer un agent dont on n a pas besoin, et
          a repondre pour lui a des questions que Meta ignore. Julien : « je ne sais pas ou l affecter pour
          le MBA ». */}
      {isAdmin && <OutilPourMba tenantId={tenantId} onCree={apresCreation} />}

      {/* La publication chez Meta. Elle vit ICI et pas dans les paramètres MBA : ce qu'on publie, c'est
          cette bibliothèque-là, et le geste doit être à côté de ce qu'il emporte. */}
      {isAdmin && (
        <section className="rounded-2xl border border-ink-200 bg-ink-50/50 p-4" data-testid="publication-mba">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm font-medium text-ink-800">{t('Envoyer chez Meta', 'Send to Meta')}</span>
            <button type="button" className="rounded-lg bg-brand-600 px-3 py-1 text-xs font-semibold text-white hover:bg-brand-700"
              data-testid="publication-publier" onClick={() => { void envoyerChezMeta(); }}>
              {t('Envoyer', 'Send')}
            </button>
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

        </section>
      )}

      {outils.length === 0 ? (
        /**
         * 🔴 UN ÉTAT VIDE QUI DÉSIGNE UN AUTRE ÉCRAN PENDANT QUE LE GESTE EST JUSTE AU-DESSUS (2026-09-18).
         * Il disait « Ajoutez-en un depuis l'onglet Outils d'un agent » : Julien l'a suivi, n'a rien trouvé
         * là-bas, et a conclu qu'il n'existait AUCUN endroit où nommer et décrire son outil. Le formulaire
         * était à deux centimètres, derrière un lien discret. Un état vide est une consigne, pas un constat :
         * il doit nommer le geste de CET écran.
         */
        <p className="text-sm text-ink-500" data-testid="bibliotheque-vide">
          {isAdmin
            ? t('Aucun outil exposé pour l’instant. Choisissez un appel ci-dessus, puis dites à l’agent de Meta quand s’en servir.',
              'No tool exposed yet. Pick a call above, then tell Meta’s agent when to use it.')
            : t('Aucun outil pour l’instant. Un administrateur peut en ajouter un depuis cet écran.',
              'No tools yet. An administrator can add one from this screen.')}
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
 * 🔴 ON CHOISIT L'APPEL D'ABORD, LES DÉTAILS APPARAISSENT ENSUITE (demande de Julien, 2026-09-18, et le
 * sens comptait). Ce bloc était replié derrière un lien « + un outil », et dedans les quatre champs
 * arrivaient AVANT le choix : on décrivait donc un outil avant de savoir lequel. Julien a cherché où mettre
 * ces mots, ne les a pas trouvés, et a conclu qu'il n'existait aucun endroit pour ça. La liste des appels
 * est désormais la première chose visible, et les champs ne s'ouvrent que sur celui qu'on a pris.
 *
 * 🔴 AUCUNE QUESTION « POUSSE OU INTÈGRE » ICI, ET C'EST DÉLIBÉRÉ. Meta appelle le système du client EN
 * DIRECT et lit toute la réponse : ni la nature, ni les champs cochés ne s'y appliquent. Poser la question
 * donnerait un réglage sans effet, c'est-à-dire le motif « offert-et-inerte » que ce produit s'interdit.
 *
 * ⚠️ LES QUATRE TEXTES VIVENT ICI ET PAS SUR L'APPEL, et c'est un arbitrage de Julien du 2026-09-18 :
 * `Tools > Connecteurs API` règle JUSTE la connexion technique. Les mots que le modèle lit pour décider
 * quand appeler appartiennent à l'endroit où l'on décide de l'exposer.
 */
function OutilPourMba({ tenantId, onCree }: { tenantId: string; onCree: () => Promise<void> | void }) {
  const t = useT();
  const [requetes, setRequetes] = useState<RequeteApi[] | null>(null);
  const [choisi, setChoisi] = useState<RequeteApi | null>(null);
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [nePasUtiliser, setNePasUtiliser] = useState('');
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  // ⚠️ AU MONTAGE, PLUS À L'OUVERTURE D'UN REPLI : la liste EST le point d'entrée de cet écran maintenant.
  useEffect(() => {
    let vivant = true;
    listRequetes(tenantId)
      // 🔴 LECTURE DÉFENSIVE, ET LE E2E L'A PROUVÉE NÉCESSAIRE. Une réponse sans le champ `requetes` passait
      // la garde `!== null`, puis `requetes.length` levait : la page entière rendait « Application error »,
      // c'est-à-dire que l'onglet Outils du MBA disparaissait en entier à cause d'une liste secondaire.
      // Une liste qu'on ne sait pas lire doit être VIDE, jamais fatale.
      .then((r) => { if (vivant) setRequetes(Array.isArray(r?.requetes) ? r.requetes : []); })
      .catch(() => { if (vivant) setRequetes([]); });
    return () => { vivant = false; };
  }, [tenantId]);

  /**
   * ⚠️ ON PRÉREMPLIT CE QU'ON SAIT, ET RIEN DE PLUS. Le titre et le nom technique se dérivent du libellé de
   * l'appel (`normaliserCodeSortie` est le miroir de la règle serveur, on ne réécrit pas un slug à la main).
   * Les DEUX textes qui disent au modèle quand appeler et quand s'abstenir restent VIDES : les deviner
   * fabriquerait une consigne que personne n'a écrite, sur laquelle le modèle agirait pourtant.
   */
  const choisir = (r: RequeteApi): void => {
    setErreur(null);
    setChoisi(r);
    setTitle(r.label);
    setName(normaliserCodeSortie(r.label));
    setDescription('');
    setNePasUtiliser('');
  };

  const manque: string | null =
    !/^[a-z0-9_]{1,64}$/.test(name) ? t('Un nom technique en minuscules, chiffres et tirets bas.', 'A technical name in lowercase, digits and underscores.')
      : title.trim() === '' ? t('Donnez un titre lisible.', 'Give it a readable title.')
        : description.trim() === '' ? t('Dites quand l’appeler.', 'Say when to call it.')
          : nePasUtiliser.trim() === '' ? t('Dites quand NE PAS l’appeler.', 'Say when NOT to call it.')
            : busy ? t('Envoi en cours…', 'Sending…')
              : null;

  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-ink-200 p-4" data-testid="outil-mba-form">
      <p className="text-sm font-medium text-ink-800">
        {t('Ajouter un outil pour l’agent de Meta', 'Add a tool for Meta’s agent')}
      </p>
      <p className="text-xs text-ink-500">
        {t('Choisissez l’appel à exposer, puis dites à l’agent de Meta quand s’en servir.',
          'Pick the call to expose, then tell Meta’s agent when to use it.')}
      </p>
      {erreur !== null && <p className="text-xs text-coral" data-testid="outil-mba-erreur">{erreur}</p>}

      {requetes !== null && requetes.length === 0 && (
        <p className="text-xs text-ink-500" data-testid="outil-mba-sans-appel">
          {t('Aucun appel déclaré : mettez-en un au point dans Tools > Connecteurs API.',
            'No call declared yet: set one up in Tools > API connectors.')}
        </p>
      )}

      {requetes !== null && requetes.length > 0 && (
        <ul className="flex flex-col gap-1" data-testid="outil-mba-appels">
          {requetes.map((r) => (
            <li key={r.id}
              className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 ${choisi?.id === r.id ? 'border-brand-400 bg-brand-50' : 'border-ink-200'}`}>
              <span className="flex flex-wrap items-baseline gap-2">
                <span className="text-sm text-ink-800">{r.label}</span>
                <code className="text-[11px] text-ink-500">{r.methode} {r.chemin}</code>
              </span>
              <button type="button" data-testid={`outil-mba-choisir-${r.id}`} onClick={() => choisir(r)}
                className="rounded-lg border border-ink-300 bg-white px-2 py-0.5 text-xs font-medium text-ink-700 hover:bg-ink-50">
                {choisi?.id === r.id ? t('Choisi', 'Picked') : t('Choisir', 'Pick')}
              </button>
            </li>
          ))}
        </ul>
      )}

      {choisi !== null && (
        <div className="flex flex-col gap-2 border-t border-ink-200 pt-3" data-testid="outil-mba-details">
          <p className="text-xs text-ink-500">
            {t('Meta appelle votre système en direct : il n’y a rien à choisir sur ce qu’il lit en retour, il lit toute la réponse.',
              'Meta calls your system directly: there is nothing to pick about what it reads back, it reads the whole response.')}
          </p>
          <label className="text-xs text-ink-600">
            {t('Nom technique (vu par l’agent de Meta)', 'Technical name (seen by Meta’s agent)')}
            <input className={`${inputCls} mt-1`} data-testid="outil-mba-nom" value={name} onChange={(e) => setName(e.target.value)} placeholder="poser_etiquette" />
          </label>
          <label className="text-xs text-ink-600">
            {t('Titre lisible', 'Readable title')}
            <input className={`${inputCls} mt-1`} data-testid="outil-mba-titre" value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="text-xs text-ink-600">
            {t('Quand l’appeler', 'When to call it')}
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
                creerOutilPourMba(tenantId, { requeteId: choisi.id, name, title: title.trim(), description: description.trim(), nePasUtiliser: nePasUtiliser.trim() })
                  // 🔴 SOUMETTRE ENVOIE CHEZ META DANS LA FOULÉE (demande de Julien, 2026-09-18). Le geste
                  // d'avant s'arrêtait à notre base alors que le bouton disait « exposer à Meta » : il
                  // mentait sur ce qu'il faisait, et il fallait ensuite comprendre deux autres boutons.
                  .then(() => onCree())
                  // Le formulaire ne se referme que sur un succès : le refermer sur un refus perdrait la
                  // saisie, défaut payé deux fois le 2026-09-15 sur les deux autres écrans de ce chantier.
                  .then(() => { setChoisi(null); setName(''); setTitle(''); setDescription(''); setNePasUtiliser(''); })
                  .catch((err: unknown) => { setErreur(err instanceof Error ? err.message : t('Création impossible', 'Creation failed')); })
                  .finally(() => { setBusy(false); });
              }}
            >
              {t('Soumettre', 'Submit')}
            </button>
            {manque !== null && <span className="text-[11px] text-ink-500" data-testid="outil-mba-manque">{manque}</span>}
            <button type="button" onClick={() => setChoisi(null)} className="text-xs text-ink-500 hover:underline">
              {t('Annuler', 'Cancel')}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
