/** Answering what the agent asked: confirm, choose, type, or work through a set of questions. */
import { type ReactNode, useState } from "react";
import type { DialogAnswer, DialogRequest } from "../contract";

export function DialogCard(props: { request: DialogRequest; onAnswer(answer: DialogAnswer): Promise<void> }) {
	const [busy, setBusy] = useState(false);
	const answer = async (value: DialogAnswer) => {
		setBusy(true);
		try {
			await props.onAnswer(value);
		} finally {
			setBusy(false);
		}
	};
	const skip = (
		<button type="button" className="btn" disabled={busy} onClick={() => answer({ cancelled: true })}>
			Skip
		</button>
	);
	const { request } = props;

	switch (request.method) {
		case "confirm":
			return (
				<section className="ask" aria-live="polite">
					<h3>{request.title}</h3>
					<p>{request.message}</p>
					<div className="row-actions">
						<button
							type="button"
							className="btn primary"
							disabled={busy}
							onClick={() => answer({ confirmed: true })}
						>
							Yes
						</button>
						<button type="button" className="btn" disabled={busy} onClick={() => answer({ confirmed: false })}>
							No
						</button>
					</div>
				</section>
			);
		case "select":
			return (
				<section className="ask" aria-live="polite">
					<h3>{request.title}</h3>
					{request.options.map((option, index) => (
						<button
							key={option}
							type="button"
							className="option"
							disabled={busy}
							onClick={() => answer({ value: option })}
						>
							{option}
							{request.optionDetails?.[index]?.description && (
								<small>{request.optionDetails[index].description}</small>
							)}
						</button>
					))}
					<div className="row-actions">{skip}</div>
				</section>
			);
		case "input":
		case "editor":
			return <TextAnswer request={request} busy={busy} onSubmit={value => answer({ value })} skip={skip} />;
		case "ask":
			return <Questions request={request} busy={busy} onSubmit={answers => answer({ answers })} skip={skip} />;
		case "form":
			return (
				<section className="ask" aria-live="polite">
					<h3>The agent opened a form</h3>
					<p>This kind of question can only be answered in a terminal. Skip it to let the agent continue.</p>
					<div className="row-actions">{skip}</div>
				</section>
			);
		default:
			return null;
	}
}

function TextAnswer(props: {
	request: Extract<DialogRequest, { method: "input" | "editor" }>;
	busy: boolean;
	onSubmit(value: string): void;
	skip: ReactNode;
}) {
	const { request } = props;
	const [value, setValue] = useState(request.method === "editor" ? (request.prefill ?? "") : "");
	return (
		<form
			className="ask"
			aria-live="polite"
			onSubmit={event => {
				event.preventDefault();
				props.onSubmit(value);
			}}
		>
			<h3>{request.title}</h3>
			{request.method === "editor" ? (
				<textarea className="textarea" value={value} onChange={event => setValue(event.target.value)} />
			) : (
				<input
					className="input"
					type={request.secret ? "password" : "text"}
					placeholder={request.placeholder}
					autoComplete="off"
					value={value}
					onChange={event => setValue(event.target.value)}
				/>
			)}
			<div className="row-actions">
				<button type="submit" className="btn primary" disabled={props.busy}>
					Send answer
				</button>
				{props.skip}
			</div>
		</form>
	);
}

function Questions(props: {
	request: Extract<DialogRequest, { method: "ask" }>;
	busy: boolean;
	onSubmit(answers: Array<{ id: string; selectedOptions: string[]; customInput?: string }>): void;
	skip: ReactNode;
}) {
	const { questions } = props.request;
	const [index, setIndex] = useState(0);
	const [picked, setPicked] = useState<Record<string, string[]>>({});
	const [custom, setCustom] = useState<Record<string, string>>({});
	const question = questions[index];
	if (!question) return null;
	const selected = picked[question.id] ?? [];
	const toggle = (label: string) => {
		const next = question.multi
			? selected.includes(label)
				? selected.filter(item => item !== label)
				: [...selected, label]
			: [label];
		setPicked({ ...picked, [question.id]: next });
	};
	const last = index === questions.length - 1;
	const answered = selected.length > 0 || Boolean(custom[question.id]?.trim());
	const submit = () =>
		props.onSubmit(
			questions.map(item => ({
				id: item.id,
				selectedOptions: picked[item.id] ?? [],
				...(custom[item.id]?.trim() ? { customInput: custom[item.id].trim() } : {}),
			})),
		);
	return (
		<section className="ask" aria-live="polite">
			{questions.length > 1 && (
				<div className="count">
					Question {index + 1} of {questions.length}
				</div>
			)}
			<h3>{question.question}</h3>
			{question.options.map((option, optionIndex) => (
				<button
					key={option.label}
					type="button"
					className="option"
					aria-pressed={selected.includes(option.label)}
					onClick={() => toggle(option.label)}
				>
					{option.label}
					{question.recommended === optionIndex && " (recommended)"}
					{option.description && <small>{option.description}</small>}
				</button>
			))}
			<input
				className="input"
				placeholder="Or type your own answer"
				value={custom[question.id] ?? ""}
				onChange={event => setCustom({ ...custom, [question.id]: event.target.value })}
			/>
			<div className="row-actions">
				{last ? (
					<button type="button" className="btn primary" disabled={props.busy || !answered} onClick={submit}>
						Send answers
					</button>
				) : (
					<button type="button" className="btn primary" disabled={!answered} onClick={() => setIndex(index + 1)}>
						Next question
					</button>
				)}
				{index > 0 && (
					<button type="button" className="btn" onClick={() => setIndex(index - 1)}>
						Previous
					</button>
				)}
				{props.skip}
			</div>
		</section>
	);
}
