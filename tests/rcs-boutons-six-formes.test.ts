import { describe, it, expect } from 'vitest';
import { rcsSuggestionSchema, rcsOutboundSchema } from '../src/rcs/schema';
import { toSmsmodeBody } from '../src/rcs/smsmode';
import { appliquerVariables, variablesDe, elaguerBoutonsInvalides } from '../src/rcs/variables';
import type { RcsOutbound, RcsSuggestion } from '../src/rcs/types';
import { nouveauBouton, boutonPret, boutonsDepuisNode, ouvreUneSortie, KINDS_BOUTON } from '../web/lib/rcs-boutons';

const AGENDA: RcsSuggestion = {
  kind: 'calendar', text: 'Ajouter a mon agenda', postbackData: 'cal',
  title: 'Votre rendez-vous', startAt: '2026-09-01T10:00', endAt: '2026-09-01T11:00',
};
const LIEU: RcsSuggestion = {
  kind: 'showLocation', text: 'Voir l agence', postbackData: 'loc',
  latitude: 48.8566, longitude: 2.3522, label: 'Agence Paris',
};
const POSITION: RcsSuggestion = { kind: 'requestLocation', text: 'Envoyer ma position', postbackData: 'pos' };

describe('Les six formes de bouton : modele et validation', () => {
  it('accepte les trois nouvelles formes', () => {
    for (const b of [AGENDA, LIEU, POSITION]) {
      expect(rcsSuggestionSchema.safeParse(b).success).toBe(true);
    }
  });

  it('REFUSE ce que le provider refuserait', () => {
    // Une latitude hors bornes, un titre absent, une date qui n'en est pas une : autant de 400 a l'envoi.
    expect(rcsSuggestionSchema.safeParse({ ...LIEU, latitude: 91 }).success).toBe(false);
    expect(rcsSuggestionSchema.safeParse({ ...AGENDA, title: '' }).success).toBe(false);
    expect(rcsSuggestionSchema.safeParse({ ...AGENDA, startAt: 'demain matin' }).success).toBe(false);
    // Libelle : 25 caracteres, sur les six formes.
    expect(rcsSuggestionSchema.safeParse({ ...POSITION, text: 'x'.repeat(26) }).success).toBe(false);
  });

  it('accepte une VARIABLE comme date de rendez-vous', () => {
    expect(rcsSuggestionSchema.safeParse({ ...AGENDA, startAt: '{{date_rdv}}', endAt: '{{fin_rdv}}' }).success).toBe(true);
  });

  // 🔴 Les noms de champs sont ceux de leur spec, relue a la source : `startTime`/`endTime` et non nos
  // `startAt`/`endAt`, `SHOW_LOCATION` et non `LOCATION`. Une faute ici ne se verrait qu'au premier envoi.
  it('mappe les six formes au format exact de smsmode', () => {
    const msg: RcsOutbound = {
      kind: 'text',
      text: 'Bonjour',
      suggestions: [
        { kind: 'reply', text: 'Oui', postbackData: 'btn:0' },
        { kind: 'openUrl', text: 'Site', url: 'https://messagingme.app', postbackData: 'url' },
        { kind: 'dial', text: 'Appeler', phoneNumber: '+33100000000', postbackData: 'tel' },
        AGENDA, LIEU, POSITION,
      ],
    };
    expect(toSmsmodeBody(msg)).toEqual({
      type: 'TEXT',
      text: 'Bonjour',
      suggestions: [
        { type: 'REPLY', text: 'Oui', postbackData: 'btn:0' },
        { type: 'OPEN_URL', text: 'Site', postbackData: 'url', url: 'https://messagingme.app' },
        { type: 'DIAL_PHONE', text: 'Appeler', postbackData: 'tel', phoneNumber: '+33100000000' },
        {
          type: 'CREATE_CALENDAR_EVENT', text: 'Ajouter a mon agenda', postbackData: 'cal',
          startTime: '2026-09-01T10:00', endTime: '2026-09-01T11:00', title: 'Votre rendez-vous',
        },
        {
          type: 'SHOW_LOCATION', text: 'Voir l agence', postbackData: 'loc',
          latitude: 48.8566, longitude: 2.3522, label: 'Agence Paris',
        },
        { type: 'REQUEST_LOCATION', text: 'Envoyer ma position', postbackData: 'pos' },
      ],
    });
  });
});

