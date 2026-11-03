/**
 * jsdom (30.x) has HTMLDialogElement with `open`, but no showModal()/close().
 * This test-only stand-in opens the dialog like a browser does (and marks it as
 * modal, so tests can tell showModal() from show()) and fires `close`. It cannot
 * make the rest of the page inert or put the dialog in the top layer: modality,
 * focus containment and real Escape handling are verified in a real browser.
 * Not part of the application bundle (only imported by tests).
 */
export function installDialogPolyfill(): void {
  const proto = HTMLDialogElement.prototype as HTMLDialogElement & Record<string, unknown>;
  if (typeof proto.showModal === 'function' && !('testStandIn' in proto)) return;
  Object.defineProperty(proto, 'testStandIn', { configurable: true, value: true });
  Object.defineProperty(proto, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) {
      // Like the browser: a dialog that is already open or not in the document cannot be shown modally.
      if (this.hasAttribute('open') || !this.isConnected) throw new DOMException('Invalid dialog state', 'InvalidStateError');
      this.setAttribute('open', '');
      this.dataset.testModal = 'true';
    },
  });
  Object.defineProperty(proto, 'close', {
    configurable: true,
    value(this: HTMLDialogElement) {
      if (!this.hasAttribute('open')) return;
      this.removeAttribute('open');
      delete this.dataset.testModal;
      this.dispatchEvent(new Event('close'));
    },
  });
}
