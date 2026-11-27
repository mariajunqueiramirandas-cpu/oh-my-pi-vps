import { Plus } from "lucide-react";
import { useState } from "react";
import type { SessionStatus, SessionView } from "../../contract";
import { api, errorText } from "../api";
import { navigate, useInterval, useResource } from "../hooks";
import { ErrorNotice, Field, relativeTime, Sheet, statusWord, TopBar } from "../ui";

const GROUPS: Array<{ title: string; statuses: SessionStatus[] }> = [
	{ title: "Needs you", statuses: ["waiting"] },
	{ title: "Working", statuses: ["provisioning", "starting", "busy", "stopping"] },
	{ title: "Ready", statuses: ["idle"] },
	{ title: "Stopped", statuses: ["stopped", "failed"] },
];

export function SessionRow(props: { session: SessionView }) {
	const { session } = props;
	return (
		<a className={`item s-${session.status}`} href={`#/sessions/${session.id}`}>
			<span className="stripe" aria-hidden="true" />
			<span className="main">
				<span className="title">{session.title ?? session.branch}</span>
				<span className="sub">
					<span>{session.repoName}</span>
					<span className="mono">{session.branch}</span>
				</span>
			</span>
			<span className="end">
				<span className="state-word">{statusWord(session.status)}</span>
				<br />
				{relativeTime(session.lastActivityAt)}
			</span>
		</a>
	);
}

export function SessionsPage() {
	const sessions = useResource(() => api.sessions.list(), []);
	const [creating, setCreating] = useState(false);
	useInterval(() => void sessions.reload(), 5000);

	const list = sessions.data ?? [];
	return (
		<>
			<TopBar
				title="Sessions"
				actions={
					<button type="button" className="btn primary" onClick={() => setCreating(true)}>
						<Plus size={18} /> New
					</button>
				}
			/>
			<main className="page">
				<ErrorNotice error={sessions.error} />
				{sessions.data && list.length === 0 && (
					<div className="empty">
						<p>No sessions yet. Start one to put an agent to work on a repository.</p>
						<button type="button" className="btn primary" onClick={() => setCreating(true)}>
							New session
						</button>
					</div>
				)}
				{GROUPS.map(group => {
					const members = list.filter(session => group.statuses.includes(session.status));
					if (members.length === 0) return null;
					return (
						<section key={group.title}>
							<h2 className="group-title">{group.title}</h2>
							<ul className="list">
								{members.map(session => (
									<li key={session.id}>
										<SessionRow session={session} />
									</li>
								))}
							</ul>
						</section>
					);
				})}
			</main>
			{creating && <NewSession onClose={() => setCreating(false)} />}
		</>
	);
}

function NewSession(props: { onClose(): void }) {
	const repos = useResource(() => api.repos.list(), []);
	const environments = useResource(() => api.environments.list(), []);
	const ready = (repos.data ?? []).filter(repo => repo.status === "ready");
	const [repoId, setRepoId] = useState("");
	const [environmentId, setEnvironmentId] = useState("default");
	const [title, setTitle] = useState("");
	const [baseRef, setBaseRef] = useState("");
	const [model, setModel] = useState("");
	const [prompt, setPrompt] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const repo = ready.find(item => item.id === repoId) ?? ready[0];

	const create = async () => {
		if (!repo) return;
		setBusy(true);
		setError(null);
		try {
			const session = await api.sessions.create({
				repoId: repo.id,
				environmentId,
				...(title.trim() ? { title: title.trim() } : {}),
				...(baseRef.trim() ? { baseRef: baseRef.trim() } : {}),
				...(model.trim() ? { model: model.trim() } : {}),
				...(prompt.trim() ? { prompt: prompt.trim() } : {}),
			});
			props.onClose();
			navigate(`/sessions/${session.id}`);
		} catch (cause) {
			setError(errorText(cause));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Sheet title="New session" onClose={props.onClose}>
			{repos.data && ready.length === 0 ? (
				<div className="empty">
					<p>Add a repository first. The agent works on a copy of it on its own branch.</p>
					<a className="btn primary" href="#/repos" onClick={props.onClose}>
						Add a repository
					</a>
				</div>
			) : (
				<form
					onSubmit={event => {
						event.preventDefault();
						void create();
					}}
				>
					<Field label="Repository">
						<select className="select" value={repo?.id ?? ""} onChange={event => setRepoId(event.target.value)}>
							{ready.map(item => (
								<option key={item.id} value={item.id}>
									{item.name}
								</option>
							))}
						</select>
					</Field>
					<Field label="What should the agent do?" hint="Sent as the first message as soon as the agent is ready.">
						<textarea
							className="textarea"
							placeholder="Fix the flaky login test and explain the cause"
							value={prompt}
							onChange={event => setPrompt(event.target.value)}
						/>
					</Field>
					<Field label="Title" hint="Also names the branch.">
						<input
							className="input"
							placeholder="Fix login test"
							value={title}
							onChange={event => setTitle(event.target.value)}
						/>
					</Field>
					<Field label="Start from branch">
						<input
							className="input mono"
							autoCapitalize="off"
							placeholder={repo?.defaultBranch ?? "main"}
							value={baseRef}
							onChange={event => setBaseRef(event.target.value)}
						/>
					</Field>
					<Field label="Environment">
						<select
							className="select"
							value={environmentId}
							onChange={event => setEnvironmentId(event.target.value)}
						>
							{(environments.data ?? []).map(environment => (
								<option key={environment.id} value={environment.id}>
									{environment.id}
									{environment.definition.description ? ` (${environment.definition.description})` : ""}
								</option>
							))}
						</select>
					</Field>
					<Field label="Model" hint="Leave empty to use the default from Settings.">
						<input
							className="input mono"
							autoCapitalize="off"
							placeholder="provider/model-id"
							value={model}
							onChange={event => setModel(event.target.value)}
						/>
					</Field>
					<ErrorNotice error={error} />
					<button type="submit" className="btn primary block" disabled={busy || !repo}>
						Start session
					</button>
				</form>
			)}
		</Sheet>
	);
}
