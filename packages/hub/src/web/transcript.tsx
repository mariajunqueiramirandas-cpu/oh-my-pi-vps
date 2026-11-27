/**
 * The conversation as a readable log. Assistant text reads like a document;
 * each tool call is one line that expands to its arguments and result.
 * Everything is rendered as text nodes: agent output never becomes markup.
 */
import type { WireMessage } from "../contract";
import { Fragment, type ReactNode } from "react";

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function blocksOf(content: unknown): Rec[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return Array.isArray(content) ? content.filter(isRec) : [];
}

function textOf(content: unknown): string {
	return blocksOf(content)
		.map(block => (block.type === "text" ? str(block.text) : block.type === "image" ? "[image]" : ""))
		.filter(Boolean)
		.join("\n");
}

const MAX_RESULT_CHARS = 20_000;

function clip(text: string): string {
	return text.length > MAX_RESULT_CHARS
		? `${text.slice(0, MAX_RESULT_CHARS)}\n… (${text.length - MAX_RESULT_CHARS} more characters)`
		: text;
}

/** The one argument that says what a tool call is about. */
function gist(args: unknown): string {
	if (!isRec(args)) return "";
	for (const key of [
		"command",
		"cmd",
		"path",
		"file_path",
		"filePath",
		"pattern",
		"query",
		"url",
		"description",
		"prompt",
		"task",
	]) {
		const value = args[key];
		if (typeof value === "string" && value.trim()) return value.replace(/\s+/g, " ").trim();
	}
	const json = JSON.stringify(args);
	return json && json !== "{}" ? json : "";
}

function Inline(props: { text: string }) {
	// `code` spans only; everything else stays literal text.
	const parts = props.text.split(/(`[^`\n]+`)/);
	return (
		<>
			{parts.map((part, index) =>
				part.startsWith("`") && part.endsWith("`") && part.length > 2 ? (
					<code key={index}>{part.slice(1, -1)}</code>
				) : (
					<Fragment key={index}>{part}</Fragment>
				),
			)}
		</>
	);
}

export function Prose(props: { text: string }) {
	const segments = props.text.split("```");
	return (
		<div className="prose">
			{segments.map((segment, index) => {
				if (index % 2 === 1) {
					const newline = segment.indexOf("\n");
					const code = newline >= 0 ? segment.slice(newline + 1) : segment;
					return (
						<pre key={index}>
							<code>{code.replace(/\n$/, "")}</code>
						</pre>
					);
				}
				return segment
					.split(/\n{2,}/)
					.map(paragraph => paragraph.trim())
					.filter(Boolean)
					.map((paragraph, inner) => (
						<p key={`${index}-${inner}`}>
							<Inline text={paragraph} />
						</p>
					));
			})}
		</div>
	);
}

interface Outcome {
	text: string;
	isError: boolean;
}

function ToolLine(props: { name: string; args: unknown; outcome?: Outcome; running: boolean }) {
	const state = props.running ? " running" : props.outcome?.isError ? " error" : "";
	const mark = props.running ? "running" : props.outcome ? (props.outcome.isError ? "failed" : "") : "";
	// A call whose only argument is its command or path shows that value as is.
	const entries = isRec(props.args) ? Object.entries(props.args) : [];
	const args =
		entries.length === 1 && typeof entries[0][1] === "string"
			? entries[0][1]
			: entries.length > 0
				? JSON.stringify(props.args, null, 2)
				: "";
	return (
		<details className={`tool${state}`}>
			<summary>
				<span className="name">{props.name}</span>
				<span className="what">{gist(props.args)}</span>
				{mark && <span className="result-mark">{mark}</span>}
			</summary>
			<div className="tool-body">
				{args && <pre>{args}</pre>}
				{props.outcome?.text && <pre>{clip(props.outcome.text)}</pre>}
			</div>
		</details>
	);
}

function AssistantMessage(props: { message: Rec; outcomes: Map<string, Outcome>; running: Set<string> }) {
	const nodes: ReactNode[] = [];
	blocksOf(props.message.content).forEach((block, index) => {
		if (block.type === "text" && str(block.text).trim()) {
			nodes.push(<Prose key={index} text={str(block.text)} />);
		} else if (block.type === "thinking" && str(block.thinking).trim()) {
			nodes.push(
				<details key={index} className="thinking">
					<summary>Thinking</summary>
					<p>{str(block.thinking)}</p>
				</details>,
			);
		} else if (block.type === "toolCall") {
			const id = str(block.id);
			nodes.push(
				<ToolLine
					key={id || index}
					name={str(block.name) || "tool"}
					args={block.arguments}
					outcome={props.outcomes.get(id)}
					running={props.running.has(id)}
				/>,
			);
		}
	});
	const error = str(props.message.errorMessage);
	if (error)
		nodes.push(
			<div key="error" className="notice error">
				{error}
			</div>,
		);
	return nodes.length > 0 ? <div className="msg assistant">{nodes}</div> : null;
}

function MessageView(props: { message: Rec; outcomes: Map<string, Outcome>; running: Set<string> }) {
	const { message } = props;
	switch (message.role) {
		case "user": {
			const text = textOf(message.content);
			return text ? <div className="msg user">{text}</div> : null;
		}
		case "assistant":
			return <AssistantMessage {...props} />;
		case "bashExecution": {
			const output = str(message.output);
			const code = message.exitCode;
			return (
				<div className="msg">
					<ToolLine
						name="shell"
						args={{ command: str(message.command) }}
						outcome={{ text: output, isError: typeof code === "number" && code !== 0 }}
						running={false}
					/>
				</div>
			);
		}
		case "compactionSummary":
		case "branchSummary":
			return <p className="note">Earlier conversation was summarized to save context.</p>;
		default:
			return null;
	}
}

export function Transcript(props: { messages: WireMessage[]; streaming: WireMessage | null; running: Set<string> }) {
	const outcomes = new Map<string, Outcome>();
	for (const message of props.messages as unknown[]) {
		if (isRec(message) && message.role === "toolResult") {
			outcomes.set(str(message.toolCallId), { text: textOf(message.content), isError: message.isError === true });
		}
	}
	const all = props.streaming ? [...props.messages, props.streaming] : props.messages;
	return (
		<>
			{(all as unknown[]).map((message, index) =>
				isRec(message) ? (
					// Messages carry no stable id; their position in the transcript is stable.
					<MessageView key={index} message={message} outcomes={outcomes} running={props.running} />
				) : null,
			)}
		</>
	);
}
