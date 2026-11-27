import { useCallback, useEffect, useRef, useState } from "react";
import { errorText } from "./api";

/** Hash routes: `#/sessions/ses_x` → `["sessions", "ses_x"]`. */
export function useRoute(): string[] {
	const [hash, setHash] = useState(window.location.hash);
	useEffect(() => {
		const onChange = () => setHash(window.location.hash);
		window.addEventListener("hashchange", onChange);
		return () => window.removeEventListener("hashchange", onChange);
	}, []);
	return hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
}

export function navigate(path: string): void {
	window.location.hash = `#${path}`;
}

export interface Resource<T> {
	data: T | undefined;
	error: string | null;
	loading: boolean;
	reload(): Promise<void>;
	set(value: T): void;
}

/** Load data, keep the last good value while reloading, and expose errors as text. */
export function useResource<T>(load: () => Promise<T>, deps: readonly unknown[]): Resource<T> {
	const [data, setData] = useState<T>();
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const loadRef = useRef(load);
	loadRef.current = load;
	const generation = useRef(0);

	const reload = useCallback(async () => {
		const current = ++generation.current;
		setLoading(true);
		try {
			const value = await loadRef.current();
			if (current !== generation.current) return;
			setData(value);
			setError(null);
		} catch (cause) {
			if (current === generation.current) setError(errorText(cause));
		} finally {
			if (current === generation.current) setLoading(false);
		}
	}, []);

	useEffect(() => {
		void reload();
	}, deps);

	return { data, error, loading, reload, set: setData };
}

/** Re-run `tick` every `ms` while the page is visible. */
export function useInterval(tick: () => void, ms: number): void {
	const tickRef = useRef(tick);
	tickRef.current = tick;
	useEffect(() => {
		const id = setInterval(() => {
			if (document.visibilityState === "visible") tickRef.current();
		}, ms);
		return () => clearInterval(id);
	}, [ms]);
}

/** A transient confirmation line ("Saved"). */
export function useToast(): [string | null, (message: string) => void] {
	const [message, setMessage] = useState<string | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const show = useCallback((text: string) => {
		setMessage(text);
		clearTimeout(timer.current);
		timer.current = setTimeout(() => setMessage(null), 2200);
	}, []);
	return [message, show];
}

export function useScrolled(): boolean {
	const [scrolled, setScrolled] = useState(false);
	useEffect(() => {
		const onScroll = () => setScrolled(window.scrollY > 4);
		window.addEventListener("scroll", onScroll, { passive: true });
		return () => window.removeEventListener("scroll", onScroll);
	}, []);
	return scrolled;
}
