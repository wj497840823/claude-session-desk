export function deletePaths(
  sessionFile: string,
  sidecarPath: string,
  sidecarExists: boolean
): string[] {
  return sidecarExists ? [sessionFile, sidecarPath] : [sessionFile]
}