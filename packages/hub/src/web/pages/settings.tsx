import { Plus } from "lucide-react";
import { useMemo, useState } from "react";
import type { AgentProfile, ProviderInfo, RuleFile } from "../../contract";
import { api, clearToken, errorText } from "../api";
import { useResource, useToast } from "../hooks";
import { ErrorNotice, Field, relativeTime, Sheet, Toast, TopBar } from "../ui";
import { SubscriptionsSection } from "./subscriptions";

type Patch = Partial<Omit<AgentProfile, "updatedAt">>;

export function SettingsPage(props: { onSignOut(): void }) {
	const profile = useResource(() => api.profile.get(), []);
	const secrets = useResource(() => api.secrets.list(), []);
	const providers = useResource(() => api.catalog.providers(), []);
	const info = useResource(() => api.info(), []);
	const [toast, showToast] = useToast();
	const [error, setError] = useState<string | null>(null);
	const [sheet, setSheet] = useState<"model" | "key" | "rule" | null>(null);
	const [editingRule, setEditingRule] = useState<RuleFile | null>(null);
	const [saved, setSaved] = useState(false);

	const save = async (patch: Patch, message = "Saved") => {
		setError(null);
		try {
			profile.set(await api.profile.update(patch));
			setSaved(true);
			showToast(message);
			return true;
		} catch (cause) {
			setError(errorText(cause));
			return false;
		}
	};

	const applyNow = async () => {
		try {
			const result = await api.profile.apply();
			setSaved(false);
			showToast(result.stopped === 0 ? "No idle sessions to restart" : `Restarted ${result.stopped} idle sessions`);
		} catch (cause) {
			setError(errorText(cause));
		}
	};

	const current = profile.data;
	const providerOf = (model: string | null) => providers.data?.find(provider => model?.startsWith(`${provider.id}/`));

	return (
		<>
			<TopBar title="Settings" />
			<main className="page">
				<ErrorNotice error={error ?? profile.error} />
				{saved && (
					<div className="notice">
						Changes apply when a session next starts. Sessions already running keep their old settings.
						<div className="row-actions">
							<button type="button" className="btn" onClick={() => void applyNow()}>
								Restart idle sessions now
							</button>
						</div>
					</div>
				)}

				<section className="section">
					<h2>Model</h2>
					<p className="lead">The model every new session starts with. A session can still pick its own.</p>
					<ul className="list">
						<li>
							<button type="button" className="item" onClick={() => setSheet("model")}>
								<span className="main">
									<span className="title">{current?.defaultModel ?? "Chosen by omp"}</span>
									<span className="sub">
										<span>
											{providerOf(current?.defaultModel ?? null)?.label ??
												"Uses the first provider with a key"}
										</span>
										<span>Thinking: {current?.thinkingLevel ?? "default"}</span>
									</span>
								</span>
								<span className="end">Change</span>
							</button>
						</li>
					</ul>
				</section>

				<SubscriptionsSection
					onChanged={message => {
						showToast(message);
						void providers.reload();
					}}
				/>

				<section className="section">
					<h2>API keys</h2>
					<p className="lead">
						Stored on your server and given to every agent sandbox as environment variables. They are never shown
						again after you save them.
					</p>
					<ul className="list">
						{(secrets.data ?? []).map(secret => (
							<li key={secret.name}>
								<div className="item">
									<span className="main">
										<span className="title mono">{secret.name}</span>
										<span className="sub">
											<span>{secret.preview}</span>
											<span>Updated {relativeTime(secret.updatedAt)}</span>
										</span>
									</span>
									<button
										type="button"
										className="btn danger"
										onClick={async () => {
											try {
												await api.secrets.remove(secret.name);
												await Promise.all([secrets.reload(), providers.reload()]);
												showToast(`Removed ${secret.name}`);
											} catch (cause) {
												setError(errorText(cause));
											}
										}}
									>
										Remove
									</button>
								</div>
							</li>
						))}
					</ul>
					<div className="row-actions">
						<button type="button" className="btn" onClick={() => setSheet("key")}>
							<Plus size={16} /> Add key
						</button>
					</div>
				</section>

				{current && (
					<>
						<TextSetting
							title="Instructions"
							lead="Standing guidance for every session: how you like code written, tested and explained."
							value={current.instructions}
							placeholder="Prefer small commits. Run the tests before saying something works."
							onSave={value => save({ instructions: value }, "Instructions saved")}
						/>
						<TextSetting
							title="Always-on rules"
							lead="Short, hard requirements kept in view on every request, including for helper agents."
							value={current.stickyRules}
							placeholder="Never push to main. Never commit secrets."
							onSave={value => save({ stickyRules: value }, "Rules saved")}
						/>

						<section className="section">
							<h2>Rules for specific files</h2>
							<p className="lead">Guidance the agent loads when it works on matching files.</p>
							<ul className="list">
								{current.rules.map(rule => (
									<li key={rule.name}>
										<button
											type="button"
											className="item"
											onClick={() => {
												setEditingRule(rule);
												setSheet("rule");
											}}
										>
											<span className="main">
												<span className="title">{rule.name}</span>
												<span className="sub">
													{rule.description && <span>{rule.description}</span>}
													{rule.globs?.length ? (
														<span className="mono">{rule.globs.join(" ")}</span>
													) : null}
													{rule.alwaysApply && <span>Always applied</span>}
												</span>
											</span>
										</button>
									</li>
								))}
							</ul>
							<div className="row-actions">
								<button
									type="button"
									className="btn"
									onClick={() => {
										setEditingRule(null);
										setSheet("rule");
									}}
								>
									<Plus size={16} /> Add rule
								</button>
							</div>
						</section>

						<details className="section">
							<summary className="group-title">Advanced</summary>
							<TextSetting
								title="System prompt addition"
								lead="Appended to the agent's system prompt."
								value={current.systemPromptAppend}
								onSave={value => save({ systemPromptAppend: value })}
							/>
							<TextSetting
								title="omp settings"
								lead="Any omp config.yml setting, as YAML. The model above takes precedence."
								value={current.settings}
								code
								placeholder={"retry:\n  maxAttempts: 5"}
								onSave={value => save({ settings: value })}
							/>
							<TextSetting
								title="Custom providers"
								lead="A models.yml for OpenAI-compatible endpoints, local models or gateways."
								value={current.models}
								code
								placeholder={
									"providers:\n  my-gateway:\n    baseUrl: https://llm.example.com/v1\n    apiKey: MY_GATEWAY_KEY\n    api: openai-completions"
								}
								onSave={value => save({ models: value })}
							/>
						</details>
					</>
				)}

				<section className="section">
					<h2>Server</h2>
					<ul className="list">
						<li>
							<a className="item" href="#/environments">
								<span className="main">
									<span className="title">Environments</span>
									<span className="sub">Images, limits and tools the agent sandboxes run with</span>
								</span>
							</a>
						</li>
					</ul>
				</section>

				<Devices onSignOut={props.onSignOut} onToast={showToast} />
			</main>
			{sheet === "model" && current && providers.data && (
				<ModelSheet
					profile={current}
					providers={providers.data}
					thinkingLevels={info.data?.thinkingLevels ?? []}
					onClose={() => setSheet(null)}
					onKeyAdded={() => void Promise.all([secrets.reload(), providers.reload()])}
					onSave={async patch => {
						if (await save(patch, "Model saved")) setSheet(null);
					}}
				/>
			)}
			{sheet === "key" && providers.data && (
				<KeySheet
					providers={providers.data}
					onClose={() => setSheet(null)}
					onSaved={name => {
						setSheet(null);
						showToast(`Saved ${name}`);
						void Promise.all([secrets.reload(), providers.reload()]);
					}}
				/>
			)}
			{sheet === "rule" && current && (
				<RuleSheet
					rule={editingRule}
					onClose={() => setSheet(null)}
					onSave={async rule => {
						const others = current.rules.filter(item => item.name !== editingRule?.name);
						if (await save({ rules: rule ? [...others, rule] : others }, rule ? "Rule saved" : "Rule removed"))
							setSheet(null);
					}}
				/>
			)}
			<Toast message={toast} />
		</>
	);
}

