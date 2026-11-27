/**
 * Providers and models for the settings page, straight from omp's bundled
 * catalog: the same ids, env-var names and model rosters omp itself uses.
 */
import { providerEntries } from "@oh-my-pi/pi-catalog/compat/providers";
import { getBundledModels, isGeneratedProvider } from "@oh-my-pi/pi-catalog/models";
import { HubError } from "./errors";

export interface ProviderInfo {
	id: string;
	label: string;
	/** Variables omp reads the credential from, in precedence order. */
	envVars: string[];
	defaultModel: string | null;
	modelCount: number;
	/** One of `envVars` has a value the hub forwards. */
	configured: boolean;
}

export interface ModelInfo {
	id: string;
	name: string;
	contextWindow: number | null;
	maxTokens: number | null;
	reasoning: boolean;
	vision: boolean;
	/** USD per million tokens, when the catalog knows it. */
	cost: { input: number; output: number } | null;
}

function bundledModels(provider: string) {
	return isGeneratedProvider(provider) ? getBundledModels(provider) : [];
}

/** Providers with at least one credential variable or bundled model, configured ones first. */
export function listProviders(isConfigured: (provider: { id: string; envVars: string[] }) => boolean): ProviderInfo[] {
	const providers: ProviderInfo[] = [];
	for (const entry of Object.values(providerEntries())) {
		const envVars = [...(entry.envVars ?? [])];
		const modelCount = bundledModels(entry.id).length;
		if (envVars.length === 0 && modelCount === 0) continue;
		providers.push({
			id: entry.id,
			label: entry.discovery?.label ?? entry.id,
			envVars,
			defaultModel: entry.defaultModel ?? null,
			modelCount,
			configured: isConfigured({ id: entry.id, envVars }),
		});
	}
	return providers.sort((a, b) => Number(b.configured) - Number(a.configured) || a.label.localeCompare(b.label));
}

export function listModels(provider: string): ModelInfo[] {
	if (!providerEntries()[provider] && !isGeneratedProvider(provider)) {
		throw new HubError(404, `unknown provider ${provider}`);
	}
	return bundledModels(provider).map(model => ({
		id: model.id,
		name: model.name ?? model.id,
		contextWindow: model.contextWindow ?? null,
		maxTokens: model.maxTokens ?? null,
		reasoning: model.reasoning === true,
		vision: model.input?.includes("image") === true,
		cost: model.cost ? { input: model.cost.input, output: model.cost.output } : null,
	}));
}
