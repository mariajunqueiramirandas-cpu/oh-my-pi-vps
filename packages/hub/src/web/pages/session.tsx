import { ArrowUp, Ellipsis, Square } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
	DialogAnswer,
	DialogRequest,
	HubEvent,
	SessionView,
	StreamFrame,
	WireAgentEvent,
	WireMessage,
} from "../../contract";
import { api, errorText, followSession } from "../api";
import { DialogCard } from "../dialog";
import { navigate, useResource, useToast } from "../hooks";
import { Transcript } from "../transcript";
import { ErrorNotice, Field, Sheet, statusWord, Toast, TopBar } from "../ui";

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor", "ask", "form"]);
const MAX_LOG_LINES = 300;

function messageKey(message: WireMessage): string | null {
	const record = message as unknown as { role?: unknown; timestamp?: unknown };
	return typeof record.timestamp === "number" ? `${String(record.role)}:${record.timestamp}` : null;
}

/** Replace a message already in the list (the stream can replay what the snapshot had), else append. */
function upsert(messages: WireMessage[], message: WireMessage): WireMessage[] {
	const key = messageKey(message);
	if (key !== null) {
		const index = messages.findIndex(candidate => messageKey(candidate) === key);
		if (index >= 0) return messages.map((candidate, at) => (at === index ? message : candidate));
	}
	return [...messages, message];
}

/** The message an agent event carries, if any; events are typed loosely on the wire. */
function messageOf(event: WireAgentEvent): WireMessage | null {
	const message: unknown = (event as { message?: unknown }).message;
	return typeof message === "object" && message !== null && typeof (message as { role?: unknown }).role === "string"
		? (message as WireMessage)
		: null;
}

function toolCallIdOf(event: WireAgentEvent): string | null {
	const id: unknown = (event as { toolCallId?: unknown }).toolCallId;
	return typeof id === "string" ? id : null;
}

function isAssistant(message: WireMessage): boolean {
	return (message as unknown as { role?: unknown }).role === "assistant";
}

function nearBottom(): boolean {
	return window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160;
}

