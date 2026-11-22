/* Copy-to-clipboard for the chain directory's address rows.
 *
 * The page is fully server-rendered; this is the only behaviour that needs a
 * browser. It copies the address, shows the shared check glyph for a moment and
 * restores the copy glyph. No key is read from or written to storage. */

const COPY_ICON = '/icons.svg#ui-copy';
const CHECK_ICON = '/icons.svg#ui-check';
const RESET_MS = 1600;

function flash(button: HTMLButtonElement, copied: boolean) {
  const use = button.querySelector('use');
  const baseLabel = button.dataset.baseLabel ?? button.getAttribute('aria-label') ?? 'Copy';
  button.dataset.baseLabel = baseLabel;
  const previous = use?.getAttribute('href') ?? COPY_ICON;
  if (use) use.setAttribute('href', copied ? CHECK_ICON : COPY_ICON);
  button.dataset.copied = copied ? 'true' : 'false';
  button.setAttribute('aria-label', copied ? 'Copied' : baseLabel);
  if (copied) {
    window.setTimeout(() => {
      if (use) use.setAttribute('href', previous === CHECK_ICON ? COPY_ICON : previous);
      button.dataset.copied = 'false';
      button.setAttribute('aria-label', baseLabel);
    }, RESET_MS);
  }
}

document.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest<HTMLButtonElement>('button[data-copy]');
  if (!button) return;
  const value = button.dataset.copy ?? '';
  if (!value || !navigator.clipboard?.writeText) return;
  navigator.clipboard.writeText(value).then(
    () => flash(button, true),
    () => flash(button, false),
  );
});
