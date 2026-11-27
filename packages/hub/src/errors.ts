/** An error with the HTTP status the API should answer with. */
export class HubError extends Error {
	constructor(
		readonly status: 400 | 404 | 409 | 422 | 429 | 500 | 502 | 503,
		message: string,
	) {
		super(message);
		this.name = "HubError";
	}
}
