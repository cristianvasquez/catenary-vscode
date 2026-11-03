// Send the card font scale to GLSP before the first model request so row geometry matches the font preference.

import { IActionDispatcher, IDiagramStartup, TYPES } from '@eclipse-glsp/client';
import { inject, injectable } from 'inversify';
import { FontPreferences } from './font-preferences';

import { SET_CARD_SCALE, type SetCardScaleAction } from '../common/protocol';

function setCardScaleAction(scale: number): SetCardScaleAction {
    return { kind: SET_CARD_SCALE, scale };
}

@injectable()
export class CardScaleStartup implements IDiagramStartup {
    @inject(TYPES.IActionDispatcher) protected readonly dispatcher!: IActionDispatcher;
    @inject(FontPreferences) protected readonly fonts!: FontPreferences;

    preRequestModel(): Promise<void> {
        return this.dispatcher.dispatch(setCardScaleAction(this.fonts.cardScale));
    }

    /** VS Code glue: ViewEditors of the Theia app sent the scale again on a change of the preference. */
    postModelInitialization(): void {
        this.fonts.onDidChange(() => void this.dispatcher.dispatch(setCardScaleAction(this.fonts.cardScale)));
    }
}
