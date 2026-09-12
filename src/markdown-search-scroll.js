import { EditorView, ViewPlugin } from '@codemirror/view';

// An explicit search remains the scroll anchor while asynchronous media loads.
// Any subsequent user navigation cancels it; ordinary editing never uses it.
export const searchNavigation = ViewPlugin.fromClass(class {
  constructor(view) {
    this.target = null;
    this.surface = view.dom.closest('#typora-view') || view.scrollDOM;
    this.cancel = () => { this.target = null; };
    this.keydown = event => {
      if (event.key !== 'Escape' && !event.target.closest('.cm-search')) this.cancel();
    };
    this.surface.addEventListener('wheel', this.cancel, { passive: true });
    this.surface.addEventListener('pointerdown', this.cancel, true);
    this.surface.addEventListener('keydown', this.keydown, true);
  }

  update(update) {
    if (update.transactions.some(tr => tr.isUserEvent('select.search') || tr.isUserEvent('select.outline'))) {
      this.target = update.state.selection.main;
    } else if (update.docChanged || update.transactions.some(tr => tr.reconfigured)
      || (this.target && update.selectionSet && !update.state.selection.main.eq(this.target))) {
      this.cancel();
    }
  }

  destroy() {
    this.surface.removeEventListener('wheel', this.cancel);
    this.surface.removeEventListener('pointerdown', this.cancel, true);
    this.surface.removeEventListener('keydown', this.keydown, true);
  }
});

export function measureLoadedPreview(view) {
  view.requestMeasure({
    key: searchNavigation,
    read: () => {
      const navigation = view.plugin(searchNavigation);
      const target = navigation?.target;
      if (!target) return null;
      const caret = view.coordsAtPos(target.head);
      const surface = navigation.surface.getBoundingClientRect();
      return caret && (caret.top < surface.top || caret.bottom > surface.bottom) ? target : null;
    },
    write: target => {
      if (!target) return;
      queueMicrotask(() => {
        if (!view.destroyed && view.plugin(searchNavigation)?.target === target) {
          view.dispatch({ effects: EditorView.scrollIntoView(target, { y: 'center' }) });
        }
      });
    },
  });
}
