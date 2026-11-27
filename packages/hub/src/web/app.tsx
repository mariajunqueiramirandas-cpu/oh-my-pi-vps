import { FolderGit2, MessagesSquare, Settings } from "lucide-react";
import { useEffect, useState } from "react";
import { api, clearToken, readToken, setUnauthorizedHandler, signInWith, takeTokenFromLocation } from "./api";
import { useInterval, useResource, useRoute } from "./hooks";
import { EnvironmentsPage } from "./pages/environments";
import { Login } from "./pages/login";
import { ReposPage } from "./pages/repos";
import { SessionPage } from "./pages/session";
import { SessionsPage } from "./pages/sessions";
import { SettingsPage } from "./pages/settings";

export function App() {
	const [signedIn, setSignedIn] = useState(() => {
		const fromLink = takeTokenFromLocation();
		if (fromLink) signInWith(fromLink);
		return Boolean(readToken());
	});
	const [reason, setReason] = useState<string | undefined>();

	useEffect(() => {
		setUnauthorizedHandler(() => {
			clearToken();
			setReason("This device was signed out. Sign in again with a token from your server.");
			setSignedIn(false);
		});
		// A pairing link opened while the app is already loaded only changes the hash.
		const onHash = () => {
			const token = takeTokenFromLocation();
			if (!token) return;
			signInWith(token);
			setReason(undefined);
			setSignedIn(true);
		};
		window.addEventListener("hashchange", onHash);
		return () => window.removeEventListener("hashchange", onHash);
	}, []);

	if (!signedIn) {
		return (
			<Login
				reason={reason}
				onSignedIn={token => {
					signInWith(token);
					setReason(undefined);
					setSignedIn(true);
					window.location.hash = "#/";
				}}
			/>
		);
	}
	return <SignedIn onSignOut={() => setSignedIn(false)} />;
}

function SignedIn(props: { onSignOut(): void }) {
	const route = useRoute();
	const [section, id] = route;
	const path = route.join("/");
	// Hash navigation keeps the old scroll position; every screen should open at its top.
	useEffect(() => {
		window.scrollTo(0, 0);
	}, [path]);
	const sessions = useResource(() => api.sessions.list(), []);
	useInterval(() => void sessions.reload(), 10_000);
	const waiting = (sessions.data ?? []).some(session => session.status === "waiting");

	if (section === "sessions" && id) return <SessionPage key={id} id={id} />;

	const current = section ?? "sessions";
	let page: React.JSX.Element;
	switch (current) {
		case "repos":
			page = <ReposPage />;
			break;
		case "settings":
			page = <SettingsPage onSignOut={props.onSignOut} />;
			break;
		case "environments":
			page = <EnvironmentsPage />;
			break;
		default:
			page = <SessionsPage />;
	}
	const tab = current === "environments" ? "settings" : current;
	return (
		<div className="shell">
			{page}
			<nav className="bottom-nav" aria-label="Main">
				<a href="#/" aria-current={tab === "sessions" ? "page" : undefined}>
					<MessagesSquare size={22} />
					{waiting && <span className="dot" aria-label="A session needs you" />}
					Sessions
				</a>
				<a href="#/repos" aria-current={tab === "repos" ? "page" : undefined}>
					<FolderGit2 size={22} />
					Repositories
				</a>
				<a href="#/settings" aria-current={tab === "settings" ? "page" : undefined}>
					<Settings size={22} />
					Settings
				</a>
			</nav>
		</div>
	);
}
