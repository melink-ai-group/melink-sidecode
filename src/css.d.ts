/**
 * Host-side bundling treats a CSS import as text, so the source stylesheet can
 * be embedded in a webview that cannot load extension-relative CSS files.
 */
declare module '*.css' {
  const css: string;
  export default css;
}
