/**
 * Host half of `@local/dsh-pinned-top`.
 *
 * The visible change is purely a Client-side fork of the workspace browser, which
 * ships through exports["./client"]; this Host row exists so the Loader has an
 * entry to resolve the package and serve its browser bundle.
 */
export function apply() {}
