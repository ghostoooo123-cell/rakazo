/**
 * A second operator-configured OpenAI-compatible endpoint, beside the local model server.
 * The id file stays free of the provider so runtime limits can name it without loading Pi.
 */
export const HOST_COMPATIBLE_PROVIDER_ID = "host-compatible";

export const HOST_COMPATIBLE_CONNECTION_ERROR = "That model is provided by the server.";

export function isHostCompatibleProvider(provider: string | null | undefined): boolean {
  return provider === HOST_COMPATIBLE_PROVIDER_ID;
}