function contextSize(tokens: number): string {
	return tokens >= 1_000_000 ? `${Number((tokens / 1_000_000).toFixed(1))}M` : `${Math.round(tokens / 1000)}k`;
}

function TextSetting(props: {
	title: string;
	lead: string;
	value: string;
	placeholder?: string;
	code?: boolean;
	onSave(value: string): Promise<boolean>;
}) {
	const [value, setValue] = useState(props.value);
	const [busy, setBusy] = useState(false);
	const dirty = value !== props.value;
	return (
		<section className="section">
			<h2>{props.title}</h2>
			<p className="lead">{props.lead}</p>
			<textarea
				className={`textarea${props.code ? " code" : ""}`}
				aria-label={props.title}
				spellCheck={!props.code}
				placeholder={props.placeholder}
				value={value}
				onChange={event => setValue(event.target.value)}
			/>
			{dirty && (
				<div className="row-actions">
					<button
						type="button"
						className="btn primary"
						disabled={busy}
						onClick={async () => {
							setBusy(true);
							await props.onSave(value);
							setBusy(false);
						}}
					>
						Save
					</button>
					<button type="button" className="btn" onClick={() => setValue(props.value)}>
						Discard
					</button>
				</div>
			)}
		</section>
	);
}

function ModelSheet(props: {
	profile: AgentProfile;
	providers: ProviderInfo[];
	thinkingLevels: readonly string[];
	onClose(): void;
	onKeyAdded(): void;
	onSave(patch: Patch): Promise<void>;
}) {
	const initialProvider =
		props.profile.defaultModel?.split("/")[0] ?? props.providers.find(item => item.configured)?.id ?? "";
	const [providerId, setProviderId] = useState(initialProvider);
	const [modelId, setModelId] = useState(
		props.profile.defaultModel?.startsWith(`${initialProvider}/`)
			? props.profile.defaultModel.slice(initialProvider.length + 1)
			: "",
	);
	const [thinking, setThinking] = useState<string>(props.profile.thinkingLevel ?? "");
	const [search, setSearch] = useState("");
	const provider = props.providers.find(item => item.id === providerId);
	const models = useResource(() => (providerId ? api.catalog.models(providerId) : Promise.resolve([])), [providerId]);
	const visible = useMemo(() => {
		const query = search.trim().toLowerCase();
		return props.providers.filter(
			item => !query || item.label.toLowerCase().includes(query) || item.id.includes(query),
		);
	}, [props.providers, search]);

	return (
		<Sheet title="Default model" onClose={props.onClose}>
			<Field label="Provider">
				<input
					className="input"
					type="search"
					placeholder="Search providers"
					value={search}
					onChange={event => setSearch(event.target.value)}
				/>
			</Field>
			<div className="picker" role="listbox" aria-label="Providers">
				{visible.map(item => (
					<button
						key={item.id}
						type="button"
						role="option"
						aria-selected={item.id === providerId}
						aria-pressed={item.id === providerId}
						onClick={() => {
							setProviderId(item.id);
							setModelId(item.defaultModel ?? "");
						}}
					>
						<span>{item.label}</span>
						<span className="meta">
							{item.configured ? <span className="ready">Key added</span> : `${item.modelCount} models`}
						</span>
					</button>
				))}
			</div>

			{provider && !provider.configured && provider.envVars.length > 0 && (
				<InlineKey provider={provider} onSaved={props.onKeyAdded} />
			)}

			{provider && (
				<>
					<Field label="Model">
						<input
							className="input mono"
							autoCapitalize="off"
							spellCheck={false}
							placeholder={provider.defaultModel ?? "model-id"}
							value={modelId}
							onChange={event => setModelId(event.target.value)}
						/>
					</Field>
					{(models.data?.length ?? 0) > 0 && (
						<div className="picker" role="listbox" aria-label="Models">
							{models.data?.map(model => (
								<button
									key={model.id}
									type="button"
									role="option"
									aria-selected={model.id === modelId}
									aria-pressed={model.id === modelId}
									onClick={() => setModelId(model.id)}
								>
									<span className="label">
										{model.name}
										<small>{model.id}</small>
									</span>
									<span className="meta">
										{model.contextWindow ? `${contextSize(model.contextWindow)} context` : ""}
									</span>
								</button>
							))}
						</div>
					)}
				</>
			)}

			<Field label="Thinking effort">
				<select className="select" value={thinking} onChange={event => setThinking(event.target.value)}>
					<option value="">omp default</option>
					{props.thinkingLevels.map(level => (
						<option key={level} value={level}>
							{level}
						</option>
					))}
				</select>
			</Field>

			<div className="row-actions">
				<button
					type="button"
					className="btn primary"
					disabled={!providerId || !modelId.trim()}
					onClick={() =>
						props.onSave({ defaultModel: `${providerId}/${modelId.trim()}`, thinkingLevel: thinking || null })
					}
				>
					Save model
				</button>
				<button
					type="button"
					className="btn"
					onClick={() => props.onSave({ defaultModel: null, thinkingLevel: thinking || null })}
				>
					Let omp choose
				</button>
			</div>
		</Sheet>
	);
}