export function SessionPage(props: { id: string }) {
	const { id } = props;
	const [session, setSession] = useState<SessionView>();
	const [messages, setMessages] = useState<WireMessage[]>([]);
	const [streaming, setStreaming] = useState<WireMessage | null>(null);
	const [running, setRunning] = useState<Set<string>>(new Set());
	const [pending, setPending] = useState<DialogRequest[]>([]);
	const [logs, setLogs] = useState<string[]>([]);
	const [notice, setNotice] = useState<string | null>(null);
	const [connected, setConnected] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [menu, setMenu] = useState(false);
	const [toast, showToast] = useToast();
	const stick = useRef(true);

	const reloadMessages = useCallback(async () => {
		const transcript = await api.sessions.messages(id);
		setMessages(Array.isArray(transcript.messages) ? transcript.messages : []);
		setStreaming(null);
	}, [id]);

	const apply = useCallback((event: HubEvent) => {
		switch (event.kind) {
			case "status":
				setSession(current =>
					current ? { ...current, status: event.status, error: event.error ?? current.error } : current,
				);
				if (event.status === "stopped" || event.status === "failed") setRunning(new Set());
				break;
			case "agent": {
				const agent = event.event;
				const message = messageOf(agent);
				const toolCallId = toolCallIdOf(agent);
				if (message && (agent.type === "message_start" || agent.type === "message_update")) {
					if (isAssistant(message)) setStreaming(message);
					else if (agent.type === "message_start") setMessages(current => upsert(current, message));
				} else if (message && agent.type === "message_end") {
					setMessages(current => upsert(current, message));
					if (isAssistant(message)) setStreaming(null);
				} else if (toolCallId && agent.type === "tool_execution_start") {
					setRunning(current => new Set(current).add(toolCallId));
				} else if (toolCallId && agent.type === "tool_execution_end") {
					setRunning(current => {
						const next = new Set(current);
						next.delete(toolCallId);
						return next;
					});
				} else if (agent.type === "agent_end") {
					setStreaming(null);
					setRunning(new Set());
				}
				break;
			}
			case "ui_request":
				if (DIALOG_METHODS.has(event.request.method)) {
					setPending(current => [...current.filter(request => request.id !== event.request.id), event.request]);
				}
				break;
			case "ui_resolved":
				setPending(current => current.filter(request => request.id !== event.id));
				break;
			case "prompt_result":
				if (event.result.status === "error") setNotice(event.result.error?.message ?? "The agent hit an error.");
				break;
			case "log":
				setLogs(current => [...current, event.line].slice(-MAX_LOG_LINES));
				break;
		}
	}, []);

	useEffect(() => {
		let stop = () => {};
		let cancelled = false;
		void (async () => {
			try {
				const view = await api.sessions.get(id);
				// Capture the stream position before the snapshot; replayed events are merged by upsert.
				const since = view.lastSeq;
				const transcript = await api.sessions.messages(id);
				if (cancelled) return;
				setSession(view);
				setPending(view.pending.filter(request => DIALOG_METHODS.has(request.method)));
				setMessages(Array.isArray(transcript.messages) ? transcript.messages : []);
				stop = followSession(id, since, {
					onFrame: (frame: StreamFrame) => {
						if (frame.type === "hello" && frame.truncated) void reloadMessages();
						if (frame.type === "event") apply(frame.event);
					},
					onState: setConnected,
				});
			} catch (cause) {
				if (!cancelled) setLoadError(errorText(cause));
			}
		})();
		return () => {
			cancelled = true;
			stop();
		};
	}, [id, apply, reloadMessages]);

	// Keep the newest output in view unless the reader scrolled up to look at something.
	useEffect(() => {
		const onScroll = () => {
			stick.current = nearBottom();
		};
		window.addEventListener("scroll", onScroll, { passive: true });
		return () => window.removeEventListener("scroll", onScroll);
	}, []);
	useLayoutEffect(() => {
		if (stick.current) window.scrollTo({ top: document.documentElement.scrollHeight });
	}, [messages, streaming, pending, logs]);

	const answer = async (request: DialogRequest, value: DialogAnswer) => {
		try {
			await api.sessions.respond(id, request.id, value);
			setPending(current => current.filter(item => item.id !== request.id));
		} catch (cause) {
			setNotice(errorText(cause));
		}
	};

	if (loadError) {
		return (
			<>
				<TopBar title="Session" back="/" />
				<main className="page">
					<ErrorNotice error={loadError} />
				</main>
			</>
		);
	}
	if (!session) return <TopBar title="Session" back="/" />;

	const busy = session.status === "busy" || session.status === "starting" || session.status === "provisioning";
	return (
		<div className="shell no-nav">
			<TopBar
				title={session.title ?? session.branch}
				back="/"
				actions={
					<button
						type="button"
						className="btn quiet icon"
						aria-label="Session actions"
						onClick={() => setMenu(true)}
					>
						<Ellipsis size={22} />
					</button>
				}
				below={
					<div className={`session-meta s-${session.status}`}>
						<span className="state-word">{connected ? statusWord(session.status) : "Reconnecting…"}</span>
						<span>{session.repoName}</span>
						<span className="mono">{session.branch}</span>
					</div>
				}
			/>
			<main className="transcript">
				{session.error && <div className="notice error">{session.error}</div>}
				{logs.length > 0 && (session.status === "provisioning" || messages.length === 0) && (
					<div className="log">{logs.join("\n")}</div>
				)}
				{messages.length === 0 && !streaming && !busy && session.status !== "failed" && (
					<p className="note">Nothing here yet. Tell the agent what to do.</p>
				)}
				<Transcript messages={messages} streaming={streaming} running={running} />
				{session.status === "busy" && !streaming && (
					<span className="typing" aria-label="Agent is working">
						<i />
						<i />
						<i />
					</span>
				)}
			</main>
			<div className="dock">
				<div className="dock-inner">
					{pending.map(request => (
						<DialogCard key={request.id} request={request} onAnswer={value => answer(request, value)} />
					))}
					<ErrorNotice error={notice} />
					{session.status !== "failed" && (
						<Composer
							id={id}
							busy={session.status === "busy" || session.status === "waiting"}
							asking={pending.length > 0}
							onError={setNotice}
							onSent={() => {
								setNotice(null);
								stick.current = true;
							}}
						/>
					)}
				</div>
			</div>
			{menu && (
				<SessionActions
					session={session}
					onClose={() => setMenu(false)}
					onDone={message => {
						setMenu(false);
						showToast(message);
					}}
				/>
			)}
			<Toast message={toast} />
		</div>
	);
}

