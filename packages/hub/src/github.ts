/** Opening pull requests for published session branches. */
import { HubError } from "./errors";

export interface PullRequestInput {
	apiUrl: string;
	token: string;
	owner: string;
	repo: string;
	head: string;
	base: string;
	title: string;
	body?: string;
	draft?: boolean;
}

interface GithubPull {
	html_url: string;
	number: number;
}

/** Open a pull request, or return the open one that already exists for `head`. */
export async function openPullRequest(
	input: PullRequestInput,
): Promise<{ url: string; number: number; created: boolean }> {
	const base = `${input.apiUrl.replace(/\/+$/, "")}/repos/${input.owner}/${input.repo}/pulls`;
	const headers = {
		Accept: "application/vnd.github+json",
		Authorization: `Bearer ${input.token}`,
		"X-GitHub-Api-Version": "2022-11-28",
		"Content-Type": "application/json",
	};
	const response = await fetch(base, {
		method: "POST",
		headers,
		body: JSON.stringify({
			title: input.title,
			body: input.body ?? "",
			head: input.head,
			base: input.base,
			draft: input.draft ?? false,
		}),
		signal: AbortSignal.timeout(30_000),
	});
	if (response.ok) {
		const pull = (await response.json()) as GithubPull;
		return { url: pull.html_url, number: pull.number, created: true };
	}
	if (response.status === 422) {
		const existing = await fetch(`${base}?state=open&head=${encodeURIComponent(`${input.owner}:${input.head}`)}`, {
			headers,
			signal: AbortSignal.timeout(30_000),
		});
		if (existing.ok) {
			const pulls = (await existing.json()) as GithubPull[];
			if (pulls[0]) return { url: pulls[0].html_url, number: pulls[0].number, created: false };
		}
	}
	const detail = await response.text().catch(() => "");
	throw new HubError(502, `GitHub refused the pull request (${response.status}): ${detail.slice(0, 500)}`);
}