function InlineKey(props: { provider: ProviderInfo; onSaved(): void }) {
	const name = props.provider.envVars[0];
	const [value, setValue] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);
	if (saved) return <p className="notice">Key saved for {props.provider.label}.</p>;
	return (
		<form
			className="notice"
			onSubmit={async event => {
				event.preventDefault();
				try {
					await api.secrets.set(name, value.trim());
					setSaved(true);
					props.onSaved();
				} catch (cause) {
					setError(errorText(cause));
				}
			}}
		>
			<Field
				label={`API key for ${props.provider.label}`}
				hint={
					<>
						Saved as <code>{name}</code>.
					</>
				}
			>
				<input
					className="input mono"
					type="password"
					autoComplete="off"
					value={value}
					onChange={event => setValue(event.target.value)}
				/>
			</Field>
			<ErrorNotice error={error} />
			<button type="submit" className="btn" disabled={!value.trim()}>
				Save key
			</button>
		</form>
	);
}

function KeySheet(props: { providers: ProviderInfo[]; onClose(): void; onSaved(name: string): void }) {
	const withKeys = props.providers.filter(provider => provider.envVars.length > 0);
	const [providerId, setProviderId] = useState(withKeys[0]?.id ?? "");
	const [custom, setCustom] = useState("");
	const [value, setValue] = useState("");
	const [error, setError] = useState<string | null>(null);
	const provider = withKeys.find(item => item.id === providerId);
	const name = providerId === "" ? custom.trim() : (provider?.envVars[0] ?? "");

	return (
		<Sheet title="Add a key" onClose={props.onClose}>
			<form
				onSubmit={async event => {
					event.preventDefault();
					try {
						await api.secrets.set(name, value.trim());
						props.onSaved(name);
					} catch (cause) {
						setError(errorText(cause));
					}
				}}
			>
				<Field label="For">
					<select className="select" value={providerId} onChange={event => setProviderId(event.target.value)}>
						{withKeys.map(item => (
							<option key={item.id} value={item.id}>
								{item.label}
							</option>
						))}
						<option value="">Another variable</option>
					</select>
				</Field>
				{providerId === "" ? (
					<Field label="Variable name" hint="Any environment variable the agent's tools need, such as NPM_TOKEN.">
						<input
							className="input mono"
							autoCapitalize="characters"
							spellCheck={false}
							value={custom}
							onChange={event => setCustom(event.target.value)}
						/>
					</Field>
				) : (
					<p className="note">
						Saved as <code>{name}</code>
						{provider && provider.envVars.length > 1
							? `; omp also reads ${provider.envVars.slice(1).join(", ")}`
							: ""}
						.
					</p>
				)}
				<Field label="Value">
					<input
						className="input mono"
						type="password"
						autoComplete="off"
						value={value}
						onChange={event => setValue(event.target.value)}
					/>
				</Field>
				<ErrorNotice error={error} />
				<button type="submit" className="btn primary block" disabled={!name || !value.trim()}>
					Save key
				</button>
			</form>
		</Sheet>
	);
}