function Composer(props: {
	id: string;
	busy: boolean;
	asking: boolean;
	onError(message: string): void;
	onSent(): void;
}) {
	const [text, setText] = useState("");
	const [mode, setMode] = useState<"followUp" | "steer">("followUp");
	const [sending, setSending] = useState(false);
	const area = useRef<HTMLTextAreaElement>(null);

	useLayoutEffect(() => {
		const element = area.current;
		if (!element) return;
		element.style.height = "auto";
		element.style.height = `${element.scrollHeight}px`;
	}, [text]);

	const send = async () => {
		const message = text.trim();
		if (!message) return;
		setSending(true);
		try {
			await api.sessions.prompt(props.id, { message, ...(props.busy ? { mode } : {}) });
			setText("");
			props.onSent();
		} catch (cause) {
			props.onError(errorText(cause));
		} finally {
			setSending(false);
		}
	};

	const stop = async () => {
		try {
			await api.sessions.abort(props.id);
		} catch (cause) {
			props.onError(errorText(cause));
		}
	};

	return (
		<>
			{props.busy && !props.asking && (
				<div className="composer-hint">
					<div className="segmented" role="group" aria-label="When to deliver your message">
						<button type="button" aria-pressed={mode === "followUp"} onClick={() => setMode("followUp")}>
							After this step
						</button>
						<button type="button" aria-pressed={mode === "steer"} onClick={() => setMode("steer")}>
							Interrupt
						</button>
					</div>
				</div>
			)}
			<form
				className="composer"
				onSubmit={event => {
					event.preventDefault();
					void send();
				}}
			>
				<textarea
					ref={area}
					rows={1}
					aria-label="Message to the agent"
					placeholder={props.busy ? "Add to what the agent is doing" : "Message the agent"}
					value={text}
					onChange={event => setText(event.target.value)}
					onKeyDown={event => {
						// Desktop keyboards send with Ctrl/⌘+Enter; on phones Enter stays a newline.
						if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
							event.preventDefault();
							void send();
						}
					}}
				/>
				{props.busy && !text.trim() ? (
					<button type="button" className="btn icon" aria-label="Stop the agent" onClick={() => void stop()}>
						<Square size={18} />
					</button>
				) : (
					<button type="submit" className="btn primary icon" aria-label="Send" disabled={sending || !text.trim()}>
						<ArrowUp size={20} />
					</button>
				)}
			</form>
		</>
	);
}

type Panel = "menu" | "diff" | "publish" | "pull" | "shell" | "delete";

