/* Copy-to-clipboard for every `button[data-copy]`: the chain directory's
 * address rows and the donation addresses.
 *
 * The pages are fully server-rendered; this is the only behaviour that needs a
 * browser. It copies the value, shows the shared check glyph and `is-copied`
 * state for a moment, announces the result in `[data-copy-status]` and restores
 * the copy glyph. A page supplies `data-copy-label` when the status should name
 * the value. No key is read from or written to storage. */

const COPY_ICON = '/icons.svg#ui-copy';
const CHECK_ICON = '/icons.svg#ui-check';
const RESET_MS = 1600;

function announce(message: string): void {
  const region = document.querySelector<HTMLElement>('[data-copy-status]');
  if (region) region.textContent = message;
}

function flash(button: HTMLButtonElement, copied: boolean): void {
  const use = button.querySelector('use');
  const baseLabel = button.dataset.baseLabel ?? button.getAttribute('aria-label') ?? 'Copy';
  button.dataset.baseLabel = baseLabel;
  const baseTooltip =
    button.dataset.baseTooltip ?? button.getAttribute('data-tooltip') ?? baseLabel;
  button.dataset.baseTooltip = baseTooltip;
  const previous = use?.getAttribute('href') ?? COPY_ICON;
  if (use) use.setAttribute('href', copied ? CHECK_ICON : COPY_ICON);
  button.dataset.copied = copied ? 'true' : 'false';
  button.classList.toggle('is-copied', copied);
  button.setAttribute('aria-label', copied ? 'Copied' : baseLabel);
  button.setAttribute('data-tooltip', copied ? 'Copied' : baseTooltip);
  if (copied) {
    announce(`${button.dataset.copyLabel ?? 'Value'} copied`);
    window.setTimeout(() => {
      if (use) use.setAttribute('href', previous === CHECK_ICON ? COPY_ICON : previous);
      button.dataset.copied = 'false';
      button.classList.remove('is-copied');
      button.setAttribute('aria-label', baseLabel);
      button.setAttribute('data-tooltip', baseTooltip);
    }, RESET_MS);
  }
}

/* The async clipboard API is the only writer; the site is served over HTTPS,
 * and a denied permission falls back to the visible "select and copy" status
 * instead of a second, deprecated code path. */
async function copyText(value: string): Promise<void> {
  if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
  await navigator.clipboard.writeText(value);
}

document.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest<HTMLButtonElement>('button[data-copy]');
  if (!button) return;
  const value = button.dataset.copy ?? '';
  if (!value) return;
  copyText(value).then(
    () => flash(button, true),
    () => {
      flash(button, false);
      announce('Copy failed. Select the value and copy it manually.');
    },
  );
});
