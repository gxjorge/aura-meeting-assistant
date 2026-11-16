export function formatLocalSttFailure(localFailure: string, azureFailure?: string): string {
  if (!azureFailure) {
    return localFailure;
  }

  return `${azureFailure} Local Vosk fallback also failed: ${localFailure}`;
}
