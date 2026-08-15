import { useId, useState } from "react";

/**
 * Pure and props-driven: no fetching, no effects, no clock. It knows nothing
 * about sessions — the cookie the backend sets is httpOnly, so this component
 * could not read it even if it wanted to. Its whole job is collecting a token
 * and handing it up.
 *
 * The error string is rendered as a React child, so React escapes it. Nothing
 * here may use dangerouslySetInnerHTML — the message can originate from a
 * server response and must never be treated as markup.
 */
export function LoginGate(props: {
  /** Called with the trimmed token; never called for an empty one. */
  onSubmit: (token: string) => void;
  /** e.g. "That token was not accepted." */
  error?: string;
  /** A login is in flight. */
  busy?: boolean;
}): JSX.Element {
  const { onSubmit, error, busy = false } = props;
  const [token, setToken] = useState("");
  const fieldId = useId();

  function submit(e: React.FormEvent) {
    // A real form submit, so Enter in the field works and not only the button.
    e.preventDefault();
    if (busy) return;
    // Tokens are pasted far more often than typed, and a paste routinely
    // carries a trailing newline or space that would fail a byte-exact compare.
    const trimmed = token.trim();
    if (trimmed === "") return;
    onSubmit(trimmed);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-4 text-slate-900">
      <div className="w-[min(24rem,100%)] rounded-lg border border-slate-300 bg-white p-5 shadow-sm">
        <h1 className="text-lg font-semibold">Agent Team Dashboard</h1>
        {/* A bare token box tells a teammate nothing about what they are
            logging into or which secret is wanted. */}
        <p className="mt-2 text-sm text-slate-600">
          This dashboard is protected by a shared access token. Enter the token
          your team configured to see agent activity.
        </p>

        <form onSubmit={submit} className="mt-4">
          <label htmlFor={fieldId} className="block text-sm font-medium text-slate-700">
            Access token
          </label>
          <input
            id={fieldId}
            // Masked: a dashboard is often on a shared or projected screen, and
            // the token is the whole lock.
            type="password"
            value={token}
            disabled={busy}
            autoComplete="current-password"
            onChange={(e) => setToken(e.target.value)}
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm disabled:bg-slate-100 disabled:text-slate-400"
          />

          {error !== undefined && (
            <p
              role="alert"
              className="mt-3 break-words rounded border border-red-300 bg-red-50 px-2 py-1 text-sm text-red-800"
            >
              {error}
            </p>
          )}

          <div className="mt-4 flex items-center gap-2">
            <button
              type="submit"
              disabled={busy}
              className="rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:bg-slate-300"
            >
              Sign in
            </button>

            {busy && (
              <span
                role="status"
                aria-label="Signing in…"
                className="inline-flex items-center gap-1 text-xs text-slate-500"
              >
                <span
                  aria-hidden="true"
                  className="h-2 w-2 animate-pulse rounded-full bg-slate-400"
                />
                signing in…
              </span>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

export default LoginGate;
