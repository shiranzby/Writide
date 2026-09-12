import { EditorView, ViewPlugin } from '@codemirror/view';
import { searchNavigation } from './markdown-search-scroll.js';

// Hold image boxes while the native scrollbar owns the pointer. On release,
// anchor to a source block instead of the changing percentage of the document.
export const mediaScrollbarAnchor = ViewPlugin.fromClass(class {
  constructor(view) {
    this.view = view;
    this.surface = view.dom.closest('#typora-view') || view.scrollDOM;
    this.dragging = false;
    this.anchor = null;
    this.bottomIntent = false;
    this.widgets = new Set();
    this.boxes = new Map();
    this.cancel = () => { this.release(); this.anchor = null; this.bottomIntent = false; };
    this.down = event => {
      this.cancel();
      const rect = this.surface.getBoundingClientRect();
      const rail = Math.max(14, this.surface.offsetWidth - this.surface.clientWidth);
      if (event.button !== 0 || event.clientX < rect.right - rail || event.clientX > rect.right
          || event.clientY < rect.top || event.clientY > rect.bottom) return;
      this.dragging = true;
      const mounted = new Map([...view.dom.querySelectorAll('[data-live-type="image"]')].map(root => [Number(root.dataset.liveStart), root]));
      for (const decorations of view.state.facet(EditorView.decorations)) {
        if (typeof decorations === 'function') continue;
        for (let cursor = decorations.iter(); cursor.value; cursor.next()) {
          const widget = cursor.value.spec.widget;
          if (widget?.block?.type !== 'image') continue;
          const root = mounted.get(widget.block.startOffset);
          widget.dragHeight = root?.getBoundingClientRect().height || Math.max(1, widget.estimatedHeight);
          this.widgets.add(widget);
          if (root) this.freeze(root, widget);
        }
      }
    };
    this.up = event => {
      if (!this.dragging) return;
      const rect = this.surface.getBoundingClientRect();
      this.bottomIntent = event.clientY >= rect.bottom - 18 && event.clientX >= rect.right - 32 && event.clientX <= rect.right + 32;
      const block = view.lineBlockAtHeight(rect.top + 80 - view.documentTop);
      this.anchor = { from: block.from, offset: block.top + view.documentTop - rect.top };
      this.release();
      this.restore();
    };
    this.restore = () => {
      if (this.dragging || (!this.anchor && !this.bottomIntent) || view.destroyed) return;
      view.requestMeasure({ key: this,
        read: () => {
          if (this.dragging || view.plugin(searchNavigation)?.target) return 0;
          if (this.bottomIntent) return this.surface.scrollHeight - this.surface.clientHeight - this.surface.scrollTop;
          if (!this.anchor) return 0;
          return view.lineBlockAt(this.anchor.from).top + view.documentTop
            - this.surface.getBoundingClientRect().top - this.anchor.offset;
        },
        write: delta => { if (Math.abs(delta) > .5) this.surface.scrollTop += delta; },
      });
    };
    this.scroll = () => { if (this.bottomIntent) this.restore(); };
    this.surface.ownerDocument.addEventListener('pointerdown', this.down, true);
    this.surface.ownerDocument.addEventListener('pointerup', this.up, true);
    this.surface.ownerDocument.addEventListener('pointercancel', this.cancel, true);
    this.surface.ownerDocument.defaultView.addEventListener('blur', this.cancel);
    this.surface.addEventListener('keydown', this.cancel, true);
    this.surface.addEventListener('wheel', this.cancel, { passive: true });
    this.surface.addEventListener('touchstart', this.cancel, { passive: true });
    this.surface.addEventListener('scroll', this.scroll, { passive: true });
    this.resize = new ResizeObserver(this.restore);
    this.resize.observe(view.contentDOM);
  }

  freeze(root, widget) {
    if (!this.dragging || this.boxes.has(root)) return;
    if (!this.widgets.has(widget)) {
      widget.dragHeight = Math.max(1, widget.estimatedHeight);
      this.widgets.add(widget);
    }
    this.boxes.set(root, root.style.cssText);
    root.style.setProperty('height', widget.dragHeight + 'px', 'important');
    root.style.setProperty('min-height', '0', 'important');
    root.style.setProperty('overflow', 'hidden', 'important');
    if (widget.inline) root.style.display = 'inline-block';
    root.dataset.mediaFrozen = 'true';
  }

  release() {
    this.dragging = false;
    for (const widget of this.widgets) delete widget.dragHeight;
    for (const [root, style] of this.boxes) {
      root.style.cssText = style; delete root.dataset.mediaFrozen;
      if (root.isConnected) root.dispatchEvent(new Event('media-layout-released'));
    }
    this.widgets.clear(); this.boxes.clear();
  }

  update(update) {
    if (update.docChanged || update.selectionSet || update.transactions.some(tr => tr.reconfigured)) this.cancel();
    else if (update.geometryChanged) this.restore();
  }

  destroy() {
    this.cancel(); this.resize.disconnect();
    this.surface.ownerDocument.removeEventListener('pointerdown', this.down, true);
    this.surface.ownerDocument.removeEventListener('pointerup', this.up, true);
    this.surface.ownerDocument.removeEventListener('pointercancel', this.cancel, true);
    this.surface.ownerDocument.defaultView.removeEventListener('blur', this.cancel);
    this.surface.removeEventListener('keydown', this.cancel, true);
    this.surface.removeEventListener('wheel', this.cancel);
    this.surface.removeEventListener('touchstart', this.cancel);
    this.surface.removeEventListener('scroll', this.scroll);
  }
});
