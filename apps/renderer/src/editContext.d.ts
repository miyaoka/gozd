/**
 * EditContext API の型。TypeScript 同梱の lib.dom に無いため、gozd が使う範囲だけを宣言する。
 * lib.dom が取り込んだら消す。
 */
export {};

declare global {
  interface TextFormat {
    readonly rangeStart: number;
    readonly rangeEnd: number;
    readonly underlineStyle: "none" | "solid" | "dotted" | "dashed" | "wavy";
    readonly underlineThickness: "none" | "thin" | "thick";
  }

  interface TextUpdateEvent extends Event {
    readonly updateRangeStart: number;
    readonly updateRangeEnd: number;
    readonly text: string;
    readonly selectionStart: number;
    readonly selectionEnd: number;
  }

  interface TextFormatUpdateEvent extends Event {
    getTextFormats(): TextFormat[];
  }

  interface CharacterBoundsUpdateEvent extends Event {
    readonly rangeStart: number;
    readonly rangeEnd: number;
  }

  interface EditContextEventMap {
    textupdate: TextUpdateEvent;
    textformatupdate: TextFormatUpdateEvent;
    characterboundsupdate: CharacterBoundsUpdateEvent;
    compositionstart: CompositionEvent;
    compositionend: CompositionEvent;
  }

  interface EditContext extends EventTarget {
    readonly text: string;
    readonly selectionStart: number;
    readonly selectionEnd: number;
    updateText(rangeStart: number, rangeEnd: number, text: string): void;
    updateSelection(start: number, end: number): void;
    updateControlBounds(controlBounds: DOMRect): void;
    updateSelectionBounds(selectionBounds: DOMRect): void;
    updateCharacterBounds(rangeStart: number, characterBounds: DOMRect[]): void;
    addEventListener<K extends keyof EditContextEventMap>(
      type: K,
      listener: (this: EditContext, ev: EditContextEventMap[K]) => unknown,
      options?: boolean | AddEventListenerOptions,
    ): void;
    removeEventListener<K extends keyof EditContextEventMap>(
      type: K,
      listener: (this: EditContext, ev: EditContextEventMap[K]) => unknown,
      options?: boolean | EventListenerOptions,
    ): void;
  }

  var EditContext: {
    prototype: EditContext;
    new (init?: { text?: string; selectionStart?: number; selectionEnd?: number }): EditContext;
  };

  interface HTMLElement {
    editContext: EditContext | null;
  }
}