function SessionActions(props: { session: SessionView; onClose(): void; onDone(message: string): void }) {
	const { session } = props;
	const [panel, setPanel] = useState<Panel>("menu");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const info = useResource(() => api.info(), []);

	const run = async (work: () => Promise<string>) => {
		setBusy(true);
		setError(null);
		try {
			props.onDone(await work());
		} catch (cause) {
			setError(errorText(cause));
		} finally {
			setBusy(false);
		}
	};

	const live = session.status !== "stopped" && session.status !== "failed";
	if (panel === "diff") return <DiffSheet session={session} onClose={props.onClose} />;
	if (panel === "publish") {
		return (
			<CommitSheet
				title="Push branch"
				action="Push branch"
				session={session}
				busy={busy}
				error={error}
				onClose={props.onClose}
				onSubmit={(message, force) =>
					run(async () => {
						const result = await api.sessions.publish(session.id, { ...(message ? { message } : {}), force });
						return `Pushed ${result.branch}`;
					})
				}
			/>
		);
	}
	if (panel === "pull") {
		return (
			<CommitSheet
				title="Open pull request"
				action="Open pull request"
				session={session}
				busy={busy}
				error={error}
				withPullRequest
				onClose={props.onClose}
				onSubmit={(message, _force, title, body) =>
					run(async () => {
						const pull = await api.sessions.pullRequest(session.id, {
							...(message ? { message } : {}),
							...(title ? { title } : {}),
							...(body ? { body } : {}),
						});
						window.open(pull.url, "_blank", "noopener");
						return pull.created
							? `Opened pull request #${pull.number}`
							: `Pull request #${pull.number} already open`;
					})
				}
			/>
		);
	}
	if (panel === "shell") return <ShellSheet session={session} onClose={props.onClose} />;
	if (panel === "delete") {
		return (
			<Sheet title="Delete this session?" onClose={props.onClose}>
				<p>
					The agent stops and its checkout, history and unpushed commits on {session.branch} are removed for good.
				</p>
				<ErrorNotice error={error} />
				<div className="row-actions">
					<button
						type="button"
						className="btn primary"
						disabled={busy}
						onClick={() =>
							run(async () => {
								await api.sessions.remove(session.id);
								navigate("/");
								return "Session deleted";
							})
						}
					>
						Delete session
					</button>
					<button type="button" className="btn" onClick={props.onClose}>
						Keep it
					</button>
				</div>
			</Sheet>
		);
	}

	return (
		<Sheet title={session.title ?? session.branch} onClose={props.onClose}>
			<p className="note">
				{session.repoName} on <code>{session.branch}</code>
				{session.activeModel ? (
					<>
						{" "}
						with <code>{session.activeModel}</code>
					</>
				) : null}
			</p>
			<ul className="list">
				<li>
					<button type="button" className="item" onClick={() => setPanel("diff")}>
						<span className="main">
							<span className="title">View changes</span>
							<span className="sub">Everything changed since the session started</span>
						</span>
					</button>
				</li>
				<li>
					<button type="button" className="item" onClick={() => setPanel("publish")}>
						<span className="main">
							<span className="title">Push branch</span>
							<span className="sub">Commit pending work and push {session.branch}</span>
						</span>
					</button>
				</li>
				{info.data?.github && (
					<li>
						<button type="button" className="item" onClick={() => setPanel("pull")}>
							<span className="main">
								<span className="title">Open pull request</span>
								<span className="sub">Push, then open a PR against {session.baseRef}</span>
							</span>
						</button>
					</li>
				)}
				<li>
					<button type="button" className="item" onClick={() => setPanel("shell")}>
						<span className="main">
							<span className="title">Run a command</span>
							<span className="sub">Runs in the sandbox; the agent sees the output</span>
						</span>
					</button>
				</li>
				<li>
					<button
						type="button"
						className="item"
						disabled={busy}
						onClick={() =>
							run(async () => {
								if (live) {
									await api.sessions.stop(session.id);
									return "Agent stopped";
								}
								await api.sessions.start(session.id);
								return "Agent started";
							})
						}
					>
						<span className="main">
							<span className="title">{live ? "Stop agent" : "Start agent"}</span>
							<span className="sub">
								{live ? "Frees the sandbox; your next message resumes it" : "Resume where it left off"}
							</span>
						</span>
					</button>
				</li>
				<li>
					<button type="button" className="item btn danger" onClick={() => setPanel("delete")}>
						<span className="main">
							<span className="title">Delete session</span>
						</span>
					</button>
				</li>
			</ul>
			<ErrorNotice error={error} />
		</Sheet>
	);
}

