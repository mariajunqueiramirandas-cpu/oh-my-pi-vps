/** Settings → Subscriptions: sign in with a plan you already pay for, from the phone. */
import { Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { LoginView, SubscriptionProvider } from "../../contract";
import { api, errorText } from "../api";
import { useResource } from "../hooks";
import { ErrorNotice, Field, Sheet } from "../ui";

const POLL_MS = 1200;

export function SubscriptionsSection(props: { onChanged(message: string): void }) {
	const providers = useResource(() => api.subscriptions.list(), []);
	const [picking, setPicking] = useState(false);
	const [signingIn, setSigningIn] = useState<SubscriptionProvider | null>(null);
	const [error, setError] = useState<string | null>(null);
	const signedIn = (providers.data ?? []).filter(provider => provider.accounts.length > 0);

	return (
		<section className="section">
			<h2>Subscriptions</h2>
			<p className="lead">
				Sign in with a plan you already pay for, such as Mistral Vibe, Claude Pro or Max, or ChatGPT. The login
				stays on your server; agents borrow it through the hub and never see its refresh token.
			</p>
			<ErrorNotice error={error ?? providers.error} />
			<ul className="list">
				{signedIn.flatMap(provider =>
					provider.accounts.map(account => (
						<li key={`${provider.id}-${account.credentialId}`}>
							<div className={`item ${account.disabled ? "s-failed" : "s-idle"}`}>
								<span className="stripe" aria-hidden="true" />
								<span className="main">
									<span className="title">{provider.name}</span>
									<span className="sub">
										<span>{account.label}</span>
										{account.disabled && <span className="state-word">Signed out by the provider</span>}
									</span>
								</span>
								<button
									type="button"
									className="btn danger"
									onClick={async () => {
										try {
											await api.subscriptions.remove(provider.provider, account.credentialId);
											await providers.reload();
											props.onChanged(`Signed out of ${provider.name}`);
										} catch (cause) {
											setError(errorText(cause));
										}
									}}
								>
									Sign out
								</button>
							</div>
						</li>
					)),
				)}
			</ul>
			<div className="row-actions">
				<button type="button" className="btn" onClick={() => setPicking(true)}>
					<Plus size={16} /> Sign in to a subscription
				</button>
			</div>
			{picking && providers.data && (
				<ProviderPicker
					providers={providers.data}
					onClose={() => setPicking(false)}
					onPick={provider => {
						setPicking(false);
						setSigningIn(provider);
					}}
				/>
			)}
			{signingIn && (
				<SignInSheet
					provider={signingIn}
					onClose={() => setSigningIn(null)}
					onDone={account => {
						setSigningIn(null);
						void providers.reload();
						props.onChanged(`Signed in to ${signingIn.name}${account ? ` as ${account}` : ""}`);
					}}
				/>
			)}
		</section>
	);
}

function ProviderPicker(props: {
	providers: SubscriptionProvider[];
	onClose(): void;
	onPick(provider: SubscriptionProvider): void;
}) {
	const [search, setSearch] = useState("");
	const visible = useMemo(() => {
		const query = search.trim().toLowerCase();
		return props.providers.filter(
			provider =>
				provider.available &&
				(!query || provider.name.toLowerCase().includes(query) || provider.id.toLowerCase().includes(query)),
		);
	}, [props.providers, search]);
	return (
		<Sheet title="Sign in to a subscription" onClose={props.onClose}>
			<Field label="Service">
				<input
					className="input"
					type="search"
					placeholder="Search, e.g. Mistral or Claude"
					value={search}
					onChange={event => setSearch(event.target.value)}
				/>
			</Field>
			<div className="picker" role="listbox" aria-label="Services">
				{visible.map(provider => (
					<button
						key={provider.id}
						type="button"
						role="option"
						aria-selected={false}
						onClick={() => props.onPick(provider)}
					>
						<span>{provider.name}</span>
						<span className="meta">
							{provider.accounts.length > 0 ? <span className="ready">Signed in</span> : ""}
						</span>
					</button>
				))}
			</div>
		</Sheet>
	);
}

function SignInSheet(props: { provider: SubscriptionProvider; onClose(): void; onDone(account: string | null): void }) {
	const [login, setLogin] = useState<LoginView | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [answer, setAnswer] = useState("");
	const [sending, setSending] = useState(false);

	useEffect(() => {
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const poll = async (id: string) => {
			try {
				const next = await api.logins.get(id);
				if (stopped) return;
				setLogin(next);
				if (next.status === "starting" || next.status === "waiting")
					timer = setTimeout(() => void poll(id), POLL_MS);
			} catch (cause) {
				if (!stopped) setError(errorText(cause));
			}
		};
		void api.logins.start(props.provider.id).then(
			started => {
				if (stopped) return;
				setLogin(started);
				timer = setTimeout(() => void poll(started.id), POLL_MS);
			},
			cause => setError(errorText(cause)),
		);
		return () => {
			stopped = true;
			clearTimeout(timer);
		};
	}, [props.provider.id]);

	const active = login?.status === "starting" || login?.status === "waiting";
	const close = () => {
		if (login && active) void api.logins.cancel(login.id).catch(() => {});
		props.onClose();
	};
	const send = async (value: string) => {
		if (!login?.input) return;
		setSending(true);
		setError(null);
		try {
			setLogin(await api.logins.answer(login.id, login.input.id, value));
			setAnswer("");
		} catch (cause) {
			setError(errorText(cause));
		} finally {
			setSending(false);
		}
	};

	return (
		<Sheet title={`Sign in to ${props.provider.name}`} onClose={close}>
			<ErrorNotice error={error} />
			{!login || login.status === "starting" ? <p className="note">Starting sign-in…</p> : null}

			{login?.status === "waiting" && login.url && (
				<div className="section">
					<p>Open the sign-in page, approve access, then come back here.</p>
					<a className="btn primary block" href={login.url} target="_blank" rel="noopener noreferrer">
						Open sign-in page
					</a>
					{login.instructions && <div className="notice">{login.instructions}</div>}
				</div>
			)}

			{login?.input && (
				<form
					onSubmit={event => {
						event.preventDefault();
						void send(answer.trim());
					}}
				>
					{login.input.kind === "confirm" ? (
						<>
							<p>{login.input.message}</p>
							<div className="row-actions">
								<button
									type="button"
									className="btn primary"
									disabled={sending}
									onClick={() => void send("yes")}
								>
									Yes
								</button>
								<button type="button" className="btn" disabled={sending} onClick={() => void send("no")}>
									No
								</button>
							</div>
						</>
					) : (
						<>
							<Field
								label={login.input.kind === "paste" ? "Address you ended on" : "Answer"}
								hint={login.input.message}
							>
								<input
									className={`input${login.input.kind === "paste" ? " mono" : ""}`}
									type={login.input.secret ? "password" : "text"}
									inputMode={login.input.kind === "paste" ? "url" : undefined}
									autoComplete="off"
									autoCapitalize="off"
									spellCheck={false}
									placeholder={login.input.placeholder ?? undefined}
									value={answer}
									onChange={event => setAnswer(event.target.value)}
								/>
							</Field>
							<button type="submit" className="btn primary block" disabled={sending || !answer.trim()}>
								Continue
							</button>
						</>
					)}
				</form>
			)}

			{active && login?.progress.length ? <p className="note">{login.progress.at(-1)}</p> : null}
			{active && login?.status === "waiting" && !login.input && login.progress.length === 0 && (
				<p className="note">Waiting for you to approve…</p>
			)}

			{login?.status === "done" && (
				<>
					<p>Signed in{login.account ? ` as ${login.account}` : ""}. New sessions can use this subscription.</p>
					<button type="button" className="btn primary block" onClick={() => props.onDone(login.account)}>
						Done
					</button>
				</>
			)}
			{(login?.status === "failed" || login?.status === "cancelled") && (
				<>
					<ErrorNotice error={login.error ?? "Sign-in did not finish."} />
					<button type="button" className="btn block" onClick={props.onClose}>
						Close
					</button>
				</>
			)}
			{active && (
				<div className="row-actions">
					<button type="button" className="btn" onClick={close}>
						Cancel sign-in
					</button>
				</div>
			)}
		</Sheet>
	);
}
