/** Request bodies the API accepts. Unknown keys are rejected so typos fail loudly. */
import { type } from "@oh-my-pi/omptype";

export const AddRepoBody = type({ url: "string", "name?": "string", "+": "reject" });

export const CreateSessionBody = type({
	repoId: "string",
	"environmentId?": "string",
	"baseRef?": "string",
	"branch?": "string",
	"title?": "string",
	"model?": "string",
	"prompt?": "string",
	"+": "reject",
});

const Image = type({ type: "'image'", data: "string", mimeType: "string", "+": "reject" });

export const PromptBody = type({
	message: "string",
	"images?": Image.array(),
	"mode?": "'steer' | 'followUp'",
	"+": "reject",
});

const AskAnswer = type({ id: "string", selectedOptions: "string[]", "customInput?": "string", "+": "reject" });

/** One of the answer shapes omp accepts for a dialog, matching the request's method. */
export const DialogAnswerBody = type({ value: "string", "+": "reject" })
	.or({ confirmed: "boolean", "+": "reject" })
	.or({ cancelled: "true", "+": "reject" })
	.or({ answers: AskAnswer.array(), "+": "reject" })
	.or({ data: "Record<string, unknown>", "+": "reject" });

export const RespondBody = type({ requestId: "string", answer: DialogAnswerBody, "+": "reject" });

export const BashBody = type({ command: "string", "timeoutMs?": "number.integer > 0", "+": "reject" });

export const PublishBody = type({ "message?": "string", "force?": "boolean", "+": "reject" });

export const PullRequestBody = type({
	"title?": "string",
	"body?": "string",
	"draft?": "boolean",
	"message?": "string",
	"+": "reject",
});

/** Any object; the environment service validates it and applies the API-only restrictions. */
export const EnvironmentBody = type("Record<string, unknown>");

export const CreateTokenBody = type({ name: "string", "+": "reject" });

export const SecretBody = type({ value: "string", "+": "reject" });

export const StartLoginBody = type({ providerId: "string", "+": "reject" });

export const LoginAnswerBody = type({ inputId: "string", value: "string", "+": "reject" });