function CommitSheet(props: {
	title: string;
	action: string;
	session: SessionView;
	busy: boolean;
	error: string | null;
	withPullRequest?: boolean;
	onClose(): void;
	onSubmit(message: string, force: boolean, title: string, body: string): void;
}) {
	const [message, setMessage] = useState("");
	const [force, setForce] = useState(false);
	const [title, setTitle] = useState(props.session.title ?? "");
	const [body, setBody] = useState("");
	return (
		<Sheet title={props.title} onClose={props.onClose}>
			<form
				onSubmit={event => {
					event.preventDefault();
					props.onSubmit(message.trim(), force, title.trim(), body.trim());
				}}
			>
				<Field
					label="Commit message"
					hint="Commits uncommitted changes first. Leave empty to push existing commits only."
				>
					<input
						className="input"
						placeholder="Fix flaky login test"
						value={message}
						onChange={event => setMessage(event.target.value)}
					/>
				</Field>
				{props.withPullRequest ? (
					<>
						<Field label="Pull request title">
							<input className="input" value={title} onChange={event => setTitle(event.target.value)} />
						</Field>
						<Field label="Description">
							<textarea className="textarea" value={body} onChange={event => setBody(event.target.value)} />
						</Field>
					</>
				) : (
					<label className="toggle">
						<input type="checkbox" checked={force} onChange={event => setForce(event.target.checked)} />
						Overwrite the remote branch if someone else pushed to it
					</label>
				)}
				<ErrorNotice error={props.error} />
				<button type="submit" className="btn primary block" disabled={props.busy}>
					{props.action}
				</button>
			</form>
		</Sheet>
	);
}

function DiffSheet(props: { session: SessionView; onClose(): void }) {
	const diff = useResource(() => api.sessions.diff(props.session.id), [props.session.id]);
	return (
		<Sheet title="Changes" onClose={props.onClose}>
			<ErrorNotice error={diff.error} />
			{diff.loading && !diff.data && <p className="note">Collecting changes…</p>}
			{diff.data && !diff.data.diff.trim() && !diff.data.status.trim() && <p className="note">No changes yet.</p>}
			{diff.data?.status.trim() && <div className="log">{diff.data.status}</div>}
			{diff.data?.diff.trim() && <DiffView text={diff.data.diff} />}
			{diff.data?.truncated && <p className="note">The diff is too large to show in full.</p>}
		</Sheet>
	);
}

function DiffView(props: { text: string }) {
	const lines = props.text.split("\n");
	return (
		<pre className="diff">
			{lines.map((line, index) => {
				const kind = line.startsWith("diff --git")
					? "file"
					: line.startsWith("@@")
						? "hunk"
						: line.startsWith("+") && !line.startsWith("+++")
							? "add"
							: line.startsWith("-") && !line.startsWith("---")
								? "del"
								: "";
				return (
					<span key={index} className={kind}>
						{kind === "file" ? line.replace(/^diff --git a\/(.*) b\/.*$/, "$1") : line || " "}
					</span>
				);
			})}
		</pre>
	);
}

function ShellSheet(props: { session: SessionView; onClose(): void }) {
	const [command, setCommand] = useState("");
	const [output, setOutput] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const run = async () => {
		setBusy(true);
		setError(null);
		try {
			const result = await api.sessions.shell(props.session.id, command);
			const exit = result.exitCode === undefined ? "" : `\n(exit ${result.exitCode})`;
			setOutput(`${result.output ?? ""}${exit}`);
		} catch (cause) {
			setError(errorText(cause));
		} finally {
			setBusy(false);
		}
	};
	return (
		<Sheet title="Run a command" onClose={props.onClose}>
			<form
				onSubmit={event => {
					event.preventDefault();
					void run();
				}}
			>
				<Field
					label="Command"
					hint="Runs in the session's checkout. Long commands keep running for up to 10 minutes."
				>
					<input
						className="input mono"
						autoCapitalize="off"
						spellCheck={false}
						placeholder="bun test"
						value={command}
						onChange={event => setCommand(event.target.value)}
					/>
				</Field>
				<ErrorNotice error={error} />
				<button type="submit" className="btn primary block" disabled={busy || !command.trim()}>
					{busy ? "Running…" : "Run"}
				</button>
			</form>
			{output !== null && <div className="log">{output}</div>}
		</Sheet>
	);
}
