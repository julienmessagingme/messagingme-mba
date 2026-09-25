'use client';

import { useState } from 'react';
import { RcsMessageForm } from '@/components/RcsMessageForm';
import { RcsCarouselForm } from '@/components/RcsCarouselForm';
import type { RcsMessage, UserFieldDef } from '@/lib/api';
import { Bouton } from '@/components/Bouton';

/**
 * ÉCRIRE UN MESSAGE RCS SANS QUITTER LA CAMPAGNE EN COURS, simple ou carrousel.
 *
 * 🔴 CE QU'IL RÉPARE (Julien, 2026-09-24) : dans une campagne RCS on ne pouvait que PARTIR d'un message
 * déjà enregistré. Un CARROUSEL ne s'y créait pas du tout, alors que ses cartes portent chacune un titre :
 * le composeur de l'étage ne sait éditer que trois champs (visuel, texte, boutons). Le vrai créateur
 * existait, mais dans un autre écran, donc il fallait abandonner sa campagne pour aller y écrire.
 *
 * ⚠️ CE COMMENTAIRE A DIT « ET UNE CARTE À TITRE NON PLUS », ET C'ÉTAIT FAUX (relecture à froid du
 * 2026-09-24). Le modèle accepte bien un titre sur une carte SIMPLE (`RcsCard.title`, `src/rcs/types.ts`),
 * mais AUCUN écran ne sait le saisir : `RcsMessageForm` n'a pas ce champ. Ouvrir ce composeur n'ouvre donc
 * pas ce chemin-là, et le dire aurait envoyé quelqu'un chercher un champ qui n'existe nulle part. Le titre
 * d'une carte simple reste hors de portée de la console, c'est noté dans `todo.md`.
 *
 * 🔴 IL MONTE LES FORMULAIRES DE PRODUCTION, PAS UNE VERSION ALLÉGÉE. `RcsMessageForm` et
 * `RcsCarouselForm` sont ceux de Contenu > RCS > Messages : même validation, même bornage de boutons,
 * même route d'enregistrement. Une seconde façon d'écrire un message RCS aurait fait deux endroits à
 * corriger le jour où smsmode change une règle. C'est la même décision que `CreationModeleEnLigne` pour
 * les modèles WhatsApp, dont ce composant est le jumeau.
 *
 * ⚠️ BEAUCOUP PLUS SIMPLE QUE SON JUMEAU, ET LA RAISON EST PRODUIT : un modèle WhatsApp passe en revue chez
 * Meta, donc il naît inenvoyable et il faut sonder son statut. Un message RCS est utilisable tout de suite.
 * Pas de sondage, pas d'attente, pas de panneau de statut.
 *
 * 🔴 LE MESSAGE NEUF EST RETROUVÉ PAR DIFFÉRENCE, parce que les deux formulaires rendent `onSaved(): void`
 * et ne disent pas ce qu'ils ont créé. On relit donc la bibliothèque et on cherche l'identifiant qui n'y
 * était pas à l'ouverture. Changer la signature des deux formulaires aurait touché l'écran en service pour
 * un besoin qui n'est pas le sien. ⚠️ Et si la différence est vide (relecture en échec, ou message créé en
 * parallèle dans un autre onglet), on ne devine PAS : on le dit, et on renvoie au sélecteur du dessus.
 */
