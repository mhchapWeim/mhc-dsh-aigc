/**
 * Organization sign-in plugin, node half.
 *
 * The sign-in surface is a browser capability: it drives the `credentials`
 * Remote namespace and renders inside the settings shell. A Host process has
 * no renderer to attach it to, so this half installs nothing.
 */

/** Host plugin body — the dialog registers from the Client half. */
export function apply(): void {}