function RuleSheet(props: { rule: RuleFile | null; onClose(): void; onSave(rule: RuleFile | null): Promise<void> }) {
	const [name, setName] = useState(props.rule?.name ?? "");
	const [description, setDescription] = useState(props.rule?.description ?? "");
	const [globs, setGlobs] = useState(props.rule?.globs?.join(" ") ?? "");
	const [alwaysApply, setAlwaysApply] = useState(props.rule?.alwaysApply ?? false);
	const [body, setBody] = useState(props.rule?.body ?? "");
	return (
		<Sheet title={props.rule ? `Edit ${props.rule.name}` : "Add a rule"} onClose={props.onClose}>
			<form
				onSubmit={event => {
					event.preventDefault();
					const patterns = globs.split(/[\s,]+/).filter(Boolean);
					void props.onSave({
						name: name.trim(),
						body,
						...(description.trim() ? { description: description.trim() } : {}),
						...(patterns.length > 0 ? { globs: patterns } : {}),
						...(alwaysApply ? { alwaysApply: true } : {}),
					});
				}}
			>
				<Field label="Name" hint="Letters, numbers, dots, dashes and underscores.">
					<input
						className="input mono"
						autoCapitalize="off"
						spellCheck={false}
						value={name}
						onChange={event => setName(event.target.value)}
					/>
				</Field>
				<Field label="When it applies" hint="Shown to the agent so it knows when to load the rule.">
					<input
						className="input"
						placeholder="Writing Go code"
						value={description}
						onChange={event => setDescription(event.target.value)}
					/>
				</Field>
				<Field label="Files" hint="Glob patterns separated by spaces.">
					<input
						className="input mono"
						autoCapitalize="off"
						spellCheck={false}
						placeholder="**/*.go"
						value={globs}
						onChange={event => setGlobs(event.target.value)}
					/>
				</Field>
				<label className="toggle">
					<input type="checkbox" checked={alwaysApply} onChange={event => setAlwaysApply(event.target.checked)} />
					Apply to every request
				</label>
				<Field label="Rule">
					<textarea className="textarea" value={body} onChange={event => setBody(event.target.value)} />
				</Field>
				<div className="row-actions">
					<button type="submit" className="btn primary" disabled={!name.trim() || !body.trim()}>
						Save rule
					</button>
					{props.rule && (
						<button type="button" className="btn danger" onClick={() => void props.onSave(null)}>
							Remove rule
						</button>
					)}
				</div>
			</form>
		</Sheet>
	);
}

