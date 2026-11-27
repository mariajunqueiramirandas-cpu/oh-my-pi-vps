import { Plus, RefreshCw } from "lucide-react";
import { useState } from "react";
import type { RepoView } from "../../contract";
import { api, errorText } from "../api";
import { useInterval, useResource, useToast } from "../hooks";
import { ErrorNotice, Field, relativeTime, Sheet, Toast, TopBar } from "../ui";

export function ReposPage() {
	const repos = useResource(() => api.repos.list(), []);
	const [adding, setAdding] = useState(false);
	const [selected, setSelected] = useState<RepoView | null>(null);
	const [toast, showToast] = useToast();
	const cloning = (repos.data ?? []).some(repo => repo.status === "cloning");
	useInterval(() => {
		if (cloning) void repos.reload();
	}, 2000);

	return (
		<>
			<TopBar
				title="Repositories"
				actions={
					<button type="button" className="btn primary" onClick={() => setAdding(true)}>
						<Plus size={18} /> Add
					</button>
				}
			/>
			<main className="page">
				<ErrorNotice error={repos.error} />
				{repos.data?.length === 0 && (
					<div className="empty">
						<p>Add a repository the agent may work on. The hub keeps a private mirror of it on the server.</p>
						<button type="button" className="btn primary" onClick={() => setAdding(true)}>
							Add a repository
						</button>
					</div>
				)}
				{repos.data && repos.data.length > 0 && (
					<ul className="list">
						{repos.data.map(repo => (
							<li key={repo.id}>
								<button
									type="button"
									className={`item ${repo.status === "error" ? "s-failed" : repo.status === "cloning" ? "s-busy" : "s-idle"}`}
									onClick={() => setSelected(repo)}
								>
									<span className="stripe" aria-hidden="true" />
									<span className="main">
										<span className="title">{repo.name}</span>
										<span className="sub">
											<span className="mono">{repo.url}</span>
										</span>
									</span>
									<span className="end">
										<span className="state-word">
											{repo.status === "cloning"
												? "Mirroring"
												: repo.status === "error"
													? "Failed"
													: repo.defaultBranch}
										</span>
										<br />
										{repo.fetchedAt ? relativeTime(repo.fetchedAt) : ""}
									</span>
								</button>
							</li>
						))}
					</ul>
				)}
			</main>
			{adding && (
				<AddRepo
					onClose={() => setAdding(false)}
					onAdded={() => {
						setAdding(false);
						void repos.reload();
					}}
				/>
			)}
			{selected && (
				<RepoSheet
					repo={selected}
					onClose={() => setSelected(null)}
					onChanged={message => {
						setSelected(null);
						showToast(message);
						void repos.reload();
					}}
				/>
			)}
			<Toast message={toast} />
		</>
	);
}

function AddRepo(props: { onClose(): void; onAdded(): void }) {
	const [url, setUrl] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const add = async () => {
		setBusy(true);
		setError(null);
		try {
			await api.repos.add(url.trim());
			props.onAdded();
		} catch (cause) {
			setError(errorText(cause));
		} finally {
			setBusy(false);
		}
	};
	return (
		<Sheet title="Add a repository" onClose={props.onClose}>
			<form
				onSubmit={event => {
					event.preventDefault();
					void add();
				}}
			>
				<Field
					label="Clone URL"
					hint="Private repositories use the server's own git credentials (an SSH key or credential helper for the hub's user)."
				>
					<input
						className="input mono"
						inputMode="url"
						autoCapitalize="off"
						spellCheck={false}
						placeholder="git@github.com:you/project.git"
						value={url}
						onChange={event => setUrl(event.target.value)}
					/>
				</Field>
				<ErrorNotice error={error} />
				<button type="submit" className="btn primary block" disabled={busy || !url.trim()}>
					Add repository
				</button>
			</form>
		</Sheet>
	);
}

function RepoSheet(props: { repo: RepoView; onClose(): void; onChanged(message: string): void }) {
	const [error, setError] = useState<string | null>(props.repo.error);
	const [busy, setBusy] = useState(false);
	const act = async (work: () => Promise<string>) => {
		setBusy(true);
		setError(null);
		try {
			props.onChanged(await work());
		} catch (cause) {
			setError(errorText(cause));
		} finally {
			setBusy(false);
		}
	};
	return (
		<Sheet title={props.repo.name} onClose={props.onClose}>
			<p className="mono">{props.repo.url}</p>
			<ErrorNotice error={error} />
			<div className="row-actions">
				<button
					type="button"
					className="btn"
					disabled={busy}
					onClick={() =>
						act(async () => {
							await api.repos.refresh(props.repo.id);
							return "Fetched latest changes";
						})
					}
				>
					<RefreshCw size={16} /> Fetch latest
				</button>
				<button
					type="button"
					className="btn danger"
					disabled={busy}
					onClick={() =>
						act(async () => {
							await api.repos.remove(props.repo.id);
							return "Repository removed";
						})
					}
				>
					Remove
				</button>
			</div>
		</Sheet>
	);
}
