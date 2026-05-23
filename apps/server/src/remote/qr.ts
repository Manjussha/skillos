/**
 * QR code generation (Layer 4).
 *
 * Renders the access URL (which carries the token) as a Unicode/ASCII QR code so
 * it shows directly in the xterm terminal — scan it with a phone to open the
 * mobile/browser client. Uses the `qrcode` package's terminal renderer.
 */

import QRCode from "qrcode";

/**
 * Build the access URL clients open. The token is carried in the URL fragment
 * (`#token=...`) rather than the query string so it is less likely to be logged
 * by intermediaries/proxies; the browser client reads it from `location.hash`.
 * For a WebSocket-only client we also accept it via the `auth` protocol message.
 */
export function accessUrl(baseUrl: string, token: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return `${trimmed}/#token=${token}`;
}

/**
 * Render a QR code for `text` as a string of Unicode half-blocks suitable for
 * writing into a terminal. `small: true` keeps it compact for xterm.
 */
export async function qrToTerminal(text: string): Promise<string> {
  return QRCode.toString(text, {
    type: "terminal",
    small: true,
    errorCorrectionLevel: "M",
  });
}