function Devices(props: { onSignOut(): void; onToast(message: string): void }) {
	const tokens = useResource(() => api.tokens.list(), []);
	const [name, setName] = useState("");
	const [created, setCreated] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	return (
		<section className="section">
			<h2>Devices</h2>
			<p className="lead">
				Each phone, laptop or script signs in with its own token. Remove a device to sign it out.
			</p>
			<ErrorNotice error={error ?? tokens.error} />
			<ul className="list">
				{(tokens.data ?? []).map(token => (
					<li key={token.id}>
						<div className="item">
							<span className="main">
								<span className="title">{token.name}</span>
								<span className="sub">
									<span>
										{token.lastUsedAt ? `Last used ${relativeTime(token.lastUsedAt)}` : "Never used"}
									</span>
								</span>
							</span>
							<button
								type="button"
								className="btn danger"
								onClick={async () => {
									try {
										await api.tokens.remove(token.id);
										await tokens.reload();
										props.onToast(`Removed ${token.name}`);
									} catch (cause) {
										setError(errorText(cause));
									}
								}}
							>
								Remove
							</button>
						</div>
					</li>
				))}
			</ul>
			{created ? (
				<div className="notice">
					Open this link on the new device. It is shown only once.
					<div className="token-reveal">{`${window.location.origin}/#token=${encodeURIComponent(created)}`}</div>
				</div>
			) : (
				<form
					className="row-actions"
					onSubmit={async event => {
						event.preventDefault();
						try {
							const result = await api.tokens.create(name.trim());
							setCreated(result.token);
							setName("");
							await tokens.reload();
						} catch (cause) {
							setError(errorText(cause));
						}
					}}
				>
					<input
						className="input"
						placeholder="Device name"
						value={name}
						onChange={event => setName(event.target.value)}
					/>
					<button type="submit" className="btn" disabled={!name.trim()}>
						Add device
					</button>
				</form>
			)}
			<div className="row-actions">
				<button
					type="button"
					className="btn"
					onClick={() => {
						clearToken();
						props.onSignOut();
					}}
				>
					Sign out of this device
				</button>
			</div>
		</section>
	);
}
