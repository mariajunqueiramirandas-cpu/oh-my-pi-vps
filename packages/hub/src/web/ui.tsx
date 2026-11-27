import { ChevronLeft } from "lucide-react";
import { type ReactNode, useEffect, useId } from "react";
import type { SessionStatus } from "../contract";
import { useScrolled } from "./hooks";

export function TopBar(props: { title: string; back?: string; actions?: ReactNode; below?: ReactNode }) {
	const scrolled = useScrolled();
	return (
		<header className={`topbar${scrolled ? " scrolled" : ""}`}>
			<div className="topbar-row">
				{props.back !== undefined && (
					<a className="btn quiet icon back" href={`#${props.back}`} aria-label="Back">
						<ChevronLeft size={24} />
					</a>
				)}
				<h1>{props.title}</h1>
				{props.actions}
			</div>
			{props.below}
		</header>
	);
}

export function Sheet(props: { title: string; onClose(): void; children: ReactNode }) {
	const titleId = useId();
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") props.onClose();
		};
		window.addEventListener("keydown", onKey);
		document.body.style.overflow = "hidden";
		return () => {
			window.removeEventListener("keydown", onKey);
			document.body.style.overflow = "";
		};
	}, [props.onClose]);
	return (
		<div className="scrim" onClick={props.onClose} role="presentation">
			<div
				className="sheet"
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				onClick={event => event.stopPropagation()}
				onKeyDown={event => event.stopPropagation()}
			>
				<div className="grabber" />
				<h2 id={titleId}>{props.title}</h2>
				{props.children}
			</div>
		</div>
	);
}

export function Field(props: { label: string; hint?: ReactNode; children: ReactNode }) {
	return (
		<label className="field">
			<span>{props.label}</span>
			{props.children}
			{props.hint && <small>{props.hint}</small>}
		</label>
	);
}

export function Toast(props: { message: string | null }) {
	return props.message ? (
		<div className="toast" role="status">
			{props.message}
		</div>
	) : null;
}

export function ErrorNotice(props: { error: string | null | undefined }) {
	return props.error ? (
		<div className="notice error" role="alert">
			{props.error}
		</div>
	) : null;
}

const STATUS_WORDS: Record<SessionStatus, string> = {
	provisioning: "Setting up",
	starting: "Starting",
	idle: "Ready",
	busy: "Working",
	waiting: "Needs you",
	stopping: "Stopping",
	stopped: "Stopped",
	failed: "Failed",
};

export function statusWord(status: SessionStatus): string {
	return STATUS_WORDS[status];
}

export function relativeTime(at: number, now = Date.now()): string {
	const seconds = Math.round((now - at) / 1000);
	if (seconds < 45) return "just now";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} h ago`;
	const days = Math.round(hours / 24);
	return days === 1 ? "yesterday" : `${days} days ago`;
}