export function CreationMessageRcsEnLigne({ tenantId, champs, rechargerMessagesRcs, onCree }: {
  tenantId: string;
  champs: UserFieldDef[];
  /** Relit la bibliothèque et rend la liste COMPLÈTE, celle que le sélecteur de l'étage propose. */
  rechargerMessagesRcs: () => Promise<RcsMessage[]>;
  /** Le message neuf, tel que la bibliothèque le rend. L'hôte décide comment le poser sur l'étage. */
  onCree: (m: RcsMessage) => void;
}) {
  const [mode, setMode] = useState<null | 'choix' | 'simple' | 'carrousel'>(null);
  /**
   * Les identifiants présents AVANT l'ouverture : c'est eux qui font la différence.
   *
   * 🔴 `null` = ON N'A PAS PU LIRE, ET CE N'EST PAS UNE LISTE VIDE (relecture à froid du 2026-09-24). Sur un
   * instantané raté, le code posait `[]`, donc la différence rendait le PREMIER message de la bibliothèque
   * et l'écran le posait sur l'étage comme s'il venait d'être écrit. C'est exactement le défaut que la
   * vérification par mutation avait mis en évidence, et le repli « introuvable » censé le couvrir devenait
   * inatteignable, puisqu'une différence n'est jamais vide quand on compare à rien.
   */
  const [avant, setAvant] = useState<readonly string[] | null>(null);
  const [souci, setSouci] = useState<string | null>(null);

  async function ouvrir(): Promise<void> {
    setSouci(null);
    // ⚠️ L'INSTANTANÉ EST PRIS SUR UNE RELECTURE, PAS SUR LA LISTE DÉJÀ EN MÉMOIRE. Celle de l'écran peut
    // dater de l'ouverture de la page ; un message créé entre-temps y manquerait, et il passerait donc pour
    // « le neuf » tout à l'heure.
    try {
      setAvant((await rechargerMessagesRcs()).map((m) => m.id));
    } catch {
      // Une relecture ratée ici n'empêche pas d'ÉCRIRE : le message sera enregistré quand même. Elle
      // empêche seulement de le RETROUVER, et on le dira plutôt que de désigner n'importe lequel.
      setAvant(null);
    }
    setMode('choix');
  }

  async function apresEnregistrement(): Promise<void> {
    if (avant === null) {
      // 🔴 ON NE DEVINE PAS. Sans instantané, « le message absent d'avant » n'a aucun sens : le premier de
      // la liste passerait pour le neuf, et l'étage porterait un message que personne n'a choisi.
      setSouci('Le message est enregistré. Nous n’avons pas pu lire la bibliothèque à l’ouverture, donc nous ne savons pas lequel est le vôtre : choisissez-le dans « Partir d’un message enregistré » juste au-dessus.');
      setMode(null);
      return;
    }
    try {
      const apres = await rechargerMessagesRcs();
      const neuf = apres.find((m) => !avant.includes(m.id));
      if (neuf) { onCree(neuf); setMode(null); return; }
      setSouci('Le message est enregistré, mais nous ne l’avons pas retrouvé pour le poser ici. Choisissez-le dans « Partir d’un message enregistré » juste au-dessus.');
    } catch {
      setSouci('Le message est enregistré. La bibliothèque n’a pas pu être relue : choisissez-le dans « Partir d’un message enregistré » juste au-dessus.');
    }
    setMode(null);
  }

  if (mode === null) {
    return (
      <div className="flex flex-col gap-1">
        <button
          type="button"
          onClick={() => { void ouvrir(); }}
          data-testid="rcs-creer-message"
          className="self-start text-xs text-brand-600 hover:underline"
        >
          ＋ Créer un nouveau message
        </button>
        {souci !== null && (
          <p className="text-xs text-alerte-700" data-testid="rcs-creer-souci">{souci}</p>
        )}
      </div>
    );
  }

  if (mode === 'choix') {
    return (
      <div className="w-full rounded-carte border border-brand-200 bg-brand-50/40 p-3" data-testid="rcs-creer-choix">
        <p className="text-xs font-medium text-ink-900">Quel genre de message ?</p>
        {/* ⚠️ LE CARROUSEL EST UN CHOIX À PART, PAS UNE CASE DANS LE FORMULAIRE SIMPLE : ce sont deux
            formulaires différents dans l'écran en service (un message a trois champs, un carrousel a de
            deux à dix cartes qui en ont chacune trois). Les fondre ici aurait fabriqué un troisième
            formulaire, c'est-à-dire exactement ce que ce composant existe pour éviter. */}
        <div className="mt-2 flex flex-wrap gap-2">
          <Bouton variante="secondaire" taille="petite" type="button" data-testid="rcs-creer-simple" onClick={() => setMode('simple')}>
            Message simple
          </Bouton>
          <Bouton variante="secondaire" taille="petite" type="button" data-testid="rcs-creer-carrousel" onClick={() => setMode('carrousel')}>
            Carrousel
          </Bouton>
          <button type="button" onClick={() => setMode(null)} className="px-2 py-1.5 text-xs text-ink-500 hover:underline">
            Annuler
          </button>
        </div>
        <p className="mt-2 text-xs text-ink-500">
          Un message simple porte un texte, un visuel et des boutons. Un carrousel porte de deux à dix cartes,
          chacune avec son titre, son texte, son visuel et ses boutons.
        </p>
      </div>
    );
  }

  return (
    <div className="w-full rounded-carte border border-brand-200 bg-brand-50/40 p-3" data-testid={`rcs-creer-${mode}-ouvert`}>
      {mode === 'simple'
        ? <RcsMessageForm tenantId={tenantId} fields={champs} onSaved={() => { void apresEnregistrement(); }} />
        : <RcsCarouselForm tenantId={tenantId} fields={champs} onSaved={() => { void apresEnregistrement(); }} />}
      <button type="button" onClick={() => setMode(null)} className="mt-2 text-xs text-ink-500 hover:underline">
        Annuler
      </button>
    </div>
  );
}
