import { useState } from "react";
import { api, ApiError, errorText } from "../api";
import { ErrorNotice } from "../ui";

export function Login(props: { onSignedIn(token: string): void; reason?: string }) {
	const [token, setToken] = useState("");
	const [error, setError] = useState<string | null>(props.reason ?? null);
	const [busy, setBusy] = useState(false);

	const submit = async () => {
		const value = token.trim();
		if (!value) return;
		setBusy(true);
		setError(null);
		try {
			await api.info(value);
			props.onSignedIn(value);
		} catch (cause) {
			setError(
				cause instanceof ApiError && cause.status === 401
					? "That token is not valid on this hub."
					: errorText(cause),
			);
		} finally {
			setBusy(false);
		}
	};

	return (
		<main className="login">
			<h1>Sign in to your hub</h1>
			<p>
				Scan the QR code that <code>omp-hub pair</code> prints on your server, or paste the token it shows.
			</p>
			<form
				onSubmit={event => {
					event.preventDefault();
					void submit();
				}}
			>
				<label className="field">
					<span>Device token</span>
					<input
						className="input mono"
						autoComplete="off"
						autoCapitalize="off"
						spellCheck={false}
						placeholder="omph_…"
						value={token}
						onChange={event => setToken(event.target.value)}
					/>
				</label>
				<ErrorNotice error={error} />
				<button type="submit" className="btn primary block" disabled={busy || !token.trim()}>
					Sign in
				</button>
			</form>
		</main>
	);
}
