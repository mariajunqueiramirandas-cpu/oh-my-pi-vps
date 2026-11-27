/**
 * The phone UI: a React app bundled in memory on first request with
 * `Bun.build`, then served from memory. Hashed chunks are immutable; the page
 * itself is never cached so a hub upgrade reaches the phone on next load.
 */
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";

interface UiFile {
	body: Uint8Array;
	type: string;
}

export interface UiBundle {
	index: UiFile;
	/** Hashed assets by file name, served under `/ui/`. */
	assets: Map<string, UiFile>;
	/** Fixed-name files served at the site root (manifest, icon). */
	root: Map<string, UiFile>;
}

const WEB_DIR = path.join(import.meta.dir, "..", "web");
const ROOT_LINKS =
	'<link rel="manifest" href="/manifest.webmanifest"><link rel="icon" href="/icon.svg" type="image/svg+xml">';
const ROOT_FILES: Record<string, string> = {
	"manifest.webmanifest": "application/manifest+json",
	"icon.svg": "image/svg+xml",
};

async function build(): Promise<UiBundle> {
	const result = await Bun.build({
		entrypoints: [path.join(WEB_DIR, "index.html")],
		target: "browser",
		minify: true,
		publicPath: "/ui/",
		define: { "process.env.NODE_ENV": JSON.stringify("production") },
	});
	if (!result.success) {
		throw new Error(`building the web UI failed:\n${result.logs.map(log => log.message).join("\n")}`);
	}
	let index: UiFile | undefined;
	const assets = new Map<string, UiFile>();
	for (const output of result.outputs) {
		const file = { body: new Uint8Array(await output.arrayBuffer()), type: output.type };
		const name = path.basename(output.path);
		if (name === "index.html") index = file;
		else assets.set(name, file);
	}
	if (!index) throw new Error("building the web UI produced no index.html");
	// Fixed-path files are served by the hub, not the bundler, so their links are added after bundling.
	const html = new TextDecoder().decode(index.body).replace("</head>", `${ROOT_LINKS}</head>`);
	index = { ...index, body: new TextEncoder().encode(html) };
	const root = new Map<string, UiFile>();
	for (const [name, type] of Object.entries(ROOT_FILES)) {
		root.set(name, { body: await Bun.file(path.join(WEB_DIR, "public", name)).bytes(), type });
	}
	return { index, assets, root };
}

let cached: Promise<UiBundle> | null = null;

/** The bundle, built once per process; a failed build is retried on the next request. */
export function uiBundle(): Promise<UiBundle> {
	cached ??= build().catch(error => {
		cached = null;
		logger.error("hub: web UI build failed", { error: error instanceof Error ? error.message : String(error) });
		throw error;
	});
	return cached;
}

export function uiResponse(file: UiFile, cache: "immutable" | "revalidate"): Response {
	return new Response(file.body, {
		headers: {
			"Content-Type": file.type,
			"Cache-Control": cache === "immutable" ? "public, max-age=31536000, immutable" : "no-cache",
		},
	});
}
