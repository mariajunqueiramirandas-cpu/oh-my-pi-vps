import { Plus } from "lucide-react";
import { useState } from "react";
import type { EnvironmentView } from "../../contract";
import { api, errorText } from "../api";
import { useInterval, useResource, useToast } from "../hooks";
import { ErrorNotice, Field, Sheet, Toast, TopBar } from "../ui";

const TEMPLATE = {
	description: "Node 22 with pnpm",
	dockerfile: "FROM oh-my-pi/pi:dev\nRUN npm install -g pnpm\n",
	resources: { memory: "4g", cpus: 2 },
	setup: ["pnpm install"],
};

export function EnvironmentsPage() {
	const environments = useResource(() => api.environments.list(), []);
	const [open, setOpen] = useState<EnvironmentView | "new" | null>(null);
	const [toast, showToast] = useToast();
	const building = (environments.data ?? []).some(environment => environment.build.status === "building");
	useInterval(() => {
		if (building) void environments.reload();
	}, 3000);

	return (
		<>
			<TopBar
				title="Environments"
				back="/settings"
				actions={
					<button type="button" className="btn primary" onClick={() => setOpen("new")}>
						<Plus size={18} /> Add
					</button>
				}
			/>
			<main className="page">
				<p className="notice">
					An environment is the container image and limits an agent runs in. Environments from your server's
					hub.yaml are read-only here; ones you add here cannot mount server folders.
				</p>
				<ErrorNotice error={environments.error} />
				<ul className="list">
					{(environments.data ?? []).map(environment => (
						<li key={environment.id}>
							<button
								type="button"
								className={`item ${environment.build.status === "error" ? "s-failed" : environment.build.status === "building" ? "s-busy" : "s-idle"}`}
								onClick={() => setOpen(environment)}
							>
								<span className="stripe" aria-hidden="true" />
								<span className="main">
									<span className="title">{environment.id}</span>
									<span className="sub">
										{environment.definition.description && <span>{environment.definition.description}</span>}
										<span className="mono">{environment.image}</span>
									</span>
								</span>
								<span className="end">{environment.source === "config" ? "hub.yaml" : "Added here"}</span>
							</button>
						</li>
					))}
				</ul>
			</main>
			{open && (
				<EnvironmentSheet
					environment={open === "new" ? null : open}
					onClose={() => setOpen(null)}
					onChanged={message => {
						showToast(message);
						void environments.reload();
					}}
				/>
			)}
			<Toast message={toast} />
		</>
	);
}

function EnvironmentSheet(props: {
	environment: EnvironmentView | null;
	onClose(): void;
	onChanged(message: string): void;
}) {
	const { environment } = props;
	const editable = environment === null || environment.source === "api";
	const [id, setId] = useState(environment?.id ?? "");
	const [text, setText] = useState(JSON.stringify(environment?.definition ?? TEMPLATE, null, 2));
	const [error, setError] = useState<string | null>(null);
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

	const save = () =>
		act(async () => {
			let definition: Record<string, unknown>;
			try {
				definition = JSON.parse(text) as Record<string, unknown>;
			} catch {
				throw new Error("The definition is not valid JSON.");
			}
			await api.environments.put(id.trim(), definition);
			props.onClose();
			return `Saved ${id.trim()}`;
		});

	return (
		<Sheet title={environment ? environment.id : "Add an environment"} onClose={props.onClose}>
			{!environment && (
				<Field label="Name" hint="Lowercase letters, numbers, dashes.">
					<input
						className="input mono"
						autoCapitalize="off"
						value={id}
						onChange={event => setId(event.target.value)}
					/>
				</Field>
			)}
			<Field
				label="Definition"
				hint="image or dockerfile, resources, network, env, secrets, mounts (named volumes), setup, settings."
			>
				<textarea
					className="textarea code"
					spellCheck={false}
					readOnly={!editable}
					value={text}
					onChange={event => setText(event.target.value)}
				/>
			</Field>
			{environment && environment.build.status !== "idle" && (
				<>
					<p className="note">
						Image build: {environment.build.status}
						{environment.build.error ? `: ${environment.build.error}` : ""}
					</p>
					{environment.build.log.length > 0 && <div className="log">{environment.build.log.join("\n")}</div>}
				</>
			)}
			<ErrorNotice error={error} />
			<div className="row-actions">
				{editable && (
					<button type="button" className="btn primary" disabled={busy || !id.trim()} onClick={() => void save()}>
						Save environment
					</button>
				)}
				{environment &&
					(environment.definition.dockerfile !== undefined || environment.definition.build !== undefined) && (
						<button
							type="button"
							className="btn"
							disabled={busy}
							onClick={() =>
								act(async () => {
									await api.environments.build(environment.id);
									return "Build started";
								})
							}
						>
							Rebuild image
						</button>
					)}
				{environment?.source === "api" && (
					<button
						type="button"
						className="btn danger"
						disabled={busy}
						onClick={() =>
							act(async () => {
								await api.environments.remove(environment.id);
								props.onClose();
								return `Removed ${environment.id}`;
							})
						}
					>
						Remove
					</button>
				)}
			</div>
		</Sheet>
	);
}
