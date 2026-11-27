/** Registered repositories and their bare mirrors under `<dataDir>/mirrors`. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { HubError } from "./errors";
import { assertRemoteUrl, ensureMirror, fetchMirror, repoNameFromUrl } from "./git";
import { KeyedSerial, newId } from "./ids";
import type { HubStore, RepoRow } from "./store";

export class RepoService {
	readonly #store: HubStore;
	readonly #mirrorRoot: string;
	readonly #timeoutMs: number;
	/** Serializes git operations per mirror: fetch, bundle import and push must not interleave. */
	readonly locks = new KeyedSerial();
	readonly #pending = new Map<string, Promise<void>>();

	constructor(store: HubStore, dataDir: string, timeoutMs: number) {
		this.#store = store;
		this.#mirrorRoot = path.join(dataDir, "mirrors");
		this.#timeoutMs = timeoutMs;
	}

	list(): RepoRow[] {
		return this.#store.listRepos();
	}

	get(id: string): RepoRow {
		const repo = this.#store.repo(id);
		if (!repo) throw new HubError(404, `repository ${id} not found`);
		return repo;
	}

	mirrorPath(id: string): string {
		return path.join(this.#mirrorRoot, `${id}.git`);
	}

	/** Register a repository and start mirroring it in the background. */
	add(url: string, name?: string): RepoRow {
		try {
			assertRemoteUrl(url);
		} catch (error) {
			throw new HubError(422, (error as Error).message);
		}
		const displayName = name?.trim() || repoNameFromUrl(url);
		if (this.#store.repoByName(displayName))
			throw new HubError(409, `a repository named ${displayName} already exists`);
		const row: RepoRow = {
			id: newId("repo"),
			name: displayName,
			url,
			defaultBranch: null,
			status: "cloning",
			error: null,
			createdAt: Date.now(),
			fetchedAt: null,
		};
		this.#store.insertRepo(row);
		this.#track(row.id, this.#mirror(row));
		return row;
	}

	/** After a restart: restart mirrors that were interrupted mid-clone. */
	resumePending(): void {
		for (const repo of this.#store.listRepos()) {
			if (repo.status === "cloning" && !this.#pending.has(repo.id)) this.#track(repo.id, this.#mirror(repo));
		}
	}

	/** Wait for an in-flight initial mirror, if any. */
	async settled(id: string): Promise<void> {
		await this.#pending.get(id);
	}

	/** Fetch the latest refs; retries the initial mirror when it previously failed. */
	async refresh(id: string): Promise<RepoRow> {
		const repo = this.get(id);
		await this.settled(id);
		if (repo.status !== "ready") {
			this.#store.updateRepo(id, { status: "cloning", error: null });
			await this.#mirror(this.get(id));
		} else {
			await this.locks.run(id, () => fetchMirror(this.mirrorPath(id), this.#timeoutMs));
			this.#store.updateRepo(id, { fetchedAt: Date.now() });
		}
		return this.get(id);
	}

	async remove(id: string): Promise<void> {
		this.get(id);
		if (this.#store.sessionsForRepo(id).length > 0) {
			throw new HubError(409, "delete this repository's sessions first; their checkouts borrow its objects");
		}
		await this.settled(id);
		await this.locks.run(id, () => fs.rm(this.mirrorPath(id), { recursive: true, force: true }));
		this.#store.deleteRepo(id);
	}

	#track(id: string, work: Promise<void>): void {
		this.#pending.set(id, work);
		void work.finally(() => {
			if (this.#pending.get(id) === work) this.#pending.delete(id);
		});
	}

	#mirror(repo: RepoRow): Promise<void> {
		return this.locks.run(repo.id, async () => {
			try {
				const { defaultBranch } = await ensureMirror(repo.url, this.mirrorPath(repo.id), this.#timeoutMs);
				this.#store.updateRepo(repo.id, { status: "ready", error: null, defaultBranch, fetchedAt: Date.now() });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				logger.warn("hub: mirroring failed", { repo: repo.name, error: message });
				this.#store.updateRepo(repo.id, { status: "error", error: message });
			}
		});
	}
}