describe('Rendez-vous propre a chaque contact', () => {
  it('compte les dates d agenda parmi les variables du message', () => {
    const msg: RcsOutbound = {
      kind: 'text', text: 'Bonjour',
      suggestions: [{ ...AGENDA, startAt: '{{date_rdv}}', endAt: '{{fin_rdv}}' }],
    };
    // 🔴 Sans cette prise en compte, un message dont la SEULE variable est une date ne declencherait aucune
    // resolution et partirait avec ses accolades dans un champ date : le provider refuserait TOUT le message.
    expect(variablesDe(msg)).toEqual(['date_rdv', 'fin_rdv']);
  });

  it('resout les dates depuis la fiche du contact', () => {
    const rendu = appliquerVariables(
      { kind: 'text', text: 'Bonjour', suggestions: [{ ...AGENDA, startAt: '{{date_rdv}}', endAt: '{{fin_rdv}}' }] },
      { date_rdv: '2026-09-01T10:00', fin_rdv: '2026-09-01T11:00' },
    );
    expect(rendu).toEqual({
      kind: 'text', text: 'Bonjour',
      suggestions: [{ ...AGENDA, startAt: '2026-09-01T10:00', endAt: '2026-09-01T11:00' }],
    });
  });

  // 🔴 LA garantie du canal : un message part TOUJOURS. Un contact sans rendez-vous perd le bouton, pas le
  // message. Sans cet elagage, le provider refuserait l'envoi entier pour une date restee `{{date_rdv}}`.
  it('retire le bouton dont la date ne s est pas resolue, et garde le message', () => {
    const rendu = appliquerVariables(
      { kind: 'text', text: 'Bonjour', suggestions: [{ ...AGENDA, startAt: '{{date_rdv}}', endAt: '{{fin_rdv}}' }, POSITION] },
      {},
    );
    expect(elaguerBoutonsInvalides(rendu)).toEqual({ kind: 'text', text: 'Bonjour', suggestions: [POSITION] });
  });

  it('retire la CLE suggestions quand il ne reste plus aucun bouton', () => {
    const elague = elaguerBoutonsInvalides({
      kind: 'text', text: 'Bonjour', suggestions: [{ ...AGENDA, startAt: '{{absent}}' }],
    });
    expect(elague).toEqual({ kind: 'text', text: 'Bonjour' });
    expect('suggestions' in elague).toBe(false);
    expect(rcsOutboundSchema.safeParse(elague).success).toBe(true);
  });

  it('elague aussi les boutons d une carte', () => {
    const elague = elaguerBoutonsInvalides({
      kind: 'card',
      card: { description: 'Offre', mediaUrl: 'https://x/i.png', suggestions: [{ ...AGENDA, endAt: '{{absent}}' }] },
      suggestions: [AGENDA],
    });
    expect(elague).toEqual({
      kind: 'card',
      card: { description: 'Offre', mediaUrl: 'https://x/i.png' },
      suggestions: [AGENDA],
    });
  });

  it('ne touche a RIEN quand toutes les dates sont valables', () => {
    const msg: RcsOutbound = { kind: 'text', text: 'Bonjour', suggestions: [AGENDA] };
    expect(elaguerBoutonsInvalides(msg)).toBe(msg); // meme reference : aucune copie inutile
  });
});

describe('Les six formes, cote ecran', () => {
  it('fabrique chaque forme COMPLETE en structure, en gardant le libelle', () => {
    for (const k of KINDS_BOUTON) {
      const b = nouveauBouton(k, { text: 'Mon bouton', postbackData: 'p' });
      expect(b.kind).toBe(k);
      expect(b.text).toBe('Mon bouton');
    }
    expect(nouveauBouton('calendar', { text: 'x', postbackData: 'p' })).toEqual({
      kind: 'calendar', text: 'x', postbackData: 'p', title: '', startAt: '', endAt: '',
    });
  });

  it('sait dire si un bouton est complet, forme par forme', () => {
    expect(boutonPret(AGENDA)).toBe(true);
    expect(boutonPret({ ...AGENDA, startAt: '' })).toBe(false);
    expect(boutonPret({ ...AGENDA, title: '' })).toBe(false);
    expect(boutonPret(LIEU)).toBe(true);
    expect(boutonPret({ ...LIEU, latitude: Number.NaN })).toBe(false);
    expect(boutonPret(POSITION)).toBe(true);
    expect(boutonPret({ ...POSITION, text: '  ' })).toBe(false);
  });

  it('seul « Reponse » ouvre une sortie de scenario', () => {
    expect(ouvreUneSortie({ kind: 'reply' })).toBe(true);
    for (const k of ['openUrl', 'dial', 'calendar', 'showLocation', 'requestLocation']) {
      expect(ouvreUneSortie({ kind: k })).toBe(false);
    }
  });

  // Un bloc de scenario stocke ses boutons en JSON libre : une forme inconnue ne doit pas faire planter le
  // panneau, elle redevient un bouton reparable en un clic.
  it('relit du JSON libre sans jamais planter', () => {
    expect(boutonsDepuisNode(null)).toEqual([]);
    expect(boutonsDepuisNode('pas un tableau')).toEqual([]);
    expect(boutonsDepuisNode([{ kind: 'inconnu', text: 'Oui' }])).toEqual([
      { kind: 'reply', text: 'Oui', postbackData: '' },
    ]);
    expect(boutonsDepuisNode([{ kind: 'calendar', text: 'RDV', postbackData: 'c', title: 'T', startAt: 'a', endAt: 'b' }])).toEqual([
      { kind: 'calendar', text: 'RDV', postbackData: 'c', title: 'T', startAt: 'a', endAt: 'b' },
    ]);
    expect(boutonsDepuisNode([{ kind: 'showLocation', text: 'Ici', postbackData: 'l', latitude: 1, longitude: 2 }])).toEqual([
      { kind: 'showLocation', text: 'Ici', postbackData: 'l', latitude: 1, longitude: 2 },
    ]);
  });

  it('ce que l ecran fabrique passe la validation SERVEUR', () => {
    for (const k of KINDS_BOUTON) {
      const b = nouveauBouton(k, { text: 'Mon bouton', postbackData: 'p' });
      // Un bouton neuf n'est pas encore complet (URL vide, dates vides) : c'est `boutonPret` qui bloque
      // l'enregistrement. Une fois rempli, il doit passer.
      const rempli = k === 'openUrl' ? { ...b, url: 'https://x.test' }
        : k === 'dial' ? { ...b, phoneNumber: '+33100000000' }
          : k === 'calendar' ? { ...b, title: 'T', startAt: '2026-09-01T10:00', endAt: '2026-09-01T11:00' }
            : b;
      expect(boutonPret(rempli as RcsSuggestion)).toBe(true);
      expect(rcsSuggestionSchema.safeParse(rempli).success).toBe(true);
    }
  });
});
